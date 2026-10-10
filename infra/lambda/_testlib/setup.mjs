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

// --- in-memory DynamoDB DocumentClient mock -------------------------------
// A tiny fake of the DynamoDBDocumentClient surface the webhook reconciliation
// helpers use (ScanCommand / UpdateCommand / PutCommand). Commands arrive as
// the aws-sdk stub's StubCommand instances carrying `.input`; we discriminate
// by the input shape. Each table is a Map keyed by item `id`.
//
// Usage:
//   const db = makeDocClientMock({ PlanTable: [plan], ItemTable: [] });
//   __setDocClientForTests(db.client);
//   ... run webhook ...
//   db.items('PlanTable');  // -> current rows
export function makeDocClientMock(seed = {}) {
    const tables = new Map();
    for (const [name, rows] of Object.entries(seed)) {
        const m = new Map();
        for (const r of rows) m.set(r.id, { ...r });
        tables.set(name, m);
    }
    const tableOf = (name) => {
        if (!tables.has(name)) tables.set(name, new Map());
        return tables.get(name);
    };
    const calls = [];

    function applyUpdate(row, input) {
        // Supports two shapes used by the helpers:
        //   SET #f0 = :v0, ...                                      (plain SET)
        //   SET #c = if_not_exists(#c, :zero) + :one, #u = :now     (counter + ts)
        const names = input.ExpressionAttributeNames || {};
        const values = input.ExpressionAttributeValues || {};
        const expr = (input.UpdateExpression || '').replace(/^SET\s+/i, '');

        // Counter assignment: #c = if_not_exists(#c, :zero) + :one
        // Groups: [full, targetField, if_not_exists-field, :default, :increment]
        const counter = expr.match(/(#?\w+)\s*=\s*if_not_exists\(\s*(#?\w+)\s*,\s*(:\w+)\s*\)\s*\+\s*(:\w+)/);
        if (counter) {
            const field = names[counter[1]] || counter[1];
            const base = row[field] != null ? row[field] : values[counter[3]];
            row[field] = base + values[counter[4]];
        }

        // Simple "#name = :value" assignments (ignore the counter clause above).
        const simple = /(#\w+)\s*=\s*(:\w+)/g;
        let m;
        while ((m = simple.exec(expr)) !== null) {
            // Skip the if_not_exists target assignment (handled above): detect by
            // whether the matched ":value" is immediately preceded by "if_not_exists".
            const before = expr.slice(0, m.index);
            if (/if_not_exists\([^)]*$/.test(before)) continue;
            const field = names[m[1]] || m[1];
            row[field] = values[m[2]];
        }
        return row;
    }

    const client = {
        async send(command) {
            const input = command.input || command;
            calls.push(input);
            // ScanCommand: single equality filter "#k = :v" on a named field.
            if (input.FilterExpression) {
                const names = input.ExpressionAttributeNames || {};
                const values = input.ExpressionAttributeValues || {};
                const m = input.FilterExpression.match(/(#?\w+)\s*=\s*(:\w+)/);
                const field = m ? (names[m[1]] || m[1]) : null;
                const want = m ? values[m[2]] : undefined;
                const items = [...tableOf(input.TableName).values()]
                    .filter((it) => field == null || it[field] === want);
                return { Items: items };
            }
            // PutCommand.
            if (input.Item) {
                tableOf(input.TableName).set(input.Item.id, { ...input.Item });
                return {};
            }
            // UpdateCommand.
            if (input.Key && input.UpdateExpression) {
                const t = tableOf(input.TableName);
                const existing = t.get(input.Key.id) || { id: input.Key.id };
                const updated = applyUpdate({ ...existing }, input);
                t.set(input.Key.id, updated);
                if (input.ReturnValues === 'ALL_NEW') return { Attributes: { ...updated } };
                return {};
            }
            throw new Error('makeDocClientMock: unrecognized command input ' + JSON.stringify(input));
        },
    };

    return {
        client,
        calls,
        items(name) { return [...tableOf(name).values()]; },
        get(name, id) { return tableOf(name).get(id); },
    };
}
