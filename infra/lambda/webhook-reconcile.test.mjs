// Webhook reconciliation suite (design §B4 / §B5 / §Acceptance #5-#11).
// Exercises handleStripeWebhook's new switch branches against a mocked
// DynamoDB DocumentClient (makeDocClientMock) and mocked fetch (for the
// stripeGet back-reconcile / schedule-subscription reads). Covers:
//   - env-unset no-op (write skipped, still 200)
//   - installment reconciliation: counter, minimumMet@12, completed@36 (pinned
//     predicate), never-complete when installmentCount===0, idempotent redelivery
//   - metadata-less down-payment stripeInvoiceId fallback (early return)
//   - 15-day grace default (down payment via due_date, installment via period.end)
//   - subscription_schedule linkage (subscription id ABSENT on the event) +
//     reversed-order back-reconcile with no double count
//   - maintenance planId fallback (subscription_details.metadata)
//
// IMPORTANT: the two table env vars are read at module load (const), so they
// MUST be set BEFORE loadHandler() imports quoteHandler.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_for_unit_tests';

const headers = { 'Content-Type': 'application/json' };

// ---- (A) env-UNSET no-op suite: load with the table vars absent -----------
// This import graph is separate per test file (node --test runs each file in
// its own process), so we assert the unset behavior first, then set the vars
// and load a SECOND copy via a query-string cache-bust for the set-behavior
// suites.
delete process.env.ACE_PAYMENTPLAN_TABLE;
delete process.env.ACE_PAYMENTPLANITEM_TABLE;

const { installFetchMock, makeDocClientMock } = await import('./_testlib/setup.mjs');
const unsetH = await import('./_testlib/setup.mjs').then((m) => m.loadHandler());

function webhookEvent(type, object) {
    return {
        rawPath: '/stripe/webhook',
        requestContext: { http: { method: 'POST', path: '/stripe/webhook' } },
        httpMethod: 'POST',
        body: JSON.stringify({ type, data: { object } }),
        headers: {},
    };
}

test('(§Acceptance #7) env-unset: a plan invoice.paid logs a warning, performs NO write, and still returns 200', async () => {
    const prevSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const db = makeDocClientMock({});
    unsetH.__setDocClientForTests(db.client);
    try {
        const res = await unsetH.handleStripeWebhook(webhookEvent('invoice.paid', {
            id: 'in_dp', metadata: { kind: 'down_payment', planId: 'p1', planItemId: 'pi1' },
            amount_paid: 250000,
        }), headers);
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).received, true);
        assert.equal(db.calls.length, 0, 'no DynamoDB calls when the table vars are unset');
    } finally {
        unsetH.__setDocClientForTests(null);
        if (prevSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = prevSecret;
    }
});

// ---- (B) env-SET suites: load a fresh module copy with the vars present ----
process.env.ACE_PAYMENTPLAN_TABLE = 'PlanTable';
process.env.ACE_PAYMENTPLANITEM_TABLE = 'ItemTable';
delete process.env.STRIPE_WEBHOOK_SECRET; // test-mode: parse without verification

// Cache-bust so the const table reads pick up the now-set env.
const H = await import('./quoteHandler.mjs?set=1');

async function runWebhook(type, object, db) {
    H.__setDocClientForTests(db.client);
    try {
        return await H.handleStripeWebhook(webhookEvent(type, object), headers);
    } finally {
        H.__setDocClientForTests(null);
    }
}

test('(§Acceptance #5) installment invoice.paid: increments counter, minimumMet at 12, completed at 36 (pinned predicate), idempotent, no maintenance Invoice row', async () => {
    // Plan at 11/36 paid, minimum 12. The 12th paid installment flips minimumMet.
    const plan = {
        id: 'plan_inst', stripeSubscriptionId: 'sub_x',
        installmentCount: 36, installmentsPaidCount: 11, minimumPaymentsOwed: 12,
        minimumMet: false, status: 'active',
    };
    const db = makeDocClientMock({ PlanTable: [plan], ItemTable: [] });
    const invObj = {
        id: 'in_12',
        parent: { subscription_details: { subscription: 'sub_x' } }, // endive path
        amount_paid: 125000, payment_intent: 'pi_12',
    };
    const res = await runWebhook('invoice.paid', invObj, db);
    assert.equal(res.statusCode, 200);
    const after = db.get('PlanTable', 'plan_inst');
    assert.equal(after.installmentsPaidCount, 12, 'counter incremented 11 -> 12');
    assert.equal(after.minimumMet, true, 'minimumMet set at 12');
    assert.notEqual(after.status, 'completed', 'not complete at 12/36');
    // No maintenance Invoice row minted (the Invoice table is ACE_INVOICE_TABLE,
    // never touched here — the plan path early-returns).
    assert.ok(!db.calls.some((c) => c.Item && c.Item.kind === 'maintenance'),
        'no kind:maintenance Invoice row created');

    // idempotent redelivery of the SAME invoice does not double-count.
    const res2 = await runWebhook('invoice.paid', invObj, db);
    assert.equal(res2.statusCode, 200);
    assert.equal(db.get('PlanTable', 'plan_inst').installmentsPaidCount, 12, 'redelivery does not double-count');
});

test('(§Acceptance #5) completed fires ONLY at installmentCount (36), not on the first paid when installmentCount===0', async () => {
    // 35/36 -> paying the 36th completes.
    const plan36 = {
        id: 'p36', stripeSubscriptionId: 'sub_36',
        installmentCount: 36, installmentsPaidCount: 35, minimumPaymentsOwed: 12, minimumMet: true, status: 'active',
    };
    const db1 = makeDocClientMock({ PlanTable: [plan36], ItemTable: [] });
    await runWebhook('invoice.paid', {
        id: 'in_36', parent: { subscription_details: { subscription: 'sub_36' } }, amount_paid: 125000,
    }, db1);
    assert.equal(db1.get('PlanTable', 'p36').installmentsPaidCount, 36);
    assert.equal(db1.get('PlanTable', 'p36').status, 'completed', 'completed at 36/36');

    // installmentCount === 0 (not configured) must NEVER complete on first paid.
    const plan0 = {
        id: 'p0', stripeSubscriptionId: 'sub_0',
        installmentCount: 0, installmentsPaidCount: 0, minimumPaymentsOwed: 0, minimumMet: false, status: 'active',
    };
    const db2 = makeDocClientMock({ PlanTable: [plan0], ItemTable: [] });
    await runWebhook('invoice.paid', {
        id: 'in_0', parent: { subscription_details: { subscription: 'sub_0' } }, amount_paid: 125000,
    }, db2);
    assert.equal(db2.get('PlanTable', 'p0').installmentsPaidCount, 1);
    assert.notEqual(db2.get('PlanTable', 'p0').status, 'completed', 'installmentCount===0 never completes (NIT-4)');
});

test('(§Acceptance #5a) down-payment invoice.paid with metadata ABSENT reconciles via the stripeInvoiceId fallback and early-returns (no maintenance Invoice)', async () => {
    const item = { id: 'pi_dp', planId: 'plan_dp', kind: 'down_payment', stripeInvoiceId: 'in_dp1', status: 'invoiced' };
    const db = makeDocClientMock({ PlanTable: [], ItemTable: [item] });
    const res = await runWebhook('invoice.paid', {
        id: 'in_dp1', // metadata absent
        amount_paid: 250000, payment_intent: 'pi_x',
    }, db);
    assert.equal(res.statusCode, 200);
    const after = db.get('ItemTable', 'pi_dp');
    assert.equal(after.status, 'paid', 'matched by stripeInvoiceId fallback and marked paid');
    assert.ok(!db.calls.some((c) => c.Item && c.Item.kind === 'maintenance'), 'no maintenance Invoice minted');
});

test('(§Acceptance #6) down-payment payment_failed past 15 days (due_date) flags default; installment past 15 days (period.end) flags default', async () => {
    const old = Math.floor(Date.now() / 1000) - 16 * 24 * 3600;

    // Down payment: anchored by due_date.
    const dpItem = { id: 'pi_f', planId: 'plan_f', kind: 'down_payment', stripeInvoiceId: 'in_f', status: 'invoiced' };
    const dpPlan = { id: 'plan_f', status: 'active', defaulted: false };
    const dbDp = makeDocClientMock({ PlanTable: [dpPlan], ItemTable: [dpItem] });
    await runWebhook('invoice.payment_failed', {
        id: 'in_f', metadata: { kind: 'down_payment', planId: 'plan_f' }, due_date: old,
    }, dbDp);
    assert.equal(dbDp.get('ItemTable', 'pi_f').status, 'failed');
    assert.equal(dbDp.get('PlanTable', 'plan_f').defaulted, true, 'down-payment default flagged');
    assert.equal(dbDp.get('PlanTable', 'plan_f').status, 'defaulted');

    // Installment: due_date null, anchored by lines[0].period.end.
    const instPlan = { id: 'plan_i', stripeSubscriptionId: 'sub_i', status: 'active', defaulted: false };
    const dbInst = makeDocClientMock({ PlanTable: [instPlan], ItemTable: [] });
    await runWebhook('invoice.payment_failed', {
        id: 'in_if', due_date: null,
        parent: { subscription_details: { subscription: 'sub_i' } },
        lines: { data: [{ period: { end: old } }] },
    }, dbInst);
    assert.equal(dbInst.get('PlanTable', 'plan_i').defaulted, true, 'installment default flagged (no revocation)');
});

test('(§Acceptance #11 / MEDIUM-3) subscription_schedule.updated with subscription id ABSENT stamps it via getScheduleSubscriptionId and back-reconciles a pre-delivered installment with no double count', async () => {
    const plan = {
        id: 'plan_s', stripeScheduleId: 'sched_1', // no stripeSubscriptionId yet
        installmentCount: 36, installmentsPaidCount: 0, minimumPaymentsOwed: 12, minimumMet: false, status: 'active',
    };
    const db = makeDocClientMock({ PlanTable: [plan], ItemTable: [] });

    // The schedule event carries NO subscription id; getScheduleSubscriptionId
    // reads it from the schedule object, then backReconcilePaidInstallments
    // lists already-paid invoices for that subscription.
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/subscription_schedules/sched_1')) return { json: { id: 'sched_1', subscription: 'sub_s' } };
        if (call.url.includes('/v1/invoices?subscription=sub_s')) {
            return { json: { data: [{ id: 'in_a', amount_paid: 125000, payment_intent: 'pi_a' }] } };
        }
        return { json: {} };
    });
    try {
        const res = await runWebhook('subscription_schedule.updated', { id: 'sched_1' /* subscription absent */ }, db);
        assert.equal(res.statusCode, 200);
        assert.equal(db.get('PlanTable', 'plan_s').stripeSubscriptionId, 'sub_s', 'stamped via getScheduleSubscriptionId');
        assert.equal(db.get('PlanTable', 'plan_s').installmentsPaidCount, 1, 'pre-delivered paid invoice recovered');
    } finally {
        fetchMock.restore();
    }

    // Now the live invoice.paid for the SAME invoice arrives after linkage — no
    // double count (idempotent).
    const planLinked = db.get('PlanTable', 'plan_s');
    const db2 = makeDocClientMock({
        PlanTable: [planLinked],
        ItemTable: db.items('ItemTable'),
    });
    await runWebhook('invoice.paid', {
        id: 'in_a', parent: { subscription_details: { subscription: 'sub_s' } }, amount_paid: 125000,
    }, db2);
    assert.equal(db2.get('PlanTable', 'plan_s').installmentsPaidCount, 1, 'no double count on reversed order (MEDIUM-3)');
});

test('(§Acceptance #11) subscription_schedule.canceled after all installments paid marks completed; before that appends a note', async () => {
    const donePlan = { id: 'pd', stripeScheduleId: 'sch_d', installmentCount: 36, installmentsPaidCount: 36, status: 'active' };
    const dbDone = makeDocClientMock({ PlanTable: [donePlan], ItemTable: [] });
    await runWebhook('subscription_schedule.canceled', { id: 'sch_d' }, dbDone);
    assert.equal(dbDone.get('PlanTable', 'pd').status, 'completed', 'terminal + all paid => completed');

    const partialPlan = { id: 'pp', stripeScheduleId: 'sch_p', installmentCount: 36, installmentsPaidCount: 10, status: 'active', notes: null };
    const dbPart = makeDocClientMock({ PlanTable: [partialPlan], ItemTable: [] });
    await runWebhook('subscription_schedule.canceled', { id: 'sch_p' }, dbPart);
    assert.notEqual(dbPart.get('PlanTable', 'pp').status, 'completed', 'partial not completed');
    assert.match(dbPart.get('PlanTable', 'pp').notes, /schedule subscription_schedule\.canceled with 10\/36 paid/);
});

test('(§Acceptance #6) maintenance invoice.payment_failed with planId ONLY under subscription_details.metadata still resolves (MEDIUM-A)', async () => {
    // Maintenance path writes to ACE_MAINTENANCE_TABLE which is unset here, so
    // it logs-and-skips; we assert it reaches the maintenance branch (no plan
    // write) and still 200s. The resolution itself is covered by event-replay
    // (e). Here we assert NO PaymentPlan/PaymentPlanItem write happens for a
    // pure-maintenance failed invoice.
    const db = makeDocClientMock({ PlanTable: [], ItemTable: [] });
    const res = await runWebhook('invoice.payment_failed', {
        id: 'in_m', // no down_payment metadata, no subscription id
        subscription_details: { metadata: { planId: 'maint_1' } },
    }, db);
    assert.equal(res.statusCode, 200);
    // No installment/plan rows written (the only Scan is the down-payment
    // fallback lookup, which finds nothing; then it hits the maintenance path).
    assert.ok(!db.calls.some((c) => c.Item || (c.Key && c.UpdateExpression)), 'no plan/item writes for pure maintenance');
});

test('(§Acceptance #? / MEDIUM-A/B) handleStripeSubscription sets subscription_data[metadata][planId] and the trialEnd guard behaves per the pinned predicate', async () => {
    const base = {
        amount: 500, cadence: 'monthly', planId: 'mp_1', clientEmail: 'a@b.com',
        successUrl: 'https://ok', cancelUrl: 'https://no',
    };

    // future trialEnd (>48h) => sets subscription_data[trial_end] + metadata planId.
    let captured;
    let fetchMock = installFetchMock((call) => {
        if (call.url.endsWith('/v1/checkout/sessions')) { captured = call.body; return { json: { url: 'https://sess' } }; }
        return { json: {} };
    });
    try {
        const future = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
        const res = await H.handleStripeSubscription({ ...base, trialEnd: future }, headers);
        assert.equal(res.statusCode, 200);
        const form = Object.fromEntries(new URLSearchParams(captured));
        assert.equal(form['subscription_data[metadata][planId]'], 'mp_1', 'planId lands on the subscription object (MEDIUM-A)');
        assert.equal(form['subscription_data[trial_end]'], String(Math.floor(Date.parse(future) / 1000)), 'future trialEnd set');
    } finally {
        fetchMock.restore();
    }

    // NaN trialEnd => 400.
    const resNaN = await H.handleStripeSubscription({ ...base, trialEnd: 'not-a-date' }, headers);
    assert.equal(resNaN.statusCode, 400);
    assert.equal(JSON.parse(resNaN.body).error, 'invalid trialEnd');

    // near trialEnd (<=48h) => omit trial_end + start now (still 200).
    fetchMock = installFetchMock((call) => {
        if (call.url.endsWith('/v1/checkout/sessions')) { captured = call.body; return { json: { url: 'https://sess2' } }; }
        return { json: {} };
    });
    try {
        const near = new Date(Date.now() + 3600 * 1000).toISOString(); // +1h
        const res = await H.handleStripeSubscription({ ...base, trialEnd: near }, headers);
        assert.equal(res.statusCode, 200);
        const form = Object.fromEntries(new URLSearchParams(captured));
        assert.ok(!('subscription_data[trial_end]' in form), 'near trialEnd omitted — starts now');
    } finally {
        fetchMock.restore();
    }
});

test('(§Acceptance #6) customer.subscription.updated resolves planId under subscription_details.metadata and tolerates item-level current_period_end', async () => {
    // ACE_MAINTENANCE_TABLE unset => updateMaintenancePlanFields logs-and-skips;
    // we only assert the branch runs without error and 200s (the resolution
    // paths are asserted against real fixtures in event-replay (e)).
    const db = makeDocClientMock({ PlanTable: [], ItemTable: [] });
    const res = await runWebhook('customer.subscription.updated', {
        id: 'sub_m',
        subscription_details: { metadata: { planId: 'maint_2' } },
        items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86400 }] },
        status: 'active',
    }, db);
    assert.equal(res.statusCode, 200);
});
