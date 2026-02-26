import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import path from 'path';

const require = createRequire(import.meta.url);
const { getUserId, getConfigPath, maskKey, validateApiUrl, sanitizeError } = require('../server-plugin/lib/utils.js');

// ─── getUserId ──────────────────────────────────────────────────────

describe('getUserId', () => {
    it('returns null for null/undefined request', () => {
        expect(getUserId(null)).toBeNull();
        expect(getUserId(undefined)).toBeNull();
    });

    it('extracts userId from session.userId', () => {
        expect(getUserId({ session: { userId: 'alice' } })).toBe('alice');
    });

    it('extracts user_id from session.user_id', () => {
        expect(getUserId({ session: { user_id: 'bob' } })).toBe('bob');
    });

    it('extracts id from user.id', () => {
        expect(getUserId({ user: { id: 'charlie' } })).toBe('charlie');
    });

    it('extracts userId from user.userId', () => {
        expect(getUserId({ user: { userId: 'dave' } })).toBe('dave');
    });

    it('extracts from x-user-id header', () => {
        expect(getUserId({ headers: { 'x-user-id': 'eve' } })).toBe('eve');
    });

    it('extracts from x-user_id header', () => {
        expect(getUserId({ headers: { 'x-user_id': 'frank' } })).toBe('frank');
    });

    it('sanitizes special characters to lowercase alphanumeric + _ -', () => {
        expect(getUserId({ session: { userId: 'Alice@Home!' } })).toBe('alicehome');
    });

    it('returns null for numeric (non-string) values', () => {
        expect(getUserId({ session: { userId: 42 } })).toBeNull();
    });

    it('returns null if sanitized result is empty', () => {
        expect(getUserId({ session: { userId: '!!!' } })).toBeNull();
    });

    it('preserves hyphens and underscores', () => {
        expect(getUserId({ session: { userId: 'user-name_123' } })).toBe('user-name_123');
    });

    it('prefers session over user over headers', () => {
        const req = {
            session: { userId: 'from-session' },
            user: { id: 'from-user' },
            headers: { 'x-user-id': 'from-header' },
        };
        expect(getUserId(req)).toBe('from-session');
    });

    it('never throws (returns null on weird input)', () => {
        expect(getUserId(42)).toBeNull();
        expect(getUserId('string')).toBeNull();
        expect(getUserId({})).toBeNull();
    });
});

// ─── getConfigPath ──────────────────────────────────────────────────

describe('getConfigPath', () => {
    it('returns config.json for null userId', () => {
        const result = getConfigPath('/fake/dir', null);
        expect(result).toMatch(/config\.json$/);
        expect(result).not.toMatch(/config\..+\.json$/);
    });

    it('returns config.<userId>.json for a userId', () => {
        const result = getConfigPath('/fake/dir', 'alice');
        expect(result).toMatch(/config\.alice\.json$/);
    });

    it('uses the provided configDir', () => {
        const result = getConfigPath('/my/custom/path', null);
        expect(result).toBe(path.join('/my/custom/path', 'config.json'));
    });
});

// ─── maskKey ────────────────────────────────────────────────────────

describe('maskKey', () => {
    it('masks a normal-length key', () => {
        expect(maskKey('sk-abcdef1234567890')).toBe('sk-...7890');
    });

    it('returns **** for short keys', () => {
        expect(maskKey('short')).toBe('****');
        expect(maskKey('1234567')).toBe('****');
    });

    it('returns **** for empty string', () => {
        expect(maskKey('')).toBe('****');
    });

    it('returns **** for null/undefined', () => {
        expect(maskKey(null)).toBe('****');
        expect(maskKey(undefined)).toBe('****');
    });

    it('handles exactly 8 character key', () => {
        expect(maskKey('12345678')).toBe('123...5678');
    });

    it('shows first 3 and last 4 characters', () => {
        const result = maskKey('abcdefghijklmnop');
        expect(result).toBe('abc...mnop');
    });
});

// ─── validateApiUrl ─────────────────────────────────────────────────

describe('validateApiUrl', () => {
    it('accepts valid HTTPS URL', () => {
        expect(validateApiUrl('https://api.openai.com/v1')).toEqual({ valid: true });
    });

    it('accepts valid HTTP URL', () => {
        expect(validateApiUrl('http://api.example.com/v1')).toEqual({ valid: true });
    });

    it('rejects invalid URL format', () => {
        const result = validateApiUrl('not-a-url');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Invalid URL');
    });

    it('rejects file:// protocol', () => {
        const result = validateApiUrl('file:///etc/passwd');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('protocol');
    });

    it('rejects ftp:// protocol', () => {
        const result = validateApiUrl('ftp://files.example.com');
        expect(result.valid).toBe(false);
    });

    it('blocks localhost', () => {
        const result = validateApiUrl('http://localhost:8080/api');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('localhost');
    });

    it('blocks subdomain of localhost', () => {
        const result = validateApiUrl('http://foo.localhost:8080/api');
        expect(result.valid).toBe(false);
    });

    it('blocks 127.0.0.1 (loopback)', () => {
        const result = validateApiUrl('http://127.0.0.1:3000');
        expect(result.valid).toBe(false);
        expect(result.error).toContain('Private');
    });

    it('blocks 10.x.x.x (private)', () => {
        const result = validateApiUrl('http://10.0.0.1');
        expect(result.valid).toBe(false);
    });

    it('blocks 172.16-31.x.x (private)', () => {
        expect(validateApiUrl('http://172.16.0.1').valid).toBe(false);
        expect(validateApiUrl('http://172.31.255.255').valid).toBe(false);
    });

    it('allows 172.15.x.x and 172.32.x.x (not private)', () => {
        expect(validateApiUrl('http://172.15.0.1').valid).toBe(true);
        expect(validateApiUrl('http://172.32.0.1').valid).toBe(true);
    });

    it('blocks 192.168.x.x (private)', () => {
        const result = validateApiUrl('http://192.168.1.1');
        expect(result.valid).toBe(false);
    });

    it('blocks 169.254.x.x (link-local)', () => {
        const result = validateApiUrl('http://169.254.0.1');
        expect(result.valid).toBe(false);
    });

    it('blocks 0.0.0.0', () => {
        const result = validateApiUrl('http://0.0.0.0');
        expect(result.valid).toBe(false);
    });

    it('blocks IPv6 loopback ::1', () => {
        const result = validateApiUrl('http://[::1]:3000');
        expect(result.valid).toBe(false);
    });

    it('blocks fc/fd private IPv6', () => {
        expect(validateApiUrl('http://fc00::1').valid).toBe(false);
        expect(validateApiUrl('http://fd12::1').valid).toBe(false);
    });

    it('blocks fe80 link-local IPv6', () => {
        expect(validateApiUrl('http://fe80::1').valid).toBe(false);
    });

    it('allows normal public IPs', () => {
        expect(validateApiUrl('http://8.8.8.8').valid).toBe(true);
        expect(validateApiUrl('https://203.0.113.5').valid).toBe(true);
    });
});

// ─── sanitizeError ──────────────────────────────────────────────────

describe('sanitizeError', () => {
    it('redacts API key from error message', () => {
        const config = { apiKey: 'sk-secret-key-12345' };
        const result = sanitizeError('Failed at sk-secret-key-12345/endpoint', config);
        expect(result).toBe('Failed at [REDACTED]/endpoint');
    });

    it('redacts multiple occurrences', () => {
        const config = { apiKey: 'mykey' };
        const result = sanitizeError('mykey and mykey again', config);
        expect(result).toBe('[REDACTED] and [REDACTED] again');
    });

    it('returns message unchanged when no config', () => {
        expect(sanitizeError('some error', null)).toBe('some error');
    });

    it('returns message unchanged when config has no apiKey', () => {
        expect(sanitizeError('some error', {})).toBe('some error');
    });

    it('returns message unchanged when key is not in message', () => {
        const config = { apiKey: 'sk-notpresent' };
        expect(sanitizeError('some other error', config)).toBe('some other error');
    });

    it('handles keys with regex special characters', () => {
        const config = { apiKey: 'key+with(special)chars' };
        const result = sanitizeError('error: key+with(special)chars', config);
        expect(result).toBe('error: [REDACTED]');
    });
});
