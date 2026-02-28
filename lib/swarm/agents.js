/**
 * Swarm agent definitions and LLM call wrapper.
 * Each agent is a single focused LLM call — no multi-turn, no tool use.
 */

import { compileRules as _compileRules } from '../text-utils.js';
import { DEFAULT_SYSTEM_PROMPT } from '../prompt-builder.js';

// ─── Agent Role System Prompts ──────────────────────────────────────

const OUTPUT_FORMAT_INSTRUCTIONS = `
Output format (MANDATORY — always follow this structure):
1. First, output a changelog inside [CHANGELOG]...[/CHANGELOG] tags listing each change you made and which rule motivated it. One line per change. If a rule required no changes, omit it.
2. Then output the full refined message inside [REFINED]...[/REFINED] tags with no other commentary.

Do NOT output any analysis, reasoning, or commentary outside the tags. Only output the two tagged blocks.`;

/**
 * Build a pipeline-stage system prompt focused on a narrow editing scope.
 */
export function buildPipelineStagePrompt(stageName, stageDescription) {
    return `You are a roleplay prose editor performing a focused editing pass. Your ONLY task in this pass is: ${stageDescription}

Do not change anything outside your scope. If something is already good within your scope, leave it alone. Do not introduce new issues while fixing others.

Core constraints:
- Preserve the original meaning, narrative direction, and emotional tone
- Preserve paragraph structure and sequence of events
- Edits are surgical: change the minimum necessary
- Do not censor, sanitize, or tone down content
- Maintain existing formatting conventions
- When in doubt, leave the original text as-is
${OUTPUT_FORMAT_INSTRUCTIONS}

You will be given the message text and the specific rules for this "${stageName}" pass.`;
}

/**
 * Build a council-refiner system prompt with a specific emphasis.
 */
export function buildCouncilRefinerPrompt(emphasis) {
    return `You are a roleplay prose editor. You refine AI-generated roleplay messages by applying specific rules while preserving the author's creative intent.

Your editing emphasis: ${emphasis}

While you should apply all provided rules, prioritize your emphasis area above others. When trade-offs arise between competing improvements, lean toward your emphasis.

Core principles:
- Preserve the original meaning, narrative direction, and emotional tone
- Preserve paragraph structure and sequence of events — do not reorder or restructure
- Edits are surgical: change the minimum necessary to satisfy the active rules
- Keep approximately the same length unless a rule specifically calls for cuts
- Do not add new story elements, actions, or dialogue not present in the original
- Do not censor, sanitize, or tone down content
- Maintain existing formatting conventions
- Treat each character as a distinct voice
${OUTPUT_FORMAT_INSTRUCTIONS}

You will be given the original message, refinement rules, and optionally context about the characters and recent conversation.`;
}

/**
 * System prompt for the council judge agent.
 */
export function buildCouncilJudgePrompt(candidateCount, judgeMode) {
    const modeInstruction = judgeMode === 'pick_best'
        ? 'Select the single strongest candidate and output it as your refined version. Do not mix candidates — pick one.'
        : 'Synthesize the best edits from all candidates into one cohesive result. You may take the strongest elements from different candidates, but ensure the final text reads as a unified piece.';

    return `You are a senior roleplay editor and arbiter. You will see the original message and ${candidateCount} refined candidates produced by different editors with different priorities.

Your task: ${modeInstruction}

Evaluation criteria (in priority order):
1. Character voice authenticity — does the candidate preserve how each character speaks?
2. Narrative intent — does the candidate keep the scene moving in the same direction?
3. Prose quality — are the edits clean, surgical, and effective?
4. Rule compliance — did the candidate address the refinement rules?

Preserve the original's intent, approximate length, and character voice.
${OUTPUT_FORMAT_INSTRUCTIONS}`;
}

/**
 * System prompt for the reviewer agent (critique only, no rewriting).
 */
export const REVIEWER_SYSTEM_PROMPT = `You are a roleplay prose critic. You analyze roleplay messages and produce structured feedback. You do NOT rewrite the message — you only critique it.

Analyze the message against the provided rules and context, then output your critique in this exact format:

[PRESERVE]
List the specific lines, phrases, or elements that are strong and should NOT be changed. Be specific — quote the text.
[/PRESERVE]

[FIX]
List specific issues you found. For each issue:
- Quote the problematic text
- Name which rule it violates
- Suggest a specific fix or direction
[/FIX]

[LEAVE]
List any intentional style choices that might look like errors but should stay as-is (dialect, character voice quirks, deliberate fragments, etc.)
[/LEAVE]

Be thorough but fair. Not every message needs many fixes. If the writing is already strong, say so.
Do NOT output a rewritten version. Only output the three tagged critique blocks.`;

/**
 * System prompt for the refiner that works from a reviewer's critique.
 */
export function buildCritiqueRefinerPrompt() {
    return `You are a roleplay prose editor. A reviewer has already analyzed this message and produced a structured critique. Your job is to apply their feedback precisely.

Instructions:
- Fix ONLY what the reviewer flagged in [FIX]. Do not make additional changes.
- Preserve everything the reviewer marked in [PRESERVE] — do not touch those elements.
- Respect everything in [LEAVE] — those are intentional style choices, not errors.
- If you disagree with a reviewer suggestion, err on the side of preserving the original.

Core constraints:
- Edits are surgical: change the minimum necessary
- Preserve paragraph structure and sequence of events
- Do not censor, sanitize, or tone down content
- Maintain existing formatting conventions
${OUTPUT_FORMAT_INSTRUCTIONS}

You will be given the original message, the reviewer's critique, and the refinement rules for reference.`;
}

// ─── Pipeline Stage Descriptions ────────────────────────────────────

export const STAGE_DESCRIPTIONS = {
    grammar: 'Fix grammatical errors, spelling mistakes, and formatting inconsistencies. Do not alter style, voice, prose quality, or narrative structure.',
    prose: 'Improve prose quality: fix filter words, purple prose, somatic clichés, and telling-over-showing. Preserve character voice and do not change grammar, formatting, or narrative structure.',
    voice: 'Ensure character voice consistency: each character should sound distinct, maintain their speech patterns, and not be flattened into a single register. Do not change grammar, prose style, or narrative structure.',
    echo: 'Remove echo and restatement where the character restates or paraphrases the user\'s previous message instead of advancing the scene. Replace cut content with forward motion. Do not change grammar, prose, or voice.',
    continuity: 'Check repetition across the response and compared to the previous response. Check for crafted endings (dismount patterns). Verify lore consistency if context is available. Do not change grammar, prose quality, or voice.',
};

// ─── Council Emphasis Presets ────────────────────────────────────────

export const COUNCIL_EMPHASES = [
    'Prioritize preserving character voice and dialogue authenticity above all other improvements. Each character must sound distinct and true to their established patterns.',
    'Prioritize tightening prose — cut unnecessary words, strengthen verbs, eliminate filter phrases and somatic clichés. Lean toward concision over embellishment.',
    'Prioritize narrative flow and scene continuity — ensure the response moves the scene forward, connects naturally to prior context, and avoids echo or restatement.',
    'Prioritize emotional authenticity and pacing — ensure reactions feel earned, beats land with appropriate weight, and the scene does not end with a crafted dismount.',
];

// ─── Agent Call Wrapper ─────────────────────────────────────────────

/**
 * Call an LLM as a specific agent. Wraps the provided refine function
 * with agent-specific system prompt and prompt building.
 *
 * @param {object} opts
 * @param {string} opts.systemPrompt - Agent's system prompt
 * @param {string} opts.promptText - The user/content prompt
 * @param {Function} opts.refineFn - Either refineViaST or refineViaPlugin
 * @param {AbortSignal} [opts.signal]
 * @param {string} [opts.modelOverride] - Model override for plugin mode
 * @returns {Promise<string>} Raw LLM response text
 */
export async function callAgent({ systemPrompt, promptText, refineFn, signal, modelOverride }) {
    return refineFn(promptText, systemPrompt, { signal, model: modelOverride || undefined });
}

/**
 * Build a refinement prompt for a pipeline stage or council refiner.
 * Includes rules, context, and the message text.
 *
 * @param {object} opts
 * @param {string} opts.messageText - The message to refine
 * @param {string} opts.rulesText - Compiled rules string
 * @param {string} [opts.contextBlock] - Optional context (character, chat, PoV)
 * @param {string} [opts.critiqueBlock] - Optional reviewer critique (for critique-refiner)
 * @returns {string}
 */
export function buildAgentPrompt({ messageText, rulesText, contextBlock, critiqueBlock }) {
    let prompt = '';

    if (contextBlock) {
        prompt += contextBlock + '\n\n';
    }

    if (critiqueBlock) {
        prompt += `Reviewer's critique:\n${critiqueBlock}\n\n`;
    }

    prompt += `Rules:\n${rulesText}\n\n`;
    prompt += `Original message:\n${messageText}`;

    return prompt;
}

/**
 * Compile a subset of built-in rules into a numbered rules string.
 * @param {string[]} ruleKeys - Array of rule keys to include (e.g., ['grammar', 'formatting'])
 * @param {object} allBuiltInRules - The full BUILTIN_RULES map
 * @param {object} settings - Extension settings (for custom rules)
 * @returns {string}
 */
export function compileRuleSubset(ruleKeys, allBuiltInRules, settings) {
    const fakeSettings = {
        builtInRules: {},
        customRules: settings.customRules || [],
    };
    for (const key of Object.keys(allBuiltInRules)) {
        fakeSettings.builtInRules[key] = ruleKeys.includes(key);
    }
    return _compileRules(fakeSettings, allBuiltInRules);
}
