// Capture REAL endive event bodies for the event-replay field check
// (design §Acceptance #10) WITHOUT the Stripe CLI and WITHOUT live charges, by
// driving a Stripe TEST clock. All objects are attached to the test clock; a
// test-mode card (pm_card_visa / a decline token) is used; advancing the clock
// makes Stripe emit authentic events under the account API version
// 2026-09-30.endive, which we then read from GET /events.
//
// Run:  STRIPE_SECRET_KEY=sk_test_... node probes/replay-capture.mjs
// Writes probes/captured-events.json (consumed by event-replay.test.mjs).
import { writeFile } from 'node:fs/promises';

const API = 'https://api.stripe.com/v1';
const K = process.env.STRIPE_SECRET_KEY;
if (!K || !K.startsWith('sk_test_')) {
    console.error('Need a sk_test_ STRIPE_SECRET_KEY. No live charges are made.');
    process.exit(2);
}
const f = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) { if (v == null) continue; p.append(k, String(v)); } return p.toString(); };
const post = async (p, params) => { const r = await fetch(API + p, { method: 'POST', headers: { Authorization: 'Bearer ' + K, 'Content-Type': 'application/x-www-form-urlencoded' }, body: f(params) }); const j = await r.json(); if (!r.ok) throw new Error(`${p} -> ${r.status} ${j.error?.message}`); return j; };
const get = async (p) => { const r = await fetch(API + p, { headers: { Authorization: 'Bearer ' + K } }); const j = await r.json(); if (!r.ok) throw new Error(`${p} -> ${r.status} ${j.error?.message}`); return j; };
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function waitClock(clockId) {
    for (let i = 0; i < 60; i++) {
        const c = await get('/test_helpers/test_clocks/' + clockId);
        if (c.status === 'ready') return c;
        await sleep(2000);
    }
    throw new Error('test clock did not become ready in time');
}

async function main() {
    const now = Math.floor(Date.now() / 1000);
    const clock = await post('/test_helpers/test_clocks', { frozen_time: now, name: 'ace-replay' });
    console.log('test clock', clock.id, 'frozen at', now);

    const customer = await post('/customers', { email: `replay-${Date.now()}@example.com`, name: 'Replay', test_clock: clock.id });

    // Attach a working test card so auto-charge subscriptions can pay.
    const pm = await post('/payment_methods', { type: 'card', 'card[token]': 'tok_visa' });
    await post('/payment_methods/' + pm.id + '/attach', { customer: customer.id });
    await post('/customers/' + customer.id, { 'invoice_settings[default_payment_method]': pm.id });

    // Reusable installment product + $1,250/mo price.
    const product = await post('/products', { name: 'ACE Installment (replay)', 'metadata[ace_kind]': 'installment' });
    const price = await post('/prices', { product: product.id, currency: 'usd', unit_amount: 125000, 'recurring[interval]': 'month', 'recurring[interval_count]': 1 });

    // Subscription SCHEDULE: starts "now" on the clock so it activates on first
    // advance → emits subscription_schedule.updated + the subscription's
    // invoice.paid (installment) + customer.subscription.updated.
    const schedule = await post('/subscription_schedules', {
        customer: customer.id,
        start_date: now,
        end_behavior: 'cancel',
        'phases[0][items][0][price]': price.id,
        'phases[0][items][0][quantity]': 1,
        'phases[0][duration][interval]': 'month',
        'phases[0][duration][interval_count]': 36,
        'phases[0][metadata][planId]': 'replay_plan',
        'phases[0][metadata][kind]': 'installment',
        'metadata[planId]': 'replay_plan',
        'metadata[kind]': 'installment',
    });
    console.log('schedule', schedule.id);

    // A send_invoice DOWN-PAYMENT invoice with our metadata, finalized then paid
    // out-of-band (pay with the test card) → invoice.paid carrying metadata.
    await post('/invoiceitems', { customer: customer.id, amount: 250000, currency: 'usd', description: 'ACE down payment (replay)' });
    const dpInvoice = await post('/invoices', {
        customer: customer.id,
        collection_method: 'send_invoice',
        due_date: now + 15 * 24 * 3600,
        'metadata[kind]': 'down_payment',
        'metadata[planId]': 'replay_plan',
        'metadata[planItemId]': 'replay_item_dp',
    });
    await post('/invoices/' + dpInvoice.id + '/finalize', {});
    try {
        await post('/invoices/' + dpInvoice.id + '/pay', { payment_method: pm.id });
    } catch (e) {
        if (!/already paid/i.test(e.message)) throw e;
        console.log('down-payment invoice already paid (ok) — invoice.paid still emitted');
    }

    // A second subscription that WILL FAIL its auto-charge, to produce a real
    // invoice.payment_failed on an auto-charge (charge_automatically) invoice
    // whose due_date is null (exercises resolveGraceAnchor's line-level path).
    const failCustomer = await post('/customers', { email: `replay-fail-${Date.now()}@example.com`, test_clock: clock.id });
    const failPm = await post('/payment_methods', { type: 'card', 'card[token]': 'tok_chargeCustomerFail' });
    await post('/payment_methods/' + failPm.id + '/attach', { customer: failCustomer.id });
    await post('/customers/' + failCustomer.id, { 'invoice_settings[default_payment_method]': failPm.id });
    const failSub = await post('/subscriptions', {
        customer: failCustomer.id,
        'items[0][price]': price.id,
        'metadata[planId]': 'replay_fail_plan',
    });
    console.log('failing subscription', failSub.id);

    // Advance the clock ~1 cycle so the schedule activates, invoices generate,
    // the good card pays and the bad card fails.
    await post('/test_helpers/test_clocks/' + clock.id + '/advance', { frozen_time: now + 2 * 24 * 3600 });
    await waitClock(clock.id);
    // Advance again a full cycle to force the failing subscription's renewal charge.
    await post('/test_helpers/test_clocks/' + clock.id + '/advance', { frozen_time: now + 40 * 24 * 3600 });
    await waitClock(clock.id);

    // Collect the real event bodies.
    const want = ['invoice.paid', 'invoice.payment_failed', 'subscription_schedule.updated', 'subscription_schedule.released', 'customer.subscription.updated'];
    const fixtures = {};
    let page = await get('/events?limit=100');
    const all = [...(page.data || [])];
    // paginate a bit for completeness
    for (let i = 0; i < 3 && page.has_more; i++) {
        page = await get('/events?limit=100&starting_after=' + all[all.length - 1].id);
        all.push(...(page.data || []));
    }
    // Prefer the installment invoice.paid (has a subscription) over any other.
    for (const e of all) {
        const o = e.data?.object || {};
        if (e.type === 'invoice.paid') {
            // keep the down-payment one that carries our metadata, and also an installment one
            if (o.metadata?.kind === 'down_payment') fixtures['invoice.paid.down_payment'] = e;
            else if (!fixtures['invoice.paid'] && (o.subscription || o.parent || o.lines)) fixtures['invoice.paid'] = e;
        } else if (want.includes(e.type) && !fixtures[e.type]) {
            fixtures[e.type] = e;
        }
    }

    await writeFile(new URL('./captured-events.json', import.meta.url), JSON.stringify(fixtures, null, 2));
    console.log('captured event types:', Object.keys(fixtures).join(', '));
}

main().catch((e) => { console.error('replay-capture failed:', e.message); process.exit(1); });
