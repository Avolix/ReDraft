import { describe, it, expect } from 'vitest';
import {
    getPluginBaseUrl,
    compileRules,
    stripProtectedBlocks,
    restoreProtectedBlocks,
    parseChangelog,
    detectPov,
    tokenize,
    lcsTable,
    computeWordDiff,
} from '../lib/text-utils.js';

// ─── getPluginBaseUrl ───────────────────────────────────────────────

describe('getPluginBaseUrl', () => {
    it('returns default when pathname is undefined', () => {
        expect(getPluginBaseUrl(undefined)).toBe('/api/plugins/redraft');
    });

    it('returns default when pathname is null', () => {
        expect(getPluginBaseUrl(null)).toBe('/api/plugins/redraft');
    });

    it('returns bare path for root /', () => {
        expect(getPluginBaseUrl('/')).toBe('/api/plugins/redraft');
    });

    it('uses first segment as base for /tavern', () => {
        expect(getPluginBaseUrl('/tavern')).toBe('/tavern/api/plugins/redraft');
    });

    it('uses first segment as base for /tavern/chat/123', () => {
        expect(getPluginBaseUrl('/tavern/chat/123')).toBe('/tavern/api/plugins/redraft');
    });

    it('strips trailing slash before processing', () => {
        expect(getPluginBaseUrl('/tavern/')).toBe('/tavern/api/plugins/redraft');
    });

    it('handles double trailing slashes', () => {
        expect(getPluginBaseUrl('/st//')).toBe('/st/api/plugins/redraft');
    });

    it('handles empty string pathname', () => {
        expect(getPluginBaseUrl('')).toBe('/api/plugins/redraft');
    });
});

// ─── compileRules ───────────────────────────────────────────────────

describe('compileRules', () => {
    const sampleRules = {
        grammar: { label: 'Grammar', prompt: 'Fix grammar errors.' },
        prose: { label: 'Prose', prompt: 'Clean up prose.' },
    };

    it('compiles enabled built-in rules into a numbered list', () => {
        const settings = {
            builtInRules: { grammar: true, prose: true },
            customRules: [],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toBe('1. Fix grammar errors.\n2. Clean up prose.');
    });

    it('skips disabled built-in rules', () => {
        const settings = {
            builtInRules: { grammar: false, prose: true },
            customRules: [],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toBe('1. Clean up prose.');
    });

    it('includes enabled custom rules', () => {
        const settings = {
            builtInRules: { grammar: false, prose: false },
            customRules: [
                { enabled: true, text: 'My custom rule' },
                { enabled: false, text: 'Disabled rule' },
            ],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toBe('1. My custom rule');
    });

    it('trims custom rule text', () => {
        const settings = {
            builtInRules: { grammar: false, prose: false },
            customRules: [{ enabled: true, text: '  spaces around  ' }],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toBe('1. spaces around');
    });

    it('skips custom rules with empty text', () => {
        const settings = {
            builtInRules: { grammar: false, prose: false },
            customRules: [{ enabled: true, text: '   ' }],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toContain('Improve the overall quality');
    });

    it('uses fallback when no rules are active', () => {
        const settings = {
            builtInRules: { grammar: false, prose: false },
            customRules: [],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toBe('1. Improve the overall quality of the message');
    });

    it('mixes built-in and custom rules in order', () => {
        const settings = {
            builtInRules: { grammar: true, prose: false },
            customRules: [{ enabled: true, text: 'Custom one' }],
        };
        const result = compileRules(settings, sampleRules);
        expect(result).toBe('1. Fix grammar errors.\n2. Custom one');
    });
});

// ─── compileRules with opts (user enhance rules) ────────────────────

describe('compileRules with opts (user enhance mode)', () => {
    const userRules = {
        grammar: { label: 'Grammar', prompt: 'Fix user grammar.' },
        personaVoice: { label: 'Persona', prompt: 'Match persona voice.' },
        expandBrevity: { label: 'Expand', prompt: 'Expand brief messages.' },
    };

    it('reads from userBuiltInRules and userCustomRules when opts are provided', () => {
        const settings = {
            builtInRules: { grammar: true }, // should be ignored
            customRules: [{ enabled: true, text: 'AI custom rule' }], // should be ignored
            userBuiltInRules: { grammar: true, personaVoice: false, expandBrevity: true },
            userCustomRules: [{ enabled: true, text: 'User custom rule' }],
        };
        const result = compileRules(settings, userRules, {
            enabledMap: 'userBuiltInRules',
            customKey: 'userCustomRules',
        });
        expect(result).toBe('1. Fix user grammar.\n2. Expand brief messages.\n3. User custom rule');
    });

    it('uses fallback when no user rules are active', () => {
        const settings = {
            userBuiltInRules: { grammar: false, personaVoice: false, expandBrevity: false },
            userCustomRules: [],
        };
        const result = compileRules(settings, userRules, {
            enabledMap: 'userBuiltInRules',
            customKey: 'userCustomRules',
        });
        expect(result).toBe('1. Improve the overall quality of the message');
    });

    it('handles missing userBuiltInRules gracefully', () => {
        const settings = {
            userCustomRules: [{ enabled: true, text: 'Only custom' }],
        };
        const result = compileRules(settings, userRules, {
            enabledMap: 'userBuiltInRules',
            customKey: 'userCustomRules',
        });
        expect(result).toBe('1. Only custom');
    });

    it('handles missing userCustomRules gracefully', () => {
        const settings = {
            userBuiltInRules: { grammar: true, personaVoice: true, expandBrevity: false },
        };
        const result = compileRules(settings, userRules, {
            enabledMap: 'userBuiltInRules',
            customKey: 'userCustomRules',
        });
        expect(result).toBe('1. Fix user grammar.\n2. Match persona voice.');
    });

    it('does not cross-contaminate with default AI rules', () => {
        const aiRules = { echo: { label: 'Echo', prompt: 'Remove echo.' } };
        const settings = {
            builtInRules: { echo: true },
            customRules: [{ enabled: true, text: 'AI rule' }],
            userBuiltInRules: { grammar: true, personaVoice: false, expandBrevity: false },
            userCustomRules: [{ enabled: true, text: 'User rule' }],
        };

        const aiResult = compileRules(settings, aiRules);
        expect(aiResult).toBe('1. Remove echo.\n2. AI rule');

        const userResult = compileRules(settings, userRules, {
            enabledMap: 'userBuiltInRules',
            customKey: 'userCustomRules',
        });
        expect(userResult).toBe('1. Fix user grammar.\n2. User rule');
    });
});

// ─── stripProtectedBlocks / restoreProtectedBlocks ──────────────────

describe('stripProtectedBlocks', () => {
    it('protects code fences', () => {
        const text = 'before ```js\ncode\n``` after';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(stripped).toContain('[PROTECTED_0]');
        expect(stripped).not.toContain('```');
        expect(blocks).toHaveLength(1);
        expect(blocks[0]).toBe('```js\ncode\n```');
    });

    it('protects HTML block-level elements', () => {
        const text = 'hello <div class="x">inner</div> world';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(stripped).toContain('[PROTECTED_0]');
        expect(blocks[0]).toBe('<div class="x">inner</div>');
    });

    it('protects custom elements with hyphens', () => {
        const text = '<sim-tracker>data</sim-tracker>';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(stripped).toBe('[PROTECTED_0]');
        expect(blocks[0]).toBe('<sim-tracker>data</sim-tracker>');
    });

    it('protects custom elements with underscores', () => {
        const text = '<lumia_ooc>data</lumia_ooc>';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(stripped).toBe('[PROTECTED_0]');
        expect(blocks[0]).toBe('<lumia_ooc>data</lumia_ooc>');
    });

    it('protects bracket-delimited blocks', () => {
        const text = '[OOC]out of character[/OOC]';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(stripped).toContain('[PROTECTED_0]');
        expect(blocks[0]).toBe('[OOC]out of character[/OOC]');
    });

    it('does NOT protect [CHANGELOG] or [PROTECTED] bracket tags', () => {
        const text = '[CHANGELOG]log[/CHANGELOG]';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(stripped).toBe('[CHANGELOG]log[/CHANGELOG]');
        expect(blocks).toHaveLength(0);
    });

    it('protects font tags when option is set', () => {
        const text = '<font color="red">text</font>';
        const { stripped: s1, blocks: b1 } = stripProtectedBlocks(text);
        expect(b1).toHaveLength(0);

        const { stripped: s2, blocks: b2 } = stripProtectedBlocks(text, { protectFontTags: true });
        expect(s2).toContain('[PROTECTED_0]');
        expect(b2[0]).toBe('<font color="red">text</font>');
    });

    it('handles multiple blocks', () => {
        const text = '```code1``` middle <div>html</div> end';
        const { stripped, blocks } = stripProtectedBlocks(text);
        expect(blocks).toHaveLength(2);
        expect(stripped).toContain('[PROTECTED_0]');
        expect(stripped).toContain('[PROTECTED_1]');
    });

    it('returns empty blocks array for plain text', () => {
        const { stripped, blocks } = stripProtectedBlocks('Just plain text.');
        expect(stripped).toBe('Just plain text.');
        expect(blocks).toHaveLength(0);
    });
});

describe('restoreProtectedBlocks', () => {
    it('restores placeholders to original content', () => {
        const blocks = ['```code```', '<div>html</div>'];
        const text = 'before [PROTECTED_0] middle [PROTECTED_1] after';
        const result = restoreProtectedBlocks(text, blocks);
        expect(result).toBe('before ```code``` middle <div>html</div> after');
    });

    it('removes stray closing tags [/PROTECTED_N]', () => {
        const blocks = ['```code```'];
        const text = '[PROTECTED_0][/PROTECTED_0]';
        const result = restoreProtectedBlocks(text, blocks);
        expect(result).toBe('```code```');
    });

    it('appends missing blocks if LLM dropped placeholders', () => {
        const blocks = ['```code```', '<div>html</div>'];
        const text = 'LLM only kept [PROTECTED_0]';
        const result = restoreProtectedBlocks(text, blocks);
        expect(result).toContain('```code```');
        expect(result).toContain('<div>html</div>');
    });

    it('round-trips with stripProtectedBlocks', () => {
        const original = 'Hello ```python\nprint("hi")\n``` and <details>secret</details> end.';
        const { stripped, blocks } = stripProtectedBlocks(original);
        const restored = restoreProtectedBlocks(stripped, blocks);
        expect(restored).toBe(original);
    });
});

// ─── parseChangelog ─────────────────────────────────────────────────

describe('parseChangelog', () => {
    it('extracts both REFINED and CHANGELOG tags', () => {
        const input = `[CHANGELOG]
- Fixed grammar
[/CHANGELOG]
[REFINED]
The refined text here.
[/REFINED]`;
        const { changelog, refined } = parseChangelog(input);
        expect(changelog).toBe('- Fixed grammar');
        expect(refined).toBe('The refined text here.');
    });

    it('extracts REFINED even without CHANGELOG', () => {
        const input = '[REFINED]Just the refined text.[/REFINED]';
        const { changelog, refined } = parseChangelog(input);
        expect(changelog).toBeNull();
        expect(refined).toBe('Just the refined text.');
    });

    it('extracts CHANGELOG-only and takes text after it', () => {
        const input = `[CHANGELOG]
- Change 1
[/CHANGELOG]
This is the refined message.`;
        const { changelog, refined } = parseChangelog(input);
        expect(changelog).toBe('- Change 1');
        expect(refined).toBe('This is the refined message.');
    });

    it('handles unclosed CHANGELOG with double-newline split', () => {
        const input = `[CHANGELOG]
- Change 1

The refined message here.`;
        const { changelog, refined } = parseChangelog(input);
        expect(changelog).toBe('- Change 1');
        expect(refined).toBe('The refined message here.');
    });

    it('falls back to entire text when no tags present', () => {
        const input = 'Just a plain response.';
        const { changelog, refined } = parseChangelog(input);
        expect(changelog).toBeNull();
        expect(refined).toBe('Just a plain response.');
    });

    it('strips leftover tag markers from refined text', () => {
        const input = '[REFINED]Text [CHANGELOG] leftover[/REFINED]';
        const { refined } = parseChangelog(input);
        expect(refined).not.toContain('[REFINED]');
        expect(refined).not.toContain('[/REFINED]');
        expect(refined).not.toContain('[CHANGELOG]');
    });

    it('handles case-insensitive tags', () => {
        const input = '[refined]Hello world.[/refined]';
        const { refined } = parseChangelog(input);
        expect(refined).toBe('Hello world.');
    });

    it('handles whitespace around tag content', () => {
        const input = '[REFINED]   \n  Trimmed content.  \n  [/REFINED]';
        const { refined } = parseChangelog(input);
        expect(refined).toBe('Trimmed content.');
    });
});

// ─── detectPov ──────────────────────────────────────────────────────

describe('detectPov', () => {
    it('detects 1st person', () => {
        expect(detectPov('I walked down the road. My hands were cold. I felt tired.')).toBe('1st');
    });

    it('detects 2nd person', () => {
        expect(detectPov('You walk down the road. Your hands are cold. You feel tired.')).toBe('2nd');
    });

    it('detects 3rd person', () => {
        expect(detectPov('He walked down the road. His hands were cold. She watched him go.')).toBe('3rd');
    });

    it('detects 1.5 person (mixed I + you)', () => {
        expect(detectPov('I looked at you. My eyes met yours. I reached for your hand.')).toBe('1.5');
    });

    it('returns null for very short text', () => {
        expect(detectPov('Hi.')).toBeNull();
    });

    it('returns null for text with fewer than 3 pronouns', () => {
        expect(detectPov('The cat sat on the mat.')).toBeNull();
    });

    it('handles mixed case', () => {
        expect(detectPov('I WALKED. MY HANDS. I FELT.')).toBe('1st');
    });
});

// ─── tokenize ───────────────────────────────────────────────────────

describe('tokenize', () => {
    it('splits words and whitespace', () => {
        expect(tokenize('hello world')).toEqual(['hello', ' ', 'world']);
    });

    it('preserves multiple spaces', () => {
        expect(tokenize('a  b')).toEqual(['a', '  ', 'b']);
    });

    it('returns empty array for empty string', () => {
        expect(tokenize('')).toEqual([]);
    });

    it('handles tabs and newlines', () => {
        const tokens = tokenize('word\tanother\nline');
        expect(tokens).toEqual(['word', '\t', 'another', '\n', 'line']);
    });

    it('handles single word', () => {
        expect(tokenize('hello')).toEqual(['hello']);
    });
});

// ─── lcsTable ───────────────────────────────────────────────────────

describe('lcsTable', () => {
    it('returns table with correct dimensions', () => {
        const a = ['a', 'b', 'c'];
        const b = ['b', 'c', 'd'];
        const dp = lcsTable(a, b);
        expect(dp.length).toBe(4);
        expect(dp[0].length).toBe(4);
    });

    it('computes correct LCS length', () => {
        const a = ['a', 'b', 'c'];
        const b = ['b', 'c', 'd'];
        const dp = lcsTable(a, b);
        expect(dp[3][3]).toBe(2); // LCS is "b", "c"
    });

    it('handles empty arrays', () => {
        const dp = lcsTable([], []);
        expect(dp.length).toBe(1);
        expect(dp[0][0]).toBe(0);
    });

    it('handles one empty array', () => {
        const dp = lcsTable(['a', 'b'], []);
        expect(dp[2][0]).toBe(0);
    });

    it('uses Uint32Array to avoid overflow on large inputs', () => {
        const a = ['x', 'y'];
        const b = ['y', 'z'];
        const dp = lcsTable(a, b);
        expect(dp[0]).toBeInstanceOf(Uint32Array);
    });

    it('Uint32Array can store values above Uint16 max (65535)', () => {
        const dp = lcsTable(['a'], ['a']);
        dp[1][1] = 70000;
        expect(dp[1][1]).toBe(70000);
    });
});

// ─── computeWordDiff ────────────────────────────────────────────────

describe('computeWordDiff', () => {
    it('returns equal segments for identical text', () => {
        const diff = computeWordDiff('hello world', 'hello world');
        const types = diff.map(d => d.type);
        expect(types.every(t => t === 'equal')).toBe(true);
        expect(diff.map(d => d.text).join('')).toBe('hello world');
    });

    it('detects single word replacement', () => {
        const diff = computeWordDiff('the cat sat', 'the dog sat');
        const deleted = diff.filter(d => d.type === 'delete');
        const inserted = diff.filter(d => d.type === 'insert');
        expect(deleted.length).toBe(1);
        expect(deleted[0].text).toBe('cat');
        expect(inserted.length).toBe(1);
        expect(inserted[0].text).toBe('dog');
    });

    it('detects insertion', () => {
        const diff = computeWordDiff('a b', 'a c b');
        const inserted = diff.filter(d => d.type === 'insert');
        expect(inserted.some(d => d.text.includes('c'))).toBe(true);
    });

    it('detects deletion', () => {
        const diff = computeWordDiff('a b c', 'a c');
        const deleted = diff.filter(d => d.type === 'delete');
        expect(deleted.some(d => d.text.includes('b'))).toBe(true);
    });

    it('handles completely different text', () => {
        const diff = computeWordDiff('alpha beta', 'gamma delta');
        const deleted = diff.filter(d => d.type === 'delete');
        const inserted = diff.filter(d => d.type === 'insert');
        expect(deleted.length).toBeGreaterThan(0);
        expect(inserted.length).toBeGreaterThan(0);
    });

    it('handles empty original', () => {
        const diff = computeWordDiff('', 'new text');
        expect(diff.every(d => d.type === 'insert')).toBe(true);
    });

    it('handles empty refined', () => {
        const diff = computeWordDiff('old text', '');
        expect(diff.every(d => d.type === 'delete')).toBe(true);
    });

    it('merges consecutive segments of the same type', () => {
        const diff = computeWordDiff('a b c', 'x y z');
        for (let i = 1; i < diff.length; i++) {
            if (diff[i].type !== 'equal') {
                expect(diff[i].type).not.toBe(diff[i - 1].type);
            }
        }
    });
});
