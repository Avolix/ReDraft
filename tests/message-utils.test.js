import { describe, it, expect } from 'vitest';
import {
    resolveUserMessageIndex,
    categorizeRefinementError,
} from '../lib/message-utils.js';

// ─── resolveUserMessageIndex ────────────────────────────────────────

describe('resolveUserMessageIndex', () => {
    it('finds user message by send_date in fullChat', () => {
        const interceptorChat = [
            { is_user: false, mes: 'AI hello', send_date: '2025-01-01T00:00:00' },
            { is_user: true, mes: 'User reply', send_date: '2025-01-01T00:01:00' },
        ];
        const fullChat = [
            { is_user: false, mes: 'AI hello', send_date: '2025-01-01T00:00:00' },
            { is_user: true, mes: 'User reply', send_date: '2025-01-01T00:01:00' },
        ];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg).toBe(interceptorChat[1]);
        expect(realIdx).toBe(1);
    });

    it('works with cloned objects (different refs, same send_date)', () => {
        const original = { is_user: true, mes: 'Hello', send_date: '2025-06-15T12:00:00' };
        const clone = { ...original };
        expect(clone).not.toBe(original);

        const interceptorChat = [clone];
        const fullChat = [original];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg).toBe(clone);
        expect(realIdx).toBe(0);
    });

    it('picks the last user message in interceptorChat', () => {
        const interceptorChat = [
            { is_user: true, mes: 'First user msg', send_date: 'date-1' },
            { is_user: false, mes: 'AI response', send_date: 'date-2' },
            { is_user: true, mes: 'Second user msg', send_date: 'date-3' },
        ];
        const fullChat = [
            { is_user: true, mes: 'First user msg', send_date: 'date-1' },
            { is_user: false, mes: 'AI response', send_date: 'date-2' },
            { is_user: true, mes: 'Second user msg', send_date: 'date-3' },
        ];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg.mes).toBe('Second user msg');
        expect(realIdx).toBe(2);
    });

    it('falls back to content matching when send_date is missing', () => {
        const interceptorChat = [
            { is_user: true, mes: 'My unique message' },
        ];
        const fullChat = [
            { is_user: false, mes: 'AI greeting' },
            { is_user: true, mes: 'My unique message' },
        ];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg.mes).toBe('My unique message');
        expect(realIdx).toBe(1);
    });

    it('content fallback only matches user messages', () => {
        const interceptorChat = [
            { is_user: true, mes: 'Same text' },
        ];
        const fullChat = [
            { is_user: false, mes: 'Same text' },
            { is_user: true, mes: 'Same text' },
        ];
        const { realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(realIdx).toBe(1);
    });

    it('returns null chatMsg and -1 when no user messages exist', () => {
        const interceptorChat = [
            { is_user: false, mes: 'AI only' },
        ];
        const fullChat = [
            { is_user: false, mes: 'AI only' },
        ];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg).toBeNull();
        expect(realIdx).toBe(-1);
    });

    it('returns -1 realIdx when message is not found in fullChat', () => {
        const interceptorChat = [
            { is_user: true, mes: 'Orphaned message', send_date: 'unknown-date' },
        ];
        const fullChat = [
            { is_user: false, mes: 'AI message', send_date: 'other-date' },
        ];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg).not.toBeNull();
        expect(realIdx).toBe(-1);
    });

    it('skips user messages with empty mes', () => {
        const interceptorChat = [
            { is_user: true, mes: 'Valid message', send_date: 'date-1' },
            { is_user: true, mes: '', send_date: 'date-2' },
        ];
        const fullChat = [
            { is_user: true, mes: 'Valid message', send_date: 'date-1' },
            { is_user: true, mes: '', send_date: 'date-2' },
        ];
        const { chatMsg, realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(chatMsg.mes).toBe('Valid message');
        expect(realIdx).toBe(0);
    });

    it('handles empty interceptorChat', () => {
        const { chatMsg, realIdx } = resolveUserMessageIndex([], []);
        expect(chatMsg).toBeNull();
        expect(realIdx).toBe(-1);
    });

    it('prefers send_date match over content match at a different index', () => {
        const interceptorChat = [
            { is_user: true, mes: 'Duplicate text', send_date: 'date-B' },
        ];
        const fullChat = [
            { is_user: true, mes: 'Duplicate text', send_date: 'date-A' },
            { is_user: false, mes: 'AI reply', send_date: 'date-X' },
            { is_user: true, mes: 'Different text', send_date: 'date-B' },
        ];
        const { realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(realIdx).toBe(2);
    });

    it('picks the last matching send_date in fullChat (reverse search)', () => {
        const interceptorChat = [
            { is_user: true, mes: 'Message', send_date: 'same-date' },
        ];
        const fullChat = [
            { is_user: true, mes: 'Old message', send_date: 'same-date' },
            { is_user: false, mes: 'AI', send_date: 'other' },
            { is_user: true, mes: 'Newer message', send_date: 'same-date' },
        ];
        const { realIdx } = resolveUserMessageIndex(interceptorChat, fullChat);
        expect(realIdx).toBe(2);
    });
});

// ─── categorizeRefinementError ──────────────────────────────────────

describe('categorizeRefinementError', () => {
    it('categorizes "not configured" errors', () => {
        const result = categorizeRefinementError('Server not configured for this user');
        expect(result.toastMessage).toContain('configured');
        expect(result.timeOut).toBe(8000);
    });

    it('categorizes "Please set up API credentials" errors', () => {
        const result = categorizeRefinementError('Please set up API credentials');
        expect(result.toastMessage).toContain('configured');
    });

    it('categorizes timeout errors', () => {
        const result = categorizeRefinementError('Request timed out after 60s');
        expect(result.toastMessage).toContain('timed out');
        expect(result.timeOut).toBe(8000);
    });

    it('categorizes 401 Unauthorized errors', () => {
        const result = categorizeRefinementError('API returned 401: Unauthorized');
        expect(result.toastMessage).toContain('authentication');
        expect(result.toastMessage).toContain('401');
    });

    it('categorizes standalone "Unauthorized" errors', () => {
        const result = categorizeRefinementError('Unauthorized');
        expect(result.toastMessage).toContain('authentication');
    });

    it('categorizes 402 Payment Required errors', () => {
        const result = categorizeRefinementError('API returned 402: Payment Required');
        expect(result.toastMessage).toContain('billing');
        expect(result.toastMessage).toContain('402');
    });

    it('categorizes "insufficient" credits errors', () => {
        const result = categorizeRefinementError('insufficient credits remaining');
        expect(result.toastMessage).toContain('billing');
    });

    it('categorizes 429 rate limit errors', () => {
        const result = categorizeRefinementError('API returned 429: rate limit exceeded');
        expect(result.toastMessage).toContain('Rate limited');
        expect(result.timeOut).toBe(6000);
    });

    it('categorizes "Rate limit" with capital R', () => {
        const result = categorizeRefinementError('Rate limit hit');
        expect(result.toastMessage).toContain('Rate limited');
    });

    it('categorizes 404 errors', () => {
        const result = categorizeRefinementError('API returned 404: model not found');
        expect(result.toastMessage).toContain('not found');
        expect(result.toastMessage).toContain('404');
    });

    it('categorizes 503 errors', () => {
        const result = categorizeRefinementError('API returned 503: Service Unavailable');
        expect(result.toastMessage).toContain('Service Unavailable');
        expect(result.toastMessage).toContain('503');
    });

    it('categorizes HTML response errors', () => {
        const result = categorizeRefinementError('Server returned a web page instead of JSON');
        expect(result.toastMessage).toContain('HTML instead of JSON');
        expect(result.timeOut).toBe(10000);
    });

    it('falls back to the raw message for unknown errors', () => {
        const result = categorizeRefinementError('Something weird happened');
        expect(result.toastMessage).toBe('Something weird happened');
        expect(result.timeOut).toBe(8000);
    });

    it('provides a default message for empty/null/undefined input', () => {
        expect(categorizeRefinementError('').toastMessage).toContain('Refinement failed');
        expect(categorizeRefinementError(null).toastMessage).toContain('Refinement failed');
        expect(categorizeRefinementError(undefined).toastMessage).toContain('Refinement failed');
    });

    it('prioritizes first matching category (not configured over others)', () => {
        const result = categorizeRefinementError('not configured and also timed out');
        expect(result.toastMessage).toContain('configured');
    });
});
