import { describe, it, expect } from 'vitest';
import {
    STRATEGY_TYPES,
    DEFAULT_PIPELINE_STAGES,
    DEFAULT_COUNCIL_SIZE,
    MIN_COUNCIL_SIZE,
    MAX_COUNCIL_SIZE,
    JUDGE_MODES,
    STRATEGY_META,
    validatePipelineStages,
    validateCouncilConfig,
    resolveStrategyConfig,
} from '../lib/swarm/strategies.js';

// ─── Constants ──────────────────────────────────────────────────────

describe('strategy constants', () => {
    it('defines three strategy types', () => {
        expect(STRATEGY_TYPES.PIPELINE).toBe('pipeline');
        expect(STRATEGY_TYPES.COUNCIL).toBe('council');
        expect(STRATEGY_TYPES.REVIEW).toBe('review');
    });

    it('has metadata for every strategy type', () => {
        for (const type of Object.values(STRATEGY_TYPES)) {
            const meta = STRATEGY_META[type];
            expect(meta).toBeDefined();
            expect(meta.name).toBeTruthy();
            expect(meta.description).toBeTruthy();
        }
    });

    it('has valid default pipeline stages', () => {
        expect(DEFAULT_PIPELINE_STAGES.length).toBeGreaterThanOrEqual(1);
        for (const stage of DEFAULT_PIPELINE_STAGES) {
            expect(stage.id).toBeTruthy();
            expect(stage.name).toBeTruthy();
            expect(Array.isArray(stage.rules)).toBe(true);
            expect(stage.rules.length).toBeGreaterThanOrEqual(1);
        }
    });

    it('has valid council size bounds', () => {
        expect(MIN_COUNCIL_SIZE).toBeLessThanOrEqual(DEFAULT_COUNCIL_SIZE);
        expect(DEFAULT_COUNCIL_SIZE).toBeLessThanOrEqual(MAX_COUNCIL_SIZE);
        expect(MIN_COUNCIL_SIZE).toBeGreaterThanOrEqual(2);
    });

    it('defines judge modes', () => {
        expect(JUDGE_MODES.PICK_BEST).toBe('pick_best');
        expect(JUDGE_MODES.SYNTHESIZE).toBe('synthesize');
    });
});

// ─── validatePipelineStages ─────────────────────────────────────────

describe('validatePipelineStages', () => {
    it('accepts valid stages', () => {
        const result = validatePipelineStages(DEFAULT_PIPELINE_STAGES);
        expect(result.valid).toBe(true);
        expect(result.error).toBeUndefined();
    });

    it('rejects non-array', () => {
        expect(validatePipelineStages(null).valid).toBe(false);
        expect(validatePipelineStages('bad').valid).toBe(false);
        expect(validatePipelineStages({}).valid).toBe(false);
    });

    it('rejects empty array', () => {
        expect(validatePipelineStages([]).valid).toBe(false);
    });

    it('rejects when all stages are disabled', () => {
        const stages = DEFAULT_PIPELINE_STAGES.map(s => ({ ...s, enabled: false }));
        const result = validatePipelineStages(stages);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('enabled');
    });

    it('accepts when at least one stage is enabled', () => {
        const stages = DEFAULT_PIPELINE_STAGES.map((s, i) => ({ ...s, enabled: i === 0 }));
        expect(validatePipelineStages(stages).valid).toBe(true);
    });

    it('rejects stage without id', () => {
        const stages = [{ name: 'Test', rules: ['grammar'], enabled: true }];
        expect(validatePipelineStages(stages).valid).toBe(false);
    });

    it('rejects stage without name', () => {
        const stages = [{ id: 'test', rules: ['grammar'], enabled: true }];
        expect(validatePipelineStages(stages).valid).toBe(false);
    });

    it('rejects stage with empty rules', () => {
        const stages = [{ id: 'test', name: 'Test', rules: [], enabled: true }];
        const result = validatePipelineStages(stages);
        expect(result.valid).toBe(false);
        expect(result.error).toContain('rule');
    });

    it('rejects stage with non-array rules', () => {
        const stages = [{ id: 'test', name: 'Test', rules: 'grammar', enabled: true }];
        expect(validatePipelineStages(stages).valid).toBe(false);
    });
});

// ─── validateCouncilConfig ──────────────────────────────────────────

describe('validateCouncilConfig', () => {
    it('accepts valid config', () => {
        expect(validateCouncilConfig(3, 'synthesize').valid).toBe(true);
        expect(validateCouncilConfig(2, 'pick_best').valid).toBe(true);
        expect(validateCouncilConfig(4, 'synthesize').valid).toBe(true);
    });

    it('rejects size below minimum', () => {
        const result = validateCouncilConfig(1, 'synthesize');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('size');
    });

    it('rejects size above maximum', () => {
        const result = validateCouncilConfig(5, 'synthesize');
        expect(result.valid).toBe(false);
    });

    it('rejects non-number size', () => {
        expect(validateCouncilConfig('3', 'synthesize').valid).toBe(false);
        expect(validateCouncilConfig(null, 'synthesize').valid).toBe(false);
    });

    it('rejects invalid judge mode', () => {
        const result = validateCouncilConfig(3, 'invalid');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('judge mode');
    });
});

// ─── resolveStrategyConfig ──────────────────────────────────────────

describe('resolveStrategyConfig', () => {
    it('defaults to pipeline when no strategy set', () => {
        const config = resolveStrategyConfig({});
        expect(config.type).toBe('pipeline');
        expect(config.stages).toBeDefined();
        expect(config.stages.length).toBeGreaterThanOrEqual(1);
    });

    it('resolves pipeline config with custom stages', () => {
        const customStages = [{ id: 'x', name: 'X', rules: ['grammar'], enabled: true }];
        const config = resolveStrategyConfig({
            swarmStrategy: 'pipeline',
            swarmPipelineStages: customStages,
        });
        expect(config.type).toBe('pipeline');
        expect(config.stages).toEqual(customStages);
    });

    it('resolves council config', () => {
        const config = resolveStrategyConfig({
            swarmStrategy: 'council',
            swarmCouncilSize: 4,
            swarmCouncilJudgeMode: 'pick_best',
            swarmCouncilModelOverrides: { judge: 'gpt-4o' },
        });
        expect(config.type).toBe('council');
        expect(config.councilSize).toBe(4);
        expect(config.judgeMode).toBe('pick_best');
        expect(config.modelOverrides).toEqual({ judge: 'gpt-4o' });
    });

    it('resolves council config with defaults', () => {
        const config = resolveStrategyConfig({ swarmStrategy: 'council' });
        expect(config.councilSize).toBe(DEFAULT_COUNCIL_SIZE);
        expect(config.judgeMode).toBe('synthesize');
        expect(config.modelOverrides).toEqual({});
    });

    it('resolves review config', () => {
        const config = resolveStrategyConfig({ swarmStrategy: 'review' });
        expect(config.type).toBe('review');
    });

    it('falls back to pipeline for unknown strategy', () => {
        const config = resolveStrategyConfig({ swarmStrategy: 'unknown' });
        expect(config.type).toBe('pipeline');
    });
});
