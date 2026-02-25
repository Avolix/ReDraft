/**
 * ReDraft server plugin — runs inside SillyTavern and proxies refine requests to a separate LLM.
 * Changes to this file require users to re-run server-plugin/install.js and restart ST.
 * Note "Server plugin update required" in release notes / INSTALL_PLUGIN.md when releasing such changes.
 *
 * This file is CommonJS. The installer creates a package.json with "type": "commonjs" in the
 * plugins/redraft/ directory so Node treats this as CJS even when ST's root package.json has
 * "type": "module".
 */
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const MODULE_NAME = 'redraft';
const REQUEST_TIMEOUT_MS = 30000;
const MAX_BODY_SIZE_BYTES = 512 * 1024; // 512 KB

let cachedConfig = null;

/**
 * Read and cache config from disk.
 * @returns {object|null} The config object or null if not configured.
 */
function readConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            return null;
        }
        const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
        cachedConfig = JSON.parse(raw);
        return cachedConfig;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to read config:`, err.message);
        return null;
    }
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
 * Prevents SSRF by blocking file://, private IPs, localhost, and link-local addresses.
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

    // Block private/reserved IPv4 and IPv6 ranges
    const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4Match) {
        const [, a, b, c] = ipv4Match.map(Number);
        const blocked =
            a === 127 ||                              // 127.0.0.0/8 loopback
            a === 10 ||                               // 10.0.0.0/8 private
            (a === 172 && b >= 16 && b <= 31) ||      // 172.16.0.0/12 private
            (a === 192 && b === 168) ||                // 192.168.0.0/16 private
            (a === 169 && b === 254) ||                // 169.254.0.0/16 link-local
            a === 0;                                   // 0.0.0.0/8

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
 * @returns {string}
 */
function sanitizeError(message) {
    const config = cachedConfig;
    if (config && config.apiKey && message.includes(config.apiKey)) {
        message = message.replace(new RegExp(config.apiKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '[REDACTED]');
    }
    return message;
}

/**
 * Initialize the ReDraft server plugin.
 * @param {import('express').Router} router
 */
async function init(router) {
    readConfig();

    const configDir = path.dirname(CONFIG_PATH);
    fs.watch(configDir, (eventType, filename) => {
        if (filename === 'config.json') {
            console.log(`[${MODULE_NAME}] Config file changed, reloading...`);
            readConfig();
        }
    });

    /**
     * POST /config — Save API credentials to disk.
     * Accepts: { apiUrl, apiKey, model, maxTokens? }
     */
    router.post('/config', (req, res) => {
        try {
            const { apiUrl, apiKey, model, maxTokens } = req.body;

            if (!apiUrl || typeof apiUrl !== 'string' || !apiUrl.trim()) {
                return res.status(400).json({ error: 'apiUrl is required and must be a non-empty string' });
            }

            const urlCheck = validateApiUrl(apiUrl.trim());
            if (!urlCheck.valid) {
                return res.status(400).json({ error: `Invalid API URL: ${urlCheck.error}` });
            }

            if (!model || typeof model !== 'string' || !model.trim()) {
                return res.status(400).json({ error: 'model is required and must be a non-empty string' });
            }

            // If no new key was sent, reuse the saved one (allows changing model without re-entering key)
            const existingConfig = readConfig();
            const resolvedKey = (apiKey && typeof apiKey === 'string' && apiKey.trim())
                ? apiKey.trim()
                : existingConfig?.apiKey;

            if (!resolvedKey) {
                return res.status(400).json({ error: 'apiKey is required (no saved key found)' });
            }

            const config = {
                apiUrl: apiUrl.trim().replace(/\/+$/, ''),
                apiKey: resolvedKey,
                model: model.trim(),
                maxTokens: Math.min(Math.max(Number(maxTokens) || 4096, 1), 128000),
            };

            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
            cachedConfig = config;

            console.log(`[${MODULE_NAME}] Config saved successfully`);
            return res.json({ ok: true });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Error saving config:`, err.message);
            return res.status(500).json({ error: 'Failed to save configuration' });
        }
    });

    /**
     * GET /status — Return plugin status (no secrets exposed).
     */
    router.get('/status', (req, res) => {
        const config = readConfig();
        if (!config || !config.apiKey || !config.apiUrl) {
            return res.json({
                configured: false,
                apiUrl: null,
                model: null,
                maskedKey: null,
            });
        }

        return res.json({
            configured: true,
            apiUrl: config.apiUrl,
            model: config.model || null,
            maskedKey: maskKey(config.apiKey),
        });
    });

    /**
     * GET /models — Fetch available models from the configured API.
     * Returns: { models: [{ id, name? }] }
     */
    router.get('/models', async (req, res) => {
        try {
            const config = readConfig();
            if (!config || !config.apiKey || !config.apiUrl) {
                return res.status(503).json({ error: 'Not configured. Save API credentials first.' });
            }

            const endpoint = `${config.apiUrl}/models`;
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(endpoint, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                signal: controller.signal,
            });

            clearTimeout(timeout);

            if (!response.ok) {
                const body = await response.text();
                const sanitized = sanitizeError(body);
                return res.status(502).json({ error: `API returned ${response.status}: ${sanitized.slice(0, 200)}` });
            }

            const data = await response.json();

            // OpenAI-compatible format: { data: [{ id: "model-name", ... }] }
            const models = Array.isArray(data?.data)
                ? data.data.map(m => ({ id: m.id, name: m.name || m.id })).sort((a, b) => a.id.localeCompare(b.id))
                : [];

            return res.json({ models });
        } catch (err) {
            if (err.name === 'AbortError') {
                return res.status(504).json({ error: 'Models request timed out' });
            }
            console.error(`[${MODULE_NAME}] Models fetch error:`, sanitizeError(err.message));
            return res.status(500).json({ error: 'Failed to fetch models' });
        }
    });

    /**
     * POST /refine — Proxy refinement request to configured LLM.
     * Accepts: { messages: [{role, content}] }
     * Returns: { text: string }
     */
    router.post('/refine', async (req, res) => {
        try {
            const bodySize = JSON.stringify(req.body).length;
            if (bodySize > MAX_BODY_SIZE_BYTES) {
                return res.status(413).json({ error: 'Request body too large' });
            }

            const { messages } = req.body;
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'messages must be a non-empty array' });
            }

            for (const msg of messages) {
                if (!msg.role || typeof msg.role !== 'string') {
                    return res.status(400).json({ error: 'Each message must have a string "role"' });
                }
                if (!msg.content || typeof msg.content !== 'string') {
                    return res.status(400).json({ error: 'Each message must have a string "content"' });
                }
            }

            const config = readConfig();
            if (!config || !config.apiKey || !config.apiUrl) {
                return res.status(503).json({ error: 'ReDraft is not configured. Please set up API credentials.' });
            }

            const endpoint = `${config.apiUrl}/chat/completions`;
            const payload = {
                model: config.model,
                messages: messages,
                max_tokens: config.maxTokens || 4096,
                temperature: 0.3,
            };

            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: JSON.stringify(payload),
                signal: controller.signal,
            });

            clearTimeout(timeout);

            const rawBody = await response.text();

            if (!response.ok) {
                const sanitized = sanitizeError(rawBody);
                console.error(`[${MODULE_NAME}] LLM API error (${response.status}):`, sanitized);
                return res.status(502).json({ error: `LLM API returned ${response.status}: ${sanitized.slice(0, 200)}` });
            }

            let data;
            try {
                data = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                const trimmed = (rawBody || '').trim();
                if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
                    console.error(`[${MODULE_NAME}] LLM API returned HTML instead of JSON`);
                    return res.status(502).json({ error: 'API returned a web page instead of JSON. Check your API URL (e.g. use the API base URL, not a login or docs page).' });
                }
                return res.status(502).json({ error: `API returned invalid JSON: ${trimmed.slice(0, 100)}…` });
            }

            const text = data?.choices?.[0]?.message?.content;

            if (!text) {
                return res.status(502).json({ error: 'LLM returned an empty or malformed response' });
            }

            return res.json({ text });

        } catch (err) {
            if (err.name === 'AbortError') {
                console.error(`[${MODULE_NAME}] LLM request timed out after ${REQUEST_TIMEOUT_MS}ms`);
                return res.status(504).json({ error: 'LLM request timed out' });
            }
            console.error(`[${MODULE_NAME}] Refine error:`, sanitizeError(err.message));
            return res.status(500).json({ error: 'Internal error during refinement' });
        }
    });

    console.log(`[${MODULE_NAME}] Plugin loaded. Config ${cachedConfig ? 'found' : 'not found — configure via UI'}.`);
}

async function exit() {
    console.log(`[${MODULE_NAME}] Plugin unloaded.`);
}

module.exports = {
    init,
    exit,
    info: {
        id: 'redraft',
        name: 'ReDraft',
        description: 'Server-side proxy for ReDraft message refinement. Securely stores API credentials and proxies refinement requests to a separate LLM.',
    },
};
