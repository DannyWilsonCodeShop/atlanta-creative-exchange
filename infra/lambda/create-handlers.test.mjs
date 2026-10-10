// Create-handler suite (design §B1 / §B2 / §Acceptance #4b / §Testability).
// create-plan-invoice call ordering; installment-schedule product/Price reuse
// (NIT-2) and the schedule shape (referenced price, iterations=36,
// end_behavior=cancel); input validation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, installFetchMock, parseForm } from './_testlib/setup.mjs';

const { handleCreatePlanInvoice, handleCreateSubscriptionSchedule } = await loadHandler();

process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_for_unit_tests';
const headers = { 'Content-Type': 'application/json' };

test('handleCreatePlanInvoice: invoiceitem -> invoice(send_invoice,due_date,metadata) -> finalize, in order', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_1' }] } };
        if (call.url.endsWith('/v1/invoiceitems')) return { json: { id: 'ii_1' } };
        if (call.url.endsWith('/v1/invoices')) return { json: { id: 'in_1' } };
        if (call.url.includes('/v1/invoices/in_1/finalize')) return { json: { id: 'in_1', status: 'open', hosted_invoice_url: 'https://pay/x' } };
        return { json: {} };
    });
    try {
        const res = await handleCreatePlanInvoice({
            planId: 'plan_1', planItemId: 'item_1', amount: 2500, dueDate: '2026-10-21', clientEmail: 'a@b.com',
        }, headers);
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.deepEqual(body, { invoiceId: 'in_1', hostedInvoiceUrl: 'https://pay/x', status: 'open' });

        const urls = fetchMock.calls.map((c) => c.url);
        const iItem = urls.findIndex((u) => u.endsWith('/v1/invoiceitems'));
        const iInv = urls.findIndex((u) => u.endsWith('/v1/invoices'));
        const iFin = urls.findIndex((u) => u.includes('/finalize'));
        assert.ok(iItem >= 0 && iInv > iItem && iFin > iInv, 'ordered invoiceitem -> invoice -> finalize');

        const itemForm = parseForm(fetchMock.calls[iItem].body);
        assert.equal(itemForm.amount, '250000', 'dollars -> cents');
        assert.equal(itemForm.customer, 'cus_1');

        const invForm = parseForm(fetchMock.calls[iInv].body);
        assert.equal(invForm.collection_method, 'send_invoice');
        assert.equal(invForm['metadata[kind]'], 'down_payment');
        assert.equal(invForm['metadata[planId]'], 'plan_1');
        assert.equal(invForm['metadata[planItemId]'], 'item_1');
        assert.equal(invForm.due_date, String(Math.floor(Date.parse('2026-10-21') / 1000)));
    } finally {
        fetchMock.restore();
    }
});

test('handleCreatePlanInvoice: validation 400s', async () => {
    for (const [body, label] of [
        [{ planId: 'p', amount: 0, dueDate: '2026-10-21', clientEmail: 'a@b.com' }, 'amount<=0'],
        [{ planId: 'p', amount: 10, dueDate: 'not-a-date', clientEmail: 'a@b.com' }, 'bad dueDate'],
        [{ amount: 10, dueDate: '2026-10-21', clientEmail: 'a@b.com' }, 'missing planId'],
        [{ planId: 'p', amount: 10, dueDate: '2026-10-21' }, 'missing clientEmail'],
    ]) {
        const res = await handleCreatePlanInvoice(body, headers);
        assert.equal(res.statusCode, 400, label);
    }
});

test('handleCreateSubscriptionSchedule: references price, duration month×36, end_behavior=cancel; creates Price when none exists', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_1' }] } };
        if (call.url.includes('/v1/products/search')) return { json: { data: [{ id: 'prod_installment' }] } };
        if (call.url.includes('/v1/prices?product=')) return { json: { data: [] } };
        if (call.url.endsWith('/v1/prices')) return { json: { id: 'price_new' } };
        if (call.url.endsWith('/v1/subscription_schedules')) return { json: { id: 'sub_sched_1' } };
        return { json: {} };
    });
    try {
        const res = await handleCreateSubscriptionSchedule({
            planId: 'plan_1', amount: 1250, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com',
        }, headers);
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).scheduleId, 'sub_sched_1');

        const schedCall = fetchMock.calls.find((c) => c.url.endsWith('/v1/subscription_schedules'));
        const form = parseForm(schedCall.body);
        assert.equal(form['phases[0][items][0][price]'], 'price_new', 'references a Price (not price_data)');
        // endive removed phase `iterations`; finite length is a monthly duration of `count`.
        assert.equal(form['phases[0][duration][interval]'], 'month');
        assert.equal(form['phases[0][duration][interval_count]'], '36');
        assert.equal(form.end_behavior, 'cancel');
        assert.equal(form.start_date, String(Math.floor(Date.parse('2026-12-01') / 1000)));
        assert.equal(form['metadata[planId]'], 'plan_1');
        assert.ok(!schedCall.body.includes('price_data'), 'does not use inline price_data for the primary path');

        const priceCreate = fetchMock.calls.find((c) => c.url.endsWith('/v1/prices') && c.method === 'POST');
        const pf = parseForm(priceCreate.body);
        assert.equal(pf.unit_amount, '125000');
        assert.equal(pf['recurring[interval]'], 'month');
    } finally {
        fetchMock.restore();
    }
});

test('handleCreateSubscriptionSchedule: reuses an existing matching Price (NIT-2 — no second POST /prices)', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_1' }] } };
        if (call.url.includes('/v1/products/search')) return { json: { data: [{ id: 'prod_installment' }] } };
        if (call.url.includes('/v1/prices?product=')) {
            return { json: { data: [{ id: 'price_existing', unit_amount: 125000, recurring: { interval: 'month', interval_count: 1 } }] } };
        }
        if (call.url.endsWith('/v1/subscription_schedules')) return { json: { id: 'sub_sched_2' } };
        return { json: {} };
    });
    try {
        const res = await handleCreateSubscriptionSchedule({
            planId: 'plan_2', amount: 1250, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com',
        }, headers);
        assert.equal(res.statusCode, 200);

        const priceCreates = fetchMock.calls.filter((c) => c.url.endsWith('/v1/prices') && c.method === 'POST');
        assert.equal(priceCreates.length, 0, 'reuses existing Price — no POST /prices');

        const schedCall = fetchMock.calls.find((c) => c.url.endsWith('/v1/subscription_schedules'));
        assert.equal(parseForm(schedCall.body)['phases[0][items][0][price]'], 'price_existing');
    } finally {
        fetchMock.restore();
    }
});

test('handleCreateSubscriptionSchedule: uses ACE_INSTALLMENT_PRODUCT_ID when set (no product search/create)', async () => {
    process.env.ACE_INSTALLMENT_PRODUCT_ID = 'prod_env';
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_1' }] } };
        if (call.url.includes('/v1/prices?product=prod_env')) return { json: { data: [] } };
        if (call.url.endsWith('/v1/prices')) return { json: { id: 'price_env' } };
        if (call.url.endsWith('/v1/subscription_schedules')) return { json: { id: 'sub_sched_3' } };
        return { json: {} };
    });
    try {
        const res = await handleCreateSubscriptionSchedule({
            planId: 'plan_3', amount: 1250, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com',
        }, headers);
        assert.equal(res.statusCode, 200);
        assert.ok(!fetchMock.calls.some((c) => c.url.includes('/v1/products')), 'no product search/create when env id set');
    } finally {
        fetchMock.restore();
        delete process.env.ACE_INSTALLMENT_PRODUCT_ID;
    }
});

test('handleCreateSubscriptionSchedule: validation 400s', async () => {
    for (const [body, label] of [
        [{ planId: 'p', amount: 0, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com' }, 'amount<=0'],
        [{ planId: 'p', amount: 10, count: 0, startDate: '2026-12-01', clientEmail: 'a@b.com' }, 'count<1'],
        [{ planId: 'p', amount: 10, count: 36, startDate: 'nope', clientEmail: 'a@b.com' }, 'bad startDate'],
        [{ planId: 'p', amount: 10, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com', anchorDay: 31 }, 'anchorDay>28'],
        [{ amount: 10, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com' }, 'missing planId'],
        [{ planId: 'p', amount: 10, count: 36, startDate: '2026-12-01' }, 'missing clientEmail'],
    ]) {
        const res = await handleCreateSubscriptionSchedule(body, headers);
        assert.equal(res.statusCode, 400, label);
    }
});
