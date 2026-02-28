import { describe, it, expect } from 'vitest';
import {
    buildPipelineStagePrompt,
    buildCouncilRefinerPrompt,
    buildCouncilJudgePrompt,
    buildCritiqueRefinerPrompt,
    REVIEWER_SYSTEM_PROMPT,
    STAGE_DESCRIPTIONS,
    COUNCIL_EMPHASES,
    callAgent,
    buildAgentPrompt,
    compileRuleSubset,
} from '../lib/swarm/agents.js';

// ─── Prompt Builders ────────────────────────────────────────────────

describe('buildPipelineStagePrompt', () => {
    it('includes stage name and description', () => {
        const prompt = buildPipelineStagePrompt('grammar', 'Fix grammar errors.');
        expect(prompt).toContain('grammar');
        expect(prompt).toContain('Fix grammar errors.');
    });

    it('includes output format instructions', () => {
        const prompt = buildPipelineStagePrompt('test', 'Test stage.');
        expect(prompt).toContain('[CHANGELOG]');
        expect(prompt).toContain('[REFINED]');
    });

    it('includes core constraints', () => {
        const prompt = buildPipelineStagePrompt('test', 'Test stage.');
        expect(prompt).toContain('Do not censor');
        expect(prompt).toContain('surgical');
    });
});

describe('buildCouncilRefinerPrompt', () => {
    it('includes the emphasis', () => {
        const prompt = buildCouncilRefinerPrompt('Prioritize voice preservation');
        expect(prompt).toContain('Prioritize voice preservation');
    });

    it('includes output format instructions', () => {
        const prompt = buildCouncilRefinerPrompt('test');
        expect(prompt).toContain('[CHANGELOG]');
        expect(prompt).toContain('[REFINED]');
    });
});

describe('buildCouncilJudgePrompt', () => {
    it('uses pick_best mode instruction', () => {
        const prompt = buildCouncilJudgePrompt(3, 'pick_best');
        expect(prompt).toContain('3');
        expect(prompt).toContain('Select the single strongest candidate');
        expect(prompt).not.toContain('Synthesize');
    });

    it('uses synthesize mode instruction', () => {
        const prompt = buildCouncilJudgePrompt(2, 'synthesize');
        expect(prompt).toContain('2');
        expect(prompt).toContain('Synthesize');
    });

    it('includes evaluation criteria', () => {
        const prompt = buildCouncilJudgePrompt(3, 'synthesize');
        expect(prompt).toContain('Character voice');
        expect(prompt).toContain('Narrative intent');
    });
});

describe('buildCritiqueRefinerPrompt', () => {
    it('references the reviewer critique sections', () => {
        const prompt = buildCritiqueRefinerPrompt();
        expect(prompt).toContain('[FIX]');
        expect(prompt).toContain('[PRESERVE]');
        expect(prompt).toContain('[LEAVE]');
    });

    it('includes output format instructions', () => {
        const prompt = buildCritiqueRefinerPrompt();
        expect(prompt).toContain('[CHANGELOG]');
        expect(prompt).toContain('[REFINED]');
    });
});

describe('REVIEWER_SYSTEM_PROMPT', () => {
    it('instructs critique-only output', () => {
        expect(REVIEWER_SYSTEM_PROMPT).toContain('[PRESERVE]');
        expect(REVIEWER_SYSTEM_PROMPT).toContain('[FIX]');
        expect(REVIEWER_SYSTEM_PROMPT).toContain('[LEAVE]');
        expect(REVIEWER_SYSTEM_PROMPT).toContain('Do NOT output a rewritten version');
    });
});

// ─── Stage Descriptions ─────────────────────────────────────────────

describe('STAGE_DESCRIPTIONS', () => {
    it('has descriptions for standard stages', () => {
        expect(STAGE_DESCRIPTIONS.grammar).toBeTruthy();
        expect(STAGE_DESCRIPTIONS.prose).toBeTruthy();
        expect(STAGE_DESCRIPTIONS.voice).toBeTruthy();
        expect(STAGE_DESCRIPTIONS.echo).toBeTruthy();
        expect(STAGE_DESCRIPTIONS.continuity).toBeTruthy();
    });

    it('each description is a non-empty string', () => {
        for (const desc of Object.values(STAGE_DESCRIPTIONS)) {
            expect(typeof desc).toBe('string');
            expect(desc.length).toBeGreaterThan(10);
        }
    });
});

// ─── Council Emphases ───────────────────────────────────────────────

describe('COUNCIL_EMPHASES', () => {
    it('has at least 4 emphases (max council size)', () => {
        expect(COUNCIL_EMPHASES.length).toBeGreaterThanOrEqual(4);
    });

    it('each emphasis is a non-empty string', () => {
        for (const e of COUNCIL_EMPHASES) {
            expect(typeof e).toBe('string');
            expect(e.length).toBeGreaterThan(10);
        }
    });
});

// ─── buildAgentPrompt ───────────────────────────────────────────────

describe('buildAgentPrompt', () => {
    it('builds prompt with message and rules', () => {
        const prompt = buildAgentPrompt({
            messageText: 'Hello world',
            rulesText: '1. Fix grammar',
        });
        expect(prompt).toContain('Hello world');
        expect(prompt).toContain('1. Fix grammar');
    });

    it('includes context block when provided', () => {
        const prompt = buildAgentPrompt({
            messageText: 'Hello',
            rulesText: '1. Fix grammar',
            contextBlock: 'Character: Alice',
        });
        expect(prompt).toContain('Character: Alice');
        expect(prompt.indexOf('Character: Alice')).toBeLessThan(prompt.indexOf('Hello'));
    });

    it('includes critique block when provided', () => {
        const prompt = buildAgentPrompt({
            messageText: 'Hello',
            rulesText: '1. Fix grammar',
            critiqueBlock: '[FIX] some fix [/FIX]',
        });
        expect(prompt).toContain("Reviewer's critique");
        expect(prompt).toContain('[FIX] some fix [/FIX]');
    });

    it('orders: context, critique, rules, message', () => {
        const prompt = buildAgentPrompt({
            messageText: 'msg',
            rulesText: 'rules',
            contextBlock: 'ctx',
            critiqueBlock: 'crit',
        });
        const ctxIdx = prompt.indexOf('ctx');
        const critIdx = prompt.indexOf('crit');
        const rulesIdx = prompt.indexOf('rules');
        const msgIdx = prompt.indexOf('msg');
        expect(ctxIdx).toBeLessThan(critIdx);
        expect(critIdx).toBeLessThan(rulesIdx);
        expect(rulesIdx).toBeLessThan(msgIdx);
    });
});

// ─── callAgent ──────────────────────────────────────────────────────

describe('callAgent', () => {
    it('calls refineFn with prompt and system prompt', async () => {
        const mockRefine = async (prompt, _sys) => `response for ${prompt}`;
        const result = await callAgent({
            systemPrompt: 'sys',
            promptText: 'hello',
            refineFn: mockRefine,
        });
        expect(result).toBe('response for hello');
    });

    it('passes model override to refineFn', async () => {
        let receivedOpts;
        const mockRefine = async (_prompt, _sys, opts) => {
            receivedOpts = opts;
            return 'ok';
        };
        await callAgent({
            systemPrompt: 'sys',
            promptText: 'hello',
            refineFn: mockRefine,
            modelOverride: 'gpt-4o',
        });
        expect(receivedOpts.model).toBe('gpt-4o');
    });

    it('passes undefined model when no override', async () => {
        let receivedOpts;
        const mockRefine = async (_prompt, _sys, opts) => {
            receivedOpts = opts;
            return 'ok';
        };
        await callAgent({
            systemPrompt: 'sys',
            promptText: 'hello',
            refineFn: mockRefine,
        });
        expect(receivedOpts.model).toBeUndefined();
    });
});

// ─── compileRuleSubset ──────────────────────────────────────────────

describe('compileRuleSubset', () => {
    const BUILTIN = {
        grammar: { label: 'Grammar', prompt: 'Fix grammar.' },
        prose: { label: 'Prose', prompt: 'Improve prose.' },
        voice: { label: 'Voice', prompt: 'Check voice.' },
    };

    it('compiles only selected rule keys', () => {
        const result = compileRuleSubset(['grammar', 'voice'], BUILTIN, { customRules: [] });
        expect(result).toContain('Fix grammar.');
        expect(result).toContain('Check voice.');
        expect(result).not.toContain('Improve prose.');
    });

    it('returns numbered list', () => {
        const result = compileRuleSubset(['grammar', 'prose'], BUILTIN, { customRules: [] });
        expect(result).toMatch(/^1\. /);
        expect(result).toContain('2. ');
    });

    it('falls back to default when no keys match', () => {
        const result = compileRuleSubset(['nonexistent'], BUILTIN, { customRules: [] });
        expect(result).toContain('Improve the overall quality');
    });
});
