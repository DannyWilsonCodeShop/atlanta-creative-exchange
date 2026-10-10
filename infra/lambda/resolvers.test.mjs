// Resolver + ensureStripeCustomer suite (design §B0 / §Acceptance #3 /
// §Testability). Pure resolvers plus the mocked-fetch customer dedup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadHandler, installFetchMock, parseForm } from './_testlib/setup.mjs';

const { resolveInvoiceSubscriptionId, resolveGraceAnchor, ensureStripeCustomer } = await loadHandler();

process.env.STRIPE_SECRET_KEY ||= 'sk_test_dummy_for_unit_tests';

test('resolveInvoiceSubscriptionId returns the id from each candidate location in turn', () => {
    assert.equal(resolveInvoiceSubscriptionId({ subscription: 'sub_top' }), 'sub_top');
    assert.equal(resolveInvoiceSubscriptionId({ parent: { subscription_details: { subscription: 'sub_parent' } } }), 'sub_parent');
    assert.equal(resolveInvoiceSubscriptionId({ subscription_details: { subscription: 'sub_sd' } }), 'sub_sd');
    assert.equal(resolveInvoiceSubscriptionId({ lines: { data: [{ subscription: 'sub_line' }] } }), 'sub_line');
    assert.equal(
        resolveInvoiceSubscriptionId({ lines: { data: [{ parent: { subscription_item_details: { subscription: 'sub_item' } } }] } }),
        'sub_item',
    );
});

test('resolveInvoiceSubscriptionId prefers earlier candidates over later ones', () => {
    const obj = {
        subscription: 'sub_top',
        subscription_details: { subscription: 'sub_sd' },
        lines: { data: [{ subscription: 'sub_line' }] },
    };
    assert.equal(resolveInvoiceSubscriptionId(obj), 'sub_top');
});

test('resolveInvoiceSubscriptionId returns undefined when none present', () => {
    assert.equal(resolveInvoiceSubscriptionId({}), undefined);
    assert.equal(resolveInvoiceSubscriptionId({ lines: { data: [{}] } }), undefined);
});

test('resolveGraceAnchor picks due_date, then line period.end, then period_end, then created', () => {
    assert.equal(resolveGraceAnchor({ due_date: 111, lines: { data: [{ period: { end: 222 } }] }, period_end: 333, created: 444 }), 111);
    assert.equal(resolveGraceAnchor({ lines: { data: [{ period: { end: 222 } }] }, period_end: 333, created: 444 }), 222);
    assert.equal(resolveGraceAnchor({ period_end: 333, created: 444 }), 333);
});

test('resolveGraceAnchor falls through to created and warns', () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    try {
        assert.equal(resolveGraceAnchor({ id: 'in_x', created: 444 }), 444);
    } finally {
        console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => w.includes('grace anchor fell through to invoice.created')), 'logs on created fall-through');
});

test('ensureStripeCustomer: exactly one match uses it (no POST)', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_one' }] } };
        return { json: {} };
    });
    try {
        const id = await ensureStripeCustomer('a@b.com');
        assert.equal(id, 'cus_one');
        assert.equal(fetchMock.calls.length, 1, 'only the GET lookup, no create');
        assert.equal(fetchMock.calls[0].method, 'GET');
    } finally {
        fetchMock.restore();
    }
});

test('ensureStripeCustomer: multiple matches uses most recent (data[0]) and warns', async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => warnings.push(a.join(' '));
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [{ id: 'cus_recent' }, { id: 'cus_old' }] } };
        return { json: {} };
    });
    try {
        const id = await ensureStripeCustomer('a@b.com');
        assert.equal(id, 'cus_recent');
        assert.equal(fetchMock.calls.length, 1, 'no create on multi-match');
    } finally {
        fetchMock.restore();
        console.warn = origWarn;
    }
    assert.ok(warnings.some((w) => w.includes('Multiple Stripe customers')), 'warns on multi-match');
});

test('ensureStripeCustomer: zero matches creates (with name when available)', async () => {
    const fetchMock = installFetchMock((call) => {
        if (call.url.includes('/v1/customers?email=')) return { json: { data: [] } };
        if (call.url.endsWith('/v1/customers')) return { json: { id: 'cus_created' } };
        return { json: {} };
    });
    try {
        const id = await ensureStripeCustomer('new@b.com', 'New Client');
        assert.equal(id, 'cus_created');
        assert.equal(fetchMock.calls.length, 2, 'GET lookup then POST create');
        const createCall = fetchMock.calls[1];
        assert.equal(createCall.method, 'POST');
        const form = parseForm(createCall.body);
        assert.equal(form.email, 'new@b.com');
        assert.equal(form.name, 'New Client');
    } finally {
        fetchMock.restore();
    }
});
