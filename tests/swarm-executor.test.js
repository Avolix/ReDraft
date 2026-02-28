import { describe, it, expect, vi } from 'vitest';
import { executeStrategy } from '../lib/swarm/executor.js';

const BUILTIN_RULES = {
    grammar: { label: 'Grammar', prompt: 'Fix grammar.' },
    formatting: { label: 'Formatting', prompt: 'Fix formatting.' },
    prose: { label: 'Prose', prompt: 'Improve prose.' },
    voice: { label: 'Voice', prompt: 'Check voice.' },
    echo: { label: 'Echo', prompt: 'Remove echo.' },
    repetition: { label: 'Repetition', prompt: 'Reduce repetition.' },
    ending: { label: 'Ending', prompt: 'Fix endings.' },
    lore: { label: 'Lore', prompt: 'Check lore.' },
};

function makeLlmResponse(refined, changelog = 'No changes') {
    return `[CHANGELOG]\n${changelog}\n[/CHANGELOG]\n[REFINED]\n${refined}\n[/REFINED]`;
}

function makeRefineFn(responses) {
    let callIndex = 0;
    return vi.fn(async () => {
        const response = typeof responses === 'string'
            ? responses
            : responses[callIndex++ % responses.length];
        return response;
    });
}

const defaultSettings = {
    builtInRules: { grammar: true, formatting: true },
    customRules: [],
};

// ─── Pipeline ───────────────────────────────────────────────────────

describe('pipeline strategy', () => {
    it('runs enabled stages sequentially', async () => {
        const refineFn = makeRefineFn([
            makeLlmResponse('after stage 1'),
            makeLlmResponse('after stage 2'),
        ]);

        const result = await executeStrategy({
            strategyConfig: {
                type: 'pipeline',
                stages: [
                    { id: 'grammar', name: 'Grammar', rules: ['grammar'], enabled: true },
                    { id: 'prose', name: 'Prose', rules: ['prose'], enabled: true },
                ],
            },
            messageText: 'original text',
            contextBlock: 'Character: Alice',
            fullRulesText: '1. Fix grammar',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(refineFn).toHaveBeenCalledTimes(2);
        expect(result.agentLog).toHaveLength(2);
        expect(result.agentLog[0].agentName).toBe('Grammar');
        expect(result.agentLog[1].agentName).toBe('Prose');
        expect(result.refinedRaw).toContain('after stage 2');
    });

    it('skips disabled stages', async () => {
        const refineFn = makeRefineFn(makeLlmResponse('refined'));

        const result = await executeStrategy({
            strategyConfig: {
                type: 'pipeline',
                stages: [
                    { id: 'grammar', name: 'Grammar', rules: ['grammar'], enabled: true },
                    { id: 'prose', name: 'Prose', rules: ['prose'], enabled: false },
                ],
            },
            messageText: 'original text',
            contextBlock: '',
            fullRulesText: '1. Fix grammar',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(refineFn).toHaveBeenCalledTimes(1);
        expect(result.agentLog).toHaveLength(1);
        expect(result.agentLog[0].agentName).toBe('Grammar');
    });

    it('passes output of each stage to the next', async () => {
        const calls = [];
        const refineFn = vi.fn(async (promptText) => {
            calls.push(promptText);
            if (calls.length === 1) return makeLlmResponse('intermediate result');
            return makeLlmResponse('final result');
        });

        await executeStrategy({
            strategyConfig: {
                type: 'pipeline',
                stages: [
                    { id: 'grammar', name: 'Grammar', rules: ['grammar'], enabled: true },
                    { id: 'prose', name: 'Prose', rules: ['prose'], enabled: true },
                ],
            },
            messageText: 'original text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(calls[1]).toContain('intermediate result');
    });

    it('calls onProgress for each stage', async () => {
        const progressCalls = [];
        const refineFn = makeRefineFn(makeLlmResponse('done'));

        await executeStrategy({
            strategyConfig: {
                type: 'pipeline',
                stages: [
                    { id: 'grammar', name: 'Grammar', rules: ['grammar'], enabled: true },
                ],
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
            onProgress: (p) => progressCalls.push({ ...p }),
        });

        expect(progressCalls.length).toBeGreaterThanOrEqual(2);
        expect(progressCalls[0].status).toBe('running');
        expect(progressCalls[progressCalls.length - 1].status).toBe('done');
    });

    it('aborts on signal', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(executeStrategy({
            strategyConfig: {
                type: 'pipeline',
                stages: [
                    { id: 'grammar', name: 'Grammar', rules: ['grammar'], enabled: true },
                ],
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn: makeRefineFn(makeLlmResponse('ok')),
            signal: controller.signal,
        })).rejects.toThrow('Aborted');
    });

    it('records duration for each agent', async () => {
        const refineFn = makeRefineFn(makeLlmResponse('done'));

        const result = await executeStrategy({
            strategyConfig: {
                type: 'pipeline',
                stages: [
                    { id: 'grammar', name: 'Grammar', rules: ['grammar'], enabled: true },
                ],
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(result.agentLog[0].durationMs).toBeGreaterThanOrEqual(0);
        expect(typeof result.agentLog[0].rawResponse).toBe('string');
    });
});

// ─── Council ────────────────────────────────────────────────────────

describe('council strategy', () => {
    it('runs council members and a judge', async () => {
        const refineFn = makeRefineFn(makeLlmResponse('council output'));

        const result = await executeStrategy({
            strategyConfig: {
                type: 'council',
                councilSize: 2,
                judgeMode: 'synthesize',
                modelOverrides: {},
            },
            messageText: 'original text',
            contextBlock: '',
            fullRulesText: '1. Fix grammar',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        // 2 council members + 1 judge = 3 calls
        expect(refineFn).toHaveBeenCalledTimes(3);
        expect(result.agentLog).toHaveLength(3);
        expect(result.agentLog[0].agentName).toBe('Council Member A');
        expect(result.agentLog[1].agentName).toBe('Council Member B');
        expect(result.agentLog[2].agentName).toBe('Judge');
    });

    it('passes model overrides for specific agents', async () => {
        const receivedModels = [];
        const refineFn = vi.fn(async (_prompt, _sys, opts) => {
            receivedModels.push(opts?.model);
            return makeLlmResponse('output');
        });

        await executeStrategy({
            strategyConfig: {
                type: 'council',
                councilSize: 2,
                judgeMode: 'pick_best',
                modelOverrides: { council_0: 'model-a', judge: 'model-judge' },
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(receivedModels[0]).toBe('model-a');
        expect(receivedModels[1]).toBeUndefined();
        expect(receivedModels[2]).toBe('model-judge');
    });

    it('succeeds even when one council member fails', async () => {
        let callIdx = 0;
        const refineFn = vi.fn(async () => {
            callIdx++;
            if (callIdx === 1) throw new Error('agent failed');
            return makeLlmResponse('output');
        });

        const result = await executeStrategy({
            strategyConfig: {
                type: 'council',
                councilSize: 2,
                judgeMode: 'synthesize',
                modelOverrides: {},
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        const failedAgents = result.agentLog.filter(a => a.failed);
        expect(failedAgents).toHaveLength(1);
        expect(result.refinedRaw).toBeTruthy();
    });

    it('throws when all council members fail', async () => {
        const refineFn = vi.fn(async (_prompt, _sys) => {
            throw new Error('all fail');
        });

        await expect(executeStrategy({
            strategyConfig: {
                type: 'council',
                councilSize: 2,
                judgeMode: 'synthesize',
                modelOverrides: {},
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        })).rejects.toThrow('All council members failed');
    });

    it('aborts on signal', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(executeStrategy({
            strategyConfig: {
                type: 'council',
                councilSize: 2,
                judgeMode: 'synthesize',
                modelOverrides: {},
            },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn: makeRefineFn(makeLlmResponse('ok')),
            signal: controller.signal,
        })).rejects.toThrow('Aborted');
    });
});

// ─── Review + Refine ────────────────────────────────────────────────

describe('review strategy', () => {
    it('runs reviewer then refiner (2 calls)', async () => {
        const refineFn = makeRefineFn([
            '[PRESERVE]\nGood dialogue\n[/PRESERVE]\n[FIX]\nFix typo\n[/FIX]\n[LEAVE]\nNone\n[/LEAVE]',
            makeLlmResponse('refined output'),
        ]);

        const result = await executeStrategy({
            strategyConfig: { type: 'review' },
            messageText: 'original text',
            contextBlock: 'Character: Alice',
            fullRulesText: '1. Fix grammar',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(refineFn).toHaveBeenCalledTimes(2);
        expect(result.agentLog).toHaveLength(2);
        expect(result.agentLog[0].agentName).toBe('Reviewer');
        expect(result.agentLog[1].agentName).toBe('Refiner');
        expect(result.refinedRaw).toContain('refined output');
    });

    it('passes reviewer critique to the refiner', async () => {
        const calls = [];
        const refineFn = vi.fn(async (prompt) => {
            calls.push(prompt);
            if (calls.length === 1) return 'CRITIQUE_TEXT';
            return makeLlmResponse('done');
        });

        await executeStrategy({
            strategyConfig: { type: 'review' },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
        });

        expect(calls[1]).toContain('CRITIQUE_TEXT');
    });

    it('calls onProgress for both phases', async () => {
        const progressCalls = [];
        const refineFn = makeRefineFn(makeLlmResponse('done'));

        await executeStrategy({
            strategyConfig: { type: 'review' },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
            onProgress: (p) => progressCalls.push({ ...p }),
        });

        const reviewerCalls = progressCalls.filter(p => p.agentName === 'Reviewer');
        const refinerCalls = progressCalls.filter(p => p.agentName === 'Refiner');
        expect(reviewerCalls.length).toBeGreaterThanOrEqual(2);
        expect(refinerCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('aborts between reviewer and refiner', async () => {
        const controller = new AbortController();
        let callCount = 0;
        const refineFn = vi.fn(async () => {
            callCount++;
            if (callCount === 1) {
                controller.abort();
                return 'critique';
            }
            return makeLlmResponse('done');
        });

        await expect(executeStrategy({
            strategyConfig: { type: 'review' },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn,
            signal: controller.signal,
        })).rejects.toThrow('Aborted');

        expect(callCount).toBe(1);
    });
});

// ─── Unknown Strategy ───────────────────────────────────────────────

describe('unknown strategy', () => {
    it('throws for unknown strategy type', async () => {
        await expect(executeStrategy({
            strategyConfig: { type: 'nonexistent' },
            messageText: 'text',
            contextBlock: '',
            fullRulesText: '',
            allBuiltInRules: BUILTIN_RULES,
            settings: defaultSettings,
            refineFn: makeRefineFn('ok'),
        })).rejects.toThrow('Unknown swarm strategy');
    });
});
