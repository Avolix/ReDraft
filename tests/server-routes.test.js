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
});
