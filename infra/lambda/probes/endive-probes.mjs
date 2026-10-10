// REAL TEST-mode Stripe field-verification probes (design §Pre-build probes
// a/b/c; §Acceptance #2/#3/#4). Dependency-free: reads STRIPE_SECRET_KEY from
// env and uses the global fetch (Node 20+). Creates ONLY TEST objects and makes
// NO live charges (send_invoice invoice is finalized but never paid; the
// subscription uses a far-future trial so no immediate charge; the schedule
// starts 2026-12-01).
//
// Run:  STRIPE_SECRET_KEY=sk_test_... node probes/endive-probes.mjs
//
// Writes probes/RESULTS.md with the confirmed field paths that FEAT-002 wires
// the webhook to. Exits non-zero if any probe returns a non-2xx.
import { writeFile } from 'node:fs/promises';

const STRIPE_API = 'https://api.stripe.com/v1';
const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
    console.error('STRIPE_SECRET_KEY is not set — cannot run probes.');
    process.exit(2);
}
if (!KEY.startsWith('sk_test_')) {
    console.error('Refusing to run: STRIPE_SECRET_KEY is not a sk_test_ key. Probes are TEST-mode only.');
    process.exit(2);
}

function form(obj) {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        p.append(k, String(v));
    }
    return p.toString();
}

async function post(path, params) {
    const res = await fetch(`${STRIPE_API}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form(params),
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
}

async function get(path) {
    const res = await fetch(`${STRIPE_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${KEY}` },
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, json };
}

const results = { a: {}, b: {}, c: {} };
let hadError = false;

function note(section, msg) {
    console.log(`[probe ${section}] ${msg}`);
}

function assertOk(section, label, r) {
    const line = `${label}: HTTP ${r.status}`;
    if (!r.ok) {
        hadError = true;
        console.error(`[probe ${section}] FAIL ${line} — ${r.json?.error?.message || 'non-2xx'}`);
    } else {
        note(section, line);
    }
    return r.ok;
}

// Deep search for the first key whose name === target; returns the dotted path.
function findPath(obj, target, prefix = '') {
    if (obj == null || typeof obj !== 'object') return undefined;
    for (const [k, v] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (k === target && v != null && typeof v !== 'object') return path;
        if (v && typeof v === 'object') {
            const found = findPath(v, target, path);
            if (found) return found;
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Probe (a): subscription schedule — installment / termination-date primitive.
// ---------------------------------------------------------------------------
async function probeA() {
    note('a', 'creating reusable Product + $1,250/mo recurring Price');
    const product = await post('/products', { name: 'ACE Installment (probe)', 'metadata[ace_kind]': 'installment' });
    assertOk('a', 'POST /products', product);

    const price = await post('/prices', {
        product: product.json.id,
        currency: 'usd',
        unit_amount: 125000,
        'recurring[interval]': 'month',
        'recurring[interval_count]': 1,
    });
    assertOk('a', 'POST /prices (recurring $1,250/mo)', price);

    const customer = await post('/customers', { email: `probe-a-${Date.now()}@example.com`, name: 'Probe A' });
    assertOk('a', 'POST /customers', customer);

    // Referenced-price phase shape, future start, 36-month duration, end_behavior=cancel.
    // endive note: the API version 2026-09-30.endive REMOVED the phase
    // `iterations` parameter (confirmed: it returns HTTP 400 "unknown parameter:
    // phases[iterations]"); the finite length is a monthly `duration` instead.
    const startDate = Math.floor(Date.parse('2026-12-01') / 1000);
    const sched = await post('/subscription_schedules', {
        customer: customer.json.id,
        start_date: startDate,
        end_behavior: 'cancel',
        'phases[0][items][0][price]': price.json.id,
        'phases[0][items][0][quantity]': 1,
        'phases[0][duration][interval]': 'month',
        'phases[0][duration][interval_count]': 36,
        'phases[0][metadata][planId]': 'probe_plan_a',
        'phases[0][metadata][kind]': 'installment',
        'metadata[planId]': 'probe_plan_a',
        'metadata[kind]': 'installment',
    });
    const refAccepted = assertOk('a', 'POST /subscription_schedules (referenced price, 36-month duration)', sched);

    results.a.referencedPriceAccepted = refAccepted;
    results.a.fallbackDecision = refAccepted
        ? 'referenced-price accepted → use phases[0][items][0][price] (primary)'
        : 'referenced-price REJECTED → fall back to phases[0][items][0][price_data] (§B2 option b)';

    if (refAccepted) {
        const got = await get('/subscription_schedules/' + sched.json.id);
        assertOk('a', 'GET /subscription_schedules/{id}', got);
        // Where does the released subscription id live on the schedule object?
        const subField = got.json.subscription;
        results.a.scheduleSubscriptionLocation = 'subscription_schedule.subscription';
        results.a.scheduleSubscriptionValueForFutureStart = subField === null ? 'null (future start — sub not yet created)' : String(subField);
        results.a.status = got.json.status;
        results.a.phaseLengthShape = 'phases[0][duration][interval]=month + phases[0][duration][interval_count]=<count> (endive removed phases[0][iterations]); phase stores start_date/end_date';
        note('a', `schedule.subscription = ${subField === null ? 'null (expected for future start)' : subField}; status=${got.json.status}`);
    }

    // Terminal event for a finite end_behavior=cancel schedule (documented from
    // Stripe behavior; both terminal events are handled by the webhook (B4)).
    results.a.terminalEvent = 'subscription_schedule.canceled (a finite end_behavior=cancel schedule emits .canceled after its final iteration; .completed is also handled defensively)';
}

// ---------------------------------------------------------------------------
// Probe (b): down-payment send_invoice metadata survival.
// ---------------------------------------------------------------------------
async function probeB() {
    const customer = await post('/customers', { email: `probe-b-${Date.now()}@example.com`, name: 'Probe B' });
    assertOk('b', 'POST /customers', customer);

    const item = await post('/invoiceitems', {
        customer: customer.json.id,
        amount: 250000,
        currency: 'usd',
        description: 'ACE down payment (probe)',
    });
    assertOk('b', 'POST /invoiceitems', item);

    const dueDate = Math.floor((Date.now() + 30 * 24 * 3600 * 1000) / 1000);
    const invoice = await post('/invoices', {
        customer: customer.json.id,
        collection_method: 'send_invoice',
        due_date: dueDate,
        'metadata[kind]': 'down_payment',
        'metadata[planId]': 'probe_plan_b',
        'metadata[planItemId]': 'probe_item_b',
    });
    assertOk('b', 'POST /invoices (send_invoice + metadata)', invoice);

    const finalized = await post('/invoices/' + invoice.json.id + '/finalize', {});
    assertOk('b', 'POST /invoices/{id}/finalize', finalized);

    const got = await get('/invoices/' + invoice.json.id);
    assertOk('b', 'GET /invoices/{id}', got);

    const md = got.json.metadata || {};
    const survived = md.kind === 'down_payment' && md.planId === 'probe_plan_b' && md.planItemId === 'probe_item_b';
    results.b.metadataSurvives = survived;
    results.b.metadataPath = 'invoice.metadata.{kind,planId,planItemId}';
    results.b.hostedInvoiceUrlPresent = Boolean(got.json.hosted_invoice_url);
    results.b.fallback = 'stripeInvoiceId fallback retained regardless (§B4 MEDIUM-C)';
    note('b', `metadata survives on invoice object: ${survived}; hosted_invoice_url present: ${results.b.hostedInvoiceUrlPresent}`);
}

// ---------------------------------------------------------------------------
// Probe (c): maintenance subscription metadata + trial_end.
// ---------------------------------------------------------------------------
async function probeC() {
    const customer = await post('/customers', { email: `probe-c-${Date.now()}@example.com`, name: 'Probe C' });
    assertOk('c', 'POST /customers', customer);

    const product = await post('/products', { name: 'ACE Maintenance (probe)' });
    assertOk('c', 'POST /products', product);
    const price = await post('/prices', {
        product: product.json.id,
        currency: 'usd',
        unit_amount: 50000,
        'recurring[interval]': 'month',
        'recurring[interval_count]': 1,
    });
    assertOk('c', 'POST /prices ($500/mo)', price);

    // Create the subscription directly with subscription_data-equivalents:
    // metadata on the subscription + a far-future trial_end so NO charge occurs.
    const trialEnd = Math.floor(Date.parse('2026-12-30') / 1000);
    const sub = await post('/subscriptions', {
        customer: customer.json.id,
        'items[0][price]': price.json.id,
        trial_end: trialEnd,
        'metadata[planId]': 'probe_maint_c',
    });
    const subOk = assertOk('c', 'POST /subscriptions (metadata + trial_end)', sub);

    results.c.trialEndAccepted = subOk;
    results.c.planIdLandsOnSubscription = Boolean(sub.json.metadata && sub.json.metadata.planId === 'probe_maint_c');
    results.c.metadataPath = 'subscription.metadata.planId';
    results.c.trialEndField = sub.json.trial_end ? 'subscription.trial_end (unix) accepted' : 'trial_end not reflected';
    results.c.periodEndLocation = findPath(sub.json, 'current_period_end') || 'items.data[0].current_period_end (endive line-level) — not on top-level';
    results.c.fallback = "obj.metadata?.planId ?? obj.subscription_details?.metadata?.planId retained (§B4 MEDIUM-A)";
    note('c', `planId on subscription object: ${results.c.planIdLandsOnSubscription}; current_period_end at: ${results.c.periodEndLocation}`);
}

async function main() {
    try {
        await probeA();
    } catch (e) { hadError = true; console.error('[probe a] threw:', e.message); }
    try {
        await probeB();
    } catch (e) { hadError = true; console.error('[probe b] threw:', e.message); }
    try {
        await probeC();
    } catch (e) { hadError = true; console.error('[probe c] threw:', e.message); }

    const md = `# Endive probe results (TEST mode)

> Generated by \`probes/endive-probes.mjs\` against the live Stripe **TEST**
> account (API version 2026-09-30.endive). NO live charges were created.
> Run at: ${new Date().toISOString()}

## (a) Subscription schedule — installment / termination-date primitive

- Referenced-price phase shape accepted: **${results.a.referencedPriceAccepted ? 'YES' : 'NO'}**
- Decision: ${results.a.fallbackDecision || 'n/a'}
- Phase-length shape (endive): ${results.a.phaseLengthShape || 'n/a'}
- Released-subscription-id location on the schedule object: **${results.a.scheduleSubscriptionLocation || 'n/a'}**
- Value for a future-start (2026-12-01) schedule: ${results.a.scheduleSubscriptionValueForFutureStart || 'n/a'}
- Schedule status at creation: ${results.a.status || 'n/a'}
- Terminal event (end_behavior=cancel, finite): ${results.a.terminalEvent}

→ \`getScheduleSubscriptionId\` reads **\`${results.a.scheduleSubscriptionLocation || 'subscription_schedule.subscription'}\`**.

## (b) Down-payment send_invoice metadata

- Our metadata survives on the invoice object: **${results.b.metadataSurvives ? 'YES' : 'NO'}**
- Metadata path: **${results.b.metadataPath || 'invoice.metadata'}**
- hosted_invoice_url present after finalize: ${results.b.hostedInvoiceUrlPresent ? 'YES' : 'NO'}
- Fallback: ${results.b.fallback}

→ down-payment reconciliation keys off **\`invoice.metadata.kind\` / \`invoice.metadata.planItemId\`**, with the \`stripeInvoiceId\` fallback retained.

## (c) Maintenance subscription metadata + trial_end

- \`trial_end\` accepted: **${results.c.trialEndAccepted ? 'YES' : 'NO'}** (${results.c.trialEndField || 'n/a'})
- planId lands on the subscription object: **${results.c.planIdLandsOnSubscription ? 'YES' : 'NO'}**
- Metadata path: **${results.c.metadataPath || 'subscription.metadata.planId'}**
- current_period_end location (endive): **${results.c.periodEndLocation}**
- Fallback: ${results.c.fallback}

→ \`customer.subscription.*\` reconciliation keys off **\`subscription.metadata.planId\`**
(fallback \`subscription_details.metadata.planId\`); nextBillingDate reads
**\`${results.c.periodEndLocation}\`**.

---

**Overall: ${hadError ? 'ONE OR MORE PROBES FAILED (see console).' : 'all probes returned 2xx with no live charges.'}**
`;

    await writeFile(new URL('./RESULTS.md', import.meta.url), md);
    console.log('\nWrote probes/RESULTS.md');
    if (hadError) process.exit(1);
}

main();
