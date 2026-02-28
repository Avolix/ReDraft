/**
 * Swarm strategy definitions: Pipeline, Council, Review+Refine.
 * Each strategy is a declarative config describing how agents are orchestrated.
 */

// ─── Strategy Types ─────────────────────────────────────────────────

export const STRATEGY_TYPES = {
    PIPELINE: 'pipeline',
    COUNCIL: 'council',
    REVIEW: 'review',
};

// ─── Default Pipeline Stage Configs ─────────────────────────────────

export const DEFAULT_PIPELINE_STAGES = [
    {
        id: 'grammar',
        name: 'Grammar & Formatting',
        rules: ['grammar', 'formatting'],
        enabled: true,
    },
    {
        id: 'prose',
        name: 'Prose & Voice',
        rules: ['prose', 'voice', 'echo'],
        enabled: true,
    },
    {
        id: 'continuity',
        name: 'Continuity & Flow',
        rules: ['repetition', 'ending', 'lore'],
        enabled: true,
    },
];

// ─── Strategy Metadata ──────────────────────────────────────────────

export const STRATEGY_META = {
    [STRATEGY_TYPES.PIPELINE]: {
        name: 'Pipeline',
        description: 'Multi-pass sequential refinement. Each stage focuses on a specific rule set and passes its output to the next stage.',
        icon: '⟩',
    },
    [STRATEGY_TYPES.COUNCIL]: {
        name: 'Council',
        description: 'Multiple agents refine in parallel with different emphases, then a judge picks the best or synthesizes a final version.',
        icon: '⊕',
    },
    [STRATEGY_TYPES.REVIEW]: {
        name: 'Review + Refine',
        description: 'A reviewer critiques the message first, then a refiner applies the critique. Two focused passes instead of one broad one.',
        icon: '⇄',
    },
};

// ─── Strategy Defaults ──────────────────────────────────────────────

export const DEFAULT_COUNCIL_SIZE = 3;
export const MIN_COUNCIL_SIZE = 2;
export const MAX_COUNCIL_SIZE = 4;

export const JUDGE_MODES = {
    PICK_BEST: 'pick_best',
    SYNTHESIZE: 'synthesize',
};

// ─── Validation ─────────────────────────────────────────────────────

/**
 * Validate a pipeline stages array.
 * @param {Array} stages
 * @returns {{ valid: boolean, error?: string }}
 */
export function validatePipelineStages(stages) {
    if (!Array.isArray(stages) || stages.length === 0) {
        return { valid: false, error: 'Pipeline must have at least one stage.' };
    }
    const enabledStages = stages.filter(s => s.enabled);
    if (enabledStages.length === 0) {
        return { valid: false, error: 'At least one pipeline stage must be enabled.' };
    }
    for (const stage of stages) {
        if (!stage.id || !stage.name) {
            return { valid: false, error: 'Each stage must have an id and name.' };
        }
        if (!Array.isArray(stage.rules) || stage.rules.length === 0) {
            return { valid: false, error: `Stage "${stage.name}" must have at least one rule.` };
        }
    }
    return { valid: true };
}

/**
 * Validate council configuration.
 * @param {number} size
 * @param {string} judgeMode
 * @returns {{ valid: boolean, error?: string }}
 */
export function validateCouncilConfig(size, judgeMode) {
    if (typeof size !== 'number' || size < MIN_COUNCIL_SIZE || size > MAX_COUNCIL_SIZE) {
        return { valid: false, error: `Council size must be between ${MIN_COUNCIL_SIZE} and ${MAX_COUNCIL_SIZE}.` };
    }
    if (!Object.values(JUDGE_MODES).includes(judgeMode)) {
        return { valid: false, error: `Invalid judge mode: ${judgeMode}` };
    }
    return { valid: true };
}

/**
 * Get the full resolved strategy config from settings.
 * @param {object} settings - Extension settings
 * @returns {object} Resolved strategy config
 */
export function resolveStrategyConfig(settings) {
    const type = settings.swarmStrategy || STRATEGY_TYPES.PIPELINE;

    switch (type) {
        case STRATEGY_TYPES.PIPELINE:
            return {
                type,
                stages: settings.swarmPipelineStages || [...DEFAULT_PIPELINE_STAGES],
            };
        case STRATEGY_TYPES.COUNCIL:
            return {
                type,
                councilSize: settings.swarmCouncilSize || DEFAULT_COUNCIL_SIZE,
                judgeMode: settings.swarmCouncilJudgeMode || JUDGE_MODES.SYNTHESIZE,
                modelOverrides: settings.swarmCouncilModelOverrides || {},
            };
        case STRATEGY_TYPES.REVIEW:
            return { type };
        default:
            return { type: STRATEGY_TYPES.PIPELINE, stages: [...DEFAULT_PIPELINE_STAGES] };
    }
}
