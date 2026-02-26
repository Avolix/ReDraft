/**
 * ReDraft — SillyTavern Message Refinement Extension
 *
 * Refines completed AI messages by sending them (with quality rules)
 * to an LLM. Supports two modes:
 *   - "st" mode: Uses SillyTavern's built-in generateRaw() (no plugin needed)
 *   - "plugin" mode: Proxies through a server plugin to a separate LLM
 */

import {
    getPluginBaseUrl as _getPluginBaseUrl,
    compileRules as _compileRules,
    stripProtectedBlocks,
    restoreProtectedBlocks,
    parseChangelog,
    detectPov,
    tokenize,
    lcsTable,
    computeWordDiff,
} from './lib/text-utils.js';

const MODULE_NAME = 'redraft';
const LOG_PREFIX = '[ReDraft]';
/** Extension version (semver). Bump when releasing client/UI changes. */
const EXTENSION_VERSION = '2.2';

/**
 * Base URL path for the ReDraft server plugin API. Thin adapter over the
 * pure implementation in lib/text-utils.js.
 */
function getPluginBaseUrl() {
    const pathname = (typeof window !== 'undefined' && window.location)
        ? window.location.pathname
        : undefined;
    return _getPluginBaseUrl(pathname);
}


// ─── Default Settings ───────────────────────────────────────────────

const defaultSettings = Object.freeze({
    enabled: true,
    autoRefine: false,
    userEnhanceEnabled: true,
    userAutoEnhance: false,
    userEnhanceMode: 'post', // 'pre' (intercept before generation) or 'post' (enhance after render)
    userSystemPrompt: '',
    userBuiltInRules: {
        grammar: true,
        personaVoice: true,
        prose: true,
        formatting: true,
        sceneContinuity: false,
        expandBrevity: false,
    },
    userCustomRules: [],
    connectionMode: 'st', // 'st' or 'plugin'
    builtInRules: {
        grammar: true,
        echo: true,
        repetition: true,
        voice: true,
        prose: true,
        formatting: true,
        ending: false,   // opinionated — off by default
        lore: false,     // needs rich character context
    },
    customRules: [],
    systemPrompt: '',
    showDiffAfterRefine: true,
    pov: 'auto', // 'auto' | 'detect' | '1st' | '1.5' | '2nd' | '3rd'
    hasSeenHint: false,
    characterContextChars: 500,
    previousResponseTailChars: 200,
    protectFontTags: false,
    notificationSoundEnabled: false,
    notificationSoundUrl: '', // '' = built-in beep; or URL / data URL for custom
});

const POV_LABELS = {
    auto: 'Auto (no instruction)',
    detect: 'Detect from message',
    '1st': '1st person (I/me)',
    '1.5': '1.5th person (I + you)',
    '2nd': '2nd person (you)',
    '3rd': '3rd person (he/she/they)',
};

const POV_INSTRUCTIONS = {
    '1st': 'PERSPECTIVE RULES (MANDATORY): "I/me/my" = the AI narrator character ONLY. "you/your" = the player\'s character ONLY. All other characters = "he/she/they." These assignments are absolute \u2014 do not swap, mix, or shift them. If any pronoun violates this map, fix it.',
    '1.5': 'PERSPECTIVE RULES (MANDATORY): "I/me/my" = the current POV AI character. "you/your" = the player\'s character \u2014 ALWAYS in descriptions and actions, no exceptions. All other AI characters = "he/she/they." Do not use "I" for the player\'s character under any circumstance. Do not use "he/she/they" for the player\'s character in descriptions or actions \u2014 always "you/your." If any pronoun violates this map, fix it.',
    '2nd': 'PERSPECTIVE RULES (MANDATORY): "you/your" = the player\'s character ONLY \u2014 all narration addresses them as "you." All AI characters = "he/she/they" in narration (dialogue may use "I"). No AI character uses "I" in narrative voice. If any pronoun violates this map, fix it.',
    '3rd': 'PERSPECTIVE RULES (MANDATORY): ALL characters (including the player\'s character) use "he/she/they" + names. No "I" in narration. No "you" in narration. If any pronoun violates this map, fix it.',
};

const BUILTIN_RULES = {
    grammar: {
        label: 'Fix grammar & spelling',
        prompt: 'Fix grammatical errors, spelling mistakes, and awkward phrasing. Do not alter intentional dialect, slang, verbal tics, or character-specific speech patterns \u2014 only correct genuine errors. Preserve intentional sentence fragments used for rhythm or voice.',
    },
    echo: {
        label: 'Remove echo & restatement',
        prompt: 'Using the "Last user message" from context above, scan for sentences where the character restates, paraphrases, or references the user\'s previous message instead of advancing the scene.\n\nBANNED patterns \u2014 if the sentence matches, cut and replace with forward motion:\n1. Character speaks ABOUT what user said/did (any tense): "You\'re asking me to..." / "You said..." / "You want me to..."\n2. "That/this" referring to user\'s input: "That\'s not what you..." / "This is about..."\n3. Reframing: "Not [user\'s word] \u2014 [character\'s word]." / "In other words..."\n4. Processing narration: "Your words [verb]..." (hung, landed, settled) / Character processing what user said / Italicized replays of user\'s dialogue as character thought.\n\nCheck the WHOLE response, not just the opening. Replace cut content with character action \u2014 what they do next, not what they think about what was said. One-word acknowledgment permitted ("Yeah." / nod), then forward.',
    },
    repetition: {
        label: 'Reduce repetition',
        prompt: 'Using the "Previous response ending" from context above, scan for repetitive elements within this response AND compared to the previous response:\n1. Repeated physical actions: Same gesture appearing twice+ (crossing arms, sighing, looking away). Replace the second instance with a different physical expression.\n2. Repeated sentence structures: Same openings, same punctuation patterns, same metaphor family used twice+.\n3. Repeated emotional beats: Character hitting the same note twice without progression. If angry twice, the second should be a different texture.\n\nDo NOT remove intentional repetition for rhetorical effect (anaphora, callbacks, echoed dialogue). Only flag mechanical/unconscious repetition.',
    },
    voice: {
        label: 'Maintain character voice',
        prompt: 'Using the "Character" context provided above, verify each character\'s dialogue is distinct and consistent:\n1. Speech patterns: If a character uses contractions, slang, verbal tics, or specific vocabulary \u2014 preserve them. Do not polish rough speech into grammatically correct prose.\n2. Voice flattening: If multiple characters speak, their dialogue should sound different. Flag if all characters use the same register or vocabulary level.\n3. Register consistency: A casual character shouldn\'t suddenly become eloquent mid-scene (unless that shift IS the point).\n\nDo not homogenize dialogue. A character\'s voice is more important than technically "correct" writing.',
    },
    prose: {
        label: 'Clean up prose',
        prompt: 'Scan for common AI prose weaknesses. Per issue found, make the minimum surgical fix:\n1. Somatic clich\u00e9s: "breath hitched/caught," "heart skipped/clenched," "stomach dropped/tightened," "shiver down spine." Replace with plain statement or specific physical detail.\n2. Purple prose: "Velvety voice," "liquid tone," "fluid grace," "pregnant pause," cosmic melodrama. Replace with concrete, grounded language.\n3. Filter words: "She noticed," "he felt," "she realized." Cut the filter \u2014 go direct.\n4. Telling over showing: "She felt sad" / "He was angry." Replace with embodied reactions ONLY if the telling is genuinely weaker.\n\nDo NOT over-edit. If prose is functional and voice-consistent, leave it alone. This rule targets clear weaknesses, not style preferences.',
    },
    formatting: {
        label: 'Fix formatting',
        prompt: 'Ensure consistent formatting within the response\'s existing convention:\n1. Fix orphaned formatting marks (unclosed asterisks, mismatched quotes, broken tags)\n2. Fix inconsistent style (mixing *asterisks* and _underscores_ for the same purpose)\n3. Ensure dialogue punctuation is consistent with the established convention\n\nDo not change the author\'s chosen formatting convention \u2014 only correct errors within it.',
    },
    ending: {
        label: 'Fix crafted endings',
        prompt: 'Check if the response ends with a "dismount" \u2014 a crafted landing designed to feel like an ending rather than a mid-scene pause.\n\nDISMOUNT patterns to fix:\n1. Dialogue payload followed by physical stillness: "Her thumb rested on his pulse." \u2014 body part + state verb + location as final beat.\n2. Fragment clusters placed after dialogue for weight: "One beat." / "Counting." / "Still."\n3. Summary narration re-describing the emotional state of the scene.\n4. Poetic/philosophical final line \u2014 theatrical closing statements.\n5. Double dismount: two landing constructions stacked.\n\nFIX: Find the last line of dialogue or action with unresolved consequences. Cut everything after it. If the response has no dialogue (pure narration/action), find the last action with unresolved consequences and cut any stillness or summary after it. The response should end mid-scene.\n\nEXCEPTION: If the scene is genuinely concluding (location change, time skip, departure), one clean landing beat is permitted.',
    },
    lore: {
        label: 'Maintain lore consistency',
        prompt: 'Using the "Character" context provided above, flag only glaring contradictions with established character/world information. Examples: wrong eye color, wrong relationship status, referencing events that didn\'t happen, contradicting established abilities.\n\nDo not invent new lore. When uncertain, preserve the original phrasing rather than "correcting" it. Minor ambiguities are not errors.',
    },
};

const BUILTIN_USER_RULES = {
    grammar: {
        label: 'Fix grammar & spelling',
        prompt: 'Fix grammatical errors, spelling mistakes, and awkward phrasing. Preserve intentional dialect, slang, verbal tics, and character-specific speech patterns — only correct genuine errors. The user wrote this message in character; do not "correct" deliberate voice choices.',
    },
    personaVoice: {
        label: 'Match persona voice',
        prompt: 'Using the "Your character" context provided above, ensure the message\'s dialogue and narration match the user\'s character persona:\n1. Speech register: If the persona is casual, don\'t polish into formal prose. If the persona is eloquent, don\'t simplify.\n2. Vocabulary: Use words and expressions consistent with the character\'s background, education, and personality.\n3. Verbal tics and patterns: If the persona has established speech habits (contractions, sentence fragments, specific phrases), lean into them.\n4. Emotional expression: Match how this character would express the emotion — stoic characters understate, dramatic characters amplify.\n\nDo not invent new personality traits. Work with what the persona description establishes.',
    },
    prose: {
        label: 'Improve prose',
        prompt: 'Improve the user\'s prose while preserving their intent and meaning:\n1. Awkward phrasing: Smooth out clunky sentence constructions without changing the meaning.\n2. Vague descriptions: Where the user wrote something generic ("looked around the room"), suggest a more specific or vivid alternative that fits the scene.\n3. Passive voice: Convert unnecessary passive constructions to active voice when it improves clarity.\n4. Redundancy: Cut redundant phrases ("nodded his head," "shrugged her shoulders") to the cleaner form.\n\nDo NOT over-embellish. The user\'s brevity may be intentional. Improve clarity and vividness, not word count.',
    },
    formatting: {
        label: 'Fix formatting',
        prompt: 'Ensure consistent formatting within the message:\n1. Fix orphaned formatting marks (unclosed asterisks, mismatched quotes)\n2. Ensure consistent convention: *asterisks for actions/narration*, "quotes for dialogue" (or whatever convention the user established)\n3. Fix dialogue punctuation errors\n4. Ensure paragraph breaks are placed sensibly\n\nDo not change the user\'s chosen convention — only correct errors within it.',
    },
    sceneContinuity: {
        label: 'Check scene continuity',
        prompt: 'Using the "Last response" context provided above, check that the user\'s message is consistent with the established scene:\n1. Spatial continuity: If the last response placed characters in a specific location or position, does the user\'s action make physical sense?\n2. Object continuity: If the user references an object, was it established in the scene?\n3. Conversational continuity: If the user\'s dialogue responds to something, does it match what was actually said?\n\nOnly flag clear contradictions. Ambiguity is fine — the user may be intentionally advancing the scene. Fix only outright impossibilities.',
    },
    expandBrevity: {
        label: 'Expand brief messages',
        prompt: 'If the user\'s message is very brief (1-2 short sentences), expand it into a richer scene contribution while preserving the exact intent:\n1. Add sensory detail: What does the character see, hear, feel in this moment?\n2. Add body language: How does the character physically express the action or emotion?\n3. Add interiority: A brief thought or reaction that reveals character.\n\nIMPORTANT: Do NOT change the user\'s actions, dialogue, or decisions. Only add texture around what they wrote. If the message is already substantial (3+ sentences with detail), leave it as-is.',
    },
};

const DEFAULT_SYSTEM_PROMPT = `You are a roleplay prose editor. You refine AI-generated roleplay messages by applying specific rules while preserving the author's creative intent.

Core principles:
- Preserve the original meaning, narrative direction, and emotional tone
- Preserve the original paragraph structure and sequence of events \u2014 do not reorder content, merge paragraphs, or restructure the narrative flow
- Edits are surgical: change the minimum necessary to satisfy the active rules. Fix the violating sentence, not the paragraph around it
- Keep approximately the same length unless a rule specifically calls for cuts
- Do not add new story elements, actions, or dialogue not present in the original
- Do not censor, sanitize, or tone down content \u2014 the original's maturity level is intentional
- Maintain existing formatting conventions (e.g. *asterisks for actions*, "quotes for dialogue")
- Treat each character as a distinct voice \u2014 do not flatten dialogue into a single register
- When rules conflict, character voice and narrative intent take priority over technical polish

Output format (MANDATORY \u2014 always follow this structure):
1. First, output a changelog inside [CHANGELOG]...[/CHANGELOG] tags listing each change you made and which rule motivated it. One line per change. If a rule required no changes, omit it.
2. Then output the full refined message inside [REFINED]...[/REFINED] tags with no other commentary.

Example:
[CHANGELOG]
- Grammar: Fixed \"their\" \u2192 \"they're\" in paragraph 2
- Repetition: Replaced 3rd use of \"softly\" with \"gently\"
[/CHANGELOG]
[REFINED]
(refined message here)
[/REFINED]

Do NOT output any analysis, reasoning, or commentary outside the tags. Only output the two tagged blocks.

You will be given the original message, a set of refinement rules to apply, and optionally context about the characters and recent conversation. Apply the rules faithfully.`;

const DEFAULT_USER_ENHANCE_SYSTEM_PROMPT = `You are a roleplay writing assistant. You enhance user-written roleplay messages by fixing grammar, improving prose, and ensuring the writing matches the user's character persona.

Core principles:
- Fix grammar, spelling, and punctuation errors
- Preserve the user's creative intent, actions, dialogue content, and story direction exactly
- Match the user's character voice and persona — their speech patterns, vocabulary, and personality
- Keep approximately the same length unless a rule specifically calls for cuts
- Do not add new story elements, actions, or dialogue not present in the original
- Do not change the meaning, emotional tone, or direction of what the user wrote
- Do not censor, sanitize, or tone down content — the original's maturity level is intentional
- Maintain existing formatting conventions (e.g. *asterisks for actions*, "quotes for dialogue")
- Enhance prose quality while keeping the user's style — fix awkward phrasing, improve flow
- Ensure consistency with the user's character persona and established lore
- The user wrote this message as their character — treat every line as intentional role-playing

Output format (MANDATORY — always follow this structure):
1. First, output a changelog inside [CHANGELOG]...[/CHANGELOG] tags listing each change you made and which rule motivated it. One line per change. If a rule required no changes, omit it.
2. Then output the full enhanced message inside [REFINED]...[/REFINED] tags with no other commentary.

Example:
[CHANGELOG]
- Grammar: Fixed "their" → "they're" in paragraph 2
- Voice: Adjusted phrasing to match character's casual speech pattern
[/CHANGELOG]
[REFINED]
(enhanced message here)
[/REFINED]

Do NOT output any analysis, reasoning, or commentary outside the tags. Only output the two tagged blocks.

You will be given the original message, a set of enhancement rules to apply, and context about the user's character persona and the scene. Apply the rules faithfully.`;

/**
 * Retrieve the user's persona description from SillyTavern.
 * Tries the power_user global first (most reliable), then falls back to DOM.
 */
function getUserPersonaDescription() {
    try {
        if (typeof power_user !== 'undefined' && power_user?.persona_description) {
            return power_user.persona_description;
        }
    } catch { /* not available */ }

    const el = document.getElementById('persona_description');
    if (el?.value) return el.value;

    return '';
}

// ─── State ──────────────────────────────────────────────────────────

let isRefining = false; // Re-entrancy guard
let pluginAvailable = false; // Whether server plugin is reachable
let eventListenerRefs = {}; // For cleanup
let _popoutOutsideClickRef = null; // Ref to the click-outside listener for cleanup

/**
 * Hide the popout panel and clean up the click-outside listener.
 * All code paths that close the popout should call this.
 */
function hidePopout() {
    const panel = document.getElementById('redraft_popout_panel');
    if (panel) panel.style.display = 'none';
    if (_popoutOutsideClickRef) {
        document.removeEventListener('pointerdown', _popoutOutsideClickRef, true);
        _popoutOutsideClickRef = null;
    }
}

// Global keydown handler for ESC
function onGlobalKeydown(e) {
    if (e.key !== 'Escape') return;
    // Close diff popup first (higher z-index)
    const diffOverlay = document.getElementById('redraft_diff_overlay');
    if (diffOverlay) { closeDiffPopup(); return; }
    // Then close popout
    const popout = document.getElementById('redraft_popout_panel');
    if (popout && popout.style.display !== 'none') { hidePopout(); }
}
document.addEventListener('keydown', onGlobalKeydown);

// ─── Helpers ────────────────────────────────────────────────────────

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const { lodash } = SillyTavern.libs;
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    } else {
        extensionSettings[MODULE_NAME] = lodash.merge(
            structuredClone(defaultSettings),
            extensionSettings[MODULE_NAME],
        );
    }
    return extensionSettings[MODULE_NAME];
}

function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

/**
 * Compile active rules into a numbered list string.
 * Delegates to lib/text-utils.js and adds debug logging.
 */
function compileRules(settings) {
    for (const key of Object.keys(BUILTIN_RULES)) {
        console.debug(`${LOG_PREFIX} [rules] Built-in ${settings.builtInRules[key] ? 'ON' : 'OFF'}: ${key}`);
    }
    for (let i = 0; i < settings.customRules.length; i++) {
        const rule = settings.customRules[i];
        if (rule.enabled && rule.text && rule.text.trim()) {
            console.debug(`${LOG_PREFIX} [rules] Custom #${i} ON: "${rule.text.trim().substring(0, 80)}${rule.text.trim().length > 80 ? '…' : ''}"`);
        } else {
            console.debug(`${LOG_PREFIX} [rules] Custom #${i} SKIPPED (enabled=${rule.enabled}, text=${JSON.stringify(rule.text?.substring?.(0, 40) || rule.text)})`);
        }
    }
    const compiled = _compileRules(settings, BUILTIN_RULES);
    console.debug(`${LOG_PREFIX} [rules] Compiled rules`);
    return compiled;
}

/**
 * Compile active user-enhance rules into a numbered list string.
 * Delegates to lib/text-utils.js and adds debug logging.
 */
function compileUserRules(settings) {
    for (const key of Object.keys(BUILTIN_USER_RULES)) {
        const enabled = settings.userBuiltInRules?.[key];
        console.debug(`${LOG_PREFIX} [user-rules] Built-in ${enabled ? 'ON' : 'OFF'}: ${key}`);
    }
    const customList = settings.userCustomRules || [];
    for (let i = 0; i < customList.length; i++) {
        const rule = customList[i];
        if (rule.enabled && rule.text && rule.text.trim()) {
            console.debug(`${LOG_PREFIX} [user-rules] Custom #${i} ON: "${rule.text.trim().substring(0, 80)}${rule.text.trim().length > 80 ? '…' : ''}"`);
        } else {
            console.debug(`${LOG_PREFIX} [user-rules] Custom #${i} SKIPPED (enabled=${rule.enabled}, text=${JSON.stringify(rule.text?.substring?.(0, 40) || rule.text)})`);
        }
    }
    const compiled = _compileRules(settings, BUILTIN_USER_RULES, {
        enabledMap: 'userBuiltInRules',
        customKey: 'userCustomRules',
    });
    console.debug(`${LOG_PREFIX} [user-rules] Compiled user rules`);
    return compiled;
}

// stripProtectedBlocks, restoreProtectedBlocks, parseChangelog, detectPov
// are imported from ./lib/text-utils.js

/**
 * Play the notification sound when refinement finishes.
 * Uses built-in beep (Web Audio) if no custom URL is set; otherwise plays the configured URL or uploaded sound.
 */
function playNotificationSound() {
    const settings = getSettings();
    if (!settings.notificationSoundEnabled) return;

    try {
        const url = (settings.notificationSoundUrl || '').trim();
        if (url) {
            const audio = new Audio(url);
            audio.volume = 0.6;
            audio.play().catch(() => { /* autoplay / policy blocked */ });
            return;
        }

        // Built-in short beep via Web Audio
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gain.gain.setValueAtTime(0.12, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.12);
    } catch {
        // Ignore (e.g. AudioContext not allowed, invalid URL)
    }
}

/**
 * Call the server plugin API.
 * Uses ST's request headers (including CSRF token) and sends credentials (cookies) so
 * multi-user instances treat the request as the current user and don't return a login page.
 * Handles HTML responses (e.g. 404/login pages) with a clear error instead of "is not valid JSON".
 */
async function pluginRequest(endpoint, method = 'GET', body = null) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const options = {
        method,
        credentials: 'same-origin', // send cookies so auth/session is sent on multi-user instances
        headers: getRequestHeaders ? getRequestHeaders() : { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    const base = getPluginBaseUrl();
    const url = `${base}${endpoint}`;
    const response = await fetch(url, options);
    const text = await response.text();

    let data;
    try {
        data = text ? JSON.parse(text) : null;
    } catch {
        const trimmed = (text || '').trim();
        if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
            const fullUrl = typeof window !== 'undefined' && window.location
                ? new URL(url, window.location.origin).href
                : url;
            const isLocalhost = typeof window !== 'undefined' && window.location &&
                /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(window.location.origin);
            let hint = '';
            if (response.status === 502) {
                hint = ' 502 Bad Gateway — your reverse proxy may have timed out before ST could respond. Check the SillyTavern terminal for the real error. If you use Caddy/nginx, increase the proxy timeout to at least 90s.';
            } else if (response.status === 401 || response.status === 403 || response.redirected) {
                hint = ' The server returned a login/auth page — refresh the page and try again. On multi-user instances, your session may have expired.';
            } else if (response.status === 404) {
                hint = ' The plugin endpoint was not found — the server plugin may not be installed or ST needs a restart.';
            }
            throw new Error(
                `Server returned a web page instead of JSON.` + hint +
                (isLocalhost
                    ? ' On localhost, if the plugin is not installed, run the installer and restart ST.'
                    : '')
            );
        }
        throw new Error(`Invalid response from server: ${trimmed.slice(0, 80)}${trimmed.length > 80 ? '…' : ''}`);
    }

    if (!response.ok) {
        throw new Error(data?.error || `Server returned ${response.status}`);
    }
    return data;
}

// ─── Plugin Status ──────────────────────────────────────────────────

function updateVersionDisplay(status) {
    const el = document.getElementById('redraft_server_plugin_version');
    if (el) el.textContent = (status && status.version) ? status.version : '—';
}

async function checkPluginStatus() {
    try {
        const status = await pluginRequest('/status');
        pluginAvailable = true;
        updateStatusDot(status.configured);
        updateConnectionInfo(status);
        updatePluginBanner();
        updateConnectionModeUI();
        populatePluginFields(status);
        updateVersionDisplay(status);
        return status;
    } catch {
        pluginAvailable = false;
        updateStatusDot(false, true);
        updateConnectionInfo(null);
        updatePluginBanner();
        updateConnectionModeUI();
        updateVersionDisplay(null);
        return null;
    }
}

/**
 * Populate the connection fields from saved plugin config (URL, model, masked key).
 * The API key field shows a placeholder when a key is already saved so the user
 * doesn't have to re-enter it just to change the model.
 */
function populatePluginFields(status) {
    if (!status?.configured) return;

    const urlField = document.getElementById('redraft_api_url');
    const modelField = document.getElementById('redraft_model');
    const keyField = document.getElementById('redraft_api_key');

    if (urlField && status.apiUrl && !urlField.value) {
        urlField.value = status.apiUrl;
    }
    if (modelField && status.model && !modelField.value) {
        modelField.value = status.model;
    }
    if (keyField && status.maskedKey && !keyField.value) {
        keyField.placeholder = `Saved (${status.maskedKey}) — leave blank to keep`;
    }
}

function updateStatusDot(configured, error = false) {
    const dot = document.getElementById('redraft_status_dot');
    if (!dot) return;
    const settings = getSettings();

    dot.classList.remove('connected', 'error');

    if (settings.connectionMode === 'st') {
        dot.classList.add('connected');
        dot.title = 'Using ST connection';
    } else if (error || !pluginAvailable) {
        dot.classList.add('error');
        dot.title = 'Server plugin unavailable';
    } else if (configured) {
        dot.classList.add('connected');
        dot.title = 'Connected';
    } else {
        dot.title = 'Not configured';
    }
}

function updateConnectionInfo(status) {
    const info = document.getElementById('redraft_connection_info');
    if (!info) return;
    if (!pluginAvailable) {
        info.textContent = 'Plugin unavailable';
        info.title = 'Install the server plugin and restart SillyTavern';
    } else if (status?.configured) {
        info.textContent = `\u2713 ${status.model} (${status.maskedKey})`;
        info.title = 'Connection ready for refinement';
    } else {
        info.textContent = 'Not configured \u2014 save credentials above';
        info.title = 'Enter API URL, Key, and Model, then click Save Connection';
    }
}

function updatePluginBanner() {
    const banner = document.getElementById('redraft_plugin_banner');
    if (!banner) return;
    const settings = getSettings();

    // Show banner if in ST mode and plugin is not available
    if (settings.connectionMode === 'st' && !pluginAvailable) {
        banner.style.display = '';
    } else {
        banner.style.display = 'none';
    }
}

const INSTALL_DOC_URL = 'https://github.com/MeowCatboyMeow/ReDraft/blob/main/INSTALL_PLUGIN.md';

function updateConnectionModeUI() {
    const settings = getSettings();
    const pluginFields = document.getElementById('redraft_plugin_fields');
    const stModeInfo = document.getElementById('redraft_st_mode_info');
    const modeHint = document.getElementById('redraft_connection_mode_hint');
    const pluginUnavailableBlock = document.getElementById('redraft_plugin_unavailable_block');

    const isPluginMode = settings.connectionMode === 'plugin';

    if (pluginFields) {
        pluginFields.style.display = isPluginMode ? '' : 'none';
    }
    if (stModeInfo) {
        stModeInfo.style.display = settings.connectionMode === 'st' ? '' : 'none';
    }
    if (modeHint) {
        modeHint.style.display = isPluginMode ? '' : 'none';
    }
    const multiuserHint = document.getElementById('redraft_multiuser_hint');
    if (multiuserHint) {
        multiuserHint.style.display = isPluginMode ? '' : 'none';
    }
    if (pluginUnavailableBlock) {
        pluginUnavailableBlock.style.display = isPluginMode && !pluginAvailable ? '' : 'none';
    }

    // Status dot is updated by checkPluginStatus; only update for ST mode when switching
    if (settings.connectionMode === 'st') {
        updateStatusDot(true);
    }
    updatePluginBanner();
}

/**
 * Show/hide the post-send options and hint based on the enhancement mode.
 * @param {string} mode - 'pre' or 'post'
 */
function updateEnhanceModeUI(mode) {
    const postSendOptions = document.getElementById('redraft_post_send_options');
    const modeHint = document.getElementById('redraft_enhance_mode_hint');

    if (postSendOptions) {
        postSendOptions.style.display = mode === 'post' ? '' : 'none';
    }
    if (modeHint) {
        if (mode === 'pre') {
            modeHint.textContent = 'Your message will be enhanced before the AI sees it. Adds 2\u201310s before generation starts (use a fast model to minimize delay). Messages under 20 characters are sent as-is.';
            modeHint.style.display = '';
        } else {
            modeHint.textContent = '';
            modeHint.style.display = 'none';
        }
    }
}

// ─── Core Refinement (Dual-Mode) ────────────────────────────────────

/**
 * Send refinement request via ST's generateRaw().
 */
async function refineViaST(promptText, systemPrompt) {
    const { generateRaw } = SillyTavern.getContext();
    if (typeof generateRaw !== 'function') {
        throw new Error('generateRaw is not available in this version of SillyTavern');
    }

    const result = await generateRaw({ prompt: promptText, systemPrompt: systemPrompt });

    if (!result || typeof result !== 'string' || !result.trim()) {
        throw new Error('ST generated an empty response');
    }

    return result.trim();
}

/**
 * Send refinement request via server plugin.
 */
async function refineViaPlugin(promptText, systemPrompt) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText },
    ];

    const result = await pluginRequest('/refine', 'POST', { messages });

    if (!result.text || !result.text.trim()) {
        throw new Error('Plugin returned an empty response');
    }

    return result.text.trim();
}

/**
 * Refine a message at the given index.
 * @param {number} messageIndex Index in context.chat
 */
async function redraftMessage(messageIndex) {
    if (isRefining) {
        console.debug(`${LOG_PREFIX} Already refining, skipping`);
        return;
    }

    const context = SillyTavern.getContext();
    const { chat, saveChat, chatMetadata, saveMetadata } = context;

    if (!chat || messageIndex < 0 || messageIndex >= chat.length) {
        toastr.error('Invalid message index', 'ReDraft');
        return;
    }

    const message = chat[messageIndex];
    if (!message || !message.mes) {
        toastr.error('Message has no text content', 'ReDraft');
        return;
    }

    const settings = getSettings();
    let refineSucceeded = false;

    // Check if plugin mode is selected but plugin is unavailable
    if (settings.connectionMode === 'plugin' && !pluginAvailable) {
        toastr.error(
            'ReDraft server plugin is not available. Install it once (see Install server plugin in ReDraft settings), then restart SillyTavern.',
            'ReDraft',
            { timeOut: 8000 }
        );
        return;
    }

    // Set re-entrancy guard and start timer for floating-button display
    isRefining = true;
    const refineStartTime = Date.now();
    setPopoutTriggerLoading(true);

    // Clean up stale undo/diff buttons from prior refinement of this message
    // (fixes compare showing wrong diff after swiping in auto mode)
    hideUndoButton(messageIndex);
    hideDiffButton(messageIndex);

    // Show loading state on the message button + toast
    const isUserMessage = !!message.is_user;
    setMessageButtonLoading(messageIndex, true);
    toastr.info(isUserMessage ? 'Enhancing message\u2026' : 'Refining message\u2026', 'ReDraft');

    try {
        // Save original to chatMetadata for undo
        if (!chatMetadata['redraft_originals']) {
            chatMetadata['redraft_originals'] = {};
        }
        chatMetadata['redraft_originals'][messageIndex] = message.mes;
        await saveMetadata();

        // Strip structured content (code fences, HTML, bracket blocks, optionally font tags) before sending to LLM
        const { stripped: strippedMessage, blocks: protectedBlocks } = stripProtectedBlocks(message.mes, {
            protectFontTags: settings.protectFontTags,
        });

        // Build the refinement prompt — user messages get their own rule set
        const rulesText = isUserMessage ? compileUserRules(settings) : compileRules(settings);

        // Gather context for the LLM — different framing for user vs AI messages
        const contextParts = [];
        const char = context.characters?.[context.characterId];
        const charLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
        const charDesc = char?.data?.personality
            || char?.data?.description?.substring(0, charLimit)
            || '';

        let systemPrompt;

        if (isUserMessage) {
            // ── User message enhancement ──
            systemPrompt = settings.userSystemPrompt?.trim() || DEFAULT_USER_ENHANCE_SYSTEM_PROMPT;

            // User's persona (the character they're writing as)
            const personaDesc = getUserPersonaDescription();
            const personaLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
            if (context.name1 || personaDesc) {
                const truncatedPersona = personaDesc ? personaDesc.substring(0, personaLimit) : '';
                contextParts.push(`Your character (who you are writing as): ${context.name1 || 'Unknown'}${truncatedPersona ? ' \u2014 ' + truncatedPersona : ''}`);
            }

            // The AI character they're interacting with (for lore/context)
            if (context.name2 || charDesc) {
                contextParts.push(`Character you are interacting with: ${context.name2 || 'Unknown'}${charDesc ? ' \u2014 ' + charDesc : ''}`);
            }

            // Previous AI response (for scene context)
            const prevAiMsg = [...chat.slice(0, messageIndex)].reverse().find(m => !m.is_user && m.mes);
            if (prevAiMsg) {
                const tailChars = Math.min(800, Math.max(50, settings.previousResponseTailChars ?? 200));
                contextParts.push(`Last response from ${context.name2 || 'the character'} (for scene context, last ~${tailChars} chars):\n${prevAiMsg.mes.slice(-tailChars)}`);
            }

            console.debug(`${LOG_PREFIX} Enhancing user message ${messageIndex} (persona: ${personaDesc ? personaDesc.length + ' chars' : 'none'})`);
        } else {
            // ── AI message refinement (existing behavior) ──
            systemPrompt = settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;

            if (context.name2 || charDesc) {
                contextParts.push(`Character: ${context.name2 || 'Unknown'}${charDesc ? ' \u2014 ' + charDesc : ''}`);
            }
            if (context.name1) {
                contextParts.push(`User character: ${context.name1}`);
            }

            // Last user message before this AI message (for echo detection)
            const messagesBeforeThis = chat.slice(0, messageIndex);
            const lastUserMsgBefore = [...messagesBeforeThis].reverse().find(m => m.is_user && m.mes);
            if (lastUserMsgBefore) {
                contextParts.push(`Last user message (what the user said before this response):\n${lastUserMsgBefore.mes}`);
            }

            // Previous AI response ending (for repetition detection)
            const prevAiMsgs = chat.filter((m, i) => !m.is_user && m.mes && i < messageIndex);
            if (prevAiMsgs.length > 0) {
                const tailChars = Math.min(800, Math.max(50, settings.previousResponseTailChars ?? 200));
                const prevTail = prevAiMsgs[prevAiMsgs.length - 1].mes.slice(-tailChars);
                contextParts.push(`Previous response ending (last ~${tailChars} chars):\n${prevTail}`);
            }
        }

        // Point of view instruction (applies to both user and AI messages)
        let povKey = settings.pov || 'auto';
        const wasAuto = povKey === 'auto';
        if (povKey === 'detect' || povKey === 'auto') {
            const detected = detectPov(strippedMessage);
            if (detected) {
                povKey = detected;
                console.debug(`${LOG_PREFIX} PoV ${wasAuto ? '(auto) ' : ''}detected: ${detected}`);
            } else if (povKey === 'detect') {
                povKey = 'auto';
            }
        }
        if (povKey !== 'auto' && POV_INSTRUCTIONS[povKey]) {
            contextParts.push(`Point of view: ${POV_INSTRUCTIONS[povKey]}`);
        }

        const contextBlock = contextParts.length > 0
            ? `Context:\n${contextParts.join('\n\n')}\n\n`
            : '';

        const actionVerb = isUserMessage ? 'enhancement' : 'refinement';
        const promptText = `${contextBlock}Apply the following ${actionVerb} rules to the message below. Any [PROTECTED_N] placeholders are protected regions — output them exactly as-is.

Remember: output [CHANGELOG]...[/CHANGELOG] first, then the ${isUserMessage ? 'enhanced' : 'refined'} message inside [REFINED]...[/REFINED]. No other text outside these tags.

Rules:\n${rulesText}\n\nOriginal message:\n${strippedMessage}`;

        console.debug(`${LOG_PREFIX} [prompt] System prompt (${systemPrompt.length} chars):`, systemPrompt.substring(0, 200) + '\u2026');
        console.debug(`${LOG_PREFIX} [prompt] Full ${actionVerb} prompt (${promptText.length} chars):`);
        console.debug(promptText);

        // Call refinement via the appropriate mode
        let refinedText;
        if (settings.connectionMode === 'plugin') {
            refinedText = await refineViaPlugin(promptText, systemPrompt);
        } else {
            refinedText = await refineViaST(promptText, systemPrompt);
        }

        // Parse changelog from response
        const { changelog, refined: cleanRefined } = parseChangelog(refinedText);
        if (changelog) {
            console.log(`${LOG_PREFIX} [changelog]`, changelog);
        }

        // Restore protected blocks and write refined text back
        refinedText = restoreProtectedBlocks(cleanRefined, protectedBlocks);
        const originalText = message.mes;
        message.mes = refinedText;
        await saveChat();

        // Re-render the message in the UI
        rerenderMessage(messageIndex);

        // Persist diff data so diff button can be restored on reload
        if (!chatMetadata['redraft_diffs']) chatMetadata['redraft_diffs'] = {};
        chatMetadata['redraft_diffs'][messageIndex] = { original: originalText, changelog: changelog || null };
        await saveMetadata();

        // Show undo + diff buttons
        showUndoButton(messageIndex);
        showDiffButton(messageIndex, originalText, refinedText, changelog);

        // Auto-show diff popup if toggle is on
        if (settings.showDiffAfterRefine) {
            showDiffPopup(originalText, refinedText, changelog);
        }

        toastr.success(isUserMessage ? 'Message enhanced' : 'Message refined', 'ReDraft');
        playNotificationSound();
        refineSucceeded = true;
        const refineMs = Date.now() - refineStartTime;
        setPopoutTriggerLoading(false, refineMs);
        console.log(`${LOG_PREFIX} Message ${messageIndex} refined successfully (mode: ${settings.connectionMode}) in ${(refineMs / 1000).toFixed(1)}s`);

    } catch (err) {
        console.error(`${LOG_PREFIX} Refinement failed:`, err.message);
        const msg = err.message || '';

        if (msg.includes('not configured') || msg.includes('Please set up API credentials')) {
            toastr.error(
                'ReDraft plugin isn\'t configured. In ReDraft settings, enter API URL, Key, and Model under Separate LLM, then click Save Connection.',
                'ReDraft',
                { timeOut: 8000 }
            );
        } else if (msg.includes('timed out')) {
            toastr.error(
                'Refinement timed out — the LLM took too long to respond. Try a shorter message, a faster model, or check your API provider\'s status page.',
                'ReDraft',
                { timeOut: 8000 }
            );
        } else if (msg.includes('returned 401') || msg.includes('Unauthorized')) {
            toastr.error(
                'API authentication failed (401). Your API key may be invalid or expired — check your key in ReDraft Connection settings.',
                'ReDraft',
                { timeOut: 8000 }
            );
        } else if (msg.includes('returned 402') || msg.includes('Payment Required') || msg.includes('insufficient')) {
            toastr.error(
                'API billing error (402). Your account may be out of credits — check your balance on your API provider\'s dashboard.',
                'ReDraft',
                { timeOut: 8000 }
            );
        } else if (msg.includes('returned 429') || msg.includes('rate limit') || msg.includes('Rate limit')) {
            toastr.error(
                'Rate limited by the API (429). Wait a moment and try again, or switch to a less busy model.',
                'ReDraft',
                { timeOut: 6000 }
            );
        } else if (msg.includes('returned 404')) {
            toastr.error(
                'Model or endpoint not found (404). Check that your model name and API URL are correct in ReDraft Connection settings.',
                'ReDraft',
                { timeOut: 8000 }
            );
        } else if (msg.includes('returned 503')) {
            toastr.error(
                'The API returned Service Unavailable (503). The model\'s backend is temporarily down — try again in a moment or switch to a different model.',
                'ReDraft',
                { timeOut: 8000 }
            );
        } else if (msg.includes('web page instead of JSON')) {
            toastr.error(
                'Server returned HTML instead of JSON. If you use a reverse proxy, check its timeout settings (need at least 90s). Otherwise check the SillyTavern terminal for errors.',
                'ReDraft',
                { timeOut: 10000 }
            );
        } else {
            toastr.error(msg || 'Refinement failed — check the browser console for details.', 'ReDraft', { timeOut: 8000 });
        }
    } finally {
        isRefining = false;
        setMessageButtonLoading(messageIndex, false);
        // Only clear loading here on failure; success path already called setPopoutTriggerLoading(false, refineMs)
        if (!refineSucceeded) {
            setPopoutTriggerLoading(false);
        }
    }
}

/**
 * Undo a refinement — restore original text.
 * @param {number} messageIndex
 */
async function undoRedraft(messageIndex) {
    const context = SillyTavern.getContext();
    const { chat, saveChat, chatMetadata, saveMetadata } = context;

    const originals = chatMetadata['redraft_originals'];
    if (!originals || !originals[messageIndex]) {
        toastr.warning('No original text to restore', 'ReDraft');
        return;
    }

    chat[messageIndex].mes = originals[messageIndex];
    delete originals[messageIndex];

    // Also clean up persisted diff data
    const diffs = chatMetadata['redraft_diffs'];
    if (diffs) delete diffs[messageIndex];

    await saveMetadata();
    await saveChat();
    rerenderMessage(messageIndex);
    hideUndoButton(messageIndex);
    hideDiffButton(messageIndex);

    toastr.info('Original message restored', 'ReDraft');
    console.log(`${LOG_PREFIX} Message ${messageIndex} restored`);
}

/**
 * Re-render a single message in the UI using ST's own updateMessageBlock.
 * Falls back to manual innerHTML update if the API is unavailable.
 */
function rerenderMessage(messageIndex) {
    const context = SillyTavern.getContext();
    if (!context.chat[messageIndex]) return;

    // Prefer ST's built-in updateMessageBlock — handles user vs AI, formatting, etc.
    if (typeof context.updateMessageBlock === 'function') {
        const mesElement = document.querySelector(`.mes[mesid="${messageIndex}"]`);
        if (mesElement) {
            context.updateMessageBlock(messageIndex, mesElement);
            return;
        }
    }

    // Fallback: manual re-render with correct isUser flag
    const mesBlock = document.querySelector(`.mes[mesid="${messageIndex}"] .mes_text`);
    if (mesBlock) {
        const msg = context.chat[messageIndex];
        const { messageFormatting } = context;
        if (typeof messageFormatting === 'function') {
            const isUser = !!msg.is_user;
            const isSystem = !!msg.is_system;
            mesBlock.innerHTML = messageFormatting(msg.mes, msg.name, isSystem, isUser, messageIndex);
        } else {
            mesBlock.textContent = msg.mes;
        }
    }
}

// ─── Per-Message Buttons ────────────────────────────────────────────

function addMessageButtons() {
    const settings = getSettings();

    document.querySelectorAll('.mes[is_system="false"]').forEach(mesEl => {
        const isUser = mesEl.getAttribute('is_user') === 'true';
        const mesId = parseInt(mesEl.getAttribute('mesid'), 10);
        const buttonsRow = mesEl.querySelector('.mes_buttons');
        if (!buttonsRow) return;

        if (isUser) {
            if (!settings.userEnhanceEnabled) return;
            if (buttonsRow.querySelector('.redraft-enhance-btn')) return;

            const btn = document.createElement('div');
            btn.classList.add('mes_button', 'redraft-enhance-btn');
            btn.title = 'Enhance (ReDraft)';
            btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
            btn.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
                redraftMessage(mesId);
            }, 500, { leading: true, trailing: false }));

            buttonsRow.prepend(btn);
        } else {
            if (buttonsRow.querySelector('.redraft-msg-btn')) return;

            const btn = document.createElement('div');
            btn.classList.add('mes_button', 'redraft-msg-btn');
            btn.title = 'ReDraft';
            btn.innerHTML = '<i class="fa-solid fa-pen-nib"></i>';
            btn.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
                redraftMessage(mesId);
            }, 500, { leading: true, trailing: false }));

            buttonsRow.prepend(btn);
        }
    });
}

function setMessageButtonLoading(messageIndex, loading) {
    const aiBtn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-msg-btn`);
    const userBtn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-enhance-btn`);
    const btn = aiBtn || userBtn;
    if (!btn) return;
    const isEnhance = btn.classList.contains('redraft-enhance-btn');
    if (loading) {
        btn.classList.add('redraft-loading');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    } else {
        btn.classList.remove('redraft-loading');
        btn.innerHTML = isEnhance
            ? '<i class="fa-solid fa-wand-magic-sparkles"></i>'
            : '<i class="fa-solid fa-pen-nib"></i>';
    }
}

let _triggerDurationTimeout = null;

function setPopoutTriggerLoading(loading, lastDurationMs) {
    const trigger = document.getElementById('redraft_popout_trigger');
    if (!trigger) return;
    if (loading) {
        if (_triggerDurationTimeout) {
            clearTimeout(_triggerDurationTimeout);
            _triggerDurationTimeout = null;
        }
        trigger.classList.add('redraft-refining');
        trigger.classList.remove('redraft-show-duration');
        trigger.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
    } else {
        trigger.classList.remove('redraft-refining');
        if (typeof lastDurationMs === 'number' && lastDurationMs >= 0) {
            const sec = lastDurationMs / 1000;
            const durationText = sec >= 10 ? `${Math.round(sec)}s` : sec % 1 === 0 ? `${sec}s` : `${sec.toFixed(1)}s`;
            trigger.classList.add('redraft-show-duration');
            trigger.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-trigger-duration">' + durationText + '</span><span class="redraft-auto-dot"></span>';
            trigger.title = `ReDraft — last refine: ${durationText}`;
            updatePopoutAutoState();
            if (_triggerDurationTimeout) clearTimeout(_triggerDurationTimeout);
            _triggerDurationTimeout = setTimeout(() => {
                _triggerDurationTimeout = null;
                const t = document.getElementById('redraft_popout_trigger');
                if (t && !t.classList.contains('redraft-refining')) {
                    t.classList.remove('redraft-show-duration');
                    t.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-auto-dot"></span>';
                    t.title = 'ReDraft';
                    updatePopoutAutoState();
                }
            }, 15000);
        } else {
            trigger.classList.remove('redraft-show-duration');
            trigger.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-auto-dot"></span>';
            trigger.title = 'ReDraft';
            updatePopoutAutoState();
        }
    }
}

function showUndoButton(messageIndex) {
    const mesEl = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!mesEl) return;
    const buttonsRow = mesEl.querySelector('.mes_buttons');
    if (!buttonsRow || buttonsRow.querySelector('.redraft-undo-btn')) return;

    const btn = document.createElement('div');
    btn.classList.add('mes_button', 'redraft-undo-btn');
    btn.title = 'Undo ReDraft';
    btn.innerHTML = '<i class="fa-solid fa-rotate-left"></i>';
    btn.addEventListener('click', () => undoRedraft(messageIndex));

    // Insert after the redraft button for consistent order: [refine] [undo] [diff]
    const refineBtn = buttonsRow.querySelector('.redraft-msg-btn');
    if (refineBtn) {
        refineBtn.after(btn);
    } else {
        buttonsRow.prepend(btn);
    }
}

function hideUndoButton(messageIndex) {
    const btn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-undo-btn`);
    if (btn) btn.remove();
}

function showDiffButton(messageIndex, originalText, refinedText, changelog = null) {
    const mesEl = document.querySelector(`.mes[mesid="${messageIndex}"]`);
    if (!mesEl) return;
    const buttonsRow = mesEl.querySelector('.mes_buttons');
    if (!buttonsRow || buttonsRow.querySelector('.redraft-diff-btn')) return;

    const btn = document.createElement('div');
    btn.classList.add('mes_button', 'redraft-diff-btn');
    btn.title = 'View ReDraft Changes';
    btn.innerHTML = '<i class="fa-solid fa-code-compare"></i>';
    btn.addEventListener('click', () => showDiffPopup(originalText, refinedText, changelog));

    // Insert after undo, or after refine, for consistent order: [refine] [undo] [diff]
    const undoBtn = buttonsRow.querySelector('.redraft-undo-btn');
    const refineBtn = buttonsRow.querySelector('.redraft-msg-btn');
    const anchor = undoBtn || refineBtn;
    if (anchor) {
        anchor.after(btn);
    } else {
        buttonsRow.prepend(btn);
    }
}

function hideDiffButton(messageIndex) {
    const btn = document.querySelector(`.mes[mesid="${messageIndex}"] .redraft-diff-btn`);
    if (btn) btn.remove();
}

// ─── Diff Engine ───────────────────────────────────────────────────────────
// tokenize, lcsTable, computeWordDiff are imported from ./lib/text-utils.js

/**
 * Show a diff popup comparing original vs refined text.
 */
function showDiffPopup(original, refined, changelog = null) {
    // Remove any existing popup
    closeDiffPopup();

    if (original === refined) {
        toastr.info('No changes were made', 'ReDraft');
        return;
    }

    const diff = computeWordDiff(original, refined);

    // Build diff HTML
    const { DOMPurify } = SillyTavern.libs;
    let diffHtml = '';
    for (const seg of diff) {
        const escaped = DOMPurify.sanitize(seg.text, { ALLOWED_TAGS: [] })
            .replace(/\n/g, '<br>');
        switch (seg.type) {
            case 'delete':
                diffHtml += `<span class="redraft-diff-del">${escaped}</span>`;
                break;
            case 'insert':
                diffHtml += `<span class="redraft-diff-ins">${escaped}</span>`;
                break;
            default:
                diffHtml += escaped;
        }
    }

    // Count changed words (not segments)
    const countWords = (segments, type) => segments
        .filter(s => s.type === type)
        .reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
    const delCount = countWords(diff, 'delete');
    const insCount = countWords(diff, 'insert');

    // Build changelog section if available
    let changelogHtml = '';
    if (changelog) {
        const sanitizedLog = DOMPurify.sanitize(changelog, { ALLOWED_TAGS: [] })
            .replace(/\n/g, '<br>');
        changelogHtml = `
            <details class="redraft-changelog">
                <summary class="redraft-changelog-summary">
                    <i class="fa-solid fa-clipboard-list"></i> Change Log
                </summary>
                <div class="redraft-changelog-body">${sanitizedLog}</div>
            </details>
        `;
    }

    const overlay = document.createElement('div');
    overlay.id = 'redraft_diff_overlay';
    overlay.classList.add('redraft-diff-overlay');
    overlay.innerHTML = `
        <div class="redraft-diff-panel">
            <div class="redraft-diff-header">
                <span class="redraft-diff-title">ReDraft Changes</span>
                <span class="redraft-diff-stats">
                    <span class="redraft-diff-stat-del">−${delCount}</span>
                    <span class="redraft-diff-stat-ins">+${insCount}</span>
                </span>
                <div class="redraft-diff-close" title="Close">
                    <i class="fa-solid fa-xmark"></i>
                </div>
            </div>
            ${changelogHtml}
            <div class="redraft-diff-body">${diffHtml}</div>
        </div>
    `;

    // Close handlers
    overlay.querySelector('.redraft-diff-close').addEventListener('click', closeDiffPopup);
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeDiffPopup();
    });

    document.body.appendChild(overlay);
}

function closeDiffPopup() {
    const overlay = document.getElementById('redraft_diff_overlay');
    if (overlay) overlay.remove();
}

// ─── Floating Popout ────────────────────────────────────────────────

function createPopoutTrigger() {
    if (document.getElementById('redraft_popout_trigger')) return;

    const trigger = document.createElement('div');
    trigger.id = 'redraft_popout_trigger';
    trigger.classList.add('redraft-popout-trigger');
    trigger.title = 'ReDraft';
    trigger.innerHTML = `
        <i class="fa-solid fa-pen-nib"></i>
        <span class="redraft-auto-dot"></span>
    `;
    trigger.addEventListener('click', togglePopout);
    document.body.appendChild(trigger);

    updatePopoutAutoState();
}

function togglePopout() {
    const panel = document.getElementById('redraft_popout_panel');
    if (!panel) return;
    const isVisible = panel.style.display !== 'none';

    if (isVisible) {
        hidePopout();
        return;
    }

    panel.style.display = 'block';

    const autoCheckbox = document.getElementById('redraft_popout_auto');
    if (autoCheckbox) {
        autoCheckbox.checked = getSettings().autoRefine;
    }
    updatePopoutStatus();

    // Click-outside to close — store ref so hidePopout() can clean it up
    _popoutOutsideClickRef = (e) => {
        if (!panel.contains(e.target) && !e.target.closest('.redraft-popout-trigger')) {
            hidePopout();
        }
    };
    // Defer so the opening click doesn't immediately close it
    requestAnimationFrame(() => {
        document.addEventListener('pointerdown', _popoutOutsideClickRef, true);
    });
}

function updatePopoutAutoState() {
    const trigger = document.getElementById('redraft_popout_trigger');
    if (!trigger) return;
    const settings = getSettings();
    trigger.classList.toggle('auto-active', settings.autoRefine && settings.enabled);
}

async function updatePopoutStatus() {
    const el = document.getElementById('redraft_popout_status');
    if (!el) return;
    const settings = getSettings();

    if (settings.connectionMode === 'st') {
        el.textContent = 'Using ST connection';
    } else if (!pluginAvailable) {
        el.textContent = 'Plugin unavailable';
    } else {
        try {
            const status = await pluginRequest('/status');
            el.textContent = status.configured ? `${status.model} ready` : 'Not configured';
        } catch {
            el.textContent = 'Plugin unavailable';
        }
    }
}

// ─── Custom Rules UI ────────────────────────────────────────────────

function renderCustomRules(settingsKey = 'customRules', containerId = 'redraft_custom_rules_list') {
    const container = document.getElementById(containerId);
    const settings = getSettings();
    const rules = settings[settingsKey] || [];
    console.debug(`${LOG_PREFIX} renderCustomRules(${settingsKey}): container found=${!!container}, rules count=${rules.length}`);
    if (!container) return;

    const { DOMPurify } = SillyTavern.libs;

    container.innerHTML = '';

    rules.forEach((rule, index) => {
        const item = document.createElement('div');
        item.classList.add('redraft-custom-rule-item');
        item.dataset.index = index;

        item.innerHTML = `
            <span class="drag-handle" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
            <input type="checkbox" class="redraft-rule-toggle" ${rule.enabled ? 'checked' : ''} />
            <textarea class="text_pole redraft-rule-text" rows="1" placeholder="Enter rule...">${DOMPurify.sanitize(rule.text || '')}</textarea>
            <button class="redraft-delete-rule" title="Remove rule"><i class="fa-solid fa-trash-can"></i></button>
        `;

        item.querySelector('.redraft-rule-toggle').addEventListener('change', (e) => {
            getSettings()[settingsKey][index].enabled = e.target.checked;
            saveSettings();
            updateCustomRulesToggle(settingsKey);
        });

        item.querySelector('.redraft-rule-text').addEventListener('input', (e) => {
            getSettings()[settingsKey][index].text = e.target.value;
            saveSettings();
        });

        item.querySelector('.redraft-delete-rule').addEventListener('click', () => {
            getSettings()[settingsKey].splice(index, 1);
            saveSettings();
            renderCustomRules(settingsKey, containerId);
        });

        container.appendChild(item);
    });

    initDragReorder(container, settingsKey, containerId);
    updateCustomRulesToggle(settingsKey);
}

/**
 * Sync the master custom-rules toggle state.
 * Checked = all enabled, unchecked = all disabled, indeterminate = mixed.
 */
function updateCustomRulesToggle(settingsKey = 'customRules') {
    const toggleId = settingsKey === 'userCustomRules' ? 'redraft_user_custom_rules_toggle' : 'redraft_custom_rules_toggle';
    const toggle = document.getElementById(toggleId);
    if (!toggle) return;
    const rules = getSettings()[settingsKey] || [];
    if (rules.length === 0) {
        toggle.checked = false;
        toggle.indeterminate = false;
        return;
    }
    const enabledCount = rules.filter(r => r.enabled).length;
    toggle.checked = enabledCount === rules.length;
    toggle.indeterminate = enabledCount > 0 && enabledCount < rules.length;
}

function initDragReorder(container, settingsKey = 'customRules', containerId = 'redraft_custom_rules_list') {
    let draggedItem = null;

    container.querySelectorAll('.drag-handle').forEach(handle => {
        const item = handle.closest('.redraft-custom-rule-item');
        item.setAttribute('draggable', true);

        item.addEventListener('dragstart', (e) => {
            draggedItem = item;
            item.style.opacity = '0.4';
            e.dataTransfer.effectAllowed = 'move';
        });

        item.addEventListener('dragend', () => {
            item.style.opacity = '';
            draggedItem = null;
            container.querySelectorAll('.redraft-custom-rule-item').forEach(el => {
                el.classList.remove('redraft-drag-over');
            });
        });

        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            item.classList.add('redraft-drag-over');
        });

        item.addEventListener('dragleave', () => {
            item.classList.remove('redraft-drag-over');
        });

        item.addEventListener('drop', (e) => {
            e.preventDefault();
            item.classList.remove('redraft-drag-over');
            if (!draggedItem || draggedItem === item) return;

            const fromIndex = parseInt(draggedItem.dataset.index, 10);
            const toIndex = parseInt(item.dataset.index, 10);

            const s = getSettings();
            const rules = s[settingsKey] || [];
            const [moved] = rules.splice(fromIndex, 1);
            rules.splice(toIndex, 0, moved);
            saveSettings();
            renderCustomRules(settingsKey, containerId);
        });
    });
}

/**
 * Export custom rules as a JSON file download.
 */
function exportCustomRules(settingsKey = 'customRules') {
    const settings = getSettings();
    const rules = settings[settingsKey] || [];
    if (rules.length === 0) {
        toastr.warning('No custom rules to export', 'ReDraft');
        return;
    }

    const isUser = settingsKey === 'userCustomRules';
    const data = {
        name: isUser ? 'ReDraft User Enhance Rules' : 'ReDraft Custom Rules',
        version: 1,
        rules: rules.map(r => ({
            label: r.label || '',
            text: r.text || '',
            enabled: r.enabled !== false,
        })),
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = isUser ? 'redraft-user-enhance-rules.json' : 'redraft-rules.json';
    a.click();
    URL.revokeObjectURL(url);

    toastr.success(`Exported ${data.rules.length} rules`, 'ReDraft');
}

/**
 * Import custom rules from a JSON file.
 * @param {File} file
 */
async function importCustomRules(file, settingsKey = 'customRules') {
    const containerId = settingsKey === 'userCustomRules' ? 'redraft_user_custom_rules_list' : 'redraft_custom_rules_list';
    try {
        const text = await file.text();
        const data = JSON.parse(text);

        if (!data.rules || !Array.isArray(data.rules) || data.rules.length === 0) {
            toastr.error('Invalid file: must contain a non-empty "rules" array', 'ReDraft');
            return;
        }

        const importedRules = data.rules
            .filter(r => r && typeof r.text === 'string' && r.text.trim())
            .map(r => ({
                label: r.label || '',
                text: r.text.trim(),
                enabled: r.enabled !== false,
            }));

        if (importedRules.length === 0) {
            toastr.error('No valid rules found in file', 'ReDraft');
            return;
        }

        const ruleName = data.name || file.name.replace(/\.json$/i, '');

        const s = getSettings();
        if (!s[settingsKey]) s[settingsKey] = [];
        const hasExisting = s[settingsKey].length > 0;

        if (hasExisting) {
            const replace = confirm(
                `Import "${ruleName}" (${importedRules.length} rules)?\n\n` +
                `OK = Replace existing ${s[settingsKey].length} rules\n` +
                `Cancel = Append after existing rules`
            );

            if (replace) {
                s[settingsKey] = importedRules;
            } else {
                s[settingsKey].push(...importedRules);
            }
        } else {
            s[settingsKey] = importedRules;
        }

        saveSettings();
        renderCustomRules(settingsKey, containerId);
        toastr.success(`Imported ${importedRules.length} rules from "${ruleName}"`, 'ReDraft');

    } catch (err) {
        console.error(`${LOG_PREFIX} Import failed:`, err);
        toastr.error('Failed to import: ' + (err.message || 'Invalid JSON'), 'ReDraft');
    }
}

// ─── Settings UI Binding ────────────────────────────────────────────

function bindSettingsUI() {
    // IMPORTANT: Always use getSettings() fresh in each handler — ST may replace
    // the extension_settings object during save/load, making cached refs stale.
    const initSettings = getSettings();


    // Connection mode selector
    const modeSelect = document.getElementById('redraft_connection_mode');
    if (modeSelect) {
        modeSelect.value = initSettings.connectionMode;
        modeSelect.addEventListener('change', (e) => {
            getSettings().connectionMode = e.target.value;
            saveSettings();
            updateConnectionModeUI();
        });
    }

    // Enable toggle
    const enabledEl = document.getElementById('redraft_enabled');
    if (enabledEl) {
        enabledEl.checked = initSettings.enabled;
        enabledEl.addEventListener('change', (e) => {
            getSettings().enabled = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // Auto-refine toggle
    const autoEl = document.getElementById('redraft_auto_refine');
    if (autoEl) {
        autoEl.checked = initSettings.autoRefine;
        autoEl.addEventListener('change', (e) => {
            getSettings().autoRefine = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // User enhance toggle
    const userEnhanceEl = document.getElementById('redraft_user_enhance');
    if (userEnhanceEl) {
        userEnhanceEl.checked = initSettings.userEnhanceEnabled;
        userEnhanceEl.addEventListener('change', (e) => {
            getSettings().userEnhanceEnabled = e.target.checked;
            saveSettings();
            addMessageButtons();
        });
    }

    // User auto-enhance toggle
    const userAutoEnhanceEl = document.getElementById('redraft_user_auto_enhance');
    if (userAutoEnhanceEl) {
        userAutoEnhanceEl.checked = initSettings.userAutoEnhance;
        userAutoEnhanceEl.addEventListener('change', (e) => {
            getSettings().userAutoEnhance = e.target.checked;
            saveSettings();
        });
    }

    // Enhancement mode selector (pre-send / post-send)
    const enhanceModeEl = document.getElementById('redraft_user_enhance_mode');
    if (enhanceModeEl) {
        enhanceModeEl.value = initSettings.userEnhanceMode || 'post';
        updateEnhanceModeUI(initSettings.userEnhanceMode || 'post');
        enhanceModeEl.addEventListener('change', (e) => {
            getSettings().userEnhanceMode = e.target.value;
            saveSettings();
            updateEnhanceModeUI(e.target.value);
        });
    }

    // User built-in rule toggles
    for (const key of Object.keys(BUILTIN_USER_RULES)) {
        const el = document.getElementById(`redraft_user_rule_${key}`);
        if (el) {
            el.checked = !!(initSettings.userBuiltInRules?.[key]);
            el.addEventListener('change', (e) => {
                const s = getSettings();
                if (!s.userBuiltInRules) s.userBuiltInRules = {};
                s.userBuiltInRules[key] = e.target.checked;
                saveSettings();
            });
        }
    }

    // User custom rules: import
    const userImportBtn = document.getElementById('redraft_user_import_rules');
    const userImportFile = document.getElementById('redraft_user_import_rules_file');
    if (userImportBtn && userImportFile) {
        userImportBtn.addEventListener('click', () => userImportFile.click());
        userImportFile.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                importCustomRules(file, 'userCustomRules');
                e.target.value = '';
            }
        });
    }

    // User custom rules: export
    const userExportBtn = document.getElementById('redraft_user_export_rules');
    if (userExportBtn) {
        userExportBtn.addEventListener('click', () => exportCustomRules('userCustomRules'));
    }

    // User custom rules: master toggle
    const userCustomToggle = document.getElementById('redraft_user_custom_rules_toggle');
    if (userCustomToggle) {
        userCustomToggle.addEventListener('change', (e) => {
            const s = getSettings();
            const enable = e.target.checked;
            (s.userCustomRules || []).forEach(r => r.enabled = enable);
            saveSettings();
            renderCustomRules('userCustomRules', 'redraft_user_custom_rules_list');
        });
    }

    // User custom rules: add button
    const userAddRuleBtn = document.getElementById('redraft_user_add_rule');
    if (userAddRuleBtn) {
        userAddRuleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const s = getSettings();
            if (!s.userCustomRules) s.userCustomRules = [];
            s.userCustomRules.push({ text: '', enabled: true });
            saveSettings();
            renderCustomRules('userCustomRules', 'redraft_user_custom_rules_list');
            const ruleInputs = document.querySelectorAll('#redraft_user_custom_rules_list .redraft-rule-text');
            if (ruleInputs.length > 0) {
                ruleInputs[ruleInputs.length - 1].focus();
            }
        });
    }

    // Show diff after refinement toggle
    const diffEl = document.getElementById('redraft_show_diff');
    if (diffEl) {
        diffEl.checked = initSettings.showDiffAfterRefine;
        diffEl.addEventListener('change', (e) => {
            getSettings().showDiffAfterRefine = e.target.checked;
            saveSettings();
        });
    }

    // Notification sound when refinement finishes
    const notifSoundEl = document.getElementById('redraft_notification_sound');
    if (notifSoundEl) {
        notifSoundEl.checked = initSettings.notificationSoundEnabled === true;
        notifSoundEl.addEventListener('change', (e) => {
            getSettings().notificationSoundEnabled = e.target.checked;
            saveSettings();
        });
    }
    const notifSoundUrlEl = document.getElementById('redraft_notification_sound_url');
    if (notifSoundUrlEl) {
        const savedUrl = initSettings.notificationSoundUrl || '';
        notifSoundUrlEl.value = savedUrl.startsWith('data:') ? '(uploaded file)' : savedUrl;
        notifSoundUrlEl.addEventListener('change', (e) => {
            const v = (e.target.value || '').trim();
            if (v !== '(uploaded file)') getSettings().notificationSoundUrl = v;
            saveSettings();
        });
    }
    const notifSoundFileEl = document.getElementById('redraft_notification_sound_file');
    const notifSoundUploadBtn = document.getElementById('redraft_notification_sound_upload_btn');
    if (notifSoundFileEl && notifSoundUploadBtn) {
        notifSoundUploadBtn.addEventListener('click', () => notifSoundFileEl.click());
        notifSoundFileEl.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = reader.result;
                if (typeof dataUrl === 'string' && dataUrl.startsWith('data:')) {
                    getSettings().notificationSoundUrl = dataUrl;
                    if (notifSoundUrlEl) notifSoundUrlEl.value = '(uploaded file)';
                    saveSettings();
                }
            };
            reader.readAsDataURL(file);
            e.target.value = '';
        });
    }
    const notifSoundClearBtn = document.getElementById('redraft_notification_sound_clear_btn');
    if (notifSoundClearBtn) {
        notifSoundClearBtn.addEventListener('click', () => {
            getSettings().notificationSoundUrl = '';
            if (notifSoundUrlEl) notifSoundUrlEl.value = '';
            saveSettings();
        });
    }

    // System prompt (AI messages)
    const promptEl = document.getElementById('redraft_system_prompt');
    if (promptEl) {
        promptEl.value = initSettings.systemPrompt || '';
        promptEl.addEventListener('input', (e) => {
            getSettings().systemPrompt = e.target.value;
            saveSettings();
        });
    }

    // System prompt (user messages)
    const userPromptEl = document.getElementById('redraft_user_system_prompt');
    if (userPromptEl) {
        userPromptEl.value = initSettings.userSystemPrompt || '';
        userPromptEl.addEventListener('input', (e) => {
            getSettings().userSystemPrompt = e.target.value;
            saveSettings();
        });
    }

    // PoV selector
    const povEl = document.getElementById('redraft_pov');
    if (povEl) {
        povEl.value = initSettings.pov || 'auto';
        povEl.addEventListener('change', (e) => {
            const s = getSettings();
            s.pov = e.target.value;
            // Sync with popout selector
            const popoutPov = document.getElementById('redraft_popout_pov');
            if (popoutPov) popoutPov.value = e.target.value;
            saveSettings();
        });
    }

    // Character context length
    const charContextEl = document.getElementById('redraft_character_context_chars');
    if (charContextEl) {
        const val = initSettings.characterContextChars ?? 500;
        charContextEl.value = String([500, 1000, 2000].includes(val) ? val : 500);
        charContextEl.addEventListener('change', (e) => {
            getSettings().characterContextChars = parseInt(e.target.value, 10);
            saveSettings();
        });
    }

    // Previous response tail length
    const prevTailEl = document.getElementById('redraft_previous_response_tail');
    if (prevTailEl) {
        const val = initSettings.previousResponseTailChars ?? 200;
        prevTailEl.value = String([100, 200, 400].includes(val) ? val : 200);
        prevTailEl.addEventListener('change', (e) => {
            getSettings().previousResponseTailChars = parseInt(e.target.value, 10);
            saveSettings();
        });
    }

    // Protect font/color tags
    const protectFontEl = document.getElementById('redraft_protect_font_tags');
    if (protectFontEl) {
        protectFontEl.checked = initSettings.protectFontTags === true;
        protectFontEl.addEventListener('change', (e) => {
            getSettings().protectFontTags = e.target.checked;
            saveSettings();
        });
    }

    // Built-in rule toggles
    for (const key of Object.keys(BUILTIN_RULES)) {
        const el = document.getElementById(`redraft_rule_${key}`);
        if (el) {
            el.checked = initSettings.builtInRules[key];
            el.addEventListener('change', (e) => {
                getSettings().builtInRules[key] = e.target.checked;
                saveSettings();
            });
        }
    }

    // Install doc links (open in new tab)
    const installLink = document.getElementById('redraft_plugin_install_link');
    if (installLink) installLink.href = INSTALL_DOC_URL;
    const unavailLink = document.getElementById('redraft_plugin_unavailable_link');
    if (unavailLink) unavailLink.href = INSTALL_DOC_URL;

    // Save connection button
    const saveConnBtn = document.getElementById('redraft_save_connection');
    if (saveConnBtn) {
        saveConnBtn.addEventListener('click', saveConnection);
    }

    // Test connection button
    const testConnBtn = document.getElementById('redraft_test_connection');
    if (testConnBtn) {
        testConnBtn.addEventListener('click', testConnection);
    }

    // Fetch models button
    const fetchModelsBtn = document.getElementById('redraft_fetch_models');
    if (fetchModelsBtn) {
        fetchModelsBtn.addEventListener('click', fetchModels);
    }

    // Model text input — auto-save on change (debounced for typing)
    const modelInput = document.getElementById('redraft_model');
    if (modelInput) {
        modelInput.addEventListener('change', () => scheduleAutoSave(true));
        modelInput.addEventListener('input', () => scheduleAutoSave());
    }

    // Model select dropdown (mobile-friendly alternative to datalist) — auto-save immediately
    const modelSelect = document.getElementById('redraft_model_select');
    if (modelSelect) {
        modelSelect.addEventListener('change', (e) => {
            const input = document.getElementById('redraft_model');
            if (input && e.target.value) {
                input.value = e.target.value;
            }
            scheduleAutoSave(true);
        });
    }

    // Max tokens — auto-save on change
    const maxTokensInput = document.getElementById('redraft_max_tokens');
    if (maxTokensInput) {
        maxTokensInput.addEventListener('change', () => scheduleAutoSave(true));
    }

    // Import custom rules button
    const importBtn = document.getElementById('redraft_import_rules');
    const importFile = document.getElementById('redraft_import_rules_file');
    if (importBtn && importFile) {
        importBtn.addEventListener('click', () => importFile.click());
        importFile.addEventListener('change', (e) => {
            const file = e.target.files?.[0];
            if (file) {
                importCustomRules(file);
                e.target.value = ''; // Reset so same file can be re-imported
            }
        });
    }

    // Export custom rules button
    const exportBtn = document.getElementById('redraft_export_rules');
    if (exportBtn) {
        exportBtn.addEventListener('click', exportCustomRules);
    }

    // Master custom-rules toggle
    const customRulesToggle = document.getElementById('redraft_custom_rules_toggle');
    if (customRulesToggle) {
        customRulesToggle.addEventListener('change', (e) => {
            const s = getSettings();
            const enable = e.target.checked;
            s.customRules.forEach(r => r.enabled = enable);
            saveSettings();
            renderCustomRules();
        });
    }

    // Add custom rule button
    const addRuleBtn = document.getElementById('redraft_add_rule');

    if (addRuleBtn) {
        addRuleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const s = getSettings();
            s.customRules.push({ text: '', enabled: true });
            saveSettings();
            renderCustomRules();

            // Auto-focus the new rule's textarea
            const ruleInputs = document.querySelectorAll('.redraft-rule-text');

            if (ruleInputs.length > 0) {
                ruleInputs[ruleInputs.length - 1].focus();
            }
        });
    }



    // Popout panel bindings
    const popoutClose = document.getElementById('redraft_popout_close');
    if (popoutClose) {
        popoutClose.addEventListener('click', hidePopout);
    }

    const popoutAuto = document.getElementById('redraft_popout_auto');
    if (popoutAuto) {
        popoutAuto.checked = initSettings.autoRefine;
        popoutAuto.addEventListener('change', (e) => {
            const s = getSettings();
            s.autoRefine = e.target.checked;
            if (autoEl) autoEl.checked = e.target.checked;
            saveSettings();
            updatePopoutAutoState();
        });
    }

    // Popout PoV selector
    const popoutPov = document.getElementById('redraft_popout_pov');
    if (popoutPov) {
        popoutPov.value = initSettings.pov || 'auto';
        popoutPov.addEventListener('change', (e) => {
            const s = getSettings();
            s.pov = e.target.value;
            // Sync with main settings panel
            const mainPov = document.getElementById('redraft_pov');
            if (mainPov) mainPov.value = e.target.value;
            saveSettings();
        });
    }

    const popoutRefine = document.getElementById('redraft_popout_refine');
    if (popoutRefine) {
        popoutRefine.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            const lastAiIdx = findLastAiMessageIndex();
            if (lastAiIdx >= 0) {
                redraftMessage(lastAiIdx);
            } else {
                toastr.warning('No AI message found to refine', 'ReDraft');
            }
        }, 500, { leading: true, trailing: false }));
    }

    const popoutEnhanceUser = document.getElementById('redraft_popout_enhance_user');
    if (popoutEnhanceUser) {
        popoutEnhanceUser.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            const lastUserIdx = findLastUserMessageIndex();
            if (lastUserIdx >= 0) {
                redraftMessage(lastUserIdx);
            } else {
                toastr.warning('No user message found to enhance', 'ReDraft');
            }
        }, 500, { leading: true, trailing: false }));
    }

    const popoutOpenSettings = document.getElementById('redraft_popout_open_settings');

    if (popoutOpenSettings) {
        popoutOpenSettings.addEventListener('click', () => {

            togglePopout();

            // Check if extensions panel is already visible
            const extPanel = document.getElementById('top-settings-holder');
            const isPanelOpen = extPanel && extPanel.style.display !== 'none' && !extPanel.classList.contains('displayNone');


            if (!isPanelOpen) {
                // Only click if panel is closed
                const extBtn = document.getElementById('extensionsMenuButton');

                if (extBtn) extBtn.click();
            }

            // Scroll to and open the ReDraft drawer
            setTimeout(() => {
                const redraftSettings = document.getElementById('redraft_settings');

                if (redraftSettings) {
                    redraftSettings.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Open the drawer if it's closed
                    const drawerContent = redraftSettings.querySelector('.inline-drawer-content');
                    if (drawerContent && !drawerContent.classList.contains('open') && getComputedStyle(drawerContent).display === 'none') {
                        const drawerToggle = redraftSettings.querySelector('.inline-drawer-toggle');
                        if (drawerToggle) drawerToggle.click();
                    }
                }
            }, 300);
        });
    }

    // Render custom rules (AI refine + user enhance)
    renderCustomRules();
    renderCustomRules('userCustomRules', 'redraft_user_custom_rules_list');

    // Set initial connection mode UI
    updateConnectionModeUI();
}

/**
 * Auto-save connection config (model, URL, maxTokens) without requiring the Save button.
 * Only fires when the plugin is already configured (has a saved API key).
 * Does NOT send the API key — the server keeps the existing one.
 */
let _autoSaveTimeout = null;

function scheduleAutoSave(immediate = false) {
    if (_autoSaveTimeout) clearTimeout(_autoSaveTimeout);
    if (immediate) {
        autoSaveConnection();
    } else {
        _autoSaveTimeout = setTimeout(autoSaveConnection, 800);
    }
}

async function autoSaveConnection() {
    if (!pluginAvailable) return;

    const apiUrl = document.getElementById('redraft_api_url')?.value?.trim();
    const model = document.getElementById('redraft_model')?.value?.trim();
    const maxTokens = document.getElementById('redraft_max_tokens')?.value;

    if (!apiUrl || !model) return;

    const payload = {
        apiUrl,
        model,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : 4096,
    };

    try {
        await pluginRequest('/config', 'POST', payload);
        await checkPluginStatus();
        updatePopoutStatus();
        showAutoSaveIndicator();
    } catch {
        // Silent — initial setup (no key yet) will 400, user uses Save button for that
    }
}

function showAutoSaveIndicator() {
    const info = document.getElementById('redraft_connection_info');
    if (!info) return;
    const prev = info.textContent;
    info.textContent = '\u2713 Saved';
    info.classList.add('redraft-autosave-flash');
    setTimeout(() => {
        info.classList.remove('redraft-autosave-flash');
        // Restore real status if it hasn't been changed by something else
        if (info.textContent === '\u2713 Saved') {
            checkPluginStatus();
        }
    }, 1500);
}

async function saveConnection() {
    const apiUrl = document.getElementById('redraft_api_url')?.value?.trim();
    const apiKey = document.getElementById('redraft_api_key')?.value?.trim();
    const model = document.getElementById('redraft_model')?.value?.trim();
    const maxTokens = document.getElementById('redraft_max_tokens')?.value;

    if (!apiUrl || !model) {
        toastr.warning('Please fill in API URL and Model', 'ReDraft');
        return;
    }

    const payload = {
        apiUrl,
        model,
        maxTokens: maxTokens ? parseInt(maxTokens, 10) : 4096,
    };

    // Only send apiKey if the user entered a new one; otherwise the server keeps the saved key
    if (apiKey) {
        payload.apiKey = apiKey;
    }

    try {
        await pluginRequest('/config', 'POST', payload);

        const keyField = document.getElementById('redraft_api_key');
        if (keyField) keyField.value = '';

        toastr.success('Connection saved', 'ReDraft');
        await checkPluginStatus();
        updateConnectionModeUI();
        updatePopoutStatus();
    } catch (err) {
        toastr.error(err.message || 'Failed to save connection', 'ReDraft');
    }
}

/**
 * Test plugin reachability and configuration. User-facing feedback via toasts.
 */
async function testConnection() {
    try {
        const status = await pluginRequest('/status');
        if (!status.configured) {
            toastr.warning(
                'Plugin is reachable but not configured. Enter API URL, Key, and Model, then click Save Connection.',
                'ReDraft',
                { timeOut: 6000 }
            );
            return;
        }
        toastr.success(`Connection OK — ${status.model} ready for refinement`, 'ReDraft');
        await checkPluginStatus();
        updateConnectionModeUI();
    } catch (err) {
        toastr.error(
            err?.message || 'Plugin unreachable. Install the ReDraft server plugin and restart SillyTavern. See install instructions in the README.',
            'ReDraft',
            { timeOut: 8000 }
        );
    }
}

/**
 * Fetch available models from the configured API and populate the model datalist.
 */
async function fetchModels() {
    try {
        const data = await pluginRequest('/models');
        const models = data?.models;
        if (!Array.isArray(models) || models.length === 0) {
            toastr.info('No models returned by the API', 'ReDraft');
            return;
        }

        const datalist = document.getElementById('redraft_model_list');
        if (datalist) {
            datalist.innerHTML = '';
            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m.id;
                if (m.name && m.name !== m.id) opt.label = m.name;
                datalist.appendChild(opt);
            }
        }

        const modelSelect = document.getElementById('redraft_model_select');
        if (modelSelect) {
            const currentModel = document.getElementById('redraft_model')?.value?.trim() || '';
            modelSelect.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.disabled = true;
            placeholder.selected = !currentModel;
            placeholder.textContent = `Select a model (${models.length} available)`;
            modelSelect.appendChild(placeholder);

            for (const m of models) {
                const opt = document.createElement('option');
                opt.value = m.id;
                opt.textContent = m.name && m.name !== m.id ? `${m.id} — ${m.name}` : m.id;
                if (m.id === currentModel) opt.selected = true;
                modelSelect.appendChild(opt);
            }
            modelSelect.style.display = '';
        }

        toastr.success(`${models.length} model(s) loaded — select from the dropdown or type a name`, 'ReDraft');
    } catch (err) {
        toastr.error(err?.message || 'Failed to fetch models', 'ReDraft');
    }
}

// ─── Event Handlers ─────────────────────────────────────────────────

function findLastAiMessageIndex() {
    const { chat } = SillyTavern.getContext();
    if (!chat) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) {
            return i;
        }
    }
    return -1;
}

function findLastUserMessageIndex() {
    const { chat } = SillyTavern.getContext();
    if (!chat) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && !chat[i].is_system) {
            return i;
        }
    }
    return -1;
}

function onCharacterMessageRendered(messageIndex) {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoRefine) return;
    if (isRefining) return;

    setTimeout(() => {
        redraftMessage(messageIndex);
    }, 100);
}

function onUserMessageRendered(messageIndex) {
    addMessageButtons();
    const settings = getSettings();
    if (!settings.enabled || !settings.userEnhanceEnabled || !settings.userAutoEnhance) return;
    // In pre-send mode, the interceptor handles auto-enhance before generation
    if (settings.userEnhanceMode === 'pre') return;
    if (isRefining) return;

    setTimeout(() => {
        redraftMessage(messageIndex);
    }, 100);
}

function onMessageRendered() {
    addMessageButtons();
    const context = SillyTavern.getContext();
    const { chat, chatMetadata } = context;
    const originals = chatMetadata?.['redraft_originals'];
    const diffs = chatMetadata?.['redraft_diffs'];
    if (originals) {
        for (const idx of Object.keys(originals)) {
            const i = parseInt(idx, 10);
            showUndoButton(i);
            // Restore diff button if persisted diff data exists
            if (diffs && diffs[idx] && chat[i]) {
                showDiffButton(i, diffs[idx].original, chat[i].mes, diffs[idx].changelog);
            }
        }
    }
}

function onChatChanged() {
    addMessageButtons();
}

// ─── Slash Command ──────────────────────────────────────────────────

function registerSlashCommand() {
    const context = SillyTavern.getContext();
    const {
        SlashCommandParser,
        SlashCommand,
        SlashCommandArgument,
        ARGUMENT_TYPE,
    } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.warn(`${LOG_PREFIX} SlashCommandParser not available, skipping command registration`);
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'redraft',
        callback: async (namedArgs, unnamedArgs) => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('ReDraft is disabled', 'ReDraft');
                return '';
            }

            let idx;
            const rawArg = unnamedArgs?.toString()?.trim();
            if (rawArg && !isNaN(rawArg)) {
                idx = parseInt(rawArg, 10);
            } else {
                idx = findLastAiMessageIndex();
            }

            if (idx < 0) {
                toastr.warning('No message found to refine', 'ReDraft');
                return '';
            }

            await redraftMessage(idx);
            return '';
        },
        aliases: [],
        returns: 'empty string',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message index to refine (defaults to last AI message)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: '<div>Refine a message using ReDraft. Optionally provide a message index, otherwise refines the last AI message.</div>',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'enhance',
        callback: async (namedArgs, unnamedArgs) => {
            const settings = getSettings();
            if (!settings.enabled) {
                toastr.warning('ReDraft is disabled', 'ReDraft');
                return '';
            }

            let idx;
            const rawArg = unnamedArgs?.toString()?.trim();
            if (rawArg && !isNaN(rawArg)) {
                idx = parseInt(rawArg, 10);
            } else {
                idx = findLastUserMessageIndex();
            }

            if (idx < 0) {
                toastr.warning('No user message found to enhance', 'ReDraft');
                return '';
            }

            await redraftMessage(idx);
            return '';
        },
        aliases: [],
        returns: 'empty string',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'Message index to enhance (defaults to last user message)',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
        ],
        helpString: '<div>Enhance a user message using ReDraft. Fixes grammar, matches your persona voice, checks lore. Optionally provide a message index, otherwise enhances the last user message.</div>',
    }));

    console.log(`${LOG_PREFIX} Slash commands /redraft and /enhance registered`);
}

// ─── Pre-Send Interceptor ───────────────────────────────────────────

/**
 * SillyTavern generate_interceptor. Called before every generation request.
 * When pre-send enhance is enabled, enhances the last user message in the
 * chat array so the main LLM sees the polished version.
 *
 * Signature per ST docs: (chat, contextSize, abort, type)
 *   chat        — mutable message array (same objects as context.chat)
 *   contextSize — current context size in tokens
 *   abort       — call abort() to cancel generation
 *   type        — generation trigger: 'normal', 'quiet', 'regenerate', 'impersonate', 'swipe', etc.
 */
globalThis.redraftGenerateInterceptor = async function (chat, contextSize, abort, type) {
    const settings = getSettings();

    if (!settings.enabled || !settings.userEnhanceEnabled) return;
    if (settings.userEnhanceMode !== 'pre') return;
    if (isRefining) return;

    // Only intercept normal user-initiated generations
    if (type === 'quiet' || type === 'impersonate') return;

    // Find the last user message — search in context.chat (full chat) for correct DOM index.
    // The interceptor's `chat` param may be a trimmed subset for prompt building, so we use
    // it only to identify the message object, then resolve its real index in context.chat.
    const context = SillyTavern.getContext();
    const fullChat = context.chat;

    let message = null;
    let realIdx = -1;

    // Walk backward through the interceptor's chat to find the last user message object
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i].is_user && chat[i].mes) {
            message = chat[i];
            break;
        }
    }
    if (!message) return;

    // Resolve the real index in context.chat (same object reference)
    for (let i = fullChat.length - 1; i >= 0; i--) {
        if (fullChat[i] === message) {
            realIdx = i;
            break;
        }
    }
    if (realIdx < 0) {
        console.warn(`${LOG_PREFIX} [pre-send] Could not resolve real index for user message, skipping`);
        return;
    }

    // Skip very short messages (e.g. "ok", "sure", "*nods*")
    if (message.mes.trim().length < 20) {
        console.debug(`${LOG_PREFIX} [pre-send] Skipping short message (${message.mes.trim().length} chars)`);
        return;
    }

    // Skip if this message was already enhanced (avoid double-enhance on regenerate/swipe)
    const originals = context.chatMetadata?.['redraft_originals'];
    if (originals && originals[realIdx] !== undefined) {
        console.debug(`${LOG_PREFIX} [pre-send] Message ${realIdx} already has an original stored, skipping`);
        return;
    }

    // Check plugin availability if in plugin mode
    if (settings.connectionMode === 'plugin' && !pluginAvailable) {
        console.warn(`${LOG_PREFIX} [pre-send] Plugin mode selected but plugin unavailable, skipping`);
        return;
    }

    console.log(`${LOG_PREFIX} [pre-send] Enhancing user message (chat index ${realIdx}) before generation`);
    isRefining = true;
    toastr.info('Enhancing your message before sending\u2026', 'ReDraft', { timeOut: 0, extendedTimeOut: 0, tapToDismiss: false, className: 'redraft-presend-toast' });

    try {
        const { stripped, blocks } = stripProtectedBlocks(message.mes, {
            protectFontTags: settings.protectFontTags,
        });

        const rulesText = compileUserRules(settings);

        const contextParts = [];
        const char = context.characters?.[context.characterId];
        const charLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
        const charDesc = char?.data?.personality || char?.data?.description?.substring(0, charLimit) || '';

        const systemPrompt = settings.userSystemPrompt?.trim() || DEFAULT_USER_ENHANCE_SYSTEM_PROMPT;

        const personaDesc = getUserPersonaDescription();
        const personaLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
        if (context.name1 || personaDesc) {
            const truncatedPersona = personaDesc ? personaDesc.substring(0, personaLimit) : '';
            contextParts.push(`Your character (who you are writing as): ${context.name1 || 'Unknown'}${truncatedPersona ? ' \u2014 ' + truncatedPersona : ''}`);
        }

        if (context.name2 || charDesc) {
            contextParts.push(`Character you are interacting with: ${context.name2 || 'Unknown'}${charDesc ? ' \u2014 ' + charDesc : ''}`);
        }

        // Previous AI response (for scene context) — use full chat for correct lookback
        const prevAiMsg = [...fullChat.slice(0, realIdx)].reverse().find(m => !m.is_user && m.mes);
        if (prevAiMsg) {
            const tailChars = Math.min(800, Math.max(50, settings.previousResponseTailChars ?? 200));
            contextParts.push(`Last response from ${context.name2 || 'the character'} (for scene context, last ~${tailChars} chars):\n${prevAiMsg.mes.slice(-tailChars)}`);
        }

        // PoV
        let povKey = settings.pov || 'auto';
        const wasAuto = povKey === 'auto';
        if (povKey === 'detect' || povKey === 'auto') {
            const detected = detectPov(stripped);
            if (detected) {
                povKey = detected;
            } else if (povKey === 'detect') {
                povKey = 'auto';
            }
        }
        if (povKey !== 'auto' && POV_INSTRUCTIONS[povKey]) {
            contextParts.push(`Point of view: ${POV_INSTRUCTIONS[povKey]}`);
        }

        const contextBlock = contextParts.length > 0
            ? `Context:\n${contextParts.join('\n\n')}\n\n`
            : '';

        const promptText = `${contextBlock}Apply the following enhancement rules to the message below. Any [PROTECTED_N] placeholders are protected regions — output them exactly as-is.

Remember: output [CHANGELOG]...[/CHANGELOG] first, then the enhanced message inside [REFINED]...[/REFINED]. No other text outside these tags.

Rules:\n${rulesText}\n\nOriginal message:\n${stripped}`;

        let refinedText;
        if (settings.connectionMode === 'plugin') {
            refinedText = await refineViaPlugin(promptText, systemPrompt);
        } else {
            refinedText = await refineViaST(promptText, systemPrompt);
        }

        const { changelog, refined: cleanRefined } = parseChangelog(refinedText);
        if (changelog) {
            console.log(`${LOG_PREFIX} [pre-send] Changelog:`, changelog);
        }

        refinedText = restoreProtectedBlocks(cleanRefined, blocks);

        // Store original for undo and update the chat message in place
        const { chatMetadata, saveChat, saveMetadata: saveMeta } = context;
        if (!chatMetadata['redraft_originals']) chatMetadata['redraft_originals'] = {};
        chatMetadata['redraft_originals'][realIdx] = message.mes;

        if (!chatMetadata['redraft_diffs']) chatMetadata['redraft_diffs'] = {};
        chatMetadata['redraft_diffs'][realIdx] = { original: message.mes, changelog: changelog || null };

        message.mes = refinedText;
        await saveChat();
        await saveMeta();

        // Re-render the user message so the UI shows the enhanced version.
        // Use immediate + deferred re-render to handle ST's own rendering pipeline.
        rerenderMessage(realIdx);
        setTimeout(() => {
            rerenderMessage(realIdx);
            showUndoButton(realIdx);
            showDiffButton(realIdx, chatMetadata['redraft_originals'][realIdx], refinedText, changelog);
        }, 200);

        console.log(`${LOG_PREFIX} [pre-send] User message ${realIdx} enhanced successfully`);
        toastr.clear();
        toastr.success('Message enhanced (pre-send)', 'ReDraft');
        playNotificationSound();
    } catch (err) {
        console.error(`${LOG_PREFIX} [pre-send] Enhancement failed:`, err);
        toastr.clear();
        toastr.warning('Pre-send enhancement failed, sending original message', 'ReDraft');
    } finally {
        isRefining = false;
        // Dismiss the "Enhancing..." toast
        document.querySelectorAll('.redraft-presend-toast').forEach(el => el.remove());
    }
};

// ─── Initialization ─────────────────────────────────────────────────

(async function init() {
    console.log(`${LOG_PREFIX} Loading...`);

    const context = SillyTavern.getContext();
    const { eventSource, event_types } = context;

    // Load settings HTML (inlined to avoid path resolution issues with third-party extensions)
    const settingsHtml = `
<div id="redraft_settings">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>ReDraft</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <div class="redraft-version-line" style="margin-bottom: 8px; font-size: calc(var(--mainFontSize) * 0.85); opacity: 0.85;">
                <span title="Extension (client) version">Current ver. <strong id="redraft_ext_version">${EXTENSION_VERSION}</strong></span>
                <span style="margin: 0 6px;">·</span>
                <span title="Server plugin version (from ST server)">Server plugin ver. <strong id="redraft_server_plugin_version">—</strong></span>
            </div>

            <!-- Top-level toggles -->
            <label class="checkbox_label">
                <input type="checkbox" id="redraft_enabled" />
                <span>Enable ReDraft</span>
            </label>
            <label class="checkbox_label">
                <input type="checkbox" id="redraft_auto_refine" />
                <span>Auto-refine new AI messages</span>
            </label>

            <hr style="margin: 8px 0; opacity: 0.2;" />

            <label class="checkbox_label">
                <input type="checkbox" id="redraft_show_diff" />
                <span>Show diff after refinement</span>
            </label>
            <div class="redraft-form-group" style="margin-top: 8px;">
                <label class="checkbox_label">
                    <input type="checkbox" id="redraft_notification_sound" />
                    <span>Play sound when refinement finishes</span>
                </label>
                <div id="redraft_notification_sound_options" style="margin-left: 1.5em; margin-top: 6px;">
                    <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 6px;">
                        <input type="url" id="redraft_notification_sound_url" class="text_pole" placeholder="Custom sound URL (optional)" style="flex: 1; min-width: 160px;" />
                        <span style="white-space: nowrap;">or</span>
                        <input type="file" id="redraft_notification_sound_file" accept="audio/*" hidden />
                        <div id="redraft_notification_sound_upload_btn" class="menu_button menu_button_icon" title="Upload a sound file (WAV, MP3, etc.)">
                            <i class="fa-solid fa-file-audio"></i>
                            <span>Upload</span>
                        </div>
                        <div id="redraft_notification_sound_clear_btn" class="menu_button menu_button_icon" title="Use default beep">
                            <i class="fa-solid fa-rotate-left"></i>
                            <span>Default</span>
                        </div>
                    </div>
                    <small class="redraft-section-hint" style="display: block; margin-top: 4px;">Leave empty for a short default beep. Use a URL or upload your own (saved in browser).</small>
                </div>
            </div>

            <!-- Connection Section -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Connection <span id="redraft_status_dot" class="redraft-status-dot" title="Not configured"></span></span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="redraft-form-group">
                        <label for="redraft_connection_mode">Refinement Mode</label>
                        <select id="redraft_connection_mode">
                            <option value="st">Use current ST connection</option>
                            <option value="plugin">Separate LLM (server plugin)</option>
                        </select>
                    </div>
                    <p id="redraft_connection_mode_hint" class="redraft-connection-hint" style="display: none;">
                        Use a different API/model for refinement (e.g. a faster or cheaper model). One-time plugin install required — see install instructions below.
                    </p>
                    <p id="redraft_multiuser_hint" class="redraft-section-hint" style="display: none; margin-top: 4px;">
                        In multi-user setups, each user can have their own Separate LLM credentials (per-user config). If your ST instance does not pass user context to plugins, a single shared config is used.
                    </p>

                    <!-- Banner: ST mode, plugin not installed (nudge) -->
                    <div id="redraft_plugin_banner" class="redraft-plugin-banner" style="display: none;">
                        <div class="redraft-banner-text">
                            <i class="fa-solid fa-info-circle"></i>
                            <span>Want a different model just for refinement? Install the ReDraft server plugin once — no extra server to run.</span>
                        </div>
                        <a id="redraft_plugin_install_link" href="#" class="menu_button" target="_blank" rel="noopener noreferrer">View install instructions</a>
                    </div>

                    <!-- Plugin mode: not installed / not restarted -->
                    <div id="redraft_plugin_unavailable_block" class="redraft-plugin-unavailable" style="display: none;">
                        <div class="redraft-unavailable-text">
                            <i class="fa-solid fa-plug-circle-xmark"></i>
                            <span>Plugin not detected. Install it once, then restart SillyTavern. Credentials are saved in the plugin (not in the browser).</span>
                        </div>
                        <a id="redraft_plugin_unavailable_link" href="#" class="menu_button" target="_blank" rel="noopener noreferrer">Install server plugin</a>
                    </div>

                    <!-- Plugin connection fields (shown only in plugin mode) -->
                    <div id="redraft_plugin_fields" style="display: none;">
                        <div class="redraft-form-group">
                            <label for="redraft_api_url">API URL</label>
                            <input id="redraft_api_url" type="text" class="text_pole"
                                placeholder="https://api.openai.com/v1" title="OpenAI-compatible endpoint (no trailing slash)" />
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_api_key">API Key</label>
                            <input id="redraft_api_key" type="password" class="text_pole" placeholder="sk-..."
                                autocomplete="off" />
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_model">Model</label>
                            <div class="redraft-model-picker">
                                <input id="redraft_model" type="text" class="text_pole" placeholder="gpt-4o-mini" title="e.g. gpt-4o-mini, claude-3-haiku" list="redraft_model_list" autocomplete="off" />
                                <datalist id="redraft_model_list"></datalist>
                                <select id="redraft_model_select" class="redraft-model-select" style="display:none;">
                                    <option value="" disabled selected>Click "Models" to load list</option>
                                </select>
                            </div>
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_max_tokens">Max Tokens</label>
                            <input id="redraft_max_tokens" type="number" class="text_pole" placeholder="4096" min="1"
                                max="128000" />
                        </div>
                        <div class="redraft-button-row">
                            <div id="redraft_save_connection" class="menu_button" title="Save API key (other fields auto-save). Credentials are stored on disk, not in browser.">
                                <i class="fa-solid fa-key"></i>
                                <span>Save Key</span>
                            </div>
                            <div id="redraft_test_connection" class="menu_button" title="Verify plugin is reachable and configured">
                                <i class="fa-solid fa-circle-check"></i>
                                <span>Test</span>
                            </div>
                            <div id="redraft_fetch_models" class="menu_button" title="Fetch available models from the API">
                                <i class="fa-solid fa-list"></i>
                                <span>Models</span>
                            </div>
                            <span id="redraft_connection_info" class="redraft-connection-info"></span>
                        </div>
                    </div>

                    <!-- ST mode info -->
                    <div id="redraft_st_mode_info" class="redraft-st-mode-info">
                        <small>Refinement will use your currently selected API and model in SillyTavern.</small>
                    </div>
                </div>
            </div>

            <!-- Rules Section (AI messages) -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Rules (AI Refine)</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="redraft-section-hint">Rules for refining AI-generated messages. User message enhancement has its own rules in the Enhance section below.</small>

                    <div class="redraft-rules-builtins">
                        <label class="checkbox_label" title="Fix grammatical errors, spelling mistakes, and awkward phrasing. Preserves intentional dialect, slang, and character-specific speech.">
                            <input type="checkbox" id="redraft_rule_grammar" />
                            <span>Fix grammar &amp; spelling</span>
                        </label>
                        <label class="checkbox_label" title="Remove sentences where the character restates or paraphrases the user's previous message instead of advancing the scene.">
                            <input type="checkbox" id="redraft_rule_echo" />
                            <span>Remove echo &amp; restatement</span>
                        </label>
                        <label class="checkbox_label" title="Reduce repeated gestures, sentence structures, and emotional beats within the response and compared to the previous one.">
                            <input type="checkbox" id="redraft_rule_repetition" />
                            <span>Reduce repetition</span>
                        </label>
                        <label class="checkbox_label" title="Ensure each character's dialogue is distinct and consistent with their established speech patterns and personality.">
                            <input type="checkbox" id="redraft_rule_voice" />
                            <span>Maintain character voice</span>
                        </label>
                        <label class="checkbox_label" title="Fix common AI prose weaknesses: somatic clichés, purple prose, filter words, and telling over showing.">
                            <input type="checkbox" id="redraft_rule_prose" />
                            <span>Clean up prose</span>
                        </label>
                        <label class="checkbox_label" title="Fix orphaned formatting marks, inconsistent style, and dialogue punctuation errors.">
                            <input type="checkbox" id="redraft_rule_formatting" />
                            <span>Fix formatting</span>
                        </label>
                        <label class="checkbox_label" title="Remove theatrical 'dismount' endings — crafted landing lines that make the response feel concluded instead of mid-scene.">
                            <input type="checkbox" id="redraft_rule_ending" />
                            <span>Fix crafted endings</span>
                        </label>
                        <label class="checkbox_label" title="Flag glaring contradictions with established character and world information. Won't invent new lore.">
                            <input type="checkbox" id="redraft_rule_lore" />
                            <span>Maintain lore consistency</span>
                        </label>
                    </div>

                    <hr />

                    <div class="redraft-custom-rules-header">
                        <label class="checkbox_label" style="margin:0;gap:4px;">
                            <input type="checkbox" id="redraft_custom_rules_toggle" title="Enable/disable all custom rules" />
                            <small>Custom Rules (ordered by priority)</small>
                        </label>
                        <div>
                            <div id="redraft_import_rules" class="menu_button menu_button_icon" title="Import rules from JSON">
                                <i class="fa-solid fa-file-import"></i>
                            </div>
                            <input type="file" id="redraft_import_rules_file" accept=".json" hidden />
                            <div id="redraft_export_rules" class="menu_button menu_button_icon" title="Export rules to JSON">
                                <i class="fa-solid fa-file-export"></i>
                            </div>
                            <div id="redraft_add_rule" class="menu_button menu_button_icon" title="Add custom rule">
                                <i class="fa-solid fa-plus"></i>
                            </div>
                        </div>
                    </div>

                    <div id="redraft_custom_rules_list" class="redraft-custom-rules-list">
                        <!-- Custom rules injected here by JS -->
                    </div>
                </div>
            </div>

            <!-- Enhance Section (User messages) -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Enhance (User Messages)</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <small class="redraft-section-hint" style="margin-bottom: 6px;">Enhance your own messages — fix grammar, match your persona voice, improve prose.</small>

                    <label class="checkbox_label" title="Show an Enhance button on your messages. Uses your persona page for character voice matching.">
                        <input type="checkbox" id="redraft_user_enhance" />
                        <span>Enable user message enhancement</span>
                    </label>

                    <div class="redraft-form-group" style="margin-top: 6px;">
                        <label for="redraft_user_enhance_mode">Enhancement Mode</label>
                        <select id="redraft_user_enhance_mode">
                            <option value="post">Post-send (enhance after message is sent)</option>
                            <option value="pre">Pre-send (enhance before AI sees your message)</option>
                        </select>
                    </div>
                    <small id="redraft_enhance_mode_hint" class="redraft-section-hint" style="margin-top: 2px; display: none;"></small>

                    <div id="redraft_post_send_options">
                        <label class="checkbox_label" title="Automatically enhance your messages right after you send them.">
                            <input type="checkbox" id="redraft_user_auto_enhance" />
                            <span>Auto-enhance after sending</span>
                        </label>
                    </div>

                    <hr style="margin: 8px 0; opacity: 0.2;" />
                    <small class="redraft-section-hint" style="margin-bottom: 4px;">Rules for enhancing user-written messages.</small>

                    <div class="redraft-rules-builtins">
                        <label class="checkbox_label" title="Fix grammatical errors, spelling mistakes, and awkward phrasing while respecting intentional character voice.">
                            <input type="checkbox" id="redraft_user_rule_grammar" />
                            <span>Fix grammar &amp; spelling</span>
                        </label>
                        <label class="checkbox_label" title="Match your writing to your character's established voice, register, and speech patterns using your persona description.">
                            <input type="checkbox" id="redraft_user_rule_personaVoice" />
                            <span>Match persona voice</span>
                        </label>
                        <label class="checkbox_label" title="Improve phrasing, smooth out clunky constructions, and add vividness without changing meaning.">
                            <input type="checkbox" id="redraft_user_rule_prose" />
                            <span>Improve prose</span>
                        </label>
                        <label class="checkbox_label" title="Fix orphaned formatting marks, ensure consistent conventions (asterisks for actions, quotes for dialogue).">
                            <input type="checkbox" id="redraft_user_rule_formatting" />
                            <span>Fix formatting</span>
                        </label>
                        <label class="checkbox_label" title="Check that your actions and references are consistent with the previous AI response and established scene.">
                            <input type="checkbox" id="redraft_user_rule_sceneContinuity" />
                            <span>Check scene continuity</span>
                        </label>
                        <label class="checkbox_label" title="If your message is very brief (1-2 sentences), expand it with sensory detail, body language, and interiority while preserving intent.">
                            <input type="checkbox" id="redraft_user_rule_expandBrevity" />
                            <span>Expand brief messages</span>
                        </label>
                    </div>

                    <hr />

                    <div class="redraft-custom-rules-header">
                        <label class="checkbox_label" style="margin:0;gap:4px;">
                            <input type="checkbox" id="redraft_user_custom_rules_toggle" title="Enable/disable all user custom rules" />
                            <small>Custom Rules (ordered by priority)</small>
                        </label>
                        <div>
                            <div id="redraft_user_import_rules" class="menu_button menu_button_icon" title="Import user enhance rules from JSON">
                                <i class="fa-solid fa-file-import"></i>
                            </div>
                            <input type="file" id="redraft_user_import_rules_file" accept=".json" hidden />
                            <div id="redraft_user_export_rules" class="menu_button menu_button_icon" title="Export user enhance rules to JSON">
                                <i class="fa-solid fa-file-export"></i>
                            </div>
                            <div id="redraft_user_add_rule" class="menu_button menu_button_icon" title="Add custom user enhance rule">
                                <i class="fa-solid fa-plus"></i>
                            </div>
                        </div>
                    </div>

                    <div id="redraft_user_custom_rules_list" class="redraft-custom-rules-list">
                        <!-- User custom rules injected here by JS -->
                    </div>

                    <hr style="margin: 8px 0; opacity: 0.2;" />

                    <div class="redraft-form-group">
                        <label for="redraft_user_system_prompt">System Prompt Override</label>
                        <textarea id="redraft_user_system_prompt" class="text_pole textarea_compact" rows="3"
                            style="resize:vertical;field-sizing:content;max-height:50vh;"
                            placeholder="Leave blank for default user enhancement prompt..."></textarea>
                    </div>
                </div>
            </div>

            <!-- Advanced Section -->
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <span>Advanced</span>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <div class="redraft-form-group redraft-pov-group">
                        <label for="redraft_pov">Point of View</label>
                        <select id="redraft_pov">
                            <option value="auto">Auto (no instruction)</option>
                            <option value="detect">Detect from message</option>
                            <option value="1st">1st person (I/me)</option>
                            <option value="1.5">1.5th person (I + you)</option>
                            <option value="2nd">2nd person (you)</option>
                            <option value="3rd">3rd person (he/she/they)</option>
                        </select>
                    </div>
                    <div class="redraft-form-group">
                        <label for="redraft_character_context_chars">Character context (chars)</label>
                        <select id="redraft_character_context_chars">
                            <option value="500">500</option>
                            <option value="1000">1000</option>
                            <option value="2000">2000</option>
                        </select>
                    </div>
                    <div class="redraft-form-group">
                        <label for="redraft_previous_response_tail">Previous response tail (chars)</label>
                        <select id="redraft_previous_response_tail">
                            <option value="100">100</option>
                            <option value="200">200</option>
                            <option value="400">400</option>
                        </select>
                    </div>
                    <label class="checkbox_label">
                        <input type="checkbox" id="redraft_protect_font_tags" />
                        <span>Protect font/color tags</span>
                    </label>
                    <div class="redraft-form-group">
                        <label for="redraft_system_prompt">System Prompt Override (AI messages)</label>
                        <textarea id="redraft_system_prompt" class="text_pole textarea_compact" rows="3"
                            style="resize:vertical;field-sizing:content;max-height:50vh;"
                            placeholder="Leave blank for default refinement prompt..."></textarea>
                    </div>
                </div>
            </div>

        </div>
    </div>
</div>

<!-- Floating Popout Panel (injected near bottom of body by JS) -->
<div id="redraft_popout_panel" class="redraft-popout-panel" style="display: none;">
    <div class="redraft-popout-header">
        <span class="redraft-popout-title">ReDraft</span>
        <div id="redraft_popout_close" class="dragClose" title="Close">
            <i class="fa-solid fa-xmark"></i>
        </div>
    </div>
    <div class="redraft-popout-body">
        <label class="checkbox_label">
            <input type="checkbox" id="redraft_popout_auto" />
            <span>Auto-refine</span>
        </label>
        <div class="redraft-popout-pov">
            <small>PoV</small>
            <select id="redraft_popout_pov">
                <option value="auto">Auto</option>
                <option value="detect">Detect</option>
                <option value="1st">1st</option>
                <option value="1.5">1.5th</option>
                <option value="2nd">2nd</option>
                <option value="3rd">3rd</option>
            </select>
        </div>
        <div id="redraft_popout_status" class="redraft-popout-status"></div>
        <div id="redraft_popout_refine" class="menu_button">
            <i class="fa-solid fa-pen-nib"></i>
            <span>Refine Last AI Message</span>
        </div>
        <div id="redraft_popout_enhance_user" class="menu_button">
            <i class="fa-solid fa-wand-magic-sparkles"></i>
            <span>Enhance Last User Message</span>
        </div>
        <div id="redraft_popout_open_settings" class="menu_button">
            <i class="fa-solid fa-gear"></i>
            <span>Full Settings</span>
        </div>
    </div>
</div>`;

    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);

        // Move popout panel to body for proper positioning
        const popout = document.getElementById('redraft_popout_panel');
        if (popout) document.body.appendChild(popout);
    }

    // Initialize settings and bind UI
    getSettings();
    bindSettingsUI();

    // Create floating popout trigger
    createPopoutTrigger();

    // First-run hint — show once to help users find the popout
    const initSettings = getSettings();
    if (!initSettings.hasSeenHint) {
        toastr.info(
            'Use the ✏️ button in the bottom-right corner to quickly refine messages, toggle auto-refine, and adjust settings.',
            'ReDraft — Tip',
            { timeOut: 8000, extendedTimeOut: 4000, positionClass: 'toast-bottom-right' }
        );
        initSettings.hasSeenHint = true;
        saveSettings();
    }

    // Check plugin status
    await checkPluginStatus();

    // Register events
    eventListenerRefs.messageRendered = () => onMessageRendered();
    eventListenerRefs.charMessageRendered = (idx) => onCharacterMessageRendered(idx);
    eventListenerRefs.userMessageRendered = (idx) => onUserMessageRendered(idx);
    eventListenerRefs.chatChanged = () => onChatChanged();

    eventSource.on(event_types.USER_MESSAGE_RENDERED, eventListenerRefs.messageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, eventListenerRefs.userMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, eventListenerRefs.charMessageRendered);
    eventSource.on(event_types.CHAT_CHANGED, eventListenerRefs.chatChanged);

    // Add buttons to any existing messages
    addMessageButtons();

    // Register slash command
    registerSlashCommand();

    console.log(`${LOG_PREFIX} Loaded successfully (mode: ${getSettings().connectionMode})`);
})();
