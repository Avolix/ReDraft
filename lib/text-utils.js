/**
 * Pure utility functions extracted from the ReDraft client extension.
 * No DOM, no SillyTavern API — safe to test in Node.js.
 */

/**
 * Compute the plugin base URL from a pathname string.
 * Uses the first path segment as the app base when present, so /tavern/...
 * and /tavern/chat/... both hit /tavern/api/plugins/redraft.
 * @param {string} [pathname] - The window.location.pathname (or undefined for SSR/fallback).
 * @returns {string}
 */
export function getPluginBaseUrl(pathname) {
    if (pathname == null) return '/api/plugins/redraft';
    const clean = (pathname || '/').replace(/\/$/, '') || '/';
    const segments = clean.split('/').filter(Boolean);
    const basePath = segments.length > 0 ? '/' + segments[0] : '';
    return basePath + '/api/plugins/redraft';
}

/**
 * Compile active rules into a numbered list string.
 * @param {object} settings - Extension settings with builtInRules and customRules.
 * @param {Record<string, {label: string, prompt: string}>} builtInRules - Built-in rule definitions.
 * @param {{ enabledMap?: string, customKey?: string }} [opts] - Override which settings keys to read.
 * @returns {string}
 */
export function compileRules(settings, builtInRules, opts = {}) {
    const enabledMap = settings[opts.enabledMap || 'builtInRules'] || {};
    const customList = settings[opts.customKey || 'customRules'] || [];
    const rules = [];

    for (const [key, rule] of Object.entries(builtInRules)) {
        if (enabledMap[key]) {
            rules.push(rule.prompt);
        }
    }

    for (let i = 0; i < customList.length; i++) {
        const rule = customList[i];
        if (rule.enabled && rule.text && rule.text.trim()) {
            rules.push(rule.text.trim());
        }
    }

    if (rules.length === 0) {
        rules.push('Improve the overall quality of the message');
    }

    return rules.map((r, i) => `${i + 1}. ${r}`).join('\n');
}

/**
 * Strip structured content from text, replacing with placeholders.
 * Protects code fences, HTML/XML tags, and bracket-delimited blocks
 * from being mangled by the refinement LLM.
 * @param {string} text
 * @param {{ protectFontTags?: boolean }} [options]
 * @returns {{ stripped: string, blocks: string[] }}
 */
export function stripProtectedBlocks(text, options = {}) {
    const blocks = [];
    let result = text;

    result = result.replace(/```[\s\S]*?```/g, (match) => {
        blocks.push(match);
        return `[PROTECTED_${blocks.length - 1}]`;
    });

    const blockTags = 'details|div|table|section|aside|article|nav|pre|fieldset|figure|timeline';
    const blockRegex = new RegExp(
        `<((?:${blockTags}|\\w+[-_]\\w[\\w-]*))(\\b[^>]*)>[\\s\\S]*?<\\/\\1>`, 'gi'
    );
    result = result.replace(blockRegex, (match) => {
        blocks.push(match);
        return `[PROTECTED_${blocks.length - 1}]`;
    });

    result = result.replace(/\[([A-Z_]+)\][\s\S]*?\[\/\1\]/gi, (match, tag) => {
        if (tag.toUpperCase() === 'CHANGELOG' || tag.toUpperCase().startsWith('PROTECTED')) return match;
        blocks.push(match);
        return `[PROTECTED_${blocks.length - 1}]`;
    });

    if (options.protectFontTags) {
        result = result.replace(/<font[^>]*>[\s\S]*?<\/font>/gi, (match) => {
            blocks.push(match);
            return `[PROTECTED_${blocks.length - 1}]`;
        });
    }

    return { stripped: result, blocks };
}

/**
 * Restore protected blocks from placeholders.
 * Handles [PROTECTED_N] replacements and stray [/PROTECTED_N] closing tags.
 * @param {string} text
 * @param {string[]} blocks
 * @returns {string}
 */
export function restoreProtectedBlocks(text, blocks) {
    let result = text.replace(/\[PROTECTED_(\d+)\]/g, (_, idx) => {
        return blocks[parseInt(idx, 10)] || '';
    });

    result = result.replace(/\[\/PROTECTED_(\d+)\]/g, '');

    for (let i = 0; i < blocks.length; i++) {
        if (!text.includes(`[PROTECTED_${i}]`)) {
            result = result + '\n' + blocks[i];
        }
    }

    return result;
}

/**
 * Parse the LLM response, extracting changelog and refined message.
 * @param {string} responseText
 * @returns {{ changelog: string|null, refined: string }}
 */
export function parseChangelog(responseText) {
    let changelog = null;
    let refined;

    const refinedMatch = responseText.match(/\[REFINED\]\s*([\s\S]*?)\s*\[\/REFINED\]/i);
    if (refinedMatch) {
        refined = refinedMatch[1].trim();
        const changelogMatch = responseText.match(/\[CHANGELOG\]\s*([\s\S]*?)\s*\[\/CHANGELOG\]/i);
        changelog = changelogMatch ? changelogMatch[1].trim() : null;
    } else {
        let match = responseText.match(/\[CHANGELOG\]\s*([\s\S]*?)\s*\[\/CHANGELOG\]/i);
        if (match) {
            changelog = match[1].trim();
            refined = responseText.substring(match.index + match[0].length).trim();
        } else {
            match = responseText.match(/\[CHANGELOG\]\s*([\s\S]*?)$/i);
            if (match) {
                const remainder = match[1];
                const splitIdx = remainder.search(/\n\s*\n/);
                if (splitIdx !== -1) {
                    changelog = remainder.substring(0, splitIdx).trim();
                    refined = remainder.substring(splitIdx).trim();
                }
            }
        }
    }

    if (!refined) {
        refined = responseText.trim();
    }

    refined = refined.replace(/\[\/?(?:REFINED|CHANGELOG)\]/gi, '').trim();

    return { changelog, refined };
}

/**
 * Detect the PoV of a text by checking pronoun frequency.
 * @param {string} text
 * @returns {'1st'|'1.5'|'2nd'|'3rd'|null}
 */
export function detectPov(text) {
    const lower = text.toLowerCase();
    const first = (lower.match(/\b(i|me|my|myself|mine)\b/g) || []).length;
    const second = (lower.match(/\b(you|your|yours|yourself)\b/g) || []).length;
    const third = (lower.match(/\b(he|she|they|him|her|them|his|hers|their|theirs)\b/g) || []).length;

    const total = first + second + third;
    if (total < 3) return null;

    if (first > total * 0.2 && second > total * 0.2) return '1.5';
    if (first > second && first > third) return '1st';
    if (second > first && second > third) return '2nd';
    if (third > first && third > second) return '3rd';
    return null;
}

/**
 * Tokenize text into words and whitespace for diffing.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
    return text.match(/\S+|\s+/g) || [];
}

/**
 * Compute LCS (Longest Common Subsequence) table for two token arrays.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Uint16Array[]}
 */
export function lcsTable(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1] + 1
                : Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
    }
    return dp;
}

/**
 * Compute word-level diff between original and refined text.
 * @param {string} original
 * @param {string} refined
 * @returns {Array<{type: 'equal'|'delete'|'insert', text: string}>}
 */
export function computeWordDiff(original, refined) {
    const a = tokenize(original);
    const b = tokenize(refined);
    const dp = lcsTable(a, b);

    const diff = [];
    let i = a.length, j = b.length;
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
            diff.push({ type: 'equal', text: a[i - 1] });
            i--; j--;
        } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.push({ type: 'insert', text: b[j - 1] });
            j--;
        } else {
            diff.push({ type: 'delete', text: a[i - 1] });
            i--;
        }
    }
    diff.reverse();

    const merged = [];
    for (const seg of diff) {
        if (merged.length > 0 && merged[merged.length - 1].type === seg.type) {
            merged[merged.length - 1].text += seg.text;
        } else {
            merged.push({ ...seg });
        }
    }
    return merged;
}
