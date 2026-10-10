// Shared test setup: registers the @aws-sdk/* resolve hook, then dynamically
// imports the handler module AFTER the hook is active, so plain `node --test`
// (no --import flag needed) can load the dependency-free quoteHandler.mjs
// without a node_modules.
//
// Each *.test.mjs does:  const H = await import('./setup.mjs').then(m => m.loadHandler());
import { register } from 'node:module';

const stubUrl = new URL('./aws-sdk-stub.mjs', import.meta.url).href;
const hookUrl = new URL('./resolve-hook.mjs', import.meta.url).href;

register(hookUrl, { data: { stubUrl } });

export async function loadHandler() {
    // Dynamic import so the resolve hook (registered above) is in effect before
    // quoteHandler.mjs's top-level `import '@aws-sdk/...'` lines resolve.
    return import('../quoteHandler.mjs');
}

// --- shared fetch mock helper ---------------------------------------------
// Installs a global.fetch that returns queued responses in order and records
// every call. Returns a handle with `.calls` and `.restore()`.
export function installFetchMock(responder) {
    const original = global.fetch;
    const calls = [];
    global.fetch = async (url, opts = {}) => {
        const call = { url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers };
        calls.push(call);
        const result = await responder(call, calls.length - 1);
        const status = result?.status ?? 200;
        const json = result?.json ?? {};
        return {
            ok: status >= 200 && status < 300,
            status,
            json: async () => json,
        };
    };
    return {
        calls,
        restore() { global.fetch = original; },
    };
}

// Parse a urlencoded Stripe request body into a plain object.
export function parseForm(body) {
    const out = {};
    for (const [k, v] of new URLSearchParams(body || '')) out[k] = v;
    return out;
}
