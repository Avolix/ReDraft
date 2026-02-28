/**
 * Integration tests for the server plugin's Express routes.
 *
 * Uses vi.spyOn with selective pass-through: config-related fs calls are
 * mocked while .js file reads (needed by require()) pass to the real fs.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginPath = path.resolve(__dirname, '..', 'server-plugin', 'index.js');
const utilsPath = path.resolve(__dirname, '..', 'server-plugin', 'lib', 'utils.js');

function createSpyRouter() {
    const routes = { get: {}, post: {} };
    return {
        get(p, handler) { routes.get[p] = handler; },
        post(p, handler) { routes.post[p] = handler; },
        _routes: routes,
    };
}

function createMockRes() {
    const res = {
        _status: 200,
        _body: null,
        headersSent: false,
        status(code) { res._status = code; return res; },
        json(body) { res._body = body; res.headersSent = true; return res; },
    };
    return res;
}

/**
 * Initialize a fresh plugin instance with selective fs spies.
 * Only config.json-related reads are mocked; .js file reads pass through
 * so that require() still works.
 */
async function initPlugin(configData = null) {
    vi.restoreAllMocks();

    const realExistsSync = fs.existsSync;
    const realReadFileSync = fs.readFileSync;
    const realReaddirSync = fs.readdirSync;

    vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
        if (typeof p === 'string' && p.endsWith('.json') && path.basename(p).startsWith('config')) {
            return !!configData;
        }
        return realExistsSync(p);
    });

    vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.endsWith('.json') && path.basename(p).startsWith('config')) {
            return configData ? JSON.stringify(configData) : '';
        }
        return realReadFileSync(p, ...args);
    });

    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});

    vi.spyOn(fs, 'readdirSync').mockImplementation((p, ...args) => {
        if (typeof p === 'string' && p.includes('server-plugin')) {
            return configData ? ['config.json'] : [];
        }
        return realReaddirSync(p, ...args);
    });

    vi.spyOn(fs, 'watch').mockReturnValue({ close: vi.fn() });

    delete require.cache[pluginPath];
    delete require.cache[utilsPath];

    const router = createSpyRouter();
    const plugin = require(pluginPath);
    await plugin.init(router);
    return router._routes;
}

afterEach(() => {
    vi.restoreAllMocks();
});

// ─── Server-plugin CJS compatibility ────────────────────────────────

describe('server-plugin CJS compatibility', () => {
    const serverPluginDir = path.resolve(__dirname, '..', 'server-plugin');

    it('all .js files use CommonJS syntax (no ESM import/export)', () => {
        const jsFiles = fs.readdirSync(serverPluginDir, { recursive: true })
            .filter(f => typeof f === 'string' && f.endsWith('.js'));

        expect(jsFiles.length).toBeGreaterThan(0);

        for (const file of jsFiles) {
            const content = fs.readFileSync(path.join(serverPluginDir, file), 'utf-8');
            const hasImportFrom = /^\s*import\s+.+\s+from\s+/m.test(content);
            const hasExportDefault = /^\s*export\s+default\s+/m.test(content);
            const hasExportNamed = /^\s*export\s+\{/m.test(content);
            const hasImportMeta = /import\.meta/.test(content);

            expect(hasImportFrom, `${file} has ESM "import … from" — must use require()`).toBe(false);
            expect(hasExportDefault, `${file} has ESM "export default" — must use module.exports`).toBe(false);
            expect(hasExportNamed, `${file} has ESM "export {" — must use module.exports`).toBe(false);
            expect(hasImportMeta, `${file} has "import.meta" — not available in CJS`).toBe(false);
        }
    });

    it('package.json declares "type": "commonjs"', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(serverPluginDir, 'package.json'), 'utf-8'));
        expect(pkg.type).toBe('commonjs');
    });

    it('SERVER_PLUGIN_VERSION is a valid semver string', () => {
        const content = fs.readFileSync(pluginPath, 'utf-8');
        const match = content.match(/SERVER_PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/);
        expect(match).not.toBeNull();
        expect(match[1]).toMatch(/^\d+\.\d+\.\d+$/);
    });
});

// ─── Auto-update (tryUpdateFromExtension) ───────────────────────────

describe('tryUpdateFromExtension (auto-update)', () => {
    const pluginDir = path.dirname(pluginPath);
    const stRoot = path.resolve(pluginDir, '..', '..');
    const dataDir = path.join(stRoot, 'data');
    const thirdPartyDir = path.join(dataDir, 'default-user', 'extensions', 'third-party');
    const extServerPluginDir = path.join(thirdPartyDir, 'redraft', 'server-plugin');
    const extIndexPath = path.join(extServerPluginDir, 'index.js');

    const pluginSource = fs.readFileSync(pluginPath, 'utf-8');
    const currentVersion = pluginSource.match(/SERVER_PLUGIN_VERSION\s*=\s*['"]([^'"]+)['"]/)[1];

    /**
     * Initialize a fresh plugin instance with fs mocks that simulate an ST
     * data directory containing the extension's server-plugin at the given
     * version. Pass null to simulate no extension found.
     */
    async function initWithExtensionVersion(extensionVersion) {
        vi.restoreAllMocks();

        const realExistsSync = fs.existsSync;
        const realReadFileSync = fs.readFileSync;
        const realReaddirSync = fs.readdirSync;
        const realStatSync = fs.statSync;

        vi.spyOn(fs, 'existsSync').mockImplementation((p) => {
            const norm = path.normalize(String(p));
            if (extensionVersion && norm.startsWith(path.normalize(extServerPluginDir))) return true;
            if (norm === path.normalize(dataDir)) return !!extensionVersion;
            if (norm === path.normalize(thirdPartyDir)) return !!extensionVersion;
            if (norm === path.normalize(path.join(pluginDir, 'package.json'))) return true;
            if (typeof p === 'string' && p.endsWith('.json') && path.basename(p).startsWith('config')) return false;
            return realExistsSync(p);
        });

        vi.spyOn(fs, 'readFileSync').mockImplementation((p, ...args) => {
            const norm = path.normalize(String(p));
            if (extensionVersion && norm === path.normalize(extIndexPath)) {
                return `const SERVER_PLUGIN_VERSION = '${extensionVersion}';`;
            }
            if (typeof p === 'string' && p.endsWith('.json') && path.basename(p).startsWith('config')) return '';
            return realReadFileSync(p, ...args);
        });

        vi.spyOn(fs, 'readdirSync').mockImplementation((p, options) => {
            const norm = path.normalize(String(p));
            if (extensionVersion && norm === path.normalize(dataDir)) {
                return [{ name: 'default-user', isDirectory: () => true }];
            }
            if (extensionVersion && norm === path.normalize(thirdPartyDir)) {
                return [{ name: 'redraft', isDirectory: () => true }];
            }
            if (norm === path.normalize(pluginDir)) return [];
            return realReaddirSync(p, options);
        });

        vi.spyOn(fs, 'statSync').mockImplementation((p) => {
            const norm = path.normalize(String(p));
            if (extensionVersion && norm === path.normalize(extIndexPath)) {
                return { mtimeMs: Date.now() };
            }
            return realStatSync(p);
        });

        vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {});
        vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
        vi.spyOn(fs, 'watch').mockReturnValue({ close: vi.fn() });

        delete require.cache[pluginPath];
        delete require.cache[utilsPath];

        const router = createSpyRouter();
        const plugin = require(pluginPath);
        await plugin.init(router);
        return router._routes;
    }

    it('copies files when extension has a newer version', async () => {
        await initWithExtensionVersion('99.0.0');

        const copyCalls = fs.copyFileSync.mock.calls;
        const indexCopy = copyCalls.find(([src]) => String(src).endsWith('index.js'));
        expect(indexCopy).toBeDefined();
        expect(path.normalize(String(indexCopy[0]))).toBe(path.normalize(extIndexPath));
        expect(path.normalize(String(indexCopy[1]))).toBe(path.normalize(path.join(pluginDir, 'index.js')));
    });

    it('also copies lib/utils.js when updating', async () => {
        await initWithExtensionVersion('99.0.0');

        const copyCalls = fs.copyFileSync.mock.calls;
        const utilsCopy = copyCalls.find(([src]) =>
            path.normalize(String(src)) === path.normalize(path.join(extServerPluginDir, 'lib', 'utils.js')),
        );
        expect(utilsCopy).toBeDefined();
    });

    it('does not copy when extension has the same version', async () => {
        await initWithExtensionVersion(currentVersion);
        expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('does not copy when extension has an older version', async () => {
        await initWithExtensionVersion('0.0.1');
        expect(fs.copyFileSync).not.toHaveBeenCalled();
    });

    it('does not copy when no extension is found', async () => {
        await initWithExtensionVersion(null);
        expect(fs.copyFileSync).not.toHaveBeenCalled();
    });
});

// ─── GET /status ────────────────────────────────────────────────────

describe('GET /status', () => {
    it('returns configured: false when no config exists', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.get['/status']({ headers: {} }, res);
        expect(res._body.configured).toBe(false);
        expect(res._body.version).toBeDefined();
    });

    it('returns configured: true with masked key when config exists', async () => {
        const routes = await initPlugin({
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        });
        const res = createMockRes();
        routes.get['/status']({ headers: {} }, res);
        expect(res._body.configured).toBe(true);
        expect(res._body.apiUrl).toBe('https://api.example.com/v1');
        expect(res._body.model).toBe('gpt-4');
        expect(res._body.maskedKey).toBe('sk-...7890');
        expect(res._body).not.toHaveProperty('apiKey');
    });

    it('always includes version string', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.get['/status']({ headers: {} }, res);
        expect(typeof res._body.version).toBe('string');
    });
});

// ─── POST /config ───────────────────────────────────────────────────

describe('POST /config', () => {
    it('rejects missing apiUrl', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: { model: 'gpt-4', apiKey: 'sk-test12345678' },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('apiUrl');
    });

    it('rejects missing model', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: { apiUrl: 'https://api.example.com/v1', apiKey: 'sk-test12345678' },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('model');
    });

    it('rejects SSRF URLs (localhost)', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: {
                apiUrl: 'http://localhost:8080',
                apiKey: 'sk-test12345678',
                model: 'gpt-4',
            },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('localhost');
    });

    it('rejects SSRF URLs (private IP)', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: {
                apiUrl: 'http://192.168.1.1',
                apiKey: 'sk-test12345678',
                model: 'gpt-4',
            },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('Private');
    });

    it('saves valid config and returns ok', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: {
                apiUrl: 'https://api.openai.com/v1',
                apiKey: 'sk-test12345678',
                model: 'gpt-4',
            },
        }, res);
        expect(res._body).toEqual({ ok: true });
        expect(fs.writeFileSync).toHaveBeenCalled();
    });

    it('clamps maxTokens between 1 and 128000', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: {
                apiUrl: 'https://api.openai.com/v1',
                apiKey: 'sk-test12345678',
                model: 'gpt-4',
                maxTokens: 999999,
            },
        }, res);
        expect(res._body).toEqual({ ok: true });
        const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(written.maxTokens).toBe(128000);
    });

    it('strips trailing slashes from apiUrl', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: {
                apiUrl: 'https://api.openai.com/v1///',
                apiKey: 'sk-test12345678',
                model: 'gpt-4',
            },
        }, res);
        const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(written.apiUrl).toBe('https://api.openai.com/v1');
    });

    it('retains existing key when apiKey is blank and config exists', async () => {
        const routes = await initPlugin({
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-existing-key-12345',
            model: 'gpt-4',
        });
        const res = createMockRes();
        routes.post['/config']({
            headers: {},
            body: {
                apiUrl: 'https://api.openai.com/v1',
                apiKey: '',
                model: 'gpt-4o',
            },
        }, res);
        expect(res._body).toEqual({ ok: true });
        const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
        expect(written.apiKey).toBe('sk-existing-key-12345');
    });
});

// ─── POST /refine ───────────────────────────────────────────────────

describe('POST /refine', () => {
    it('rejects empty messages array', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [] },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('messages');
    });

    it('rejects messages without role', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ content: 'hello' }] },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('role');
    });

    it('rejects messages without content', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user' }] },
        }, res);
        expect(res._status).toBe(400);
        expect(res._body.error).toContain('content');
    });

    it('returns 503 when not configured', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }] },
        }, res);
        expect(res._status).toBe(503);
        expect(res._body.error).toContain('not configured');
    });

    it('rejects non-array messages', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: 'not an array' },
        }, res);
        expect(res._status).toBe(400);
    });

    it('returns 502 with status hint on LLM 401 error', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        }));
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }] },
        }, res);
        expect(res._status).toBe(502);
        expect(res._body.error).toContain('401');
        expect(res._body.error).toContain('Unauthorized');
    });

    it('returns 502 with hint when API returns HTML', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '<!DOCTYPE html><html><body>Login</body></html>',
        }));
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }] },
        }, res);
        expect(res._status).toBe(502);
        expect(res._body.error).toContain('web page instead of JSON');
    });

    it('returns 504 on timeout (AbortError)', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        const abortError = new DOMException('The operation was aborted', 'AbortError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }] },
        }, res);
        expect(res._status).toBe(504);
        expect(res._body.error).toContain('timed out');
    });

    it('returns successful refinement text', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: 'Refined text here.' } }],
            }),
        }));
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }] },
        }, res);
        expect(res._status).toBe(200);
        expect(res._body.text).toBe('Refined text here.');
    });

    it('uses client-provided timeout when valid', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        let usedTimeoutMs;
        const realSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
            if (typeof ms === 'number' && ms >= 15_000) usedTimeoutMs = ms;
            return realSetTimeout(fn, 0);
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }], timeout: 30 },
        }, res);
        expect(usedTimeoutMs).toBe(30_000);
        expect(res._status).toBe(200);
    });

    it('ignores out-of-range client timeout and uses default', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        let usedTimeoutMs;
        const realSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((fn, ms) => {
            if (typeof ms === 'number' && ms >= 15_000) usedTimeoutMs = ms;
            return realSetTimeout(fn, 0);
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({
                choices: [{ message: { content: 'ok' } }],
            }),
        }));
        const res = createMockRes();
        await routes.post['/refine']({
            headers: {},
            body: { messages: [{ role: 'user', content: 'hello' }], timeout: 999 },
        }, res);
        expect(usedTimeoutMs).toBe(120_000);
        expect(res._status).toBe(200);
    });
});

// ─── GET /models ────────────────────────────────────────────────────

describe('GET /models', () => {
    it('returns 503 when not configured', async () => {
        const routes = await initPlugin();
        const res = createMockRes();
        await routes.get['/models']({ headers: {} }, res);
        expect(res._status).toBe(503);
        expect(res._body.error).toContain('Not configured');
    });

    it('returns sorted models list on success', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                data: [
                    { id: 'gpt-4o', name: 'GPT-4o' },
                    { id: 'gpt-3.5-turbo' },
                    { id: 'gpt-4' },
                ],
            }),
        }));
        const res = createMockRes();
        await routes.get['/models']({ headers: {} }, res);
        expect(res._status).toBe(200);
        expect(res._body.models).toHaveLength(3);
        expect(res._body.models[0].id).toBe('gpt-3.5-turbo');
        expect(res._body.models[1].id).toBe('gpt-4');
        expect(res._body.models[2].id).toBe('gpt-4o');
        expect(res._body.models[2].name).toBe('GPT-4o');
    });

    it('returns 502 with hint on API 401 error', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 401,
            text: async () => 'Unauthorized',
        }));
        const res = createMockRes();
        await routes.get['/models']({ headers: {} }, res);
        expect(res._status).toBe(502);
        expect(res._body.error).toContain('401');
        expect(res._body.error).toContain('API key may be invalid');
    });

    it('returns 502 with hint on API 403 error', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: false,
            status: 403,
            text: async () => 'Forbidden',
        }));
        const res = createMockRes();
        await routes.get['/models']({ headers: {} }, res);
        expect(res._status).toBe(502);
        expect(res._body.error).toContain('403');
        expect(res._body.error).toContain('permission');
    });

    it('handles timeout without crashing (AbortError)', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        const abortError = new DOMException('The operation was aborted', 'AbortError');
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));
        const res = createMockRes();
        await routes.get['/models']({ headers: {} }, res);
        expect(res._status).toBe(504);
        expect(res._body.error).toContain('timed out');
    });

    it('handles fetch error gracefully', async () => {
        const config = {
            apiUrl: 'https://api.example.com/v1',
            apiKey: 'sk-abcdef1234567890',
            model: 'gpt-4',
        };
        const routes = await initPlugin(config);
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
        const res = createMockRes();
        await routes.get['/models']({ headers: {} }, res);
        expect(res._status).toBe(500);
        expect(res._body.error).toContain('Failed to fetch models');
    });
});
