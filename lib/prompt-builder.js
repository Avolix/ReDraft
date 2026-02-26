/**
 * Pure prompt-building functions extracted from the ReDraft client extension.
 * No DOM, no SillyTavern API — safe to test in Node.js.
 */

import { detectPov } from './text-utils.js';

export const POV_INSTRUCTIONS = {
    '1st': 'PERSPECTIVE RULES (MANDATORY): "I/me/my" = the AI narrator character ONLY. "you/your" = the player\'s character ONLY. All other characters = "he/she/they." These assignments are absolute \u2014 do not swap, mix, or shift them. If any pronoun violates this map, fix it.',
    '1.5': 'PERSPECTIVE RULES (MANDATORY): "I/me/my" = the current POV AI character. "you/your" = the player\'s character \u2014 ALWAYS in descriptions and actions, no exceptions. All other AI characters = "he/she/they." Do not use "I" for the player\'s character under any circumstance. Do not use "he/she/they" for the player\'s character in descriptions or actions \u2014 always "you/your." If any pronoun violates this map, fix it.',
    '2nd': 'PERSPECTIVE RULES (MANDATORY): "you/your" = the player\'s character ONLY \u2014 all narration addresses them as "you." All AI characters = "he/she/they" in narration (dialogue may use "I"). No AI character uses "I" in narrative voice. If any pronoun violates this map, fix it.',
    '3rd': 'PERSPECTIVE RULES (MANDATORY): ALL characters (including the player\'s character) use "he/she/they" + names. No "I" in narration. No "you" in narration. If any pronoun violates this map, fix it.',
};

export const DEFAULT_SYSTEM_PROMPT = `You are a roleplay prose editor. You refine AI-generated roleplay messages by applying specific rules while preserving the author's creative intent.

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
- Grammar: Fixed "their" \u2192 "they're" in paragraph 2
- Repetition: Replaced 3rd use of "softly" with "gently"
[/CHANGELOG]
[REFINED]
(refined message here)
[/REFINED]

Do NOT output any analysis, reasoning, or commentary outside the tags. Only output the two tagged blocks.

You will be given the original message, a set of refinement rules to apply, and optionally context about the characters and recent conversation. Apply the rules faithfully.`;

export const DEFAULT_USER_ENHANCE_SYSTEM_PROMPT = `You are a roleplay writing assistant. You enhance user-written roleplay messages by fixing grammar, improving prose, and ensuring the writing matches the user's character persona.

Core principles:
- Fix grammar, spelling, and punctuation errors
- Preserve the user's creative intent, actions, dialogue content, and story direction exactly
- Match the user's character voice and persona \u2014 their speech patterns, vocabulary, and personality
- Keep approximately the same length unless a rule specifically calls for cuts
- Do not add new story elements, actions, or dialogue not present in the original
- Do not change the meaning, emotional tone, or direction of what the user wrote
- Do not censor, sanitize, or tone down content \u2014 the original's maturity level is intentional
- Maintain existing formatting conventions (e.g. *asterisks for actions*, "quotes for dialogue")
- Enhance prose quality while keeping the user's style \u2014 fix awkward phrasing, improve flow
- Ensure consistency with the user's character persona and established lore
- The user wrote this message as their character \u2014 treat every line as intentional role-playing

Output format (MANDATORY \u2014 always follow this structure):
1. First, output a changelog inside [CHANGELOG]...[/CHANGELOG] tags listing each change you made and which rule motivated it. One line per change. If a rule required no changes, omit it.
2. Then output the full enhanced message inside [REFINED]...[/REFINED] tags with no other commentary.

Example:
[CHANGELOG]
- Grammar: Fixed "their" \u2192 "they're" in paragraph 2
- Voice: Adjusted phrasing to match character's casual speech pattern
[/CHANGELOG]
[REFINED]
(enhanced message here)
[/REFINED]

Do NOT output any analysis, reasoning, or commentary outside the tags. Only output the two tagged blocks.

You will be given the original message, a set of enhancement rules to apply, and context about the user's character persona and the scene. Apply the rules faithfully.`;

/**
 * Resolve the POV key from settings, optionally detecting from message text.
 * @param {string} settingsPov - The pov setting ('auto'|'detect'|'1st'|'1.5'|'2nd'|'3rd')
 * @param {string} messageText - Message text to detect POV from
 * @returns {string} Resolved POV key
 */
function resolvePov(settingsPov, messageText) {
    let povKey = settingsPov || 'auto';
    if (povKey === 'detect' || povKey === 'auto') {
        const detected = detectPov(messageText);
        if (detected) {
            povKey = detected;
        } else if (povKey === 'detect') {
            povKey = 'auto';
        }
    }
    return povKey;
}

/**
 * Build the full prompt and system prompt for AI message refinement.
 *
 * @param {object} settings - Extension settings
 * @param {object} context - Object with .characters, .characterId, .name1, .name2
 * @param {object[]} chatArray - The chat message array
 * @param {number} messageIndex - Index of the AI message being refined
 * @param {string} strippedMessage - Message text with protected blocks replaced
 * @param {{ rulesText: string, systemPrompt: string }} opts - Pre-resolved rules and system prompt
 * @returns {{ systemPrompt: string, promptText: string }}
 */
export function buildAiRefinePrompt(settings, context, chatArray, messageIndex, strippedMessage, { rulesText, systemPrompt }) {
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

    const messagesBeforeThis = chatArray.slice(0, messageIndex);
    const lastUserMsgBefore = [...messagesBeforeThis].reverse().find(m => m.is_user && m.mes);
    if (lastUserMsgBefore) {
        contextParts.push(`Last user message (what the user said before this response):\n${lastUserMsgBefore.mes}`);
    }

    const prevAiMsgs = chatArray.filter((m, i) => !m.is_user && m.mes && i < messageIndex);
    if (prevAiMsgs.length > 0) {
        const tailChars = Math.min(800, Math.max(50, settings.previousResponseTailChars ?? 200));
        const prevTail = prevAiMsgs[prevAiMsgs.length - 1].mes.slice(-tailChars);
        contextParts.push(`Previous response ending (last ~${tailChars} chars):\n${prevTail}`);
    }

    const povKey = resolvePov(settings.pov, strippedMessage);
    if (povKey !== 'auto' && POV_INSTRUCTIONS[povKey]) {
        contextParts.push(`Point of view: ${POV_INSTRUCTIONS[povKey]}`);
    }

    const contextBlock = contextParts.length > 0
        ? `Context:\n${contextParts.join('\n\n')}\n\n`
        : '';

    const promptText = `${contextBlock}Apply the following refinement rules to the message below. Any [PROTECTED_N] placeholders are protected regions \u2014 output them exactly as-is.

Remember: output [CHANGELOG]...[/CHANGELOG] first, then the refined message inside [REFINED]...[/REFINED]. No other text outside these tags.

Rules:\n${rulesText}\n\nOriginal message:\n${strippedMessage}`;

    return { systemPrompt, promptText };
}

/**
 * Build the full prompt and system prompt for user message enhancement.
 *
 * @param {object} settings - Extension settings
 * @param {object} context - Object with .characters, .characterId, .name1, .name2
 * @param {object[]} chatArray - The chat message array
 * @param {number} messageIndex - Index of the user message being enhanced
 * @param {string} strippedMessage - Message text with protected blocks replaced
 * @param {{ rulesText: string, personaDesc: string, systemPrompt: string }} opts - Pre-resolved values
 * @returns {{ systemPrompt: string, promptText: string }}
 */
export function buildUserEnhancePrompt(settings, context, chatArray, messageIndex, strippedMessage, { rulesText, personaDesc, systemPrompt }) {
    const contextParts = [];
    const char = context.characters?.[context.characterId];
    const charLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
    const charDesc = char?.data?.personality || char?.data?.description?.substring(0, charLimit) || '';

    const personaLimit = Math.min(4000, Math.max(100, settings.characterContextChars ?? 500));
    if (context.name1 || personaDesc) {
        const truncatedPersona = personaDesc ? personaDesc.substring(0, personaLimit) : '';
        contextParts.push(`Your character (who you are writing as): ${context.name1 || 'Unknown'}${truncatedPersona ? ' \u2014 ' + truncatedPersona : ''}`);
    }

    if (context.name2 || charDesc) {
        contextParts.push(`Character you are interacting with: ${context.name2 || 'Unknown'}${charDesc ? ' \u2014 ' + charDesc : ''}`);
    }

    const prevAiMsg = [...chatArray.slice(0, messageIndex)].reverse().find(m => !m.is_user && m.mes);
    if (prevAiMsg) {
        const tailChars = Math.min(800, Math.max(50, settings.previousResponseTailChars ?? 200));
        contextParts.push(`Last response from ${context.name2 || 'the character'} (for scene context, last ~${tailChars} chars):\n${prevAiMsg.mes.slice(-tailChars)}`);
    }

    const povKey = resolvePov(settings.pov, strippedMessage);
    if (povKey !== 'auto' && POV_INSTRUCTIONS[povKey]) {
        contextParts.push(`Point of view: ${POV_INSTRUCTIONS[povKey]}`);
    }

    const contextBlock = contextParts.length > 0
        ? `Context:\n${contextParts.join('\n\n')}\n\n`
        : '';

    const promptText = `${contextBlock}Apply the following enhancement rules to the message below. Any [PROTECTED_N] placeholders are protected regions \u2014 output them exactly as-is.

Remember: output [CHANGELOG]...[/CHANGELOG] first, then the enhanced message inside [REFINED]...[/REFINED]. No other text outside these tags.

Rules:\n${rulesText}\n\nOriginal message:\n${strippedMessage}`;

    return { systemPrompt, promptText };
}
