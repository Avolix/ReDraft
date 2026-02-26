import { describe, it, expect } from 'vitest';
import {
    buildAiRefinePrompt,
    buildUserEnhancePrompt,
    POV_INSTRUCTIONS,
    USER_POV_INSTRUCTIONS,
    DEFAULT_SYSTEM_PROMPT,
    DEFAULT_USER_ENHANCE_SYSTEM_PROMPT,
} from '../lib/prompt-builder.js';

// ─── Shared helpers ─────────────────────────────────────────────────

function makeContext({ name1 = 'Player', name2 = 'NPC', personality = '', description = '' } = {}) {
    return {
        characters: {
            0: { data: { personality, description } },
        },
        characterId: 0,
        name1,
        name2,
    };
}

function makeChat(messages) {
    return messages.map((m, i) => ({
        is_user: m.is_user ?? false,
        mes: m.mes ?? '',
        ...m,
    }));
}

const baseSettings = {
    characterContextChars: 500,
    previousResponseTailChars: 200,
    pov: 'auto',
};

// ─── buildAiRefinePrompt ────────────────────────────────────────────

describe('buildAiRefinePrompt', () => {
    it('returns the provided system prompt', () => {
        const chat = makeChat([
            { is_user: false, mes: 'Hello world.' },
        ]);
        const { systemPrompt } = buildAiRefinePrompt(
            baseSettings, makeContext(), chat, 0, 'Hello world.',
            { rulesText: '1. Fix grammar.', systemPrompt: 'Custom system prompt' },
        );
        expect(systemPrompt).toBe('Custom system prompt');
    });

    it('includes character name and description in context', () => {
        const ctx = makeContext({ name2: 'Aria', personality: 'Sarcastic rogue' });
        const chat = makeChat([{ is_user: false, mes: 'Test message.' }]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, ctx, chat, 0, 'Test message.',
            { rulesText: '1. Fix grammar.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Character: Aria');
        expect(promptText).toContain('Sarcastic rogue');
    });

    it('includes user character name in context', () => {
        const ctx = makeContext({ name1: 'Hero', name2: 'NPC' });
        const chat = makeChat([{ is_user: false, mes: 'Test.' }]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, ctx, chat, 0, 'Test.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('User character: Hero');
    });

    it('includes last user message before the AI message', () => {
        const chat = makeChat([
            { is_user: true, mes: 'I open the door.' },
            { is_user: false, mes: 'The room is dark.' },
        ]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, makeContext(), chat, 1, 'The room is dark.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Last user message');
        expect(promptText).toContain('I open the door.');
    });

    it('includes previous AI response tail', () => {
        const chat = makeChat([
            { is_user: false, mes: 'First AI response with some text.' },
            { is_user: true, mes: 'User reply.' },
            { is_user: false, mes: 'Second AI response.' },
        ]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, makeContext(), chat, 2, 'Second AI response.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Previous response ending');
        expect(promptText).toContain('First AI response with some text.');
    });

    it('truncates previous response tail to configured chars', () => {
        const longText = 'x'.repeat(500);
        const chat = makeChat([
            { is_user: false, mes: longText },
            { is_user: false, mes: 'Current message.' },
        ]);
        const settings = { ...baseSettings, previousResponseTailChars: 100 };
        const { promptText } = buildAiRefinePrompt(
            settings, makeContext(), chat, 1, 'Current message.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('last ~100 chars');
        expect(promptText).not.toContain(longText);
    });

    it('embeds rules text in the prompt', () => {
        const chat = makeChat([{ is_user: false, mes: 'Test.' }]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Fix grammar.\n2. Remove echo.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('1. Fix grammar.\n2. Remove echo.');
    });

    it('embeds the stripped message in the prompt', () => {
        const chat = makeChat([{ is_user: false, mes: 'Original with [PROTECTED_0] block.' }]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, makeContext(), chat, 0, 'Original with [PROTECTED_0] block.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Original message:\nOriginal with [PROTECTED_0] block.');
    });

    it('includes POV instructions when pov is set explicitly', () => {
        const settings = { ...baseSettings, pov: '1st' };
        const chat = makeChat([{ is_user: false, mes: 'Test.' }]);
        const { promptText } = buildAiRefinePrompt(
            settings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Point of view:');
        expect(promptText).toContain(POV_INSTRUCTIONS['1st']);
    });

    it('detects POV from message text when pov is "detect"', () => {
        const settings = { ...baseSettings, pov: 'detect' };
        const chat = makeChat([{ is_user: false, mes: 'I walked down the road. My hands were cold. I felt tired.' }]);
        const { promptText } = buildAiRefinePrompt(
            settings, makeContext(), chat, 0, 'I walked down the road. My hands were cold. I felt tired.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Point of view:');
        expect(promptText).toContain(POV_INSTRUCTIONS['1st']);
    });

    it('omits POV when set to "auto" and detection returns null', () => {
        const settings = { ...baseSettings, pov: 'auto' };
        const chat = makeChat([{ is_user: false, mes: 'The cat sat on the mat.' }]);
        const { promptText } = buildAiRefinePrompt(
            settings, makeContext(), chat, 0, 'The cat sat on the mat.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).not.toContain('Point of view:');
    });

    it('produces no context block when all context is empty', () => {
        const ctx = { characters: {}, characterId: 99, name1: '', name2: '' };
        const chat = makeChat([{ is_user: false, mes: 'Standalone.' }]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, ctx, chat, 0, 'Standalone.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).not.toContain('Context:');
        expect(promptText).toMatch(/^Apply the following/);
    });

    it('uses character description as fallback when personality is empty', () => {
        const ctx = makeContext({ name2: 'Bot', personality: '', description: 'A helpful assistant.' });
        const chat = makeChat([{ is_user: false, mes: 'Test.' }]);
        const { promptText } = buildAiRefinePrompt(
            baseSettings, ctx, chat, 0, 'Test.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('A helpful assistant.');
    });

    it('truncates character description to characterContextChars', () => {
        const longDesc = 'A'.repeat(5000);
        const ctx = makeContext({ name2: 'Bot', description: longDesc });
        const settings = { ...baseSettings, characterContextChars: 200 };
        const chat = makeChat([{ is_user: false, mes: 'Test.' }]);
        const { promptText } = buildAiRefinePrompt(
            settings, ctx, chat, 0, 'Test.',
            { rulesText: '1. Rule.', systemPrompt: DEFAULT_SYSTEM_PROMPT },
        );
        const charSection = promptText.split('Character: Bot')[1].split('\n\n')[0];
        expect(charSection.length).toBeLessThan(300);
    });
});

// ─── buildUserEnhancePrompt ─────────────────────────────────────────

describe('buildUserEnhancePrompt', () => {
    it('returns the provided system prompt', () => {
        const chat = makeChat([{ is_user: true, mes: 'Hello.' }]);
        const { systemPrompt } = buildUserEnhancePrompt(
            baseSettings, makeContext(), chat, 0, 'Hello.',
            { rulesText: '1. Fix grammar.', personaDesc: '', systemPrompt: 'My custom prompt' },
        );
        expect(systemPrompt).toBe('My custom prompt');
    });

    it('includes persona description in context', () => {
        const chat = makeChat([{ is_user: true, mes: 'Hello.' }]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, makeContext({ name1: 'Hero' }), chat, 0, 'Hello.',
            { rulesText: '1. Rule.', personaDesc: 'A brave warrior', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Your character (who you are writing as): Hero');
        expect(promptText).toContain('A brave warrior');
    });

    it('omits persona section when both name1 and personaDesc are empty', () => {
        const ctx = makeContext({ name1: '', name2: 'NPC' });
        const chat = makeChat([{ is_user: true, mes: 'Hello.' }]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, ctx, chat, 0, 'Hello.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).not.toContain('Your character');
    });

    it('includes interacting character in context', () => {
        const ctx = makeContext({ name2: 'Aria', personality: 'Mysterious elf' });
        const chat = makeChat([{ is_user: true, mes: 'Hello.' }]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, ctx, chat, 0, 'Hello.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Character you are interacting with: Aria');
        expect(promptText).toContain('Mysterious elf');
    });

    it('includes previous AI response for scene context', () => {
        const chat = makeChat([
            { is_user: false, mes: 'The elf smiles warmly at you.' },
            { is_user: true, mes: 'I smile back.' },
        ]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, makeContext(), chat, 1, 'I smile back.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Last response from');
        expect(promptText).toContain('The elf smiles warmly at you.');
    });

    it('does not include AI messages after the user message index', () => {
        const chat = makeChat([
            { is_user: true, mes: 'My message.' },
            { is_user: false, mes: 'Future AI response.' },
        ]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, makeContext(), chat, 0, 'My message.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).not.toContain('Future AI response.');
    });

    it('embeds rules text in the prompt', () => {
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Fix grammar.\n2. Match persona.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('1. Fix grammar.\n2. Match persona.');
    });

    it('uses "enhancement rules" phrasing (not "refinement")', () => {
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('enhancement rules');
        expect(promptText).not.toContain('refinement rules');
    });

    it('uses userPov setting instead of global pov', () => {
        const settings = { ...baseSettings, pov: '3rd', userPov: '1st' };
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            settings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain(USER_POV_INSTRUCTIONS['1st']);
        expect(promptText).not.toContain(POV_INSTRUCTIONS['3rd']);
    });

    it('uses USER_POV_INSTRUCTIONS (not AI POV_INSTRUCTIONS)', () => {
        const settings = { ...baseSettings, userPov: '3rd' };
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            settings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain(USER_POV_INSTRUCTIONS['3rd']);
    });

    it('falls back to global pov when userPov is not set', () => {
        const settings = { ...baseSettings, pov: '2nd' };
        delete settings.userPov;
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            settings, makeContext(), chat, 0, 'Test.',
            { rulesText: '1. Rule.', personaDesc: '', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Point of view:');
    });

    it('truncates persona description to characterContextChars', () => {
        const longPersona = 'B'.repeat(5000);
        const settings = { ...baseSettings, characterContextChars: 150 };
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            settings, makeContext({ name1: 'Hero' }), chat, 0, 'Test.',
            { rulesText: '1. Rule.', personaDesc: longPersona, systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        const personaSection = promptText.split('who you are writing as): Hero')[1].split('\n\n')[0];
        expect(personaSection.length).toBeLessThan(250);
    });

    it('shows "Unknown" when name1 is falsy but personaDesc exists', () => {
        const ctx = makeContext({ name1: '', name2: 'NPC' });
        const chat = makeChat([{ is_user: true, mes: 'Test.' }]);
        const { promptText } = buildUserEnhancePrompt(
            baseSettings, ctx, chat, 0, 'Test.',
            { rulesText: '1. Rule.', personaDesc: 'Has a persona', systemPrompt: DEFAULT_USER_ENHANCE_SYSTEM_PROMPT },
        );
        expect(promptText).toContain('Your character (who you are writing as): Unknown');
    });
});

// ─── Constants ──────────────────────────────────────────────────────

describe('exported constants', () => {
    it('POV_INSTRUCTIONS covers all four POV keys', () => {
        expect(Object.keys(POV_INSTRUCTIONS)).toEqual(
            expect.arrayContaining(['1st', '1.5', '2nd', '3rd']),
        );
        expect(Object.keys(POV_INSTRUCTIONS)).toHaveLength(4);
    });

    it('USER_POV_INSTRUCTIONS covers 1st, 2nd, and 3rd person', () => {
        expect(Object.keys(USER_POV_INSTRUCTIONS)).toEqual(
            expect.arrayContaining(['1st', '2nd', '3rd']),
        );
        expect(Object.keys(USER_POV_INSTRUCTIONS)).toHaveLength(3);
    });

    it('DEFAULT_SYSTEM_PROMPT contains CHANGELOG and REFINED tags', () => {
        expect(DEFAULT_SYSTEM_PROMPT).toContain('[CHANGELOG]');
        expect(DEFAULT_SYSTEM_PROMPT).toContain('[REFINED]');
    });

    it('DEFAULT_USER_ENHANCE_SYSTEM_PROMPT contains CHANGELOG and REFINED tags', () => {
        expect(DEFAULT_USER_ENHANCE_SYSTEM_PROMPT).toContain('[CHANGELOG]');
        expect(DEFAULT_USER_ENHANCE_SYSTEM_PROMPT).toContain('[REFINED]');
    });
});
