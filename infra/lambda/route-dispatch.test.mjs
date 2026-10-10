// Route-dispatch suite (HIGH-A / HIGH-B, design §Acceptance #4a / §Testability).
// Asserts the substring router sends each /stripe/* path to the right handler,
// that /stripe/installment-schedule is NOT swallowed by handleStripeSubscription,
// and that /stripe/webhook dispatches BEFORE JSON.parse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, installFetchMock, parseForm } from './_testlib/setup.mjs';

const H = await loadHandler();
const { handler } = H;

process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_for_unit_tests';

function evt(path, bodyObj) {
    return {
        rawPath: path,
        requestContext: { http: { method: 'POST', path } },
        httpMethod: 'POST',
        body: JSON.stringify(bodyObj || {}),
        headers: {},
    };
}

test('POST /stripe/installment-schedule reaches handleCreateSubscriptionSchedule and does NOT 400 on missing cadence/successUrl/cancelUrl', async () => {
    // A fully-valid schedule body: customer lookup -> prices lookup -> create.
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_1' }] } };
        if (call.url.includes('/v1/prices?product=')) return { json: { data: [] } };
        if (call.url.endsWith('/v1/prices')) return { json: { id: 'price_new' } };
        if (call.url.endsWith('/v1/subscription_schedules')) return { json: { id: 'sub_sched_123' } };
        if (call.url.endsWith('/v1/products')) return { json: { id: 'prod_1' } };
        if (call.url.includes('/v1/products/search')) return { json: { data: [] } };
        return { json: {} };
    });
    try {
        const res = await handler(evt('/stripe/installment-schedule', {
            planId: 'plan_1', amount: 1250, count: 36, startDate: '2026-12-01', clientEmail: 'a@b.com',
        }));
        assert.equal(res.statusCode, 200, 'schedule route should not 400/500');
        const body = JSON.parse(res.body);
        assert.equal(body.scheduleId, 'sub_sched_123', 'returns scheduleId from handleCreateSubscriptionSchedule');
        // Prove it did NOT go through handleStripeSubscription (which would POST /checkout/sessions).
        assert.ok(!fetchMock.calls.some((c) => c.url.includes('/checkout/sessions')),
            'installment route must not create a Checkout session');
        assert.ok(fetchMock.calls.some((c) => c.url.endsWith('/v1/subscription_schedules')),
            'installment route must create a subscription_schedule');
    } finally {
        fetchMock.restore();
    }
});

test('/stripe/create-plan-invoice reaches handleCreatePlanInvoice', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_1' }] } };
        if (call.url.endsWith('/v1/invoiceitems')) return { json: { id: 'ii_1' } };
        if (call.url.endsWith('/v1/invoices')) return { json: { id: 'in_1' } };
        if (call.url.includes('/v1/invoices/in_1/finalize')) return { json: { id: 'in_1', status: 'open', hosted_invoice_url: 'https://pay/x' } };
        return { json: {} };
    });
    try {
        const res = await handler(evt('/stripe/create-plan-invoice', {
            planId: 'plan_1', amount: 2500, dueDate: '2026-10-21', clientEmail: 'a@b.com',
        }));
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.invoiceId, 'in_1');
        assert.equal(body.hostedInvoiceUrl, 'https://pay/x');
        assert.ok(fetchMock.calls.some((c) => c.url.endsWith('/v1/invoiceitems')), 'reaches invoice-item creation');
    } finally {
        fetchMock.restore();
    }
});

test('/stripe/create-subscription still reaches handleStripeSubscription (unchanged)', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.endsWith('/v1/checkout/sessions')) return { json: { url: 'https://checkout/session' } };
        return { json: {} };
    });
    try {
        const res = await handler(evt('/stripe/create-subscription', {
            amount: 500, cadence: 'monthly', planId: 'mp_1', clientEmail: 'a@b.com',
            successUrl: 'https://ok', cancelUrl: 'https://no',
        }));
        assert.equal(res.statusCode, 200);
        const body = JSON.parse(res.body);
        assert.equal(body.url, 'https://checkout/session');
        const session = parseForm(fetchMock.calls[0].body);
        assert.equal(session.mode, 'subscription', 'maintenance uses a subscription Checkout session');
    } finally {
        fetchMock.restore();
    }
});

test('/stripe/create-checkout reaches handleStripeCheckout', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.endsWith('/v1/checkout/sessions')) return { json: { url: 'https://checkout/oneoff' } };
        return { json: {} };
    });
    try {
        const res = await handler(evt('/stripe/create-checkout', {
            amount: 100, successUrl: 'https://ok', cancelUrl: 'https://no',
        }));
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).url, 'https://checkout/oneoff');
        assert.equal(parseForm(fetchMock.calls[0].body).mode, 'payment');
    } finally {
        fetchMock.restore();
    }
});

test('/stripe/webhook is dispatched BEFORE JSON.parse (raw, non-JSON body does not throw the create path)', async () => {
    // A body that is NOT valid JSON — if the webhook branch ran AFTER JSON.parse,
    // the handler would 500. The webhook branch runs first, so with no signing
    // secret it parses leniently and returns 200 { received: true } (or 400 on
    // bad JSON inside the webhook handler — never the generic 500 create path).
    const prevSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
        const res = await handler({
            rawPath: '/stripe/webhook',
            requestContext: { http: { method: 'POST', path: '/stripe/webhook' } },
            httpMethod: 'POST',
            body: 'not-json-raw-body',
            headers: {},
        });
        // The webhook handler owns the parse; a bad body yields its own 400,
        // proving the generic `const body = JSON.parse(event.body)` never ran.
        assert.equal(res.statusCode, 400);
        assert.equal(JSON.parse(res.body).error, 'Invalid JSON body');
    } finally {
        if (prevSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = prevSecret;
    }
});

test('a valid webhook JSON body is handled before JSON.parse and returns received:true', async () => {
    const prevSecret = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
        const res = await handler({
            rawPath: '/stripe/webhook',
            requestContext: { http: { method: 'POST', path: '/stripe/webhook' } },
            httpMethod: 'POST',
            body: JSON.stringify({ type: 'ping', data: { object: {} } }),
            headers: {},
        });
        assert.equal(res.statusCode, 200);
        assert.equal(JSON.parse(res.body).received, true);
    } finally {
        if (prevSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
        else process.env.STRIPE_WEBHOOK_SECRET = prevSecret;
    }
});
