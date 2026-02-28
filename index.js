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
import {
    buildAiRefinePrompt as _buildAiRefinePrompt,
    buildUserEnhancePrompt as _buildUserEnhancePrompt,
    POV_INSTRUCTIONS,
    USER_POV_INSTRUCTIONS,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_USER_ENHANCE_SYSTEM_PROMPT,
} from './lib/prompt-builder.js';
import {
    resolveUserMessageIndex,
    categorizeRefinementError,
} from './lib/message-utils.js';
import { executeStrategy } from './lib/swarm/executor.js';
import { resolveStrategyConfig, STRATEGY_TYPES, STRATEGY_META, DEFAULT_PIPELINE_STAGES, MIN_COUNCIL_SIZE, MAX_COUNCIL_SIZE } from './lib/swarm/strategies.js';

const MODULE_NAME = 'redraft';
const LOG_PREFIX = '[ReDraft]';
/** Extension version (semver). Bump when releasing client/UI changes. */
const EXTENSION_VERSION = '3.0.0';

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
    userEnhanceMode: 'post', // 'pre' (intercept before generation), 'post' (enhance after render), or 'inplace' (enhance in textarea before sending)
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
    userPov: '1st', // '1st' | 'auto' | 'detect' | '2nd' | '3rd'
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
    requestTimeoutSeconds: 120,
    reasoningContext: false,
    reasoningContextMode: 'tags', // 'tags' (extract XML tags) or 'raw' (truncated pass-through)
    reasoningContextChars: 1000,
    reasoningContextRawFallback: true, // in 'tags' mode, fall back to raw if no tags found
    sidebarOpen: false,
    sidebarActiveTab: 'refine', // 'refine' | 'history' | 'stats' | 'swarm'
    sidebarWidth: 380,
    bulkDelayMs: 2000,
    swarmEnabled: false,
    swarmStrategy: 'pipeline',  // 'pipeline' | 'council' | 'review'
    swarmPipelineStages: [
        { id: 'grammar', name: 'Grammar & Formatting', rules: ['grammar', 'formatting'], enabled: true },
        { id: 'prose', name: 'Prose & Voice', rules: ['prose', 'voice', 'echo'], enabled: true },
        { id: 'continuity', name: 'Continuity & Flow', rules: ['repetition', 'ending', 'lore'], enabled: true },
    ],
    swarmCouncilSize: 3,
    swarmCouncilJudgeMode: 'synthesize', // 'pick_best' | 'synthesize'
    swarmCouncilModelOverrides: {},      // { agentId: modelString } plugin mode only
    swarmTimeoutSeconds: 180,            // per-agent timeout for swarm calls (longer than default to handle slower models)
});

// POV_INSTRUCTIONS imported from ./lib/prompt-builder.js

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

// DEFAULT_SYSTEM_PROMPT imported from ./lib/prompt-builder.js

// DEFAULT_USER_ENHANCE_SYSTEM_PROMPT imported from ./lib/prompt-builder.js

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
let isBulkRefining = false; // Bulk-refine guard (prevents single-refine during batch)
let bulkCancelled = false; // Set to true to stop the bulk loop after current message
let activeAbortController = null; // AbortController for the in-flight refinement request
let pluginAvailable = false; // Whether server plugin is reachable
let eventListenerRefs = {}; // For cleanup
function cancelRedraft() {
    if (activeAbortController) {
        activeAbortController.abort();
        activeAbortController = null;
    }
}

/**
 * Close the sidebar panel and persist the closed state.
 */
function closeSidebar() {
    const panel = document.getElementById('redraft_sidebar');
    if (panel) panel.classList.remove('redraft-sidebar-open');
    const settings = getSettings();
    settings.sidebarOpen = false;
    saveSettings();
}

/**
 * Open the sidebar panel and persist the open state.
 */
function openSidebar() {
    const panel = document.getElementById('redraft_sidebar');
    if (!panel) return;
    panel.classList.add('redraft-sidebar-open');
    syncSidebarControls();
    refreshActiveTab();
    const settings = getSettings();
    settings.sidebarOpen = true;
    saveSettings();
}

function toggleSidebar() {
    const panel = document.getElementById('redraft_sidebar');
    if (!panel) return;
    if (panel.classList.contains('redraft-sidebar-open')) {
        closeSidebar();
    } else {
        openSidebar();
    }
}

/**
 * Sync all sidebar quick-control values with current settings.
 */
function syncSidebarControls() {
    const settings = getSettings();
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val; };
    const setChk = (id, val) => { const el = document.getElementById(id); if (el) el.checked = val; };

    setChk('redraft_sb_auto', settings.autoRefine);
    setVal('redraft_sb_pov', settings.pov || 'auto');
    setChk('redraft_sb_user_auto', settings.userAutoEnhance);
    setVal('redraft_sb_user_pov', settings.userPov || '1st');
    setVal('redraft_sb_enhance_mode', settings.userEnhanceMode || 'post');

    updateSidebarStatus();
}

/**
 * Refresh whichever tab is currently active.
 */
function refreshActiveTab() {
    const settings = getSettings();
    const tab = settings.sidebarActiveTab || 'refine';
    if (tab === 'refine') renderMessagePicker();
    else if (tab === 'history') renderHistoryTab();
    else if (tab === 'stats') renderStatsTab();
    else if (tab === 'swarm') renderSwarmTab();
}

// Global keydown handler for ESC
function onGlobalKeydown(e) {
    if (e.key !== 'Escape') return;
    const diffOverlay = document.getElementById('redraft_diff_overlay');
    if (diffOverlay) { closeDiffPopup(); return; }
    const sidebar = document.getElementById('redraft_sidebar');
    if (sidebar && sidebar.classList.contains('redraft-sidebar-open')) { closeSidebar(); }
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

// ─── Refinement History & Batch Metadata ─────────────────────────────

/**
 * Append an entry to the refinement history log stored in chatMetadata.
 * @param {object} entry
 * @param {number} entry.messageIndex
 * @param {string} entry.messageType - 'ai' | 'user'
 * @param {boolean} entry.success
 * @param {number} [entry.durationMs]
 * @param {object} [entry.wordDelta] - { deleted, inserted }
 * @param {string|null} [entry.batchId]
 */
async function appendHistoryEntry(entry) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    if (!chatMetadata['redraft_history']) {
        chatMetadata['redraft_history'] = [];
    }
    const history = chatMetadata['redraft_history'];
    const seq = history.filter(h => h.timestamp === Date.now()).length;
    history.push({
        id: `${Date.now()}-${seq}`,
        messageIndex: entry.messageIndex,
        messageType: entry.messageType,
        timestamp: Date.now(),
        batchId: entry.batchId ?? null,
        success: entry.success,
        durationMs: entry.durationMs ?? 0,
        wordDelta: entry.wordDelta ?? { deleted: 0, inserted: 0 },
    });
    await saveMetadata();
}

/**
 * Record a completed batch run in chatMetadata.
 * @param {string} batchId
 * @param {object} data
 * @param {number} data.timestamp
 * @param {number[]} data.indices - Message indices that were targeted
 * @param {object} data.results - { success, failed, skipped }
 */
async function recordBatch(batchId, data) {
    const { chatMetadata, saveMetadata } = SillyTavern.getContext();
    if (!chatMetadata['redraft_batches']) {
        chatMetadata['redraft_batches'] = {};
    }
    chatMetadata['redraft_batches'][batchId] = data;
    await saveMetadata();
}

/**
 * Get the refinement history for the current chat.
 * @returns {Array}
 */
function getHistoryForChat() {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata['redraft_history'] || [];
}

/**
 * Get all batch records for the current chat.
 * @returns {Object}
 */
function getBatchesForChat() {
    const { chatMetadata } = SillyTavern.getContext();
    return chatMetadata['redraft_batches'] || {};
}

/**
 * Undo all messages in a batch, calling undoRedraft for each that still has an original.
 * @param {string} batchId
 * @returns {Promise<number>} Number of messages actually undone
 */
async function undoBatch(batchId) {
    const batches = getBatchesForChat();
    const batch = batches[batchId];
    if (!batch) return 0;

    const { chatMetadata } = SillyTavern.getContext();
    const originals = chatMetadata['redraft_originals'] || {};
    let undoneCount = 0;

    for (const idx of batch.indices) {
        if (originals[idx] !== undefined) {
            await undoRedraft(idx);
            undoneCount++;
        }
    }

    return undoneCount;
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
async function pluginRequest(endpoint, method = 'GET', body = null, { signal } = {}) {
    const { getRequestHeaders } = SillyTavern.getContext();
    const options = {
        method,
        credentials: 'same-origin', // send cookies so auth/session is sent on multi-user instances
        headers: getRequestHeaders ? getRequestHeaders() : { 'Content-Type': 'application/json' },
    };
    if (body) {
        options.body = JSON.stringify(body);
    }
    if (signal) {
        options.signal = signal;
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
                hint = ' 502 Bad Gateway — your reverse proxy may have timed out before ST could respond. Check the SillyTavern terminal for the real error. If you use Caddy/nginx, increase the proxy timeout to at least 180s (thinking models can be slow).';
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
        } else if (mode === 'inplace') {
            modeHint.textContent = 'Use the \u2728 button next to the send area to enhance your message while it\u2019s still in the text box. You can review and edit before sending.';
            modeHint.style.display = '';
        } else {
            modeHint.textContent = '';
            modeHint.style.display = 'none';
        }
    }

    updateTextareaEnhanceButton(mode);
}

// ─── Core Refinement (Dual-Mode) ────────────────────────────────────

/**
 * Send refinement request via ST's generateRaw().
 */
async function refineViaST(promptText, systemPrompt, { signal, model } = {}) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const { generateRaw } = SillyTavern.getContext();
    if (typeof generateRaw !== 'function') {
        throw new Error('generateRaw is not available in this version of SillyTavern');
    }

    const result = await generateRaw({ prompt: promptText, systemPrompt: systemPrompt });

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    if (!result || typeof result !== 'string' || !result.trim()) {
        throw new Error('ST generated an empty response');
    }

    return result.trim();
}

/**
 * Send refinement request via server plugin.
 */
async function refineViaPlugin(promptText, systemPrompt, { signal, model, timeout: timeoutOverride } = {}) {
    const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: promptText },
    ];

    const timeout = timeoutOverride || (getSettings().requestTimeoutSeconds ?? 120);
    const body = { messages, timeout };
    if (model) body.model = model;
    const result = await pluginRequest('/refine', 'POST', body, { signal });

    if (!result.text || !result.text.trim()) {
        throw new Error('Plugin returned an empty response');
    }

    return result.text.trim();
}

/**
 * Build the full prompt and system prompt for user-message enhancement.
 * Resolves globals (rulesText, personaDesc, systemPrompt) and delegates to
 * the pure implementation in lib/prompt-builder.js.
 */
function buildUserEnhancePrompt(settings, context, chatArray, messageIndex, strippedMessage) {
    return _buildUserEnhancePrompt(settings, context, chatArray, messageIndex, strippedMessage, {
        rulesText: compileUserRules(settings),
        personaDesc: getUserPersonaDescription(),
        systemPrompt: settings.userSystemPrompt?.trim() || DEFAULT_USER_ENHANCE_SYSTEM_PROMPT,
    });
}

// ─── Core Refinement Pipeline ────────────────────────────────────────

/**
 * Core refinement pipeline shared by single-refine and bulk-refine.
 * Handles: save original, strip blocks, build prompt, call LLM, parse changelog,
 * restore blocks, update message, save chat, re-render, persist diff metadata,
 * show undo/diff buttons.
 *
 * Does NOT manage: isRefining guard, toasts, abort controller lifecycle,
 * sidebar/trigger loading state, or notification sound.
 *
 * @param {number} messageIndex Index in context.chat
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal] Abort signal for cancellation
 * @param {object} [opts.overrides] Per-batch setting overrides
 * @param {boolean} [opts.showDiff=true] Whether to auto-show the diff popup
 * @returns {Promise<{durationMs: number, wordDelta: {deleted: number, inserted: number}}>}
 */
async function _refineMessageCore(messageIndex, { signal, overrides, showDiff = true } = {}) {
    const context = SillyTavern.getContext();
    const { chat, saveChat, chatMetadata, saveMetadata } = context;
    const message = chat[messageIndex];
    const settings = getSettings();
    const refineStartTime = Date.now();

    if (!chatMetadata['redraft_originals']) {
        chatMetadata['redraft_originals'] = {};
    }
    chatMetadata['redraft_originals'][messageIndex] = message.mes;
    await saveMetadata();

    const { stripped: strippedMessage, blocks: protectedBlocks } = stripProtectedBlocks(message.mes, {
        protectFontTags: settings.protectFontTags,
    });

    const isUserMessage = !!message.is_user;
    let systemPrompt;
    let promptText;

    if (isUserMessage) {
        const effectiveSettings = overrides
            ? { ...settings, ..._applyUserOverrides(settings, overrides) }
            : settings;
        ({ systemPrompt, promptText } = buildUserEnhancePrompt(
            effectiveSettings, context, chat, messageIndex, strippedMessage,
        ));
        console.debug(`${LOG_PREFIX} Enhancing user message ${messageIndex}`);
    } else {
        const reasoning = settings.reasoningContext ? (message.extra?.reasoning || '') : '';
        ({ systemPrompt, promptText } = _buildAiRefinePrompt(
            settings, context, chat, messageIndex, strippedMessage, {
                rulesText: overrides?.rulesText ?? compileRules(settings),
                systemPrompt: overrides?.systemPrompt ?? (settings.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT),
                reasoning,
            },
        ));
    }

    const actionVerb = isUserMessage ? 'enhancement' : 'refinement';
    console.debug(`${LOG_PREFIX} [prompt] System prompt (${systemPrompt.length} chars):`, systemPrompt.substring(0, 200) + '\u2026');
    console.debug(`${LOG_PREFIX} [prompt] Full ${actionVerb} prompt (${promptText.length} chars):`);
    console.debug(promptText);

    let refinedText;
    if (settings.connectionMode === 'plugin') {
        refinedText = await refineViaPlugin(promptText, systemPrompt, { signal });
    } else {
        refinedText = await refineViaST(promptText, systemPrompt, { signal });
    }

    const { changelog, refined: cleanRefined } = parseChangelog(refinedText);
    if (changelog) {
        console.log(`${LOG_PREFIX} [changelog]`, changelog);
    }

    refinedText = restoreProtectedBlocks(cleanRefined, protectedBlocks);
    const originalText = message.mes;
    message.mes = refinedText;
    await saveChat();

    rerenderMessage(messageIndex);

    if (!chatMetadata['redraft_diffs']) chatMetadata['redraft_diffs'] = {};
    chatMetadata['redraft_diffs'][messageIndex] = { original: originalText, changelog: changelog || null };
    await saveMetadata();

    showUndoButton(messageIndex);
    showDiffButton(messageIndex, originalText, refinedText, changelog);

    if (showDiff && settings.showDiffAfterRefine) {
        showDiffPopup(originalText, refinedText, changelog);
    }

    const durationMs = Date.now() - refineStartTime;
    console.log(`${LOG_PREFIX} Message ${messageIndex} refined successfully (mode: ${settings.connectionMode}) in ${(durationMs / 1000).toFixed(1)}s`);

    const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;
    const oldWords = countWords(originalText);
    const newWords = countWords(refinedText);

    return {
        durationMs,
        wordDelta: { deleted: Math.max(0, oldWords - newWords), inserted: Math.max(0, newWords - oldWords) },
    };
}

/**
 * Refine a message using swarm multi-agent strategies.
 * Mirrors _refineMessageCore pattern: save original, strip blocks, call swarm,
 * restore blocks, update message, save, re-render, persist metadata.
 */
async function _refineMessageSwarm(messageIndex, { signal, overrides, showDiff = true } = {}) {
    const context = SillyTavern.getContext();
    const { chat, saveChat, chatMetadata, saveMetadata } = context;
    const message = chat[messageIndex];
    const settings = getSettings();
    const refineStartTime = Date.now();

    if (!chatMetadata['redraft_originals']) {
        chatMetadata['redraft_originals'] = {};
    }
    chatMetadata['redraft_originals'][messageIndex] = message.mes;
    await saveMetadata();

    const { stripped: strippedMessage, blocks: protectedBlocks } = stripProtectedBlocks(message.mes, {
        protectFontTags: settings.protectFontTags,
    });

    const strategyConfig = resolveStrategyConfig(settings);

    const contextParts = [];
    const char = context.characters?.[context.characterId];
    const charLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
    const charDesc = char?.data?.personality
        || char?.data?.description?.substring(0, charLimit)
        || '';

    if (context.name2 || charDesc) {
        contextParts.push(`Character: ${context.name2 || 'Unknown'}${charDesc ? ' \u2014 ' + charDesc : ''}`);
    }
    if (context.name1) {
        contextParts.push(`User character: ${context.name1}`);
    }

    const messagesBeforeThis = chat.slice(0, messageIndex);
    const lastUserMsgBefore = [...messagesBeforeThis].reverse().find(m => m.is_user && m.mes);
    if (lastUserMsgBefore) {
        contextParts.push(`Last user message:\n${lastUserMsgBefore.mes}`);
    }

    const contextBlock = contextParts.length > 0
        ? `Context:\n${contextParts.join('\n\n')}`
        : '';

    const fullRulesText = overrides?.rulesText ?? compileRules(settings);
    const refineFn = settings.connectionMode === 'plugin' ? refineViaPlugin : refineViaST;

    console.log(`${LOG_PREFIX} [swarm] Starting ${strategyConfig.type} strategy for message ${messageIndex}`);

    const { refinedRaw, agentLog } = await executeStrategy({
        strategyConfig,
        messageText: strippedMessage,
        contextBlock,
        fullRulesText,
        allBuiltInRules: BUILTIN_RULES,
        settings,
        refineFn,
        signal,
        timeoutSeconds: settings.swarmTimeoutSeconds || 180,
        onProgress: (progress) => {
            console.debug(`${LOG_PREFIX} [swarm] ${progress.phase}: ${progress.agentName} [${progress.status}] (${progress.current}/${progress.total})`);
            updateSwarmProgress(progress);
        },
    });

    const { changelog, refined: cleanRefined } = parseChangelog(refinedRaw);
    if (changelog) {
        console.log(`${LOG_PREFIX} [swarm] [changelog]`, changelog);
    }

    const refinedText = restoreProtectedBlocks(cleanRefined, protectedBlocks);
    const originalText = message.mes;
    message.mes = refinedText;
    await saveChat();

    rerenderMessage(messageIndex);

    if (!chatMetadata['redraft_diffs']) chatMetadata['redraft_diffs'] = {};
    chatMetadata['redraft_diffs'][messageIndex] = { original: originalText, changelog: changelog || null };
    await saveMetadata();

    showUndoButton(messageIndex);
    showDiffButton(messageIndex, originalText, refinedText, changelog);

    if (showDiff && settings.showDiffAfterRefine) {
        showDiffPopup(originalText, refinedText, changelog);
    }

    const durationMs = Date.now() - refineStartTime;
    const totalAgentTime = agentLog.reduce((sum, a) => sum + a.durationMs, 0);
    console.log(`${LOG_PREFIX} [swarm] ${strategyConfig.type} complete: ${agentLog.length} agents, ${(totalAgentTime / 1000).toFixed(1)}s agent time, ${(durationMs / 1000).toFixed(1)}s wall time`);

    const countWords = (text) => text.trim().split(/\s+/).filter(Boolean).length;
    const oldWords = countWords(originalText);
    const newWords = countWords(refinedText);

    return {
        durationMs,
        wordDelta: { deleted: Math.max(0, oldWords - newWords), inserted: Math.max(0, newWords - oldWords) },
        agentLog,
    };
}

/**
 * Apply user-message overrides to settings for buildUserEnhancePrompt.
 */
function _applyUserOverrides(_settings, overrides) {
    const patch = {};
    if (overrides.userPov) patch.userPov = overrides.userPov;
    if (overrides.userSystemPrompt) patch.userSystemPrompt = overrides.userSystemPrompt;
    return patch;
}

/**
 * Refine a message at the given index.
 * @param {number} messageIndex Index in context.chat
 */
async function redraftMessage(messageIndex) {
    if (isRefining || isBulkRefining) {
        if (isRefining) cancelRedraft();
        return;
    }

    const context = SillyTavern.getContext();
    const { chat } = context;

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

    if (settings.connectionMode === 'plugin' && !pluginAvailable) {
        toastr.error(
            'ReDraft server plugin is not available. Install it once (see Install server plugin in ReDraft settings), then restart SillyTavern.',
            'ReDraft',
            { timeOut: 8000 }
        );
        return;
    }

    isRefining = true;
    activeAbortController = new AbortController();
    const { signal } = activeAbortController;
    const refineStartTime = Date.now();
    setSidebarTriggerLoading(true);

    hideUndoButton(messageIndex);
    hideDiffButton(messageIndex);

    const isUserMessage = !!message.is_user;
    setMessageButtonLoading(messageIndex, true);
    toastr.info(isUserMessage ? 'Enhancing message\u2026' : 'Refining message\u2026', 'ReDraft');

    const useSwarm = settings.swarmEnabled && !isUserMessage;

    try {
        const result = useSwarm
            ? await _refineMessageSwarm(messageIndex, { signal })
            : await _refineMessageCore(messageIndex, { signal });

        toastr.success(
            isUserMessage ? 'Message enhanced' : (useSwarm ? `Message refined (${settings.swarmStrategy})` : 'Message refined'),
            'ReDraft',
        );
        playNotificationSound();
        refineSucceeded = true;
        setSidebarTriggerLoading(false, result.durationMs);

        appendHistoryEntry({
            messageIndex,
            messageType: isUserMessage ? 'user' : 'ai',
            success: true,
            durationMs: result.durationMs,
            wordDelta: result.wordDelta,
            swarmStrategy: useSwarm ? settings.swarmStrategy : undefined,
        });
    } catch (err) {
        if (err.name === 'AbortError') {
            toastr.info('Drafting stopped', 'ReDraft');
        } else {
            console.error(`${LOG_PREFIX} Refinement failed:`, err.message);
            const { toastMessage, timeOut } = categorizeRefinementError(err.message);
            toastr.error(toastMessage, 'ReDraft', { timeOut });
        }
    } finally {
        isRefining = false;
        activeAbortController = null;
        setMessageButtonLoading(messageIndex, false);
        clearSwarmProgress();
        if (!refineSucceeded) {
            setSidebarTriggerLoading(false);
        }
    }
}

/**
 * Enhance the text currently in SillyTavern's send textarea without sending.
 * Replaces the textarea content with the enhanced version so the user can
 * review and edit before sending.
 */
async function enhanceTextarea() {
    if (isRefining || isBulkRefining) {
        if (isRefining) cancelRedraft();
        return;
    }

    const textarea = document.getElementById('send_textarea');
    if (!textarea) {
        toastr.error('Could not find the message textarea', 'ReDraft');
        return;
    }

    const originalText = textarea.value.trim();
    if (!originalText) {
        toastr.warning('Type a message first', 'ReDraft');
        return;
    }

    if (originalText.length < 10) {
        toastr.info('Message too short to enhance', 'ReDraft');
        return;
    }

    const settings = getSettings();

    if (settings.connectionMode === 'plugin' && !pluginAvailable) {
        toastr.error(
            'ReDraft server plugin is not available. Install it once (see Install server plugin in ReDraft settings), then restart SillyTavern.',
            'ReDraft',
            { timeOut: 8000 }
        );
        return;
    }

    isRefining = true;
    activeAbortController = new AbortController();
    const { signal } = activeAbortController;
    const refineStartTime = Date.now();
    setSidebarTriggerLoading(true);
    setTextareaEnhanceButtonLoading(true);
    toastr.info('Enhancing message\u2026', 'ReDraft');

    try {
        const { stripped, blocks } = stripProtectedBlocks(originalText, {
            protectFontTags: settings.protectFontTags,
        });

        const context = SillyTavern.getContext();
        const chat = context.chat || [];

        const { systemPrompt, promptText } = buildUserEnhancePrompt(
            settings, context, chat, chat.length, stripped
        );

        let refinedText;
        if (settings.connectionMode === 'plugin') {
            refinedText = await refineViaPlugin(promptText, systemPrompt, { signal });
        } else {
            refinedText = await refineViaST(promptText, systemPrompt, { signal });
        }

        const { changelog, refined: cleanRefined } = parseChangelog(refinedText);
        if (changelog) {
            console.log(`${LOG_PREFIX} [inplace] Changelog:`, changelog);
        }

        refinedText = restoreProtectedBlocks(cleanRefined, blocks);

        textarea.value = refinedText;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';

        const refineMs = Date.now() - refineStartTime;
        toastr.success('Message enhanced \u2014 review and send when ready', 'ReDraft');
        playNotificationSound();
        setSidebarTriggerLoading(false, refineMs);
        console.log(`${LOG_PREFIX} [inplace] Textarea enhanced in ${(refineMs / 1000).toFixed(1)}s`);

        if (settings.showDiffAfterRefine) {
            showDiffPopup(originalText, refinedText, changelog);
        }
    } catch (err) {
        if (err.name === 'AbortError') {
            toastr.info('Enhancement stopped', 'ReDraft');
        } else {
            console.error(`${LOG_PREFIX} [inplace] Enhancement failed:`, err.message);
            const { toastMessage, timeOut } = categorizeRefinementError(err.message);
            toastr.error(toastMessage, 'ReDraft', { timeOut });
        }
    } finally {
        isRefining = false;
        activeAbortController = null;
        setSidebarTriggerLoading(false);
        setTextareaEnhanceButtonLoading(false);
    }
}

/**
 * Show or hide the textarea enhance button based on the current mode.
 * Creates the button if it doesn't exist yet.
 */
function updateTextareaEnhanceButton(mode) {
    const settings = getSettings();
    const shouldShow = mode === 'inplace' && settings.enabled && settings.userEnhanceEnabled;
    let btn = document.getElementById('redraft_textarea_enhance');

    if (shouldShow && !btn) {
        btn = document.createElement('div');
        btn.id = 'redraft_textarea_enhance';
        btn.className = 'menu_button interactable redraft-textarea-enhance-btn';
        btn.title = 'Enhance message (ReDraft)';
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        btn.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            enhanceTextarea();
        }, 500, { leading: true, trailing: false }));

        const sendForm = document.getElementById('rightSendForm') || document.getElementById('send_but_sheld')?.parentElement;
        if (sendForm) {
            sendForm.insertBefore(btn, sendForm.firstChild);
        } else {
            const textarea = document.getElementById('send_textarea');
            if (textarea?.parentElement) {
                textarea.parentElement.appendChild(btn);
            }
        }
    }

    if (btn) {
        btn.style.display = shouldShow ? '' : 'none';
    }

    const sidebarTextareaBtn = document.getElementById('redraft_sb_enhance_textarea');
    if (sidebarTextareaBtn) {
        sidebarTextareaBtn.style.display = shouldShow ? '' : 'none';
    }
}

function setTextareaEnhanceButtonLoading(loading) {
    const btn = document.getElementById('redraft_textarea_enhance');
    if (!btn) return;
    if (loading) {
        btn.classList.add('redraft-textarea-loading');
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        btn.title = 'Enhancing\u2026 click to cancel';
    } else {
        btn.classList.remove('redraft-textarea-loading');
        btn.innerHTML = '<i class="fa-solid fa-wand-magic-sparkles"></i>';
        btn.title = 'Enhance message (ReDraft)';
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
    const msg = context.chat[messageIndex];
    if (!msg) return;

    const mesBlock = document.querySelector(`.mes[mesid="${messageIndex}"] .mes_text`);
    if (!mesBlock) return;

    const { messageFormatting } = context;
    if (typeof messageFormatting === 'function') {
        mesBlock.innerHTML = messageFormatting(msg.mes, msg.name, !!msg.is_system, !!msg.is_user, messageIndex);
    } else {
        mesBlock.textContent = msg.mes;
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
        btn.innerHTML = '<i class="fa-solid fa-circle-stop"></i>';
        btn.title = 'Stop drafting';
    } else {
        btn.classList.remove('redraft-loading');
        btn.innerHTML = isEnhance
            ? '<i class="fa-solid fa-wand-magic-sparkles"></i>'
            : '<i class="fa-solid fa-pen-nib"></i>';
    }
}

let _triggerDurationTimeout = null;

function setSidebarTriggerLoading(loading, lastDurationMs) {
    const trigger = document.getElementById('redraft_sidebar_trigger');
    if (!trigger) return;
    if (loading) {
        if (_triggerDurationTimeout) {
            clearTimeout(_triggerDurationTimeout);
            _triggerDurationTimeout = null;
        }
        trigger.classList.add('redraft-refining');
        trigger.classList.remove('redraft-show-duration');
        trigger.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        trigger.title = 'Click to stop drafting';
    } else {
        trigger.classList.remove('redraft-refining');
        if (typeof lastDurationMs === 'number' && lastDurationMs >= 0) {
            const sec = lastDurationMs / 1000;
            const durationText = sec >= 10 ? `${Math.round(sec)}s` : sec % 1 === 0 ? `${sec}s` : `${sec.toFixed(1)}s`;
            trigger.classList.add('redraft-show-duration');
            trigger.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-trigger-duration">' + durationText + '</span><span class="redraft-auto-dot"></span>';
            trigger.title = `ReDraft \u2014 last refine: ${durationText}`;
            updateSidebarAutoState();
            if (_triggerDurationTimeout) clearTimeout(_triggerDurationTimeout);
            _triggerDurationTimeout = setTimeout(() => {
                _triggerDurationTimeout = null;
                const t = document.getElementById('redraft_sidebar_trigger');
                if (t && !t.classList.contains('redraft-refining')) {
                    t.classList.remove('redraft-show-duration');
                    t.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-auto-dot"></span>';
                    t.title = 'ReDraft';
                    updateSidebarAutoState();
                }
            }, 15000);
        } else {
            trigger.classList.remove('redraft-show-duration');
            trigger.innerHTML = '<i class="fa-solid fa-pen-nib"></i><span class="redraft-auto-dot"></span>';
            trigger.title = 'ReDraft';
            updateSidebarAutoState();
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
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'ReDraft diff viewer');
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

// ─── Sidebar ────────────────────────────────────────────────────────

const SIDEBAR_MIN_WIDTH = 280;
const SIDEBAR_MAX_WIDTH = 600;

function createSidebarTrigger() {
    if (document.getElementById('redraft_sidebar_trigger')) return;

    const trigger = document.createElement('div');
    trigger.id = 'redraft_sidebar_trigger';
    trigger.classList.add('redraft-sidebar-trigger');
    trigger.title = 'ReDraft';
    trigger.setAttribute('role', 'button');
    trigger.setAttribute('tabindex', '0');
    trigger.setAttribute('aria-label', 'Open ReDraft Workbench');
    trigger.innerHTML = `
        <i class="fa-solid fa-pen-nib"></i>
        <span class="redraft-auto-dot"></span>
    `;
    trigger.addEventListener('click', toggleSidebar);
    trigger.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleSidebar();
        }
    });
    document.body.appendChild(trigger);

    updateSidebarAutoState();
}

function initSidebarResize() {
    const handle = document.getElementById('redraft_sidebar_resize');
    const panel = document.getElementById('redraft_sidebar');
    if (!handle || !panel) return;

    let startX, startW, resizing = false;

    handle.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        resizing = true;
        panel.classList.add('redraft-sidebar-resizing');
        startX = e.clientX;
        startW = panel.getBoundingClientRect().width;
        handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
        if (!resizing) return;
        const dx = startX - e.clientX;
        const newW = Math.min(Math.max(startW + dx, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);
        panel.style.width = newW + 'px';
    });

    handle.addEventListener('pointerup', () => {
        if (!resizing) return;
        resizing = false;
        panel.classList.remove('redraft-sidebar-resizing');
        const s = getSettings();
        s.sidebarWidth = Math.round(panel.getBoundingClientRect().width);
        saveSettings();
    });
}

function switchTab(tabName) {
    const tabs = document.querySelectorAll('.redraft-sidebar-tab');
    const contents = document.querySelectorAll('.redraft-sidebar-tab-content');
    tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    contents.forEach(c => c.classList.toggle('active', c.dataset.tab === tabName));

    const s = getSettings();
    s.sidebarActiveTab = tabName;
    saveSettings();

    if (tabName === 'refine') renderMessagePicker();
    else if (tabName === 'history') renderHistoryTab();
    else if (tabName === 'stats') renderStatsTab();
    else if (tabName === 'swarm') renderSwarmTab();
}

function updateSidebarAutoState() {
    const trigger = document.getElementById('redraft_sidebar_trigger');
    if (!trigger) return;
    const settings = getSettings();
    trigger.classList.toggle('auto-active', settings.autoRefine && settings.enabled);
}

async function updateSidebarStatus() {
    const el = document.getElementById('redraft_sb_status');
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

// ─── Workbench: Message Picker (Refine Tab) ────────────────────────

let _pickerSelectedIndices = new Set();

function renderMessagePicker() {
    const container = document.getElementById('redraft_wb_messages');
    if (!container) return;

    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const originals = context.chatMetadata?.['redraft_originals'] || {};
    const { DOMPurify } = SillyTavern.libs;

    container.innerHTML = '';
    _pickerSelectedIndices.clear();

    chat.forEach((msg, idx) => {
        if (!msg || !msg.mes) return;
        const isUser = !!msg.is_user;
        const isSystem = !!msg.is_system;
        if (isSystem) return;

        const hasOriginal = originals[idx] !== undefined;
        const preview = (msg.mes || '').replace(/[*_`#~<>[\]]/g, '').substring(0, 80).trim() || '(empty)';

        const row = document.createElement('label');
        row.classList.add('redraft-wb-message-row');
        row.dataset.idx = idx;
        row.dataset.type = isUser ? 'user' : 'ai';
        row.dataset.refined = hasOriginal ? 'yes' : 'no';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.dataset.idx = idx;
        if (idx === 0) checkbox.disabled = true;

        checkbox.addEventListener('change', () => {
            if (checkbox.checked) _pickerSelectedIndices.add(idx);
            else _pickerSelectedIndices.delete(idx);
            updatePickerCount();
        });

        const icon = document.createElement('i');
        icon.classList.add('fa-solid', isUser ? 'fa-user' : 'fa-pen-nib');

        const label = document.createElement('span');
        label.classList.add('redraft-wb-msg-label');
        label.textContent = `#${idx}`;

        const text = document.createElement('span');
        text.classList.add('redraft-wb-msg-preview');
        text.textContent = DOMPurify ? DOMPurify.sanitize(preview, { ALLOWED_TAGS: [] }) : preview;

        const dot = document.createElement('span');
        dot.classList.add('redraft-wb-refined-dot');
        if (hasOriginal) dot.classList.add('active');
        dot.title = hasOriginal ? 'Undo available' : '';

        row.append(checkbox, icon, label, text, dot);
        container.appendChild(row);
    });

    // Bind filter bar
    document.querySelectorAll('.redraft-wb-filter').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.redraft-wb-filter').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyPickerFilter(btn.dataset.filter);
        });
    });

    // Bind select/deselect
    const selectAll = document.getElementById('redraft_wb_select_all');
    if (selectAll) selectAll.onclick = () => {
        container.querySelectorAll('.redraft-wb-message-row:not(.redraft-hidden) input[type="checkbox"]:not(:disabled)').forEach(cb => {
            cb.checked = true;
            _pickerSelectedIndices.add(parseInt(cb.dataset.idx, 10));
        });
        updatePickerCount();
    };

    const deselectAll = document.getElementById('redraft_wb_deselect');
    if (deselectAll) deselectAll.onclick = () => {
        container.querySelectorAll('input[type="checkbox"]').forEach(cb => { cb.checked = false; });
        _pickerSelectedIndices.clear();
        updatePickerCount();
    };

    // Bind delay slider
    const delaySlider = document.getElementById('redraft_wb_delay');
    const delayLabel = document.getElementById('redraft_wb_delay_label');
    if (delaySlider) {
        const settings = getSettings();
        delaySlider.value = settings.bulkDelayMs || 2000;
        if (delayLabel) delayLabel.textContent = (delaySlider.value / 1000) + 's';
        delaySlider.addEventListener('input', () => {
            if (delayLabel) delayLabel.textContent = (delaySlider.value / 1000) + 's';
            const s = getSettings();
            s.bulkDelayMs = parseInt(delaySlider.value, 10);
            saveSettings();
        });
    }

    // Bind start button
    const startBtn = document.getElementById('redraft_wb_start');
    if (startBtn) {
        startBtn.onclick = () => {
            if (_pickerSelectedIndices.size === 0) {
                toastr.warning('Select at least one message', 'ReDraft');
                return;
            }
            const overrides = collectBatchOverrides();
            bulkRedraft([..._pickerSelectedIndices].sort((a, b) => a - b), overrides);
        };
    }

    // Bind cancel button
    const cancelBtn = document.getElementById('redraft_wb_cancel');
    if (cancelBtn) {
        cancelBtn.onclick = () => {
            bulkCancelled = true;
            if (activeAbortController) activeAbortController.abort();
        };
    }

    updatePickerCount();
}

function applyPickerFilter(filter) {
    const rows = document.querySelectorAll('.redraft-wb-message-row');
    rows.forEach(row => {
        let visible = true;
        if (filter === 'ai' && row.dataset.type !== 'ai') visible = false;
        if (filter === 'user' && row.dataset.type !== 'user') visible = false;
        if (filter === 'unrefined' && row.dataset.refined === 'yes') visible = false;
        row.classList.toggle('redraft-hidden', !visible);
    });
}

function updatePickerCount() {
    const countEl = document.getElementById('redraft_wb_count');
    if (countEl) countEl.textContent = `${_pickerSelectedIndices.size} selected`;
    const startBtn = document.getElementById('redraft_wb_start');
    if (startBtn) {
        const span = startBtn.querySelector('span');
        if (span) span.textContent = `Start (${_pickerSelectedIndices.size})`;
    }
}

/**
 * Collect per-batch override values from the Refine tab overrides section.
 * Returns an overrides object or null if overrides are not enabled.
 */
function collectBatchOverrides() {
    const details = document.getElementById('redraft_wb_overrides');
    if (!details || !details.open) return null;

    const pov = document.getElementById('redraft_wb_override_pov')?.value || '';
    const sysprompt = document.getElementById('redraft_wb_override_sysprompt')?.value?.trim() || '';

    if (!pov && !sysprompt) return null;

    const overrides = {};
    if (pov) overrides.pov = pov;
    if (sysprompt) overrides.systemPrompt = sysprompt;
    return overrides;
}

// ─── Workbench: Bulk Processing ─────────────────────────────────────

async function bulkRedraft(targetIndices, overrides = null) {
    if (isBulkRefining || isRefining) return;

    const settings = getSettings();
    if (settings.connectionMode === 'plugin' && !pluginAvailable) {
        toastr.error('Plugin unavailable', 'ReDraft');
        return;
    }

    isBulkRefining = true;
    bulkCancelled = false;
    activeAbortController = new AbortController();
    const { signal } = activeAbortController;
    const batchId = `batch-${Date.now()}`;
    const batchTimestamp = Date.now();

    const progressEl = document.getElementById('redraft_wb_progress');
    const summaryEl = document.getElementById('redraft_wb_summary');
    const pickerEl = document.getElementById('redraft_wb_messages');
    const runControls = document.querySelector('.redraft-wb-run-controls');
    const fillEl = document.getElementById('redraft_wb_progress_fill');
    const textEl = document.getElementById('redraft_wb_progress_text');
    const currentEl = document.getElementById('redraft_wb_progress_current');

    if (progressEl) progressEl.style.display = '';
    if (summaryEl) summaryEl.style.display = 'none';
    if (runControls) runControls.style.display = 'none';

    setSidebarTriggerLoading(true);

    let successCount = 0;
    let failedCount = 0;
    const failedDetails = [];
    const total = targetIndices.length;

    for (let i = 0; i < total; i++) {
        if (bulkCancelled) break;

        const idx = targetIndices[i];
        const context = SillyTavern.getContext();
        const msg = context.chat[idx];
        const isUserMsg = msg?.is_user;
        const pct = ((i / total) * 100).toFixed(0);

        if (fillEl) fillEl.style.width = pct + '%';
        if (textEl) textEl.textContent = `${i} / ${total}`;
        if (currentEl) currentEl.textContent = `#${idx} — ${isUserMsg ? 'enhancing' : 'refining'}...`;

        const useSwarm = settings.swarmEnabled && !isUserMsg;
        try {
            const result = useSwarm
                ? await _refineMessageSwarm(idx, { signal, overrides, showDiff: false })
                : await _refineMessageCore(idx, { signal, overrides, showDiff: false });
            successCount++;

            await appendHistoryEntry({
                messageIndex: idx,
                messageType: isUserMsg ? 'user' : 'ai',
                success: true,
                durationMs: result.durationMs,
                wordDelta: result.wordDelta,
                batchId,
                swarmStrategy: useSwarm ? settings.swarmStrategy : undefined,
            });
        } catch (err) {
            if (err.name === 'AbortError') break;
            failedCount++;
            failedDetails.push({ idx, error: err.message });
            console.error(`${LOG_PREFIX} [bulk] Message ${idx} failed:`, err.message);

            await appendHistoryEntry({
                messageIndex: idx,
                messageType: isUserMsg ? 'user' : 'ai',
                success: false,
                batchId,
            });
        }

        // Delay between messages
        if (i < total - 1 && !bulkCancelled) {
            const delay = settings.bulkDelayMs || 2000;
            if (delay > 0) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // Finalize
    if (fillEl) fillEl.style.width = '100%';
    if (textEl) textEl.textContent = `${successCount + failedCount} / ${total}`;
    if (currentEl) currentEl.textContent = bulkCancelled ? 'Cancelled' : 'Done';

    await recordBatch(batchId, {
        timestamp: batchTimestamp,
        indices: targetIndices,
        results: { success: successCount, failed: failedCount, skipped: total - successCount - failedCount },
    });

    // Show summary
    if (summaryEl) {
        let html = `<div class="redraft-wb-summary-header">${successCount} refined, ${failedCount} failed`;
        if (bulkCancelled) html += ' (cancelled)';
        html += '</div>';

        if (failedDetails.length > 0) {
            html += '<details class="redraft-wb-summary-failures"><summary>Failed details</summary><ul>';
            failedDetails.forEach(f => { html += `<li>#${f.idx}: ${f.error}</li>`; });
            html += '</ul></details>';
        }

        html += `<div class="redraft-wb-summary-actions">`;
        html += `<button class="menu_button" id="redraft_wb_undo_batch" data-batch="${batchId}"><i class="fa-solid fa-rotate-left"></i> Undo All</button>`;
        html += `<button class="menu_button" id="redraft_wb_back_to_picker"><i class="fa-solid fa-arrow-left"></i> Back to Picker</button>`;
        html += `</div>`;

        summaryEl.innerHTML = html;
        summaryEl.style.display = '';

        const undoBtn = document.getElementById('redraft_wb_undo_batch');
        if (undoBtn) {
            undoBtn.addEventListener('click', async () => {
                const count = await undoBatch(batchId);
                toastr.success(`Undid ${count} message(s)`, 'ReDraft');
                renderMessagePicker();
            });
        }

        const backBtn = document.getElementById('redraft_wb_back_to_picker');
        if (backBtn) {
            backBtn.addEventListener('click', () => {
                if (progressEl) progressEl.style.display = 'none';
                if (summaryEl) summaryEl.style.display = 'none';
                if (runControls) runControls.style.display = '';
                renderMessagePicker();
            });
        }
    }

    if (progressEl) progressEl.style.display = 'none';
    if (runControls) runControls.style.display = '';

    isBulkRefining = false;
    bulkCancelled = false;
    activeAbortController = null;
    setSidebarTriggerLoading(false);
    playNotificationSound();
}

// ─── Workbench: History Tab ─────────────────────────────────────────

function renderHistoryTab() {
    const container = document.getElementById('redraft_wb_history');
    if (!container) return;

    const history = getHistoryForChat();
    const batches = getBatchesForChat();
    const context = SillyTavern.getContext();
    const originals = context.chatMetadata?.['redraft_originals'] || {};
    const diffs = context.chatMetadata?.['redraft_diffs'] || {};

    container.innerHTML = '';

    if (history.length === 0 && Object.keys(batches).length === 0) {
        container.innerHTML = '<div class="redraft-wb-empty">No refinement history yet</div>';
        return;
    }

    // Batch cards
    const batchIds = Object.keys(batches).sort((a, b) => batches[b].timestamp - batches[a].timestamp);
    batchIds.forEach(batchId => {
        const batch = batches[batchId];
        const card = document.createElement('div');
        card.classList.add('redraft-wb-batch-card');
        const time = new Date(batch.timestamp).toLocaleString();
        const { success, failed } = batch.results;
        card.innerHTML = `
            <div class="redraft-wb-batch-header">
                <i class="fa-solid fa-layer-group"></i>
                <span>Batch \u2014 ${time}</span>
            </div>
            <div class="redraft-wb-batch-stats">${batch.indices.length} messages (${success} OK, ${failed} failed)</div>
            <button class="menu_button redraft-wb-batch-undo" data-batch="${batchId}"><i class="fa-solid fa-rotate-left"></i> Undo Batch</button>
        `;
        card.querySelector('.redraft-wb-batch-undo').addEventListener('click', async () => {
            const count = await undoBatch(batchId);
            toastr.success(`Undid ${count} message(s)`, 'ReDraft');
            renderHistoryTab();
        });
        container.appendChild(card);
    });

    // Individual entries (most recent first)
    const sortedHistory = [...history].reverse();
    sortedHistory.forEach(entry => {
        const row = document.createElement('div');
        row.classList.add('redraft-wb-history-entry');
        if (!entry.success) row.classList.add('failed');

        const ago = _timeAgo(entry.timestamp);
        const typeIcon = entry.messageType === 'user' ? 'fa-user' : 'fa-pen-nib';
        const statusIcon = entry.success ? 'fa-check' : 'fa-xmark';
        const batchTag = entry.batchId ? '<span class="redraft-wb-badge">batch</span>' : '';
        const hasUndo = originals[entry.messageIndex] !== undefined;
        const hasDiff = diffs[entry.messageIndex] !== undefined;

        row.innerHTML = `
            <span class="redraft-wb-history-time">${ago}</span>
            <i class="fa-solid ${typeIcon}"></i>
            <span class="redraft-wb-history-idx">#${entry.messageIndex}</span>
            ${batchTag}
            <i class="fa-solid ${statusIcon} redraft-wb-history-status"></i>
            <span class="redraft-wb-history-actions">
                ${hasDiff ? '<button class="redraft-wb-btn-diff" title="View diff"><i class="fa-solid fa-code-compare"></i></button>' : ''}
                ${hasUndo ? '<button class="redraft-wb-btn-undo" title="Undo"><i class="fa-solid fa-rotate-left"></i></button>' : ''}
            </span>
        `;

        if (hasDiff) {
            row.querySelector('.redraft-wb-btn-diff')?.addEventListener('click', () => {
                const d = diffs[entry.messageIndex];
                const chat = context.chat || [];
                showDiffPopup(d.original, chat[entry.messageIndex]?.mes || '', d.changelog);
            });
        }

        if (hasUndo) {
            row.querySelector('.redraft-wb-btn-undo')?.addEventListener('click', async () => {
                await undoRedraft(entry.messageIndex);
                toastr.success(`Message #${entry.messageIndex} restored`, 'ReDraft');
                renderHistoryTab();
            });
        }

        container.appendChild(row);
    });
}

function _timeAgo(ts) {
    const diff = Date.now() - ts;
    const sec = Math.floor(diff / 1000);
    if (sec < 60) return 'just now';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}h ago`;
    return `${Math.floor(hr / 24)}d ago`;
}

// ─── Workbench: Stats Tab ───────────────────────────────────────────

function renderStatsTab() {
    const container = document.getElementById('redraft_wb_stats');
    if (!container) return;

    const context = SillyTavern.getContext();
    const chat = context.chat || [];
    const originals = context.chatMetadata?.['redraft_originals'] || {};
    const history = getHistoryForChat();

    const totalMessages = chat.filter(m => m && m.mes && !m.is_system).length;
    const aiMessages = chat.filter(m => m && m.mes && !m.is_user && !m.is_system).length;
    const userMessages = chat.filter(m => m && m.mes && m.is_user).length;

    const refinedEntries = history.filter(h => h.success && h.messageType === 'ai');
    const enhancedEntries = history.filter(h => h.success && h.messageType === 'user');

    const totalDeleted = history.reduce((sum, h) => sum + (h.wordDelta?.deleted || 0), 0);
    const totalInserted = history.reduce((sum, h) => sum + (h.wordDelta?.inserted || 0), 0);

    const successfulEntries = history.filter(h => h.success && h.durationMs > 0);
    const avgTime = successfulEntries.length > 0
        ? (successfulEntries.reduce((s, h) => s + h.durationMs, 0) / successfulEntries.length / 1000).toFixed(1)
        : '—';
    const minTime = successfulEntries.length > 0
        ? (Math.min(...successfulEntries.map(h => h.durationMs)) / 1000).toFixed(1)
        : '—';
    const maxTime = successfulEntries.length > 0
        ? (Math.max(...successfulEntries.map(h => h.durationMs)) / 1000).toFixed(1)
        : '—';

    const undoCount = Object.keys(originals).length;

    const pct = (num, den) => den > 0 ? `(${Math.round(num / den * 100)}%)` : '';

    container.innerHTML = `
        <div class="redraft-wb-stat-card">
            <div class="redraft-wb-stat-value">${totalMessages}</div>
            <div class="redraft-wb-stat-label">Total Messages</div>
            <div class="redraft-wb-stat-sub">${aiMessages} AI \u00b7 ${userMessages} User</div>
        </div>
        <div class="redraft-wb-stat-card">
            <div class="redraft-wb-stat-value">${refinedEntries.length}</div>
            <div class="redraft-wb-stat-label">AI Refined ${pct(refinedEntries.length, aiMessages)}</div>
        </div>
        <div class="redraft-wb-stat-card">
            <div class="redraft-wb-stat-value">${enhancedEntries.length}</div>
            <div class="redraft-wb-stat-label">User Enhanced ${pct(enhancedEntries.length, userMessages)}</div>
        </div>
        <div class="redraft-wb-stat-card">
            <div class="redraft-wb-stat-value redraft-wb-stat-delta">
                <span class="redraft-diff-stat-del">\u2212${totalDeleted}</span>
                <span class="redraft-diff-stat-ins">+${totalInserted}</span>
            </div>
            <div class="redraft-wb-stat-label">Word Delta</div>
        </div>
        <div class="redraft-wb-stat-card">
            <div class="redraft-wb-stat-value">${avgTime}s</div>
            <div class="redraft-wb-stat-label">Avg Refine Time</div>
            <div class="redraft-wb-stat-sub">min ${minTime}s \u00b7 max ${maxTime}s</div>
        </div>
        <div class="redraft-wb-stat-card">
            <div class="redraft-wb-stat-value">${undoCount}</div>
            <div class="redraft-wb-stat-label">Undo Available</div>
        </div>
    `;
}

// ─── Workbench: Swarm Tab ───────────────────────────────────────────

function renderSwarmTab() {
    const container = document.getElementById('redraft_wb_swarm');
    if (!container) return;

    const settings = getSettings();
    const isPlugin = settings.connectionMode === 'plugin';

    const stages = settings.swarmPipelineStages || DEFAULT_PIPELINE_STAGES;

    container.innerHTML = `
        <div class="redraft-swarm-toggle">
            <label class="checkbox_label">
                <input type="checkbox" id="redraft_swarm_enabled" ${settings.swarmEnabled ? 'checked' : ''} />
                <span>Enable Swarm Mode</span>
            </label>
            <small class="redraft-swarm-hint">Multi-agent refinement for AI messages. User messages always use single-pass.</small>
        </div>

        <div class="redraft-swarm-config" id="redraft_swarm_config" style="${settings.swarmEnabled ? '' : 'display:none'}">
            <div class="redraft-swarm-strategy-select">
                <label>Strategy</label>
                <select id="redraft_swarm_strategy" class="text_pole">
                    ${Object.entries(STRATEGY_META).map(([key, meta]) =>
                        `<option value="${key}" ${settings.swarmStrategy === key ? 'selected' : ''}>${meta.icon} ${meta.name}</option>`
                    ).join('')}
                </select>
                <small class="redraft-swarm-strategy-desc" id="redraft_swarm_strategy_desc">
                    ${STRATEGY_META[settings.swarmStrategy]?.description || ''}
                </small>
            </div>

            <div class="redraft-swarm-panel" id="redraft_swarm_panel_pipeline" style="${settings.swarmStrategy === 'pipeline' ? '' : 'display:none'}">
                <h4>Pipeline Stages</h4>
                <div class="redraft-swarm-stages" id="redraft_swarm_stages">
                    ${stages.map((stage, i) => `
                        <div class="redraft-swarm-stage" data-stage-index="${i}">
                            <span class="redraft-swarm-stage-drag" title="Drag to reorder"><i class="fa-solid fa-grip-vertical"></i></span>
                            <label class="checkbox_label">
                                <input type="checkbox" class="redraft-swarm-stage-toggle" data-stage-index="${i}" ${stage.enabled ? 'checked' : ''} />
                                <span>${stage.name}</span>
                            </label>
                            <small class="redraft-swarm-stage-rules">${stage.rules.join(', ')}</small>
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="redraft-swarm-panel" id="redraft_swarm_panel_council" style="${settings.swarmStrategy === 'council' ? '' : 'display:none'}">
                <h4>Council Configuration</h4>
                <div class="redraft-swarm-field">
                    <label>Council Members</label>
                    <input type="number" id="redraft_swarm_council_size" class="text_pole" min="${MIN_COUNCIL_SIZE}" max="${MAX_COUNCIL_SIZE}" value="${settings.swarmCouncilSize}" />
                </div>
                <div class="redraft-swarm-field">
                    <label>Judge Mode</label>
                    <select id="redraft_swarm_judge_mode" class="text_pole">
                        <option value="synthesize" ${settings.swarmCouncilJudgeMode === 'synthesize' ? 'selected' : ''}>Synthesize best edits</option>
                        <option value="pick_best" ${settings.swarmCouncilJudgeMode === 'pick_best' ? 'selected' : ''}>Pick single best</option>
                    </select>
                </div>
                ${isPlugin ? `
                <div class="redraft-swarm-model-overrides" id="redraft_swarm_model_overrides">
                    <h5>Per-Agent Model Override <small>(plugin mode)</small></h5>
                    ${buildCouncilModelOverridesHtml(settings)}
                </div>` : `
                <small class="redraft-swarm-hint">Per-agent model overrides available in plugin mode only.</small>
                `}
            </div>

            <div class="redraft-swarm-panel" id="redraft_swarm_panel_review" style="${settings.swarmStrategy === 'review' ? '' : 'display:none'}">
                <h4>Review + Refine</h4>
                <p class="redraft-swarm-hint">A reviewer analyzes the message and produces a structured critique. A refiner then applies the critique. No additional configuration needed.</p>
            </div>

            <div class="redraft-swarm-timeout">
                <div class="redraft-swarm-field">
                    <label>Per-agent timeout</label>
                    <input type="number" id="redraft_swarm_timeout" class="text_pole" min="30" max="600" value="${settings.swarmTimeoutSeconds || 180}" /> <span class="redraft-swarm-hint">seconds</span>
                </div>
                <small class="redraft-swarm-hint">Higher than normal timeout since swarm sends multiple requests. Increase if slower models time out.</small>
            </div>
        </div>

        <div class="redraft-swarm-progress" id="redraft_swarm_progress" style="display:none">
            <h4 id="redraft_swarm_progress_title">Swarm</h4>
            <div class="redraft-swarm-agents" id="redraft_swarm_agents"></div>
            <div class="redraft-swarm-progress-bar">
                <div class="redraft-swarm-progress-fill" id="redraft_swarm_progress_fill"></div>
            </div>
            <div class="redraft-swarm-progress-text" id="redraft_swarm_progress_text"></div>
        </div>
    `;

    bindSwarmUI();
}

/** Cached model list from the last /models fetch, shared with swarm UI. */
let _swarmModelCache = [];

function buildCouncilModelOverridesHtml(settings) {
    const size = settings.swarmCouncilSize || 3;
    const overrides = settings.swarmCouncilModelOverrides || {};
    const hasModels = _swarmModelCache.length > 0;

    let html = `<button class="menu_button" id="redraft_swarm_fetch_models"><i class="fa-solid fa-arrows-rotate"></i> Fetch Models</button>`;

    const agents = [];
    for (let i = 0; i < size; i++) {
        agents.push({ id: `council_${i}`, label: `Agent ${String.fromCharCode(65 + i)}` });
    }
    agents.push({ id: 'judge', label: 'Judge' });

    for (const agent of agents) {
        const currentVal = overrides[agent.id] || '';
        html += `<div class="redraft-swarm-field">
                <label>${agent.label} model</label>
                <div class="redraft-swarm-model-combo" data-agent-id="${agent.id}">
                    <select class="text_pole redraft-swarm-model-select" data-agent-id="${agent.id}" style="${hasModels ? '' : 'display:none'}">
                        <option value="">default</option>
                        ${_swarmModelCache.map(m => `<option value="${m.id}" ${m.id === currentVal ? 'selected' : ''}>${m.id}</option>`).join('')}
                    </select>
                    <input type="text" class="text_pole redraft-swarm-model-input" data-agent-id="${agent.id}" value="${currentVal}" placeholder="default" style="${hasModels ? 'display:none' : ''}" />
                </div>
            </div>`;
    }
    return html;
}

function bindSwarmUI() {
    const enableToggle = document.getElementById('redraft_swarm_enabled');
    const configContainer = document.getElementById('redraft_swarm_config');
    const strategySelect = document.getElementById('redraft_swarm_strategy');
    const strategyDesc = document.getElementById('redraft_swarm_strategy_desc');

    enableToggle?.addEventListener('change', (e) => {
        getSettings().swarmEnabled = e.target.checked;
        saveSettings();
        if (configContainer) configContainer.style.display = e.target.checked ? '' : 'none';
    });

    strategySelect?.addEventListener('change', (e) => {
        const val = e.target.value;
        getSettings().swarmStrategy = val;
        saveSettings();
        if (strategyDesc) strategyDesc.textContent = STRATEGY_META[val]?.description || '';

        for (const type of Object.values(STRATEGY_TYPES)) {
            const panel = document.getElementById(`redraft_swarm_panel_${type}`);
            if (panel) panel.style.display = type === val ? '' : 'none';
        }
    });

    document.querySelectorAll('.redraft-swarm-stage-toggle').forEach(toggle => {
        toggle.addEventListener('change', (e) => {
            const idx = parseInt(e.target.dataset.stageIndex, 10);
            const settings = getSettings();
            if (settings.swarmPipelineStages?.[idx]) {
                settings.swarmPipelineStages[idx].enabled = e.target.checked;
                saveSettings();
            }
        });
    });

    const councilSizeInput = document.getElementById('redraft_swarm_council_size');
    councilSizeInput?.addEventListener('change', (e) => {
        const val = Math.min(MAX_COUNCIL_SIZE, Math.max(MIN_COUNCIL_SIZE, parseInt(e.target.value, 10) || 3));
        e.target.value = val;
        getSettings().swarmCouncilSize = val;
        saveSettings();
        const overridesContainer = document.getElementById('redraft_swarm_model_overrides');
        if (overridesContainer) {
            overridesContainer.innerHTML = `<h5>Per-Agent Model Override <small>(plugin mode)</small></h5>` + buildCouncilModelOverridesHtml(getSettings());
            bindModelOverrideInputs();
        }
    });

    const judgeModeSelect = document.getElementById('redraft_swarm_judge_mode');
    judgeModeSelect?.addEventListener('change', (e) => {
        getSettings().swarmCouncilJudgeMode = e.target.value;
        saveSettings();
    });

    bindModelOverrideInputs();
    initSwarmStageDragDrop();

    const timeoutInput = document.getElementById('redraft_swarm_timeout');
    timeoutInput?.addEventListener('change', (e) => {
        const val = Math.min(600, Math.max(30, parseInt(e.target.value, 10) || 180));
        e.target.value = val;
        getSettings().swarmTimeoutSeconds = val;
        saveSettings();
    });
}

function bindModelOverrideInputs() {
    const saveOverride = (agentId, val) => {
        const settings = getSettings();
        if (!settings.swarmCouncilModelOverrides) settings.swarmCouncilModelOverrides = {};
        if (val) {
            settings.swarmCouncilModelOverrides[agentId] = val;
        } else {
            delete settings.swarmCouncilModelOverrides[agentId];
        }
        saveSettings();
    };

    document.querySelectorAll('.redraft-swarm-model-input').forEach(input => {
        input.addEventListener('change', (e) => saveOverride(e.target.dataset.agentId, e.target.value.trim()));
    });

    document.querySelectorAll('.redraft-swarm-model-select').forEach(select => {
        select.addEventListener('change', (e) => saveOverride(e.target.dataset.agentId, e.target.value));
    });

    const fetchBtn = document.getElementById('redraft_swarm_fetch_models');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', async () => {
            fetchBtn.disabled = true;
            fetchBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Fetching...';
            try {
                const data = await pluginRequest('/models');
                const models = data?.models;
                if (!Array.isArray(models) || models.length === 0) {
                    toastr.info('No models returned by the API', 'ReDraft');
                    return;
                }
                _swarmModelCache = models;
                toastr.success(`${models.length} model(s) loaded`, 'ReDraft');

                const overrides = getSettings().swarmCouncilModelOverrides || {};
                document.querySelectorAll('.redraft-swarm-model-select').forEach(select => {
                    const agentId = select.dataset.agentId;
                    const currentVal = overrides[agentId] || '';
                    select.innerHTML = '<option value="">default</option>'
                        + models.map(m => `<option value="${m.id}" ${m.id === currentVal ? 'selected' : ''}>${m.id}</option>`).join('');
                    select.style.display = '';
                });
                document.querySelectorAll('.redraft-swarm-model-input').forEach(input => {
                    input.style.display = 'none';
                });
            } catch (err) {
                toastr.error('Failed to fetch models: ' + err.message, 'ReDraft');
            } finally {
                fetchBtn.disabled = false;
                fetchBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Fetch Models';
            }
        });
    }
}

function initSwarmStageDragDrop() {
    const container = document.getElementById('redraft_swarm_stages');
    if (!container) return;

    let draggedEl = null;

    container.querySelectorAll('.redraft-swarm-stage').forEach(stage => {
        const handle = stage.querySelector('.redraft-swarm-stage-drag');
        if (!handle) return;

        handle.addEventListener('mousedown', () => {
            stage.draggable = true;
        });

        stage.addEventListener('dragstart', (e) => {
            draggedEl = stage;
            stage.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
        });

        stage.addEventListener('dragend', () => {
            stage.draggable = false;
            stage.classList.remove('dragging');
            draggedEl = null;
            persistStageOrder();
        });

        stage.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (!draggedEl || draggedEl === stage) return;
            const rect = stage.getBoundingClientRect();
            const midY = rect.top + rect.height / 2;
            if (e.clientY < midY) {
                container.insertBefore(draggedEl, stage);
            } else {
                container.insertBefore(draggedEl, stage.nextSibling);
            }
        });
    });
}

function persistStageOrder() {
    const container = document.getElementById('redraft_swarm_stages');
    if (!container) return;

    const settings = getSettings();
    const stages = settings.swarmPipelineStages || [];
    const newOrder = [];

    container.querySelectorAll('.redraft-swarm-stage').forEach(el => {
        const idx = parseInt(el.dataset.stageIndex, 10);
        if (stages[idx]) newOrder.push(stages[idx]);
    });

    if (newOrder.length === stages.length) {
        settings.swarmPipelineStages = newOrder;
        saveSettings();
    }
}

function updateSwarmProgress(progress) {
    const progressContainer = document.getElementById('redraft_swarm_progress');
    if (!progressContainer) return;

    progressContainer.style.display = '';

    const titleEl = document.getElementById('redraft_swarm_progress_title');
    const fillEl = document.getElementById('redraft_swarm_progress_fill');
    const textEl = document.getElementById('redraft_swarm_progress_text');
    const agentsEl = document.getElementById('redraft_swarm_agents');

    if (titleEl) titleEl.textContent = `Swarm: ${progress.phase}`;
    if (fillEl) fillEl.style.width = `${Math.round((progress.current / progress.total) * 100)}%`;

    const statusLabel = progress.status === 'failed' ? 'failed' : progress.status;
    if (textEl) textEl.textContent = `${progress.agentName} — ${statusLabel}`;

    if (agentsEl) {
        let agentEl = agentsEl.querySelector(`[data-agent="${CSS.escape(progress.agentName)}"]`);
        if (!agentEl) {
            agentEl = document.createElement('div');
            agentEl.className = 'redraft-swarm-agent-status';
            agentEl.dataset.agent = progress.agentName;
            agentsEl.appendChild(agentEl);
        }
        const iconMap = {
            done: 'fa-check',
            running: 'fa-spinner fa-spin',
            failed: 'fa-xmark',
            queued: 'fa-clock',
        };
        const icon = iconMap[progress.status] || 'fa-clock';
        agentEl.innerHTML = `<i class="fa-solid ${icon}"></i> <span>${progress.agentName}</span>`;
        agentEl.className = `redraft-swarm-agent-status redraft-swarm-status-${progress.status}`;
    }
}

function clearSwarmProgress() {
    const progressContainer = document.getElementById('redraft_swarm_progress');
    if (progressContainer) progressContainer.style.display = 'none';
    const agentsEl = document.getElementById('redraft_swarm_agents');
    if (agentsEl) agentsEl.innerHTML = '';
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
            updateSidebarAutoState();
        });
    }

    // Auto-refine toggle
    const autoEl = document.getElementById('redraft_auto_refine');
    if (autoEl) {
        autoEl.checked = initSettings.autoRefine;
        autoEl.addEventListener('change', (e) => {
            getSettings().autoRefine = e.target.checked;
            const sbEl = document.getElementById('redraft_sb_auto');
            if (sbEl) sbEl.checked = e.target.checked;
            saveSettings();
            updateSidebarAutoState();
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
            const sbEl = document.getElementById('redraft_sb_user_auto');
            if (sbEl) sbEl.checked = e.target.checked;
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
            const sbEl = document.getElementById('redraft_sb_enhance_mode');
            if (sbEl) sbEl.value = e.target.value;
            saveSettings();
            updateEnhanceModeUI(e.target.value);
        });
    }

    // User PoV selector
    const userPovEl = document.getElementById('redraft_user_pov');
    if (userPovEl) {
        userPovEl.value = initSettings.userPov || '1st';
        userPovEl.addEventListener('change', (e) => {
            getSettings().userPov = e.target.value;
            const sbEl = document.getElementById('redraft_sb_user_pov');
            if (sbEl) sbEl.value = e.target.value;
            saveSettings();
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
            const sbPovEl = document.getElementById('redraft_sb_pov');
            if (sbPovEl) sbPovEl.value = e.target.value;
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

    // Request timeout
    const timeoutEl = document.getElementById('redraft_request_timeout');
    if (timeoutEl) {
        const val = initSettings.requestTimeoutSeconds ?? 120;
        timeoutEl.value = String([60, 90, 120, 180, 300].includes(val) ? val : 120);
        timeoutEl.addEventListener('change', (e) => {
            getSettings().requestTimeoutSeconds = parseInt(e.target.value, 10);
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

    // Reasoning context
    const reasoningCtxEl = document.getElementById('redraft_reasoning_context');
    const reasoningOptsEl = document.getElementById('redraft_reasoning_options');
    if (reasoningCtxEl) {
        reasoningCtxEl.checked = initSettings.reasoningContext === true;
        if (reasoningOptsEl) reasoningOptsEl.style.display = reasoningCtxEl.checked ? '' : 'none';
        reasoningCtxEl.addEventListener('change', (e) => {
            getSettings().reasoningContext = e.target.checked;
            if (reasoningOptsEl) reasoningOptsEl.style.display = e.target.checked ? '' : 'none';
            saveSettings();
        });
    }
    const reasoningModeEl = document.getElementById('redraft_reasoning_mode');
    if (reasoningModeEl) {
        reasoningModeEl.value = initSettings.reasoningContextMode || 'tags';
        reasoningModeEl.addEventListener('change', (e) => {
            getSettings().reasoningContextMode = e.target.value;
            saveSettings();
        });
    }
    const reasoningCharsEl = document.getElementById('redraft_reasoning_chars');
    if (reasoningCharsEl) {
        const val = initSettings.reasoningContextChars ?? 1000;
        reasoningCharsEl.value = String([500, 1000, 2000, 4000].includes(val) ? val : 1000);
        reasoningCharsEl.addEventListener('change', (e) => {
            getSettings().reasoningContextChars = parseInt(e.target.value, 10);
            saveSettings();
        });
    }
    const reasoningFallbackEl = document.getElementById('redraft_reasoning_raw_fallback');
    if (reasoningFallbackEl) {
        reasoningFallbackEl.checked = initSettings.reasoningContextRawFallback !== false;
        reasoningFallbackEl.addEventListener('change', (e) => {
            getSettings().reasoningContextRawFallback = e.target.checked;
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



    // ─── Sidebar bindings ─────────────────────────────────────────────
    const sbClose = document.getElementById('redraft_sb_close');
    if (sbClose) sbClose.addEventListener('click', closeSidebar);

    const sbAuto = document.getElementById('redraft_sb_auto');
    if (sbAuto) {
        sbAuto.checked = initSettings.autoRefine;
        sbAuto.addEventListener('change', (e) => {
            const s = getSettings();
            s.autoRefine = e.target.checked;
            if (autoEl) autoEl.checked = e.target.checked;
            saveSettings();
            updateSidebarAutoState();
        });
    }

    const sbPov = document.getElementById('redraft_sb_pov');
    if (sbPov) {
        sbPov.value = initSettings.pov || 'auto';
        sbPov.addEventListener('change', (e) => {
            const s = getSettings();
            s.pov = e.target.value;
            const mainPov = document.getElementById('redraft_pov');
            if (mainPov) mainPov.value = e.target.value;
            saveSettings();
        });
    }

    const sbRefine = document.getElementById('redraft_sb_refine');
    if (sbRefine) {
        sbRefine.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            const lastAiIdx = findLastAiMessageIndex();
            if (lastAiIdx >= 0) {
                redraftMessage(lastAiIdx);
            } else {
                toastr.warning('No AI message found to refine', 'ReDraft');
            }
        }, 500, { leading: true, trailing: false }));
    }

    const sbEnhanceUser = document.getElementById('redraft_sb_enhance_user');
    if (sbEnhanceUser) {
        sbEnhanceUser.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            const lastUserIdx = findLastUserMessageIndex();
            if (lastUserIdx >= 0) {
                redraftMessage(lastUserIdx);
            } else {
                toastr.warning('No user message found to enhance', 'ReDraft');
            }
        }, 500, { leading: true, trailing: false }));
    }

    const sbEnhanceTextarea = document.getElementById('redraft_sb_enhance_textarea');
    if (sbEnhanceTextarea) {
        sbEnhanceTextarea.addEventListener('click', SillyTavern.libs.lodash.debounce(() => {
            enhanceTextarea();
        }, 500, { leading: true, trailing: false }));
    }

    const sbUserAuto = document.getElementById('redraft_sb_user_auto');
    if (sbUserAuto) {
        sbUserAuto.checked = initSettings.userAutoEnhance;
        sbUserAuto.addEventListener('change', (e) => {
            const s = getSettings();
            s.userAutoEnhance = e.target.checked;
            const mainEl = document.getElementById('redraft_user_auto_enhance');
            if (mainEl) mainEl.checked = e.target.checked;
            saveSettings();
        });
    }

    const sbUserPov = document.getElementById('redraft_sb_user_pov');
    if (sbUserPov) {
        sbUserPov.value = initSettings.userPov || '1st';
        sbUserPov.addEventListener('change', (e) => {
            const s = getSettings();
            s.userPov = e.target.value;
            const mainEl = document.getElementById('redraft_user_pov');
            if (mainEl) mainEl.value = e.target.value;
            saveSettings();
        });
    }

    const sbEnhanceMode = document.getElementById('redraft_sb_enhance_mode');
    if (sbEnhanceMode) {
        sbEnhanceMode.value = initSettings.userEnhanceMode || 'post';
        sbEnhanceMode.addEventListener('change', (e) => {
            const s = getSettings();
            s.userEnhanceMode = e.target.value;
            const mainEl = document.getElementById('redraft_user_enhance_mode');
            if (mainEl) {
                mainEl.value = e.target.value;
                mainEl.dispatchEvent(new Event('change'));
            } else {
                updateEnhanceModeUI(e.target.value);
            }
            saveSettings();
        });
    }

    const sbOpenSettings = document.getElementById('redraft_sb_open_settings');
    if (sbOpenSettings) {
        sbOpenSettings.addEventListener('click', () => {
            closeSidebar();
            const scrollToDrawer = () => {
                const drawer = document.getElementById('redraft_settings');
                if (!drawer) return;
                drawer.scrollIntoView({ behavior: 'smooth', block: 'start' });
                const content = drawer.querySelector('.inline-drawer-content');
                if (content && getComputedStyle(content).display === 'none') {
                    const toggle = drawer.querySelector('.inline-drawer-toggle');
                    if (toggle) toggle.click();
                }
            };
            const drawer = document.getElementById('redraft_settings');
            const alreadyVisible = drawer && drawer.offsetParent !== null;
            if (alreadyVisible) {
                scrollToDrawer();
            } else {
                const extBtn = document.getElementById('extensionsMenuButton');
                if (extBtn) extBtn.click();
                setTimeout(scrollToDrawer, 400);
            }
        });
    }

    // Tab switching
    document.querySelectorAll('.redraft-sidebar-tab').forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    // Initialize sidebar resize
    initSidebarResize();

    // Render custom rules (AI refine + user enhance)
    renderCustomRules();
    renderCustomRules('userCustomRules', 'redraft_user_custom_rules_list');

    // Set initial connection mode UI
    updateConnectionModeUI();

    // Polyfill field-sizing: content for browsers that don't support it (Firefox, Safari)
    if (!CSS.supports('field-sizing', 'content')) {
        const autoResize = (textarea) => {
            textarea.style.height = 'auto';
            textarea.style.height = textarea.scrollHeight + 'px';
        };
        document.querySelectorAll('#redraft_settings .redraft-system-prompt').forEach(ta => {
            ta.addEventListener('input', () => autoResize(ta));
            autoResize(ta);
        });
    }
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
        updateSidebarStatus();
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
        updateSidebarStatus();
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
    if (isRefining || isBulkRefining) return;

    // Skip the greeting (always index 0)
    if (messageIndex === 0) return;

    setTimeout(() => {
        redraftMessage(messageIndex);
    }, 100);
}

function onUserMessageRendered(messageIndex) {
    addMessageButtons();
    const settings = getSettings();
    if (!settings.enabled || !settings.userEnhanceEnabled || !settings.userAutoEnhance) return;
    // In pre-send mode, the interceptor handles auto-enhance before generation.
    // In inplace mode, enhancement happens before sending via the textarea button.
    if (settings.userEnhanceMode === 'pre' || settings.userEnhanceMode === 'inplace') return;
    if (isRefining || isBulkRefining) return;

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
    const sidebar = document.getElementById('redraft_sidebar');
    if (sidebar && sidebar.classList.contains('redraft-sidebar-open')) {
        refreshActiveTab();
    }
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

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'workbench',
        callback: async () => {
            toggleSidebar();
            return '';
        },
        aliases: ['wb'],
        returns: 'empty string',
        unnamedArgumentList: [],
        helpString: '<div>Toggle the ReDraft Workbench sidebar.</div>',
    }));

    console.log(`${LOG_PREFIX} Slash commands /redraft, /enhance, and /workbench registered`);
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
    if (isRefining || isBulkRefining) return;

    // Only intercept normal user-initiated generations
    if (type === 'quiet' || type === 'impersonate') return;

    // Find the last user message from the interceptor's chat (guaranteed to include it),
    // then resolve its real index in context.chat via send_date for DOM operations.
    const context = SillyTavern.getContext();
    const fullChat = context.chat;

    const { chatMsg, realIdx } = resolveUserMessageIndex(chat, fullChat);
    if (!chatMsg) return;
    if (realIdx < 0) {
        console.warn(`${LOG_PREFIX} [pre-send] Could not resolve real index for user message, skipping`);
        return;
    }

    const targetDate = chatMsg.send_date;
    const message = fullChat[realIdx];

    // Skip very short messages (e.g. "ok", "sure", "*nods*")
    if (message.mes.trim().length < 20) {
        console.debug(`${LOG_PREFIX} [pre-send] Skipping short message (${message.mes.trim().length} chars)`);
        return;
    }

    // Skip if this exact message was already enhanced (compare send_date, not just index)
    const originals = context.chatMetadata?.['redraft_originals'];
    const enhancedDates = context.chatMetadata?.['redraft_enhanced_dates'];
    if (originals && originals[realIdx] !== undefined) {
        if (enhancedDates?.[realIdx] === targetDate) {
            console.debug(`${LOG_PREFIX} [pre-send] Message ${realIdx} already enhanced (same send_date), skipping`);
            return;
        }
        // Different message at same index — clear stale metadata
        console.debug(`${LOG_PREFIX} [pre-send] Stale metadata at index ${realIdx}, clearing`);
        delete originals[realIdx];
        if (context.chatMetadata['redraft_diffs']) delete context.chatMetadata['redraft_diffs'][realIdx];
        if (enhancedDates) delete enhancedDates[realIdx];
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

        const { systemPrompt, promptText } = buildUserEnhancePrompt(settings, context, fullChat, realIdx, stripped);

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

        if (!chatMetadata['redraft_enhanced_dates']) chatMetadata['redraft_enhanced_dates'] = {};
        chatMetadata['redraft_enhanced_dates'][realIdx] = targetDate;

        message.mes = refinedText;

        // Also update the interceptor's chat array so the enhanced text is sent to the LLM.
        // The interceptor receives clones, so fullChat and chat hold different objects.
        if (chatMsg) chatMsg.mes = refinedText;

        await saveChat();
        await saveMeta();

        // Re-render the user message so the UI shows the enhanced version.
        // The DOM element may not exist yet during interception, so poll until it appears.
        const applyRerender = () => {
            rerenderMessage(realIdx);
            showUndoButton(realIdx);
            showDiffButton(realIdx, chatMetadata['redraft_originals'][realIdx], refinedText, changelog);
        };

        const mesBlock = document.querySelector(`.mes[mesid="${realIdx}"] .mes_text`);
        if (mesBlock) {
            applyRerender();
        }
        // Deferred re-render: ST's own rendering may overwrite during generation setup
        const delays = [150, 500, 1500];
        for (const ms of delays) {
            setTimeout(applyRerender, ms);
        }

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
            <div class="redraft-version-line">
                <span title="Extension (client) version">Current ver. <strong id="redraft_ext_version">${EXTENSION_VERSION}</strong></span>
                <span class="redraft-version-sep">·</span>
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

            <hr />

            <label class="checkbox_label">
                <input type="checkbox" id="redraft_show_diff" />
                <span>Show diff after refinement</span>
            </label>
            <div class="redraft-form-group">
                <label class="checkbox_label">
                    <input type="checkbox" id="redraft_notification_sound" />
                    <span>Play sound when refinement finishes</span>
                </label>
                <div id="redraft_notification_sound_options" class="redraft-sound-options">
                    <div class="redraft-sound-row">
                        <input type="url" id="redraft_notification_sound_url" class="text_pole" placeholder="Custom sound URL (optional)" />
                        <span class="redraft-sound-or">or</span>
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
                    <small class="redraft-section-hint">Leave empty for a short default beep. Use a URL or upload your own (saved in browser).</small>
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
                    <p id="redraft_multiuser_hint" class="redraft-section-hint" style="display: none;">
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
                        <label class="checkbox_label redraft-custom-rules-toggle-label">
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
                    <small class="redraft-section-hint">Enhance your own messages — fix grammar, match your persona voice, improve prose.</small>

                    <label class="checkbox_label" title="Show an Enhance button on your messages. Uses your persona page for character voice matching.">
                        <input type="checkbox" id="redraft_user_enhance" />
                        <span>Enable user message enhancement</span>
                    </label>

                    <div class="redraft-form-group">
                        <label for="redraft_user_enhance_mode">Enhancement Mode</label>
                        <select id="redraft_user_enhance_mode">
                            <option value="post">Post-send (enhance after message is sent)</option>
                            <option value="pre">Pre-send (enhance before AI sees your message)</option>
                            <option value="inplace">In-place (enhance in textarea, review before sending)</option>
                        </select>
                    </div>
                    <small id="redraft_enhance_mode_hint" class="redraft-section-hint" style="display: none;"></small>

                    <div class="redraft-form-group redraft-pov-group">
                        <label for="redraft_user_pov">Point of View</label>
                        <select id="redraft_user_pov">
                            <option value="1st">1st person (I/me)</option>
                            <option value="auto">Auto (no instruction)</option>
                            <option value="detect">Detect from message</option>
                            <option value="2nd">2nd person (you)</option>
                            <option value="3rd">3rd person (he/she/they)</option>
                        </select>
                    </div>

                    <div id="redraft_post_send_options">
                        <label class="checkbox_label" title="Automatically enhance your messages right after you send them.">
                            <input type="checkbox" id="redraft_user_auto_enhance" />
                            <span>Auto-enhance after sending</span>
                        </label>
                    </div>

                    <hr />
                    <small class="redraft-section-hint">Rules for enhancing user-written messages.</small>

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
                        <label class="checkbox_label redraft-custom-rules-toggle-label">
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

                    <hr />

                    <div class="redraft-form-group">
                        <label for="redraft_user_system_prompt">System Prompt Override</label>
                        <textarea id="redraft_user_system_prompt" class="text_pole textarea_compact redraft-system-prompt" rows="3"
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
                    <div class="redraft-form-group">
                        <label for="redraft_request_timeout">Request timeout (seconds)</label>
                        <select id="redraft_request_timeout">
                            <option value="60">60</option>
                            <option value="90">90</option>
                            <option value="120">120</option>
                            <option value="180">180</option>
                            <option value="300">300</option>
                        </select>
                        <small class="redraft-hint">How long to wait for the LLM to respond. Increase for thinking models.</small>
                    </div>
                    <label class="checkbox_label">
                        <input type="checkbox" id="redraft_protect_font_tags" />
                        <span>Protect font/color tags</span>
                    </label>
                    <label class="checkbox_label">
                        <input type="checkbox" id="redraft_reasoning_context" />
                        <span>Include reasoning context</span>
                    </label>
                    <div id="redraft_reasoning_options" style="display: none; margin-left: 1em;">
                        <div class="redraft-form-group">
                            <label for="redraft_reasoning_mode">Reasoning mode</label>
                            <select id="redraft_reasoning_mode">
                                <option value="tags">Extract tags (token-efficient)</option>
                                <option value="raw">Raw pass-through</option>
                            </select>
                            <small class="redraft-hint">Tags mode extracts structured settings from CoT. Raw mode passes truncated reasoning text.</small>
                        </div>
                        <div class="redraft-form-group">
                            <label for="redraft_reasoning_chars">Raw context limit (chars)</label>
                            <select id="redraft_reasoning_chars">
                                <option value="500">500</option>
                                <option value="1000">1000</option>
                                <option value="2000">2000</option>
                                <option value="4000">4000</option>
                            </select>
                        </div>
                        <label class="checkbox_label">
                            <input type="checkbox" id="redraft_reasoning_raw_fallback" />
                            <span>Fall back to raw if no tags found</span>
                        </label>
                    </div>
                    <div class="redraft-form-group">
                        <label for="redraft_system_prompt">System Prompt Override (AI messages)</label>
                        <textarea id="redraft_system_prompt" class="text_pole textarea_compact redraft-system-prompt" rows="3"
                            placeholder="Leave blank for default refinement prompt..."></textarea>
                    </div>
                </div>
            </div>

        </div>
    </div>
</div>

<!-- Sidebar Workbench (injected into body by JS) -->
<div id="redraft_sidebar" class="redraft-sidebar" role="complementary" aria-label="ReDraft Workbench">
    <div id="redraft_sidebar_resize" class="redraft-sidebar-resize" title="Resize"></div>
    <div class="redraft-sidebar-header">
        <span class="redraft-sidebar-title">ReDraft</span>
        <div id="redraft_sb_close" class="redraft-sidebar-close" title="Close"><i class="fa-solid fa-xmark"></i></div>
    </div>
    <div class="redraft-sidebar-quick">
        <div class="redraft-sb-section">
            <div class="redraft-sb-row">
                <label class="checkbox_label"><input type="checkbox" id="redraft_sb_auto" /><span>Auto-refine</span></label>
                <div class="redraft-sb-pov"><small>PoV</small>
                    <select id="redraft_sb_pov">
                        <option value="auto">Auto</option><option value="detect">Detect</option>
                        <option value="1st">1st</option><option value="1.5">1.5th</option>
                        <option value="2nd">2nd</option><option value="3rd">3rd</option>
                    </select>
                </div>
            </div>
        </div>
        <div class="redraft-sb-section">
            <div class="redraft-sb-row">
                <label class="checkbox_label"><input type="checkbox" id="redraft_sb_user_auto" /><span>Auto-enhance</span></label>
                <div class="redraft-sb-pov"><small>PoV</small>
                    <select id="redraft_sb_user_pov">
                        <option value="auto">Auto</option><option value="detect">Detect</option>
                        <option value="1st">1st</option><option value="2nd">2nd</option><option value="3rd">3rd</option>
                    </select>
                </div>
            </div>
            <div class="redraft-sb-row">
                <small class="redraft-sb-mode-label">Mode</small>
                <select id="redraft_sb_enhance_mode" class="redraft-sb-mode-select">
                    <option value="pre">Pre-send</option><option value="post">Post-send</option><option value="inplace">In-place</option>
                </select>
            </div>
        </div>
        <div id="redraft_sb_status" class="redraft-sb-status"></div>
        <div class="redraft-sb-actions">
            <div id="redraft_sb_refine" class="menu_button"><i class="fa-solid fa-pen-nib"></i><span>Refine Last AI</span></div>
            <div id="redraft_sb_enhance_user" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Enhance Last User</span></div>
            <div id="redraft_sb_enhance_textarea" class="menu_button" style="display: none;"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Enhance Textarea</span></div>
            <div id="redraft_sb_open_settings" class="menu_button"><i class="fa-solid fa-gear"></i><span>Full Settings</span></div>
        </div>
    </div>
    <div class="redraft-sidebar-tabs">
        <div class="redraft-sidebar-tab active" data-tab="refine">Refine</div>
        <div class="redraft-sidebar-tab" data-tab="history">History</div>
        <div class="redraft-sidebar-tab" data-tab="stats">Stats</div>
        <div class="redraft-sidebar-tab" data-tab="swarm">Swarm</div>
    </div>
    <div class="redraft-sidebar-content">
        <div class="redraft-sidebar-tab-content active" data-tab="refine" id="redraft_tab_refine">
            <div class="redraft-wb-filter-bar">
                <button class="redraft-wb-filter active" data-filter="all">All</button>
                <button class="redraft-wb-filter" data-filter="ai">AI</button>
                <button class="redraft-wb-filter" data-filter="user">User</button>
                <button class="redraft-wb-filter" data-filter="unrefined">Unrefined</button>
            </div>
            <div class="redraft-wb-select-bar">
                <button id="redraft_wb_select_all" class="menu_button menu_button_icon"><i class="fa-solid fa-check-double"></i> Select visible</button>
                <button id="redraft_wb_deselect" class="menu_button menu_button_icon"><i class="fa-solid fa-xmark"></i> Clear</button>
                <span class="redraft-wb-selected-count" id="redraft_wb_count">0 selected</span>
            </div>
            <div class="redraft-wb-message-list" id="redraft_wb_messages"></div>
            <details class="redraft-wb-overrides" id="redraft_wb_overrides">
                <summary>Custom settings for this run</summary>
                <div class="redraft-wb-overrides-body">
                    <div class="redraft-form-group">
                        <label>PoV override</label>
                        <select id="redraft_wb_override_pov">
                            <option value="">Use global</option><option value="auto">Auto</option><option value="detect">Detect</option>
                            <option value="1st">1st</option><option value="1.5">1.5th</option>
                            <option value="2nd">2nd</option><option value="3rd">3rd</option>
                        </select>
                    </div>
                    <div class="redraft-form-group">
                        <label>System prompt override</label>
                        <textarea id="redraft_wb_override_sysprompt" class="text_pole redraft-system-prompt" rows="3" placeholder="Leave empty to use global"></textarea>
                    </div>
                </div>
            </details>
            <div class="redraft-wb-run-controls">
                <div class="redraft-form-group">
                    <label>Delay between messages: <span id="redraft_wb_delay_label">2s</span></label>
                    <input type="range" id="redraft_wb_delay" min="0" max="10000" step="500" value="2000" />
                </div>
                <button id="redraft_wb_start" class="menu_button menu_button_icon redraft-wb-start-btn">
                    <i class="fa-solid fa-play"></i> <span>Start (0)</span>
                </button>
            </div>
            <div class="redraft-wb-progress" id="redraft_wb_progress" style="display: none;">
                <div class="redraft-wb-progress-bar-track"><div class="redraft-wb-progress-bar-fill" id="redraft_wb_progress_fill"></div></div>
                <div class="redraft-wb-progress-text" id="redraft_wb_progress_text">0 / 0</div>
                <div class="redraft-wb-progress-current" id="redraft_wb_progress_current"></div>
                <button id="redraft_wb_cancel" class="menu_button menu_button_icon"><i class="fa-solid fa-stop"></i> Cancel</button>
            </div>
            <div class="redraft-wb-summary" id="redraft_wb_summary" style="display: none;"></div>
        </div>
        <div class="redraft-sidebar-tab-content" data-tab="history" id="redraft_tab_history">
            <div class="redraft-wb-history-list" id="redraft_wb_history"></div>
        </div>
        <div class="redraft-sidebar-tab-content" data-tab="stats" id="redraft_tab_stats">
            <div class="redraft-wb-stats-grid" id="redraft_wb_stats"></div>
        </div>
        <div class="redraft-sidebar-tab-content" data-tab="swarm" id="redraft_tab_swarm">
            <div class="redraft-wb-swarm" id="redraft_wb_swarm"></div>
        </div>
    </div>
</div>`;

    const container = document.getElementById('extensions_settings2');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);

        // Move sidebar to body for proper positioning
        const sidebar = document.getElementById('redraft_sidebar');
        if (sidebar) document.body.appendChild(sidebar);
    }

    // Initialize settings and bind UI
    getSettings();
    bindSettingsUI();

    // Create sidebar trigger button
    createSidebarTrigger();

    // Restore sidebar state from settings
    const savedSettings = getSettings();
    const sidebarEl = document.getElementById('redraft_sidebar');
    if (sidebarEl) {
        sidebarEl.style.width = (savedSettings.sidebarWidth || 380) + 'px';
        if (savedSettings.sidebarOpen) {
            openSidebar();
        }
        switchTab(savedSettings.sidebarActiveTab || 'refine');
    }

    // First-run hint
    const initSettings = getSettings();
    if (!initSettings.hasSeenHint) {
        toastr.info(
            'Use the ✏️ button in the bottom-right corner to open the ReDraft Workbench — refine messages, run bulk operations, and view stats.',
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
