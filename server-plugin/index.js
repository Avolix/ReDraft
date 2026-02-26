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
const { getUserId, getConfigPath: _getConfigPath, maskKey, validateApiUrl, sanitizeError, isNewerVersion } = require('./lib/utils');

const CONFIG_DIR = __dirname;
const MODULE_NAME = 'redraft';
/** Server plugin version (semver). Bump when releasing server-plugin changes; client shows this in settings. */
const SERVER_PLUGIN_VERSION = '1.2.1';
const REQUEST_TIMEOUT_MS = 120_000;
const MAX_BODY_SIZE_BYTES = 512 * 1024; // 512 KB
const MAX_LLM_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 2000;

/** Per-user config cache: key is userId string or '__shared' for single-user. */
const configCache = new Map();

/** Bind getConfigPath to this plugin's CONFIG_DIR. */
function getConfigPath(userId) {
    return _getConfigPath(CONFIG_DIR, userId);
}

/**
 * Read and cache config from disk for the given user.
 * If the user has no per-user config file, falls back to shared config.json so that
 * when ST starts sending user ids (after another user used the plugin), the original
 * shared config still works.
 * @param {string|null} userId
 * @returns {object|null} The config object or null if not configured.
 */
function readConfigForUser(userId) {
    const cacheKey = userId ?? '__shared';
    const cached = configCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const configPath = getConfigPath(userId);
    try {
        if (!fs.existsSync(configPath)) {
            if (userId) {
                const shared = readConfigForUser(null);
                if (shared) return shared;
            }
            configCache.set(cacheKey, null);
            return null;
        }
        const raw = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(raw);
        configCache.set(cacheKey, config);
        return config;
    } catch (err) {
        console.error(`[${MODULE_NAME}] Failed to read config for ${cacheKey}:`, err.message);
        if (userId) {
            const shared = readConfigForUser(null);
            if (shared) return shared;
        }
        configCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Legacy single-config read for file watcher and initial load (shared config only).
 * @returns {object|null}
 */
function readConfig() {
    return readConfigForUser(null);
}

// maskKey, validateApiUrl, sanitizeError are imported from ./lib/utils.js

/**
 * Scan ST's data and legacy directories for the ReDraft extension's server-plugin folder.
 * Handles all user directories (multi-user) and case variations of the folder name.
 * Returns the path with the newest index.js, or null if not found.
 * @param {string} stRoot
 * @returns {string|null}
 */
function findExtensionServerPlugin(stRoot) {
    const candidates = [];

    // Scan data/*/extensions/third-party/ for all users
    const dataDir = path.join(stRoot, 'data');
    try {
        if (fs.existsSync(dataDir)) {
            const userDirs = fs.readdirSync(dataDir, { withFileTypes: true })
                .filter(d => d.isDirectory());
            for (const user of userDirs) {
                const thirdParty = path.join(dataDir, user.name, 'extensions', 'third-party');
                try {
                    if (!fs.existsSync(thirdParty)) continue;
                    const extDirs = fs.readdirSync(thirdParty, { withFileTypes: true })
                        .filter(d => d.isDirectory() && d.name.toLowerCase() === 'redraft');
                    for (const ext of extDirs) {
                        candidates.push(path.join(thirdParty, ext.name, 'server-plugin'));
                    }
                } catch { /* skip unreadable user dir */ }
            }
        }
    } catch { /* skip if data/ unreadable */ }

    // Legacy path: public/scripts/extensions/third-party/
    const legacyBase = path.join(stRoot, 'public', 'scripts', 'extensions', 'third-party');
    try {
        if (fs.existsSync(legacyBase)) {
            const extDirs = fs.readdirSync(legacyBase, { withFileTypes: true })
                .filter(d => d.isDirectory() && d.name.toLowerCase() === 'redraft');
            for (const ext of extDirs) {
                candidates.push(path.join(legacyBase, ext.name, 'server-plugin'));
            }
        }
    } catch { /* skip if legacy path unreadable */ }

    // Return the candidate with the newest index.js
    let newestDir = null;
    let newestMtime = 0;
    for (const dir of candidates) {
        try {
            const mtime = fs.statSync(path.join(dir, 'index.js')).mtimeMs;
            if (mtime > newestMtime) {
                newestMtime = mtime;
                newestDir = dir;
            }
        } catch { /* no index.js in this candidate */ }
    }
    return newestDir;
}

/**
 * Parse SERVER_PLUGIN_VERSION from an index.js file without requiring it.
 * @param {string} filePath
 * @returns {string|null} e.g. '1.2.0', or null if unreadable / not found.
 */
function parseVersionFromFile(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const match = content.match(/SERVER_PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/**
 * If the ReDraft extension was updated within ST, its server-plugin folder may contain a newer
 * version than the installed plugin. Copy those files here so the next restart runs the updated
 * plugin. Uses version-string comparison instead of file timestamps (mtime is unreliable because
 * fs.copyFileSync sets the destination's mtime to the current time, making the installed copy
 * appear perpetually "newer" than the source).
 * Does not overwrite config*.json (user credentials).
 */
function tryUpdateFromExtension() {
    const pluginDir = __dirname;
    const stRoot = path.join(pluginDir, '..', '..');

    const extensionDir = findExtensionServerPlugin(stRoot);
    if (!extensionDir) return;

    const extIndex = path.join(extensionDir, 'index.js');
    const extVersion = parseVersionFromFile(extIndex);
    if (!extVersion) return;

    if (!isNewerVersion(extVersion, SERVER_PLUGIN_VERSION)) return;

    console.log(`[${MODULE_NAME}] Extension has server plugin v${extVersion} (installed: v${SERVER_PLUGIN_VERSION}). Updating...`);

    const filesToCopy = ['index.js', 'config.json.example', 'lib/utils.js'];
    for (const file of filesToCopy) {
        const src = path.join(extensionDir, file);
        const dest = path.join(pluginDir, file);
        if (!fs.existsSync(src)) continue;
        try {
            const destDir = path.dirname(dest);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
            fs.copyFileSync(src, dest);
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Could not copy ${file}:`, e.message);
            if (file === 'index.js') return;
        }
    }
    const pkgPath = path.join(pluginDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
        try {
            fs.writeFileSync(pkgPath, JSON.stringify({ type: 'commonjs' }, null, 2) + '\n', 'utf-8');
        } catch (e) {
            console.warn(`[${MODULE_NAME}] Could not write package.json:`, e.message);
        }
    }
    console.log(`[${MODULE_NAME}] Server plugin updated from extension at ${extensionDir}. Restart SillyTavern to use the new version.`);
}

/**
 * Initialize the ReDraft server plugin.
 * @param {import('express').Router} router
 */
async function init(router) {
    tryUpdateFromExtension();

    readConfig();

    fs.watch(CONFIG_DIR, (eventType, filename) => {
        if (filename && (filename === 'config.json' || (filename.startsWith('config.') && filename.endsWith('.json')))) {
            const userId = filename === 'config.json' ? '__shared' : filename.slice(7, -5);
            configCache.delete(userId);
            console.log(`[${MODULE_NAME}] Config file changed (${filename}), cache invalidated.`);
        }
    });

    /**
     * POST /config — Save API credentials to disk (per-user in multi-user mode).
     * Accepts: { apiUrl, apiKey, model, maxTokens? }
     */
    router.post('/config', (req, res) => {
        try {
            const userId = getUserId(req);
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

            const existingConfig = readConfigForUser(userId);
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

            const configPath = getConfigPath(userId);
            fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
            configCache.set(userId ?? '__shared', config);

            console.log(`[${MODULE_NAME}] Config saved successfully${userId ? ` for user ${userId}` : ''}`);
            return res.json({ ok: true });
        } catch (err) {
            console.error(`[${MODULE_NAME}] Error saving config:`, err.message);
            return res.status(500).json({ error: 'Failed to save configuration' });
        }
    });

    /**
     * GET /status — Return plugin status (no secrets exposed). Per-user in multi-user mode.
     * Always includes version so the client can show "Server plugin 1.1" in settings.
     */
    router.get('/status', (req, res) => {
        const userId = getUserId(req);
        const config = readConfigForUser(userId);
        const base = { version: SERVER_PLUGIN_VERSION };
        if (!config || !config.apiKey || !config.apiUrl) {
            return res.json({
                ...base,
                configured: false,
                apiUrl: null,
                model: null,
                maskedKey: null,
            });
        }

        return res.json({
            ...base,
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
        let config = null;
        try {
            const userId = getUserId(req);
            config = readConfigForUser(userId);
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
                const hint = response.status === 401
                    ? ' Your API key may be invalid.'
                    : response.status === 403
                        ? ' Your API key may not have permission to list models.'
                        : '';
                return res.status(502).json({ error: `Models API returned ${response.status} from ${config.apiUrl}.${hint} ${sanitized.slice(0, 150)}`.trim() });
            }

            const data = await response.json();

            // OpenAI-compatible format: { data: [{ id: "model-name", ... }] }
            const models = Array.isArray(data?.data)
                ? data.data.map(m => ({ id: m.id, name: m.name || m.id })).sort((a, b) => a.id.localeCompare(b.id))
                : [];

            return res.json({ models });
        } catch (err) {
            if (err.name === 'AbortError') {
                return res.status(504).json({ error: `Models request to ${config?.apiUrl || 'API'} timed out after 10s. Check that the API URL is correct and reachable.` });
            }
            const safeMsg = sanitizeError(err.message, config);
            console.error(`[${MODULE_NAME}] Models fetch error from ${config?.apiUrl}:`, safeMsg);
            return res.status(500).json({ error: `Failed to fetch models from ${config?.apiUrl || 'API'}: ${safeMsg.slice(0, 150)}` });
        }
    });

    /**
     * POST /refine — Proxy refinement request to configured LLM. Per-user config in multi-user mode.
     * Accepts: { messages: [{role, content}] }
     * Returns: { text: string }
     * Outer try/catch ensures we always respond with JSON (never HTML or no response).
     */
    router.post('/refine', async (req, res) => {
        let config = null;
        let timeoutMs = REQUEST_TIMEOUT_MS;
        const sendJson = (status, body) => {
            if (!res.headersSent) {
                try { res.status(status).json(body); } catch (e) {
                    console.error(`[${MODULE_NAME}] Failed to send response:`, e.message);
                }
            }
        };
        try {
            const body = req.body != null ? req.body : {};
            const bodySize = JSON.stringify(body).length;
            if (bodySize > MAX_BODY_SIZE_BYTES) {
                return res.status(413).json({ error: 'Request body too large' });
            }

            const { messages, timeout: requestedTimeout } = body;
            if (!Array.isArray(messages) || messages.length === 0) {
                return res.status(400).json({ error: 'messages must be a non-empty array' });
            }

            timeoutMs = (requestedTimeout && Number(requestedTimeout) >= 15 && Number(requestedTimeout) <= 300)
                ? Number(requestedTimeout) * 1000
                : REQUEST_TIMEOUT_MS;

            for (const msg of messages) {
                if (!msg.role || typeof msg.role !== 'string') {
                    return res.status(400).json({ error: 'Each message must have a string "role"' });
                }
                if (!msg.content || typeof msg.content !== 'string') {
                    return res.status(400).json({ error: 'Each message must have a string "content"' });
                }
            }

            const userId = getUserId(req);
            config = readConfigForUser(userId);
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

            let response;
            let rawBody;

            for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), timeoutMs);

                try {
                    response = await fetch(endpoint, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${config.apiKey}`,
                        },
                        body: JSON.stringify(payload),
                        signal: controller.signal,
                    });

                    rawBody = await response.text();
                } finally {
                    clearTimeout(timeout);
                }

                if (response.ok || response.status !== 503 || attempt === MAX_LLM_ATTEMPTS) break;

                const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
                console.warn(`[${MODULE_NAME}] LLM returned 503 for model "${config.model}" (attempt ${attempt}/${MAX_LLM_ATTEMPTS}), retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }

            if (!response.ok) {
                const sanitized = sanitizeError(rawBody, config);
                console.error(`[${MODULE_NAME}] LLM API error (${response.status}) for model "${config.model}" at ${config.apiUrl}:`, sanitized);
                const statusHints = {
                    400: 'Bad request — the model name may be invalid or the request format is not supported by this API.',
                    401: 'Unauthorized — your API key is invalid, expired, or missing.',
                    402: 'Payment required — your API account may be out of credits.',
                    403: 'Forbidden — your API key does not have access to this model.',
                    404: 'Not found — the model name or API endpoint may be incorrect.',
                    429: 'Rate limited — too many requests. Wait a moment and try again.',
                    500: 'Internal server error on the API side — try again later.',
                    502: 'Bad gateway — the API\'s upstream provider returned an error.',
                    503: 'Service unavailable — the model\'s backend is temporarily down. Try again or use a different model.',
                };
                const hint = statusHints[response.status] || '';
                const detail = sanitized.slice(0, 200);
                return res.status(502).json({
                    error: `LLM API returned ${response.status} for model "${config.model}"${hint ? ': ' + hint : ''}${detail ? ' (' + detail + ')' : ''}`,
                });
            }

            let data;
            try {
                data = rawBody ? JSON.parse(rawBody) : null;
            } catch {
                const trimmed = (rawBody || '').trim();
                if (trimmed.startsWith('<') || trimmed.toLowerCase().startsWith('<!doctype')) {
                    console.error(`[${MODULE_NAME}] LLM API returned HTML instead of JSON for model "${config.model}" at ${config.apiUrl}`);
                    return res.status(502).json({ error: `API returned a web page instead of JSON for model "${config.model}". Check your API URL — it should be the base URL (e.g. https://openrouter.ai/api/v1), not a login page or docs URL.` });
                }
                return res.status(502).json({ error: `API returned invalid JSON for model "${config.model}": ${trimmed.slice(0, 100)}…` });
            }

            const text = data?.choices?.[0]?.message?.content;

            if (!text) {
                console.error(`[${MODULE_NAME}] LLM returned empty response for model "${config.model}". Raw:`, (rawBody || '').slice(0, 300));
                return res.status(502).json({ error: `LLM returned an empty or malformed response for model "${config.model}". The model may not support chat completions or the response format was unexpected.` });
            }

            return res.json({ text });

        } catch (err) {
            if (err.name === 'AbortError') {
                const model = config?.model || 'unknown';
                console.error(`[${MODULE_NAME}] LLM request timed out after ${timeoutMs}ms for model "${model}"`);
                sendJson(504, { error: `LLM request timed out after ${Math.round(timeoutMs / 1000)}s for model "${model}". The model may be overloaded — try increasing the timeout in ReDraft's Advanced settings, or use a faster model.` });
                return;
            }
            const safeMsg = sanitizeError(err.message, config);
            console.error(`[${MODULE_NAME}] Refine error for model "${config?.model || 'unknown'}":`, safeMsg);
            sendJson(500, { error: `Refinement failed: ${safeMsg.slice(0, 200)}` });
        }
    });

    const hasAnyConfig = fs.readdirSync(CONFIG_DIR).some(f => f.startsWith('config') && f.endsWith('.json'));
    console.log(`[${MODULE_NAME}] Plugin loaded. Multi-user config supported. ${hasAnyConfig ? 'Config file(s) present.' : 'No config yet — configure via UI.'}`);
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
