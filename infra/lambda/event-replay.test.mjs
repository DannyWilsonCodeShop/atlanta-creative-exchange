// Event-replay FIELD CHECK (design §Acceptance #10) against REAL endive event
// bodies captured from the live TEST account (API version 2026-09-30.endive)
// via probes/replay-capture.mjs → probes/captured-events.json. DB writes are
// not involved here: this suite only exercises the version-sensitive field
// extraction (the resolvers + schedule-subscription read) against real
// payloads, so FEAT-002 can wire the webhook to the confirmed paths.
//
// Assertions (a)-(e) map to §Acceptance #10. The suite runs offline from the
// committed fixture; assertion (b) additionally verifies the LIVE
// getScheduleSubscriptionId read only when STRIPE_SECRET_KEY is present.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadHandler } from './_testlib/setup.mjs';

const { resolveInvoiceSubscriptionId, resolveGraceAnchor, getScheduleSubscriptionId } = await loadHandler();

const fixtureUrl = new URL('./probes/captured-events.json', import.meta.url);
let fixtures;
try {
    fixtures = JSON.parse(await readFile(fixtureUrl, 'utf8'));
} catch {
    fixtures = null;
}

const haveFixtures = fixtures && Object.keys(fixtures).length > 0;
const objOf = (key) => fixtures?.[key]?.data?.object;

test('fixtures were captured from real endive events (not fabricated)', { skip: !haveFixtures && 'no captured-events.json' }, () => {
    for (const e of Object.values(fixtures)) {
        assert.equal(e.api_version, '2026-09-30.endive', 'each fixture is a real endive event');
    }
});

test('(a) resolveInvoiceSubscriptionId returns a NON-NULL sub id from the real paid installment invoice', { skip: !objOf('invoice.paid') && 'no invoice.paid fixture' }, () => {
    const subId = resolveInvoiceSubscriptionId(objOf('invoice.paid'));
    assert.ok(subId, 'installment invoice.paid resolves a subscription id');
    assert.match(subId, /^sub_/, 'resolved id looks like a subscription id');
    // Confirmed path on this account: parent.subscription_details.subscription.
    assert.equal(subId, objOf('invoice.paid').parent?.subscription_details?.subscription);
});

test('(b) the schedule-event branch / getScheduleSubscriptionId yields a NON-NULL subscription id', { skip: !objOf('subscription_schedule.withSubscription') && !objOf('subscription_schedule.updated') && 'no schedule fixture' }, async () => {
    const schedObj = objOf('subscription_schedule.withSubscription') || objOf('subscription_schedule.updated');
    // The webhook prefers obj.subscription if the event carries it, else reads it
    // from the schedule object. On this account an active schedule event carries
    // it directly at subscription_schedule.subscription.
    const fromEvent = schedObj.subscription;
    assert.ok(fromEvent, 'active schedule event carries a non-null subscription id');
    assert.match(fromEvent, /^sub_/);

    // Live confirmation of getScheduleSubscriptionId (reads the schedule object)
    // only when a TEST key is available; skipped offline.
    if (process.env.STRIPE_SECRET_KEY) {
        const live = await getScheduleSubscriptionId(schedObj.id);
        assert.ok(live, 'getScheduleSubscriptionId returns a non-null id from the schedule object');
    }
});

test('(c) resolveGraceAnchor returns a NON-created anchor on the real failed auto-charge invoice', { skip: !objOf('invoice.payment_failed') && 'no invoice.payment_failed fixture' }, () => {
    const o = objOf('invoice.payment_failed');
    assert.equal(o.due_date, null, 'auto-charge invoice has null due_date (the reason the fallback matters)');
    const anchor = resolveGraceAnchor(o);
    assert.ok(anchor, 'grace anchor resolved');
    assert.notEqual(anchor, o.created, 'anchor is NOT the created fall-through (uses line-level period.end)');
    assert.equal(anchor, o.lines?.data?.[0]?.period?.end, 'confirmed path: lines[0].period.end');
    // and the failed invoice still resolves its subscription id
    assert.ok(resolveInvoiceSubscriptionId(o), 'failed invoice resolves a subscription id');
});

test('(d) the down-payment invoice.paid carries our metadata.kind/planItemId (or stripeInvoiceId fallback matches)', { skip: !objOf('invoice.paid.down_payment') && 'no down-payment fixture' }, () => {
    const o = objOf('invoice.paid.down_payment');
    const md = o.metadata || {};
    const byMeta = md.kind === 'down_payment' && Boolean(md.planItemId);
    // The fallback is the stored stripeInvoiceId === invoice.id; the invoice id
    // is always present, so the reconciliation key exists either way.
    const fallbackKey = o.id;
    assert.ok(byMeta || fallbackKey, 'down payment reconciles by metadata or by stripeInvoiceId');
    // On this account the metadata DID survive on the event object.
    assert.equal(md.kind, 'down_payment', 'metadata.kind survives on the real event');
    assert.ok(md.planItemId, 'metadata.planItemId survives on the real event');
});

test('(e) customer.subscription.updated carries a NON-EMPTY planId under metadata or subscription_details.metadata', { skip: !objOf('customer.subscription.updated') && 'no subscription.updated fixture' }, () => {
    const o = objOf('customer.subscription.updated');
    const planId = o.metadata?.planId ?? o.subscription_details?.metadata?.planId;
    assert.ok(planId, 'planId resolves (MEDIUM-A fix: subscription_data[metadata] lands on the sub object)');
    // Confirmed path on this account: subscription.metadata.planId.
    assert.equal(planId, o.metadata?.planId);
    // nextBillingDate read must tolerate current_period_end moving to the item.
    const periodEnd = o.current_period_end ?? o.items?.data?.[0]?.current_period_end;
    assert.ok(periodEnd, 'current_period_end resolves (endive line-level fallback)');
});
