/**
 * Swarm strategy executor.
 * Orchestrates agents according to a strategy config: sequential for Pipeline,
 * parallel for Council, two-step for Review+Refine.
 */

import { STRATEGY_TYPES } from './strategies.js';
import {
    callAgent,
    buildAgentPrompt,
    buildPipelineStagePrompt,
    buildCouncilRefinerPrompt,
    buildCouncilJudgePrompt,
    buildCritiqueRefinerPrompt,
    REVIEWER_SYSTEM_PROMPT,
    STAGE_DESCRIPTIONS,
    COUNCIL_EMPHASES,
    compileRuleSubset,
} from './agents.js';

const COUNCIL_CONCURRENCY = 4;

/**
 * @typedef {object} SwarmProgress
 * @property {string} phase - Current phase label
 * @property {number} current - Current step index (0-based)
 * @property {number} total - Total steps
 * @property {string} agentName - Name of the active agent
 * @property {'running'|'done'|'queued'} status
 */

/**
 * Execute a swarm strategy on a single message.
 *
 * @param {object} opts
 * @param {object} opts.strategyConfig - Resolved strategy config from resolveStrategyConfig()
 * @param {string} opts.messageText - The stripped message text to refine
 * @param {string} opts.contextBlock - Context string (character, chat, PoV)
 * @param {string} opts.fullRulesText - Compiled rules for the full rule set (council/review)
 * @param {object} opts.allBuiltInRules - The BUILTIN_RULES map
 * @param {object} opts.settings - Extension settings
 * @param {Function} opts.refineFn - refineViaST or refineViaPlugin
 * @param {AbortSignal} [opts.signal]
 * @param {number} [opts.timeoutSeconds] - Per-agent timeout override (seconds)
 * @param {Function} [opts.onProgress] - Progress callback: (SwarmProgress) => void
 * @returns {Promise<{ refinedRaw: string, agentLog: Array }>}
 *   refinedRaw = final LLM response (containing [CHANGELOG]/[REFINED] tags)
 *   agentLog = array of { agentName, durationMs, rawResponse } per agent call
 */
export async function executeStrategy(opts) {
    const { strategyConfig } = opts;

    switch (strategyConfig.type) {
        case STRATEGY_TYPES.PIPELINE:
            return executePipeline(opts);
        case STRATEGY_TYPES.COUNCIL:
            return executeCouncil(opts);
        case STRATEGY_TYPES.REVIEW:
            return executeReviewRefine(opts);
        default:
            throw new Error(`Unknown swarm strategy: ${strategyConfig.type}`);
    }
}

// ─── Pipeline Execution ─────────────────────────────────────────────

async function executePipeline({ strategyConfig, messageText, contextBlock, allBuiltInRules, settings, refineFn, signal, onProgress, timeoutSeconds }) {
    const enabledStages = strategyConfig.stages.filter(s => s.enabled);
    const agentLog = [];
    let currentText = messageText;

    for (let i = 0; i < enabledStages.length; i++) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const stage = enabledStages[i];
        const agentName = stage.name;

        onProgress?.({
            phase: 'Pipeline',
            current: i,
            total: enabledStages.length,
            agentName,
            status: 'running',
        });

        const stageDesc = buildStageDescription(stage);
        const systemPrompt = buildPipelineStagePrompt(stage.id, stageDesc);
        const rulesText = compileRuleSubset(stage.rules, allBuiltInRules, settings);

        const promptText = buildAgentPrompt({
            messageText: currentText,
            rulesText,
            contextBlock,
        });

        const startTime = Date.now();
        const rawResponse = await callAgent({
            systemPrompt,
            promptText: wrapWithOutputInstructions(promptText),
            refineFn,
            signal,
            timeoutSeconds,
        });
        const durationMs = Date.now() - startTime;

        agentLog.push({ agentName, durationMs, rawResponse });

        const extracted = extractRefinedText(rawResponse);
        if (extracted) {
            currentText = extracted;
        }

        onProgress?.({
            phase: 'Pipeline',
            current: i + 1,
            total: enabledStages.length,
            agentName,
            status: 'done',
        });
    }

    const lastResponse = agentLog[agentLog.length - 1]?.rawResponse || currentText;
    return { refinedRaw: lastResponse, agentLog };
}

function buildStageDescription(stage) {
    const descriptions = stage.rules.map(r => STAGE_DESCRIPTIONS[r]).filter(Boolean);
    if (descriptions.length > 0) return descriptions.join(' ');
    return `Apply the ${stage.name} rules.`;
}

// ─── Council Execution ──────────────────────────────────────────────

async function executeCouncil({ strategyConfig, messageText, contextBlock, fullRulesText, settings: _settings, refineFn, signal, onProgress, timeoutSeconds }) {
    const { councilSize, judgeMode, modelOverrides = {} } = strategyConfig;
    const agentLog = [];

    const emphases = COUNCIL_EMPHASES.slice(0, councilSize);

    for (let i = 0; i < councilSize; i++) {
        onProgress?.({
            phase: 'Council',
            current: 0,
            total: councilSize + 1,
            agentName: `Council Member ${String.fromCharCode(65 + i)}`,
            status: 'queued',
        });
    }

    const candidates = [];
    let succeededCount = 0;
    const batches = chunkArray(
        emphases.map((emphasis, idx) => ({ emphasis, idx })),
        COUNCIL_CONCURRENCY,
    );

    for (const batch of batches) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const batchResults = await Promise.all(batch.map(async ({ emphasis, idx }) => {
            const agentId = `council_${idx}`;
            const agentName = `Council Member ${String.fromCharCode(65 + idx)}`;

            onProgress?.({
                phase: 'Council',
                current: succeededCount,
                total: councilSize + 1,
                agentName,
                status: 'running',
            });

            const systemPrompt = buildCouncilRefinerPrompt(emphasis);
            const promptText = buildAgentPrompt({
                messageText,
                rulesText: fullRulesText,
                contextBlock,
            });

            try {
                const startTime = Date.now();
                const rawResponse = await callAgent({
                    systemPrompt,
                    promptText: wrapWithOutputInstructions(promptText),
                    refineFn,
                    signal,
                    modelOverride: modelOverrides[agentId] || undefined,
                    timeoutSeconds,
                });
                const durationMs = Date.now() - startTime;

                onProgress?.({
                    phase: 'Council',
                    current: succeededCount + 1,
                    total: councilSize + 1,
                    agentName,
                    status: 'done',
                });

                return { agentName, durationMs, rawResponse, failed: false };
            } catch (err) {
                if (err.name === 'AbortError') throw err;

                onProgress?.({
                    phase: 'Council',
                    current: succeededCount,
                    total: councilSize + 1,
                    agentName,
                    status: 'failed',
                });

                return { agentName, durationMs: 0, rawResponse: null, failed: true, error: err.message };
            }
        }));

        for (const result of batchResults) {
            agentLog.push(result);
            if (!result.failed) {
                candidates.push(result.rawResponse);
                succeededCount++;
            }
        }
    }

    if (candidates.length === 0) {
        throw new Error('All council members failed — no candidates produced. Check the console for individual errors.');
    }

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    onProgress?.({
        phase: 'Council',
        current: succeededCount,
        total: councilSize + 1,
        agentName: 'Judge',
        status: 'running',
    });

    const candidateTexts = candidates.map((raw, i) => {
        const refined = extractRefinedText(raw);
        return `--- Candidate ${String.fromCharCode(65 + i)} ---\n${refined || raw}`;
    }).join('\n\n');

    const judgeSystemPrompt = buildCouncilJudgePrompt(candidates.length, judgeMode);
    const judgePrompt = `Original message:\n${messageText}\n\n${candidateTexts}\n\nProduce the best final version.`;

    const startTime = Date.now();
    const judgeResponse = await callAgent({
        systemPrompt: judgeSystemPrompt,
        promptText: wrapWithOutputInstructions(judgePrompt),
        refineFn,
        signal,
        modelOverride: modelOverrides['judge'] || undefined,
        timeoutSeconds,
    });
    const judgeDuration = Date.now() - startTime;

    agentLog.push({ agentName: 'Judge', durationMs: judgeDuration, rawResponse: judgeResponse, failed: false });

    onProgress?.({
        phase: 'Council',
        current: succeededCount + 1,
        total: councilSize + 1,
        agentName: 'Judge',
        status: 'done',
    });

    return { refinedRaw: judgeResponse, agentLog };
}

// ─── Review + Refine Execution ──────────────────────────────────────

async function executeReviewRefine({ messageText, contextBlock, fullRulesText, refineFn, signal, onProgress, timeoutSeconds }) {
    const agentLog = [];

    onProgress?.({
        phase: 'Review + Refine',
        current: 0,
        total: 2,
        agentName: 'Reviewer',
        status: 'running',
    });

    const reviewPrompt = buildAgentPrompt({
        messageText,
        rulesText: fullRulesText,
        contextBlock,
    });

    const reviewStart = Date.now();
    const critiqueResponse = await callAgent({
        systemPrompt: REVIEWER_SYSTEM_PROMPT,
        promptText: reviewPrompt,
        refineFn,
        signal,
        timeoutSeconds,
    });
    const reviewDuration = Date.now() - reviewStart;

    agentLog.push({ agentName: 'Reviewer', durationMs: reviewDuration, rawResponse: critiqueResponse });

    onProgress?.({
        phase: 'Review + Refine',
        current: 1,
        total: 2,
        agentName: 'Reviewer',
        status: 'done',
    });

    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

    onProgress?.({
        phase: 'Review + Refine',
        current: 1,
        total: 2,
        agentName: 'Refiner',
        status: 'running',
    });

    const refineSystemPrompt = buildCritiqueRefinerPrompt();
    const refinePromptText = buildAgentPrompt({
        messageText,
        rulesText: fullRulesText,
        contextBlock,
        critiqueBlock: critiqueResponse,
    });

    const refineStart = Date.now();
    const refinedResponse = await callAgent({
        systemPrompt: refineSystemPrompt,
        promptText: wrapWithOutputInstructions(refinePromptText),
        refineFn,
        signal,
        timeoutSeconds,
    });
    const refineDuration = Date.now() - refineStart;

    agentLog.push({ agentName: 'Refiner', durationMs: refineDuration, rawResponse: refinedResponse });

    onProgress?.({
        phase: 'Review + Refine',
        current: 2,
        total: 2,
        agentName: 'Refiner',
        status: 'done',
    });

    return { refinedRaw: refinedResponse, agentLog };
}

// ─── Helpers ────────────────────────────────────────────────────────

function wrapWithOutputInstructions(promptText) {
    return `${promptText}\n\nRemember: output [CHANGELOG]...[/CHANGELOG] first, then the refined message inside [REFINED]...[/REFINED]. No other text outside these tags.`;
}

/**
 * Extract the [REFINED]...[/REFINED] block from a raw LLM response.
 * Returns the inner text, or null if not found.
 */
function extractRefinedText(raw) {
    const match = raw.match(/\[REFINED\]([\s\S]*?)\[\/REFINED\]/);
    return match ? match[1].trim() : null;
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}
