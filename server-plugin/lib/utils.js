/**
 * Pure utility functions extracted from the ReDraft server plugin.
 * No fs, no Express — safe to unit test.
 */

const path = require('path');

/**
 * Get the current user id from the request when running in multi-user ST.
 * Never throws — returns null on any error so plugin always stays responsive.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function getUserId(req) {
    try {
        if (!req) return null;
        const raw = (req.session && (req.session.userId ?? req.session.user_id))
            || (req.user && (req.user.id ?? req.user.userId))
            || (req.headers && (req.headers['x-user-id'] || req.headers['x-user_id']));
        if (raw == null || typeof raw !== 'string') return null;
        const sanitized = String(raw).toLowerCase().replace(/[^a-z0-9_-]/g, '');
        return sanitized.length > 0 ? sanitized : null;
    } catch (_) {
        return null;
    }
}

/**
 * Config file path for a user (or shared config when userId is null).
 * @param {string} configDir - Base directory for config files.
 * @param {string|null} userId
 * @returns {string}
 */
function getConfigPath(configDir, userId) {
    const filename = userId ? `config.${userId}.json` : 'config.json';
    return path.join(configDir, filename);
}

/**
 * Mask an API key for safe display.
 * @param {string} key
 * @returns {string}
 */
function maskKey(key) {
    if (!key || key.length < 8) return '****';
    return key.slice(0, 3) + '...' + key.slice(-4);
}

/**
 * Validate that a URL is a safe external API endpoint (not an internal/private address).
 * @param {string} urlString
 * @returns {{ valid: boolean, error?: string }}
 */
function validateApiUrl(urlString) {
    let parsed;
    try {
        parsed = new URL(urlString);
    } catch {
        return { valid: false, error: 'Invalid URL format' };
    }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return { valid: false, error: `Unsupported protocol "${parsed.protocol}" — only http: and https: are allowed` };
    }

    const hostname = parsed.hostname.toLowerCase();

    if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
        return { valid: false, error: 'localhost URLs are not allowed — use an external API endpoint' };
    }

    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const [, a, b, c] = ipv4Match.map(Number);
        const blocked =
            a === 127 ||
            a === 10 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254) ||
            a === 0;

        if (blocked) {
            return { valid: false, error: `Private/internal IP addresses are not allowed (${hostname})` };
        }
    }

    if (hostname === '::1' || hostname === '[::1]' ||
        hostname.startsWith('fc') || hostname.startsWith('fd') ||
        hostname.startsWith('fe80')) {
        return { valid: false, error: `Private/internal IPv6 addresses are not allowed (${hostname})` };
    }

    return { valid: true };
}

/**
 * Sanitize error messages to strip any credential fragments.
 * @param {string} message
 * @param {object|null} [config]
 * @returns {string}
 */
function sanitizeError(message, config) {
    if (config && config.apiKey && message.includes(config.apiKey)) {
        message = message.replace(new RegExp(config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    }
    return message;
}

module.exports = {
    getUserId,
    getConfigPath,
    maskKey,
    validateApiUrl,
    sanitizeError,
};
