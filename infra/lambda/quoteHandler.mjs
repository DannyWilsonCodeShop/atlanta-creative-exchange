/**
 * ACE Quote Handler Lambda
 * 1. Saves quote request to DynamoDB
 * 2. Calls Bedrock (Claude) for AI analysis — pricing estimate + tailored questions
 * 3. Sends owner email with full details + AI analysis
 * 4. Sends customer confirmation email
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { PinpointSMSVoiceV2Client, SendTextMessageCommand } from '@aws-sdk/client-pinpoint-sms-voice-v2';
import { CognitoIdentityProviderClient, AdminCreateUserCommand, AdminAddUserToGroupCommand } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import { ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

/**
 * STRIPE INTEGRATION (TEST MODE) — dependency-free design.
 *
 * This Lambda ships with NO node_modules (the stripe SDK is NOT bundled). The
 * Stripe routes below call the Stripe REST API directly with the global `fetch`
 * (Node 20 runtime) and verify webhook signatures with node:crypto HMAC-SHA256.
 * This keeps the deploy zip tiny and matches the existing zero-dependency build.
 *
 * The secret key is read ONLY from process.env.STRIPE_SECRET_KEY — never
 * hardcoded, never logged. Webhook signature verification uses
 * process.env.STRIPE_WEBHOOK_SECRET (a user TODO to set after creating the
 * webhook endpoint in the Stripe dashboard); when absent we parse WITHOUT
 * verification as a TEST-MODE fallback (verification strongly PREFERRED).
 *
 * Webhook DB writes follow the existing AMPLIFY_QUOTE_TABLE direct-DynamoDB
 * approach via the DynamoDBDocumentClient already constructed in this file.
 * TD-4 FIX: invoice-paid transitions UPSERT by stripeInvoiceId (update if the
 * row exists, create only if not) to avoid duplicate Invoice rows.
 */
const STRIPE_API = 'https://api.stripe.com/v1';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const ACE_INVOICE_TABLE = process.env.ACE_INVOICE_TABLE || 'Invoice-7zcql4kvqrbfrax5eqpq3t3hmu-NONE';
const ACE_MAINTENANCE_TABLE = process.env.ACE_MAINTENANCE_TABLE; // undefined when unset → plan writes skipped
// New payment-plan tables (design §B5). Not known until the backend deploy
// creates them (same posture as ACE_MAINTENANCE_TABLE); undefined ⇒ every new
// plan write logs a warning and is skipped (never throws). The read-from-env
// code ships now; setting these vars + the DynamoDB IAM grants is the documented
// post-deploy TODO (§B5) and is NOT performed in this build.
const ACE_PAYMENTPLAN_TABLE = process.env.ACE_PAYMENTPLAN_TABLE;         // undefined ⇒ writes skipped
const ACE_PAYMENTPLANITEM_TABLE = process.env.ACE_PAYMENTPLANITEM_TABLE; // undefined ⇒ writes skipped

/**
 * Encode a (possibly nested/bracketed) flat object as
 * application/x-www-form-urlencoded for the Stripe REST API. Keys are expected
 * to already be in Stripe's bracket notation (e.g. "line_items[0][price_data][currency]").
 */
function stripeForm(obj) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        params.append(k, String(v));
    }
    return params.toString();
}

/**
 * POST to the Stripe REST API. Returns parsed JSON on 2xx, throws on non-2xx
 * logging only Stripe's error message (never the key).
 */
async function stripeRequest(path, params) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
        throw new Error('STRIPE_SECRET_KEY is not set on the Lambda');
    }
    const res = await fetch(`${STRIPE_API}${path}`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: stripeForm(params),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = json?.error?.message || `Stripe request failed (${res.status})`;
        console.error('Stripe API error:', msg);
        throw new Error(msg);
    }
    return json;
}

/**
 * GET from the Stripe REST API. Returns parsed JSON on 2xx, throws on non-2xx
 * logging only Stripe's error message (never the key). Mirrors stripeRequest
 * (same Bearer auth from process.env.STRIPE_SECRET_KEY) but sends no body
 * (design §B0).
 */
async function stripeGet(path) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) {
        throw new Error('STRIPE_SECRET_KEY is not set on the Lambda');
    }
    const res = await fetch(`${STRIPE_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${key}` },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
        const msg = json?.error?.message || `Stripe GET failed (${res.status})`;
        console.error('Stripe API error:', msg);
        throw new Error(msg);
    }
    return json;
}

/**
 * Resolve (find-or-create) a Stripe customer id for an email (design §B0).
 * Used by both the down-payment invoice route (B1) and the installment
 * schedule route (B2). Stripe returns `data` newest-first.
 *   - exactly one match  -> use it
 *   - more than one      -> use the most recent (data[0]) and warn
 *   - none               -> POST /customers (with name when available)
 */
async function ensureStripeCustomer(email, name) {
    const r = await stripeGet('/customers?email=' + encodeURIComponent(email) + '&limit=3');
    const data = r?.data || [];
    if (data.length === 1) {
        return data[0].id;
    }
    if (data.length > 1) {
        console.warn('Multiple Stripe customers for', email, '— using most recent');
        return data[0].id;
    }
    const params = { email };
    if (name) params.name = name;
    const created = await stripeRequest('/customers', params);
    return created.id;
}

/**
 * The subscription id an invoice belongs to, tolerant of API version
 * 2026-09-30.endive relocating the field off the top level onto nested/line/
 * item locations (design §B0, HIGH-1). Returns a string id or undefined.
 *
 * CONFIRMED (FEAT-001 event-replay against real endive events, §Acceptance
 * #10a): on this account `obj.subscription` is UNDEFINED on invoice events; the
 * id lives at **obj.parent.subscription_details.subscription** (2nd candidate).
 * The failed auto-charge invoice also exposes it at
 * lines[0].parent.subscription_item_details.subscription (5th candidate). The
 * full fallback chain is retained regardless (verify-then-rely).
 */
function resolveInvoiceSubscriptionId(obj) {
    return (
        obj.subscription
        ?? obj.parent?.subscription_details?.subscription
        ?? obj.subscription_details?.subscription
        ?? obj.lines?.data?.[0]?.subscription
        ?? obj.lines?.data?.[0]?.parent?.subscription_item_details?.subscription
        ?? undefined
    );
}

/**
 * The unix-seconds anchor for the 15-day grace clock on a failed invoice,
 * tolerant of period_end moving to the line level under endive (design §B0,
 * MEDIUM-1). Logs when it falls through to invoice `created` so the anchor
 * choice is visible.
 *
 * CONFIRMED (FEAT-001 event-replay against a real endive invoice.payment_failed
 * auto-charge event, §Acceptance #10c): `obj.due_date` is NULL on auto-charge
 * installment invoices and the anchor resolves to **lines[0].period.end** (2nd
 * candidate), NOT the `created` fall-through. send_invoice down payments still
 * carry due_date (1st candidate). The fallback chain is retained regardless.
 */
function resolveGraceAnchor(obj) {
    const anchor =
        obj.due_date                               // send_invoice down payments
        ?? obj.lines?.data?.[0]?.period?.end        // endive line-level period end
        ?? obj.period_end                           // pre-endive invoice-level
        ?? obj.created;                             // last resort (invoice creation)
    if (anchor === obj.created) {
        console.warn('grace anchor fell through to invoice.created for', obj.id,
            '— no due_date/period.end present; default clock starts at creation');
    }
    return anchor;
}

/**
 * The released subscription id for a schedule, read directly from the schedule
 * object (design §B2a, HIGH-2). Hits Stripe (not DynamoDB), so it is NOT
 * env-gated. Used by FEAT-002's webhook to stamp PaymentPlan.stripeSubscriptionId
 * without trusting that an event carried the field.
 *
 * CONFIRMED (FEAT-001 probe + event-replay, §Acceptance #10b): the released
 * subscription id lives at **subscription_schedule.subscription**. It is null
 * for a future-start schedule (status not_started) and becomes non-null once a
 * phase activates — so the webhook prefers obj.subscription when the event
 * already carries it, else reads it here.
 */
async function getScheduleSubscriptionId(scheduleId) {
    const sched = await stripeGet('/subscription_schedules/' + scheduleId);
    return sched?.subscription ?? undefined;
}

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE_NAME = process.env.TABLE_NAME || 'ACE-Quotes';
const AMPLIFY_QUOTE_TABLE = process.env.AMPLIFY_QUOTE_TABLE || 'Quote-7zcql4kvqrbfrax5eqpq3t3hmu-NONE';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'wilson.danny@me.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'wilson.danny@me.com';
const REPLY_TO_EMAIL = 'info@atlantacreativeexchange.com';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const dynamoRaw = new DynamoDBClient({ region: REGION });
const dynamo = dynamoRaw;
const docClient = DynamoDBDocumentClient.from(dynamoRaw);

// DynamoDB document client used by the webhook reconciliation helpers (B4/B5).
// `getDocClient()` returns the real client at runtime; `__setDocClientForTests`
// lets the node --test suites inject a recording mock (the aws-sdk stub throws
// on send()). This indirection is inert in the Lambda — AWS invokes `handler`
// and the real `docClient` is always used; the setter is never called at
// runtime. Keeping it isolated to the new plan helpers leaves the existing
// upsertInvoiceByStripeId / updateMaintenancePlanFields behavior untouched.
let _planDocClient = docClient;
function getDocClient() {
    return _planDocClient;
}
function __setDocClientForTests(client) {
    _planDocClient = client || docClient;
}
const ses = new SESClient({ region: REGION });
const sms = new PinpointSMSVoiceV2Client({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const OWNER_PHONE = process.env.OWNER_PHONE || '+14048037330';
const ORIGINATION_NUMBER = '+18552432682';
const USER_POOL_ID = process.env.USER_POOL_ID || 'us-east-1_tWSqSwGLe';

// === PRICING GUIDE (baked in for Bedrock prompt) ===
const PRICING_GUIDE = `
ACE PRICING GUIDE — Atlanta Market (2025-2026)

PA System Only (equipment rental, flat per day — includes delivery, setup, breakdown):
- Small (up to 30 people): $250–$400
- Small-Medium (30–75 people): $400–$700
- Medium (75–200 people): $1,000–$2,000
- Medium-Large (200–500 people): $2,500–$3,500
- Large (500+ people): $3,500–$5,000

DJ Services (flat rate for 4hrs, includes basic PA for the room size):
- Small (up to 30 people): $400–$600
- Small-Medium (30–75 people): $700–$1,200
- Medium (75–200 people): $1,500–$2,500
- Medium-Large (200–500 people): $3,500–$4,500
- Large (500+ people): $4,500–$6,000
- Overtime beyond booked hours: $150–$200/hr

DJ always costs more than PA Only because it includes the performer + the gear.
If a client needs DJ + upgraded PA (bigger system than the basic included), add $300–$800.

Per-item add-ons:
- Wireless microphone: $40–$60/day
- Wired microphone: $15–$25/day
- Monitor speaker: $75–$100/day
- Sound tech (operator on-site, PA Only rentals): $50–$75/hr
- Delivery + setup + breakdown (if not included): $100–$200

Live Bands / Musicians:
- Solo/Duo (acoustic, jazz): $500–$1,200
- Small band (3–5 piece): $1,000–$2,000
- Medium (75–200 people venue): $2,000–$4,000
- Medium-Large (200–500 people venue): $4,000–$6,000
- Large (500+ people venue): $6,000–$10,000

Event Hosting & Crowd Support:
- Event coordination (day-of): $500–$1,000
- MC / Host: $300–$600
- Crowd support staff (per person): $25–$40/hr

Bundle Discounts:
- DJ + PA System upgrade: 15% off combined
- Full package (DJ + PA + Hosting): 20% off
- Repeat client: 10% off

Payment Terms:
- A deposit is required to secure the date
- Remaining balance due within 24 hours of event completion

DIGITAL SERVICES PRICING:
- Landing Page: $500–$1,500
- Multi-Page Website (3-7 pages): $1,500–$5,000
- E-Commerce Site: $3,000–$8,000
- Web Application: $5,000–$15,000+
- Mobile App (iOS/Android): $8,000–$25,000+
- Branding Package: $800–$3,000
- Content Production (per project): $500–$5,000
- Content Editing (per project): $200–$2,000
- Monthly hosting & maintenance: $50–$200/month
- Revisions: 2 rounds included, additional $75/hr
- Rush delivery (under 2 weeks): +25%
- Ongoing support retainer: $300–$800/month
`;

// === MAIN HANDLER ===
export const handler = async (event) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Content-Type': 'application/json'
    };

    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS' || event.requestContext?.http?.method === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }

    try {
        const path = event.rawPath || event.requestContext?.http?.path || '';

        // Route: /stripe/webhook — routed BEFORE JSON.parse so the handler can
        // read the EXACT raw request body (required for HMAC signature
        // verification) and the Stripe-Signature header. Carries no
        // firstName/lastName, so it must run before the spam-name check.
        if (path.includes('/stripe/webhook')) {
            return await handleStripeWebhook(event, headers);
        }

        const body = JSON.parse(event.body);

        // Route: /stripe/* (create endpoints). Routed BEFORE the spam-name check
        // like /notify because Stripe payloads carry no firstName/lastName.
        // Ordered so no earlier includes() check is a substring of a later
        // route's path (design §B router, HIGH-A/HIGH-B).
        // NOTE: the installment route is '/stripe/installment-schedule' (NOT
        // '/stripe/create-subscription-schedule'), so it can never be swallowed
        // by the '/stripe/create-subscription' substring check — HIGH-A.
        if (path.includes('/stripe/installment-schedule')) {        // NEW — subscription SCHEDULE (36×$1,250)
            return await handleCreateSubscriptionSchedule(body, headers);
        }
        if (path.includes('/stripe/create-plan-invoice')) {         // NEW — dated down-payment invoices
            return await handleCreatePlanInvoice(body, headers);
        }
        if (path.includes('/stripe/create-checkout')) {
            return await handleStripeCheckout(body, headers);
        }
        if (path.includes('/stripe/create-subscription')) {
            return await handleStripeSubscription(body, headers);
        }

        // Route: /notify (ace-platform lifecycle notifications: project notes,
        // meetings, demos, contracts). Routed BEFORE spam protection because
        // notification payloads carry no firstName/lastName (which the gibberish
        // check would otherwise reject).
        if (path.includes('/notify')) {
            return await handleNotify(body, headers);
        }

        // --- Spam protection ---
        // Reject if name contains no spaces (real names have first + last)
        // Reject if name is too long or contains no vowels
        // Reject if honeypot field is filled
        if (body.honeypot) {
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, quoteId: 'filtered' }) };
        }
        const fullName = `${body.firstName || ''}${body.lastName || ''}`;
        const hasVowels = /[aeiouAEIOU]/.test(fullName);
        const isGibberish = fullName.length > 20 && !fullName.includes(' ') && !/^[A-Z][a-z]+$/.test(body.firstName || '');
        if (!hasVowels || isGibberish) {
            console.log('Spam filtered:', body.firstName, body.lastName);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, quoteId: 'filtered' }) };
        }

        // Route: /subscribe (email list signup)
        if (path.includes('/subscribe')) {
            return await handleSubscribe(body, headers);
        }

        // Route: /create-user (admin portal user creation)
        if (path.includes('/create-user')) {
            return await handleCreateUser(body, headers);
        }

        // Route: /send-quote (generate and email branded quote to customer)
        if (path.includes('/send-quote')) {
            return await handleSendQuote(body, headers);
        }

        // Route: /quote (default)
        const quoteId = randomUUID();

        // 1. Save to DynamoDB (legacy table)
        await saveQuote(quoteId, body);

        // 2. Call Bedrock for AI analysis
        const aiAnalysis = await analyzeWithBedrock(body);

        // 3. Save to Amplify table (admin portal)
        await saveToAmplifyTable(quoteId, body, aiAnalysis);

        // 4. Send owner email (full details + AI analysis)
        await sendOwnerEmail(quoteId, body, aiAnalysis);

        // 5. Send customer confirmation
        await sendCustomerConfirmation(body);

        // 6. SMS notification to owner
        await sendSmsNotification(body);

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, quoteId })
        };

    } catch (err) {
        console.error('Quote handler error:', err);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};

// === DYNAMODB ===
async function saveQuote(quoteId, data) {
    const item = {
        quoteId: { S: quoteId },
        submittedAt: { S: data.submittedAt || new Date().toISOString() },
        status: { S: 'pending' },
        serviceType: { S: data.serviceType || 'event' },
        customerName: { S: `${data.firstName} ${data.lastName}` },
        customerEmail: { S: data.email },
        customerPhone: { S: data.phone },
        organization: { S: data.organization || '' },
        howHeard: { S: data.howHeard || '' },
        source: { S: data.source || '' }
    };

    if (data.serviceType === 'digital') {
        item.digitalServices = { S: JSON.stringify(data.digitalServices || []) };
        item.projectDescription = { S: data.projectDescription || '' };
        item.hasExisting = { S: data.hasExisting || '' };
        item.existingUrl = { S: data.existingUrl || '' };
        item.pageCount = { S: data.pageCount || '' };
        item.timeline = { S: data.timeline || '' };
        item.features = { S: JSON.stringify(data.features || []) };
        item.designDirection = { S: data.designDirection || '' };
        item.referenceSites = { S: data.referenceSites || '' };
        item.digitalBudget = { S: data.digitalBudget || '' };
        item.ongoingSupport = { S: data.ongoingSupport || '' };
        item.digitalNotes = { S: data.digitalNotes || '' };
    } else {
        item.eventType = { S: data.eventType || '' };
        item.eventDates = { S: JSON.stringify(data.eventDates || []) };
        item.sameServicesAllDates = { S: String(data.sameServicesAllDates || true) };
        item.services = { S: JSON.stringify(data.services || []) };
        item.perDayDetails = { S: JSON.stringify(data.perDayDetails || null) };
        item.genre = { S: data.genre || '' };
        item.speeches = { S: data.speeches || '' };
        item.budget = { S: data.budget || '' };
        item.venueName = { S: data.venueName || '' };
        item.venueAddress = { S: data.venueAddress || '' };
        item.roomName = { S: data.roomName || '' };
        item.floorAccess = { S: data.floorAccess || '' };
        item.indoorOutdoor = { S: data.indoorOutdoor || '' };
        item.roomSize = { S: data.roomSize || '' };
        item.powerAvailability = { S: data.powerAvailability || '' };
        item.loadInTime = { S: data.loadInTime || '' };
        item.micWireless = { S: data.micWireless || '0' };
        item.micWired = { S: data.micWired || '0' };
        item.auxInputs = { S: data.auxInputs || '' };
        item.monitorSpeakers = { S: data.monitorSpeakers || '' };
        item.additionalNotes = { S: data.additionalNotes || '' };
    }

    await dynamo.send(new PutItemCommand({ TableName: TABLE_NAME, Item: item }));
}

// === SAVE TO AMPLIFY TABLE (Admin Portal) ===
async function saveToAmplifyTable(quoteId, data, aiAnalysis) {
    const now = new Date().toISOString();
    const item = {
        id: quoteId,
        __typename: 'Quote',
        serviceType: data.serviceType || 'event',
        status: 'new',
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email,
        phone: data.phone,
        organization: data.organization || null,
        howHeard: data.howHeard || null,
        aiAnalysis: aiAnalysis || null,
        source: data.source || null,
        createdAt: now,
        updatedAt: now,
    };

    if (data.serviceType === 'digital') {
        item.digitalServices = data.digitalServices || [];
        item.projectDescription = data.projectDescription || null;
        item.hasExisting = data.hasExisting || null;
        item.existingUrl = data.existingUrl || null;
        item.pageCount = data.pageCount || null;
        item.timeline = data.timeline || null;
        item.features = data.features || [];
        item.designDirection = data.designDirection || null;
        item.referenceSites = data.referenceSites || null;
        item.digitalBudget = data.digitalBudget || null;
        item.ongoingSupport = data.ongoingSupport || null;
        item.digitalNotes = data.digitalNotes || null;
    } else {
        item.eventType = data.eventType || null;
        item.eventDates = JSON.stringify(data.eventDates || []);
        item.sameServicesAllDates = data.sameServicesAllDates ?? true;
        item.services = data.services || [];
        item.perDayDetails = data.perDayDetails ? JSON.stringify(data.perDayDetails) : null;
        item.genre = data.genre || null;
        item.speeches = data.speeches || null;
        item.budget = data.budget || null;
        item.venueName = data.venueName || null;
        item.venueAddress = data.venueAddress || null;
        item.roomName = data.roomName || null;
        item.floorAccess = data.floorAccess || null;
        item.indoorOutdoor = data.indoorOutdoor || null;
        item.roomSize = data.roomSize || null;
        item.powerAvailability = data.powerAvailability || null;
        item.loadInTime = data.loadInTime || null;
        item.micWireless = data.micWireless || null;
        item.micWired = data.micWired || null;
        item.auxInputs = data.auxInputs || null;
        item.monitorSpeakers = data.monitorSpeakers || null;
        item.additionalNotes = data.additionalNotes || null;
    }

    try {
        await docClient.send(new PutCommand({
            TableName: AMPLIFY_QUOTE_TABLE,
            Item: item,
        }));
    } catch (err) {
        console.error('Failed to save to Amplify table:', err);
        // Don't throw — this is secondary, legacy table is primary
    }
}

// === BEDROCK AI ANALYSIS ===
async function analyzeWithBedrock(data) {
    let eventSummary;
    let promptContext;

    if (data.serviceType === 'digital') {
        eventSummary = `
DIGITAL PROJECT REQUEST:
- Services: ${(data.digitalServices || []).join(', ')}
- Description: ${data.projectDescription || 'Not provided'}
- Existing site/app: ${data.hasExisting || 'Not specified'}
- Existing URL: ${data.existingUrl || 'N/A'}
- Pages/Screens: ${data.pageCount || 'Not specified'}
- Timeline: ${data.timeline || 'Not specified'}
- Features needed: ${(data.features || []).join(', ') || 'None specified'}
- Design direction: ${data.designDirection || 'Not specified'}
- Reference sites: ${data.referenceSites || 'None'}
- Budget: ${data.digitalBudget || 'Not disclosed'}
- Ongoing support: ${data.ongoingSupport || 'Not specified'}
- Additional notes: ${data.digitalNotes || 'None'}

CONTACT:
- Name: ${data.firstName} ${data.lastName}
- Organization: ${data.organization || 'N/A'}
- How they heard about us: ${data.howHeard || 'Not specified'}
`;
        promptContext = `You are the AI sales assistant for Atlanta Creative Exchange (ACE), a creative technology company based in Atlanta, Georgia.

A customer has submitted a digital project request. Provide a CONCISE analysis:

1. **RECOMMENDED QUOTE** (lead with this) — Give a specific dollar range. One line for total, then 2-3 line items max.

2. **KEY QUESTIONS** (3-5 max) — The most important follow-up questions for this project.

3. **QUICK NOTES** — One sentence on complexity and recommended approach.

Keep the entire response under 300 words. Be direct and actionable.

${PRICING_GUIDE}

${eventSummary}

Format your response clearly with headers and bullet points. Be specific with dollar amounts.`;
    } else {
        eventSummary = `
EVENT DETAILS:
- Type: ${data.eventType}
- Dates: ${(data.eventDates || []).map((d, i) => `Day ${i+1}: ${d.date} (${d.startTime} to ${d.endTime})`).join('; ')}
- Number of days: ${(data.eventDates || []).length}
- Same services all dates: ${data.sameServicesAllDates}
- Services Requested: ${(data.services || []).join(', ')}
- Per-day details: ${data.perDayDetails ? JSON.stringify(data.perDayDetails) : 'Same services all days'}
- Genre Preferences: ${data.genre || 'None specified'}
- Speeches/Toasts: ${data.speeches || 'Not specified'}
- Budget: ${data.budget || 'Not disclosed'}

VENUE:
- Name: ${data.venueName}
- Address: ${data.venueAddress}
- Room: ${data.roomName || 'N/A'}
- Floor/Access: ${data.floorAccess || 'Not specified'}
- Indoor/Outdoor: ${data.indoorOutdoor}
- Room Size: ${data.roomSize}
- Power: ${data.powerAvailability || 'Not specified'}
- Load-in Time: ${data.loadInTime || 'Not specified'}

EQUIPMENT:
- Wireless Mics: ${data.micWireless}
- Wired Mics: ${data.micWired}
- Aux/Instrument Inputs: ${data.auxInputs || 'None specified'}
- Monitor Speakers: ${data.monitorSpeakers || 'Not specified'}
- Additional Notes: ${data.additionalNotes || 'None'}

CONTACT:
- Name: ${data.firstName} ${data.lastName}
- Organization: ${data.organization || 'N/A'}
- How they heard about us: ${data.howHeard || 'Not specified'}
`;

        promptContext = `You are the AI sales assistant for Atlanta Creative Exchange (ACE), an audio production, DJ, PA system, live music, and event hosting company based in Atlanta, Georgia.

A customer has submitted a quote request. Provide a CONCISE analysis:

1. **RECOMMENDED QUOTE** (lead with this) — Give a specific dollar range. One line for total, then 2-3 line items max.

2. **KEY QUESTIONS** (3-5 max) — The most important follow-up questions for this specific event.

3. **QUICK NOTES** — One sentence on complexity and any red flags.

Keep the entire response under 300 words. Be direct and actionable.

${PRICING_GUIDE}

${eventSummary}

Format your response clearly with headers and bullet points. Be specific with dollar amounts. This analysis goes directly to the business owner to help them craft the final quote.`;
    }

    const requestBody = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 2000,
        messages: [
            { role: 'user', content: promptContext }
        ]
    };

    try {
        const command = new InvokeModelCommand({
            modelId: BEDROCK_MODEL_ID,
            contentType: 'application/json',
            accept: 'application/json',
            body: JSON.stringify(requestBody)
        });

        const response = await bedrock.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        return responseBody.content[0].text;
    } catch (err) {
        console.error('Bedrock error:', err);
        return 'AI analysis unavailable — Bedrock call failed. Please review the event details manually and refer to the pricing guide.';
    }
}

// === OWNER EMAIL ===
async function sendOwnerEmail(quoteId, data, aiAnalysis) {
    const firstDate = (data.eventDates && data.eventDates[0]) ? data.eventDates[0].date : 'TBD';
    const isDigital = data.serviceType === 'digital';
    const serviceLabel = isDigital
        ? (data.digitalServices || []).join(', ')
        : (data.services || []).join(', ');

    const htmlBody = `
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111; color: #f0f0f0; padding: 32px;">
<div style="max-width: 500px; margin: 0 auto; background: #1e1e1e; border-radius: 12px; padding: 36px; border: 1px solid #333; text-align: center;">

<h1 style="color: #7b2ff7; margin-bottom: 4px; font-size: 22px;">New Quote Request</h1>
<p style="color: #a0a0a0; margin-bottom: 28px; font-size: 14px;">${isDigital ? 'Digital Project' : data.eventType || 'Event'}</p>

<table style="width: 100%; color: #f0f0f0; margin-bottom: 24px; text-align: left; font-size: 14px;">
<tr><td style="color:#a0a0a0;padding:6px 0;">Client:</td><td><strong>${data.firstName} ${data.lastName}</strong></td></tr>
<tr><td style="color:#a0a0a0;padding:6px 0;">Services:</td><td>${serviceLabel}</td></tr>
${!isDigital ? `<tr><td style="color:#a0a0a0;padding:6px 0;">Date:</td><td>${firstDate}</td></tr>` : ''}
<tr><td style="color:#a0a0a0;padding:6px 0;">Budget:</td><td>${data.budget || data.digitalBudget || 'Not disclosed'}</td></tr>
</table>

<a href="http://localhost:3000/quotes/${quoteId}" style="display: inline-block; padding: 14px 32px; background: linear-gradient(135deg, #00b4d8, #7b2ff7, #e91e8c); color: #fff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 14px;">View Full Details in Admin Portal</a>

<p style="color: #a0a0a0; margin-top: 28px; font-size: 12px;">Atlanta Creative Exchange — Quote System</p>
</div>
</body>
</html>`;

    await ses.send(new SendEmailCommand({
        Source: FROM_EMAIL,
        ReplyToAddresses: [REPLY_TO_EMAIL],
        Destination: { ToAddresses: [OWNER_EMAIL] },
        Message: {
            Subject: { Data: `[ACE Quote] ${isDigital ? 'Digital' : data.eventType} — ${data.firstName} ${data.lastName}` },
            Body: { Html: { Data: htmlBody } }
        }
    }));
}

// === CUSTOMER CONFIRMATION EMAIL ===
async function sendCustomerConfirmation(data) {
    const htmlBody = `
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f8f8f8; color: #222; padding: 32px;">
<div style="max-width: 600px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 36px; box-shadow: 0 4px 20px rgba(0,0,0,0.08);">

<img src="https://atlantacreativeexchange.com/Resources/Final%20Drafts-03.png" alt="Atlanta Creative Exchange" style="height: 48px; width: auto; max-width: 200px; margin-bottom: 24px;">

<h1 style="font-size: 24px; color: #111; margin-bottom: 8px;">Thanks, ${data.firstName}!</h1>
<p style="color: #555; font-size: 16px; line-height: 1.6;">We've received your quote request and a member of our sales team will reach out within <strong>24 hours</strong> with a personalized quote or any follow-up questions.</p>

<div style="background: #f0f0f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
<h3 style="font-size: 14px; color: #333; margin-bottom: 12px;">Here's what you submitted:</h3>
${data.serviceType === 'digital' ? `
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>What you need:</strong> ${(data.digitalServices || []).join(', ') || 'Not specified'}</p>
${data.platform ? `<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Platform:</strong> ${data.platform}</p>` : ''}
${data.projectDescription ? `<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Project:</strong> ${data.projectDescription}</p>` : ''}
${data.timeline ? `<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Timeline:</strong> ${data.timeline}</p>` : ''}
` : `
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Event:</strong> ${data.eventType || 'Not specified'}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Date(s):</strong> ${(data.eventDates || []).map(d => d.date).join(', ') || 'TBD'}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Services:</strong> ${(data.services || []).join(', ') || 'Not specified'}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Venue:</strong> ${data.venueName || 'TBD'}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Size:</strong> ${data.roomSize || 'TBD'}</p>
`}
</div>

${data.serviceType === 'digital' ? '' : `<p style="color: #555; font-size: 14px; line-height: 1.6;"><strong>Payment Terms:</strong> A deposit is required to secure your date. The remaining balance is due within 24 hours of event completion. We'll provide full payment details with your quote.</p>`}

<p style="color: #555; font-size: 16px; line-height: 1.6; margin-top: 24px;">If you have questions in the meantime, reply to this email or reach us at <a href="mailto:info@atlantacreativeexchange.com" style="color: #7b2ff7;">info@atlantacreativeexchange.com</a>.</p>

<p style="color: #555; font-size: 16px; margin-top: 24px;">— The ACE Team</p>

<hr style="border: none; border-top: 1px solid #eee; margin: 32px 0;">
<p style="color: #999; font-size: 12px; text-align: center;">Atlanta Creative Exchange | Atlanta, Georgia<br><a href="https://atlantacreativeexchange.com" style="color: #7b2ff7;">atlantacreativeexchange.com</a></p>
</div>
</body>
</html>`;

    await ses.send(new SendEmailCommand({
        Source: FROM_EMAIL,
        ReplyToAddresses: [REPLY_TO_EMAIL],
        Destination: { ToAddresses: [data.email] },
        Message: {
            Subject: { Data: `Your ACE Quote Request — We'll be in touch soon!` },
            Body: { Html: { Data: htmlBody } }
        }
    }));
}

// === UTILS ===
function calculateDuration(start, end) {
    if (!start || !end) return 'Unknown';
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    let mins = (eh * 60 + em) - (sh * 60 + sm);
    if (mins < 0) mins += 24 * 60; // crosses midnight
    const hours = Math.floor(mins / 60);
    const remaining = mins % 60;
    return remaining > 0 ? `${hours}h ${remaining}m` : `${hours} hours`;
}

// === SMS NOTIFICATION ===
async function sendSmsNotification(data) {
    const isDigital = data.serviceType === 'digital';
    const serviceLabel = isDigital
        ? `Digital: ${(data.digitalServices || []).join(', ')}`
        : `Event: ${data.eventType || 'Unknown'}`;

    const message = `New ACE Quote! ${data.firstName} ${data.lastName} - ${serviceLabel}. Budget: ${data.budget || data.digitalBudget || 'N/A'}. Check admin portal.`;

    try {
        await sms.send(new SendTextMessageCommand({
            DestinationPhoneNumber: OWNER_PHONE,
            OriginationIdentity: ORIGINATION_NUMBER,
            MessageBody: message,
        }));
        console.log('SMS sent successfully to', OWNER_PHONE);
    } catch (err) {
        console.error('SMS notification failed:', err);
    }
}

// === CREATE USER (Portal Account) ===
async function handleCreateUser(data, headers) {
    const { action, email, name, phone, role } = data;
    const group = action === 'createCustomer' ? 'customer' : (role || 'crew');

    if (!email || !name) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email and name required' }) };
    }

    try {
        await cognito.send(new AdminCreateUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: email,
            UserAttributes: [
                { Name: 'email', Value: email },
                { Name: 'email_verified', Value: 'true' },
                { Name: 'name', Value: name },
                ...(phone ? [{ Name: 'phone_number', Value: phone }] : []),
            ],
            DesiredDeliveryMediums: ['EMAIL'],
        }));

        await cognito.send(new AdminAddUserToGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: email,
            GroupName: group,
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: `Account created for ${email}. Welcome email sent with temporary password.`,
            }),
        };
    } catch (err) {
        if (err.name === 'UsernameExistsException') {
            // User exists — just add to group
            try {
                await cognito.send(new AdminAddUserToGroupCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: email,
                    GroupName: group,
                }));
                return {
                    statusCode: 200,
                    headers,
                    body: JSON.stringify({ success: true, message: `User already exists. Added to ${group} group.` }),
                };
            } catch (groupErr) {
                return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to add user to group' }) };
            }
        }
        console.error('Create user error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Failed to create user' }) };
    }
}

// === SEND QUOTE (Generate branded quote and email to customer) ===
async function handleSendQuote(data, headers) {
    const { quoteId, clientName, clientEmail, eventType, eventDates, services, venueName,
            roomSize, lineItems, subtotal, discount, discountReason, total,
            depositRequired, notes, validUntil } = data;

    if (!clientEmail || !lineItems || !total) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const dateDisplay = (eventDates || []).map((d, i) => 
        `<tr><td style="padding:4px 0;color:#a0a0a0;">Day ${i+1}</td><td style="padding:4px 0;">${d.date || ''} (${d.startTime || ''} – ${d.endTime || ''})</td></tr>`
    ).join('');

    const lineItemsHtml = (lineItems || []).map(item => `
        <tr>
            <td style="padding:10px 0;border-bottom:1px solid #eee;">${item.description}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:center;">${item.quantity}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;">$${item.unitPrice?.toLocaleString()}</td>
            <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;">$${item.total?.toLocaleString()}</td>
        </tr>
    `).join('');

    const quoteHtml = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f8f8;">
<div style="max-width:650px;margin:0 auto;background:#fff;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#0e0e0e 0%,#1a1a2e 100%);padding:40px;text-align:center;">
        <h1 style="margin:0;font-size:28px;background:linear-gradient(135deg,#00b4d8,#7b2ff7,#e91e8c);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;">Atlanta Creative Exchange</h1>
        <p style="margin:8px 0 0;color:#a0a0a0;font-size:14px;">A hub for cultural and self expression through music, art, and technology.</p>
    </div>

    <!-- Quote Title -->
    <div style="padding:32px 40px 0;">
        <h2 style="margin:0 0 4px;font-size:22px;color:#111;">Quote for ${clientName}</h2>
        <p style="margin:0;color:#666;font-size:14px;">Quote #${(quoteId || '').slice(0,8).toUpperCase()} • ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</p>
    </div>

    <!-- Event Summary -->
    <div style="padding:24px 40px;">
        <table style="width:100%;font-size:14px;color:#333;">
            <tr><td style="padding:4px 0;color:#a0a0a0;width:120px;">Event Type</td><td style="padding:4px 0;font-weight:500;">${eventType || '—'}</td></tr>
            ${dateDisplay}
            <tr><td style="padding:4px 0;color:#a0a0a0;">Services</td><td style="padding:4px 0;">${(services || []).join(', ') || '—'}</td></tr>
            <tr><td style="padding:4px 0;color:#a0a0a0;">Venue</td><td style="padding:4px 0;">${venueName || '—'}</td></tr>
            <tr><td style="padding:4px 0;color:#a0a0a0;">Size</td><td style="padding:4px 0;">${roomSize || '—'}</td></tr>
        </table>
    </div>

    <!-- Line Items -->
    <div style="padding:0 40px 24px;">
        <table style="width:100%;font-size:14px;border-collapse:collapse;">
            <thead>
                <tr style="border-bottom:2px solid #111;">
                    <th style="padding:10px 0;text-align:left;font-size:12px;text-transform:uppercase;color:#666;">Description</th>
                    <th style="padding:10px 0;text-align:center;font-size:12px;text-transform:uppercase;color:#666;">Qty</th>
                    <th style="padding:10px 0;text-align:right;font-size:12px;text-transform:uppercase;color:#666;">Price</th>
                    <th style="padding:10px 0;text-align:right;font-size:12px;text-transform:uppercase;color:#666;">Total</th>
                </tr>
            </thead>
            <tbody>
                ${lineItemsHtml}
            </tbody>
        </table>
    </div>

    <!-- Totals -->
    <div style="padding:0 40px 32px;">
        <table style="width:100%;font-size:14px;margin-left:auto;max-width:280px;float:right;">
            <tr><td style="padding:6px 0;color:#666;">Subtotal</td><td style="padding:6px 0;text-align:right;">$${subtotal?.toLocaleString()}</td></tr>
            ${discount ? `<tr><td style="padding:6px 0;color:#22c55e;">Discount${discountReason ? ` (${discountReason})` : ''}</td><td style="padding:6px 0;text-align:right;color:#22c55e;">-$${discount?.toLocaleString()}</td></tr>` : ''}
            <tr style="border-top:2px solid #111;"><td style="padding:12px 0;font-size:18px;font-weight:700;">Total</td><td style="padding:12px 0;text-align:right;font-size:18px;font-weight:700;">$${total?.toLocaleString()}</td></tr>
            ${depositRequired ? `<tr><td style="padding:6px 0;color:#666;">Deposit to secure date</td><td style="padding:6px 0;text-align:right;font-weight:600;">$${depositRequired?.toLocaleString()}</td></tr>` : ''}
        </table>
        <div style="clear:both;"></div>
    </div>

    <!-- Payment Terms -->
    <div style="padding:24px 40px;background:#f0f0f0;border-top:1px solid #e0e0e0;">
        <h3 style="margin:0 0 8px;font-size:14px;color:#111;">Payment Terms</h3>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">A deposit is required to secure your date. The remaining balance is due within 24 hours of event completion. Payment details will be provided upon acceptance.</p>
        ${validUntil ? `<p style="margin:8px 0 0;font-size:13px;color:#7b2ff7;font-weight:500;">This quote is valid until ${validUntil}.</p>` : ''}
    </div>

    ${notes ? `
    <div style="padding:24px 40px;">
        <h3 style="margin:0 0 8px;font-size:14px;color:#111;">Notes</h3>
        <p style="margin:0;font-size:13px;color:#555;line-height:1.6;">${notes}</p>
    </div>
    ` : ''}

    <!-- Footer -->
    <div style="padding:32px 40px;background:#0e0e0e;text-align:center;">
        <p style="margin:0 0 4px;color:#f0f0f0;font-size:14px;font-weight:600;">Atlanta Creative Exchange</p>
        <p style="margin:0;color:#a0a0a0;font-size:12px;">Atlanta, Georgia • info@atlantacreativeexchange.com</p>
        <p style="margin:8px 0 0;color:#a0a0a0;font-size:11px;">atlantacreativeexchange.com</p>
    </div>
</div>
</body>
</html>`;

    // Send email with the quote as HTML body
    try {
        await ses.send(new SendEmailCommand({
            Source: FROM_EMAIL,
            ReplyToAddresses: [REPLY_TO_EMAIL],
            Destination: { ToAddresses: [clientEmail] },
            Message: {
                Subject: { Data: `Your Quote from Atlanta Creative Exchange — ${eventType || 'Project'}` },
                Body: { Html: { Data: quoteHtml } }
            }
        }));

        // Also notify owner
        await ses.send(new SendEmailCommand({
            Source: FROM_EMAIL,
            Destination: { ToAddresses: [OWNER_EMAIL] },
            Message: {
                Subject: { Data: `[ACE] Quote sent to ${clientName} — $${total?.toLocaleString()}` },
                Body: { Html: { Data: `<p>Quote sent to <strong>${clientName}</strong> (${clientEmail}) for <strong>$${total?.toLocaleString()}</strong>.</p><p>Event: ${eventType} at ${venueName}</p>` } }
            }
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, message: `Quote emailed to ${clientEmail}` }),
        };
    } catch (err) {
        console.error('Send quote error:', err);
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Failed to send quote' }) };
    }
}

// === EMAIL LIST SUBSCRIBE ===
async function handleSubscribe(data, headers) {
    const { name, email, source } = data;

    if (!email) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };
    }

    // Save to DynamoDB
    await dynamo.send(new PutItemCommand({
        TableName: 'ACE-Subscribers',
        Item: {
            email: { S: email.toLowerCase() },
            name: { S: name || '' },
            source: { S: source || '' },
            subscribedAt: { S: new Date().toISOString() },
            status: { S: 'active' }
        }
    }));

    // Send confirmation email to subscriber
    try {
        await ses.send(new SendEmailCommand({
            Source: FROM_EMAIL,
            ReplyToAddresses: [REPLY_TO_EMAIL],
            Destination: { ToAddresses: [email] },
            Message: {
                Subject: { Data: "You're on the ACE list!" },
                Body: {
                    Html: {
                        Data: `<div style="font-family:-apple-system,sans-serif;max-width:500px;margin:0 auto;padding:32px;">
<h2 style="color:#111;">You're on the list, ${name || 'friend'}!</h2>
<p style="color:#555;line-height:1.6;">Thanks for signing up. We'll keep you in the loop on upcoming Creative Rest events, community gatherings, and other ACE happenings.</p>
<p style="color:#555;line-height:1.6;">We only send emails when something good is coming. No spam, ever.</p>
<p style="color:#555;line-height:1.6;">See you soon.</p>
<p style="color:#555;">— The ACE Team</p>
<hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
<p style="color:#999;font-size:12px;">Atlanta Creative Exchange | Atlanta, Georgia<br><a href="https://atlantacreativeexchange.com" style="color:#7b2ff7;">atlantacreativeexchange.com</a></p>
</div>`
                    }
                }
            }
        }));
    } catch (emailErr) {
        console.error('Subscriber confirmation email failed:', emailErr);
    }

    // Notify owner
    try {
        await ses.send(new SendEmailCommand({
            Source: FROM_EMAIL,
            Destination: { ToAddresses: [OWNER_EMAIL] },
            Message: {
                Subject: { Data: `[ACE List] New subscriber: ${name || email}` },
                Body: {
                    Html: {
                        Data: `<p><strong>New email list subscriber:</strong></p><p>Name: ${name || 'Not provided'}<br>Email: ${email}<br>Source: ${source || 'website'}<br>Time: ${new Date().toISOString()}</p>`
                    }
                }
            }
        }));
    } catch (emailErr) {
        console.error('Owner notification email failed:', emailErr);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
}

// === LIFECYCLE NOTIFICATIONS (ace-platform /notify) ===
// Handles project-note / meeting / demo / contract alerts emitted by the
// ace-platform PM app's sendNotification.ts client. Owner-facing types go to
// OWNER_EMAIL; customer-facing types (meeting_response, contract_sent) use the
// caller-supplied data.email, falling back to OWNER_EMAIL if absent.
async function handleNotify(body, headers) {
    const { type, data = {}, channels = ['email'] } = body || {};

    let emailSubject = '';
    let emailBody = '';
    let toEmail = data.email || OWNER_EMAIL;

    switch (type) {
        case 'project_note': {
            const noteKind = (data.kind || '').toUpperCase() === 'VOICE' ? 'VOICE' : 'TEXT';
            emailSubject = `[ACE] New ${noteKind} note on ${data.projectName || 'a project'}`;
            emailBody = `A new ${noteKind} note was added to project "${data.projectName || 'a project'}". Reference: ${data.noteRef || 'n/a'}. Open the admin portal to review.`;
            toEmail = OWNER_EMAIL; // owner-facing
            break;
        }
        case 'meeting_requested': {
            emailSubject = `[ACE] Meeting requested on ${data.projectName || 'a project'}`;
            emailBody = `A meeting was requested on project "${data.projectName || 'a project'}".<br/>`
                + `Proposed time: ${data.proposedAt || 'TBD'}<br/>`
                + `Mode: ${data.mode || 'TBD'}<br/>`
                + `Purpose: ${data.purpose || 'n/a'}<br/>`
                + `Agenda: ${data.agenda || 'n/a'}<br/>`
                + `Open the admin portal to respond.`;
            toEmail = OWNER_EMAIL; // owner-facing
            break;
        }
        case 'meeting_response': {
            emailSubject = `[ACE] Meeting ${data.status || 'update'}: ${data.projectName || 'your project'}`;
            emailBody = `Your meeting on project "${data.projectName || 'your project'}" was ${data.status || 'updated'}.<br/>`
                + `${data.confirmedAt ? `Confirmed time: ${data.confirmedAt}<br/>` : ''}`
                + `${data.responseNote ? `Note: ${data.responseNote}<br/>` : ''}`;
            // customer-facing: keep data.email (falls back to OWNER_EMAIL above)
            break;
        }
        case 'demo_feedback': {
            emailSubject = `[ACE] Demo feedback on ${data.projectName || 'a project'}`;
            emailBody = `New feedback on demo "${data.demoTitle || 'demo'}" for project "${data.projectName || 'a project'}".<br/>`
                + `Selected option: ${data.selectedOption || 'n/a'}<br/>`
                + `Feedback: ${data.clientFeedback || 'n/a'}<br/>`
                + `Open the admin portal to review.`;
            toEmail = OWNER_EMAIL; // owner-facing
            break;
        }
        case 'contract_sent': {
            const amountLabel = data.amount != null ? `$${data.amount}` : 'the agreed amount';
            emailSubject = `[ACE] Your contract for ${data.projectName || 'your project'}`;
            emailBody = `A contract for project "${data.projectName || 'your project'}" is ready for your review and signature.<br/>`
                + `Amount: ${amountLabel}<br/>`
                + `Sign in to your ACE portal to review and sign.`;
            // customer-facing: keep data.email
            break;
        }
        case 'contract_signed': {
            emailSubject = `[ACE] Contract signed: ${data.projectName || 'a project'}`;
            emailBody = `The contract on project "${data.projectName || 'a project'}" was signed by ${data.signerName || 'the customer'}.<br/>`
                + `Open the admin portal to review.`;
            toEmail = OWNER_EMAIL; // owner-facing
            break;
        }
        default: {
            emailSubject = `[ACE] Notification: ${type || 'unknown'}`;
            emailBody = `A notification was received.<br/>${JSON.stringify(data)}`;
            toEmail = OWNER_EMAIL;
        }
    }

    const results = {};
    if (channels.includes('email')) {
        try {
            await ses.send(new SendEmailCommand({
                Source: FROM_EMAIL,
                ReplyToAddresses: [REPLY_TO_EMAIL],
                Destination: { ToAddresses: [toEmail] },
                Message: {
                    Subject: { Data: emailSubject },
                    Body: { Html: { Data: `<p>${emailBody}</p>` } }
                }
            }));
            results.email = true;
        } catch (err) {
            console.error('Notify email failed:', err);
            results.email = false;
        }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, type, results }) };
}

// === STRIPE: CREATE CHECKOUT (one-off / deposit / balance invoice) ===
// Inputs: { amount, currency='usd', invoiceId, projectId, clientEmail,
//           description, successUrl, cancelUrl }.
// `amount` is treated as MAJOR units (dollars) and converted to Stripe minor
// units (cents) server-side. Returns { url } (the hosted Checkout URL).
async function handleStripeCheckout(data, headers) {
    const {
        amount, currency = 'usd', invoiceId, projectId, clientEmail,
        description, successUrl, cancelUrl,
    } = data || {};

    if (amount == null || !successUrl || !cancelUrl) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'amount, successUrl and cancelUrl are required' }),
        };
    }

    const productName = description || 'Atlanta Creative Exchange payment';
    const params = {
        mode: 'payment',
        'line_items[0][price_data][currency]': currency,
        'line_items[0][price_data][product_data][name]': productName,
        'line_items[0][price_data][unit_amount]': Math.round(Number(amount) * 100),
        'line_items[0][quantity]': 1,
        success_url: successUrl,
        cancel_url: cancelUrl,
        // Statement-descriptor-friendly label for the one-off payment intent.
        'payment_intent_data[statement_descriptor]': 'ATLANTA CREATIVE EXCH',
        'payment_intent_data[description]': productName,
    };
    if (clientEmail) params.customer_email = clientEmail;
    // Correlation metadata so the webhook can match the Stripe event to our row.
    if (invoiceId) params['metadata[invoiceId]'] = invoiceId;
    if (projectId) params['metadata[projectId]'] = projectId;

    try {
        const session = await stripeRequest('/checkout/sessions', params);
        return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Stripe checkout failed' }) };
    }
}

// === STRIPE: CREATE SUBSCRIPTION (maintenance plan) ===
// Inputs: { amount, cadence ('monthly'|'quarterly'|'annual'), planId,
//           clientEmail, successUrl, cancelUrl, currency='usd' }.
// Uses a Checkout Session (mode: 'subscription') so the payment method is
// collected via Stripe-hosted UI (no PCI surface in our code). Returns { url }.
async function handleStripeSubscription(data, headers) {
    const {
        amount, cadence, planId, clientEmail, successUrl, cancelUrl, currency = 'usd',
        trialEnd,
    } = data || {};

    if (amount == null || !cadence || !successUrl || !cancelUrl) {
        return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'amount, cadence, successUrl and cancelUrl are required' }),
        };
    }

    // Map cadence → Stripe recurring interval.
    const recurring = { interval: 'month', interval_count: 1 };
    if (cadence === 'monthly') { recurring.interval = 'month'; recurring.interval_count = 1; }
    else if (cadence === 'quarterly') { recurring.interval = 'month'; recurring.interval_count = 3; }
    else if (cadence === 'annual') { recurring.interval = 'year'; recurring.interval_count = 1; }
    else {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Unsupported cadence: ${cadence}` }) };
    }

    const params = {
        mode: 'subscription',
        'line_items[0][price_data][currency]': currency,
        'line_items[0][price_data][product_data][name]': `ACE Maintenance (${cadence})`,
        'line_items[0][price_data][unit_amount]': Math.round(Number(amount) * 100),
        'line_items[0][price_data][recurring][interval]': recurring.interval,
        'line_items[0][price_data][recurring][interval_count]': recurring.interval_count,
        'line_items[0][quantity]': 1,
        success_url: successUrl,
        cancel_url: cancelUrl,
    };
    if (clientEmail) params.customer_email = clientEmail;
    if (planId) {
        params['metadata[planId]'] = planId;
        // MEDIUM-A: Stripe does NOT copy Checkout Session metadata onto the
        // created Subscription, so set the planId on the subscription itself.
        // Then customer.subscription.* events carry it under subscription metadata.
        params['subscription_data[metadata][planId]'] = planId;
    }

    // MEDIUM-B: optional trialEnd honors a future maintenance start (e.g.
    // 2026-12-30) without charging earlier. PINNED predicate (verbatim):
    if (trialEnd !== undefined) {
        const t = Math.floor(Date.parse(trialEnd) / 1000);
        if (!Number.isFinite(t)) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid trialEnd' }) };
        } else if (t <= nowSec() + 48 * 3600) {
            // Too near/past — Stripe rejects it; omit trial_end and start now.
            console.warn('trialEnd not strictly in the future (>48h) — starting maintenance now');
        } else {
            params['subscription_data[trial_end]'] = t;
        }
    }

    try {
        const session = await stripeRequest('/checkout/sessions', params);
        return { statusCode: 200, headers, body: JSON.stringify({ url: session.url }) };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Stripe subscription failed' }) };
    }
}

// === STRIPE: CREATE PLAN INVOICE (dated down payment → send_invoice) ===
// Inputs: { planId, planItemId, amount, currency='usd', dueDate (YYYY-MM-DD),
//           clientEmail, clientName?, description? }.
// Creates an invoice item, a send_invoice invoice with a due_date and our
// correlation metadata, then finalizes it so a hosted invoice URL exists
// (design §B1). `amount` is MAJOR units (dollars) → minor units server-side.
// Returns { invoiceId, hostedInvoiceUrl, status }.
async function handleCreatePlanInvoice(data, headers) {
    const {
        planId, planItemId, amount, currency = 'usd', dueDate,
        clientEmail, clientName, description,
    } = data || {};

    // --- validation (design §Input validation) ---
    if (amount == null || Number(amount) <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'amount must be > 0' }) };
    }
    const dueMs = Date.parse(dueDate);
    if (!Number.isFinite(dueMs)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid dueDate' }) };
    }
    if (!planId || !clientEmail) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'planId and clientEmail are required' }) };
    }

    try {
        const customer = await ensureStripeCustomer(clientEmail, clientName);

        // 1) invoice item
        await stripeRequest('/invoiceitems', {
            customer,
            amount: Math.round(Number(amount) * 100),
            currency,
            description: description || 'ACE payment plan — down payment',
        });

        // 2) invoice (send_invoice so Stripe never auto-charges; customer pays
        //    via the hosted invoice page) with our correlation metadata.
        const invoiceParams = {
            customer,
            collection_method: 'send_invoice',
            due_date: Math.floor(dueMs / 1000),
            'metadata[kind]': 'down_payment',
            'metadata[planId]': planId,
        };
        if (planItemId) invoiceParams['metadata[planItemId]'] = planItemId;
        const invoice = await stripeRequest('/invoices', invoiceParams);

        // 3) finalize so a hosted invoice URL exists
        const finalized = await stripeRequest('/invoices/' + invoice.id + '/finalize', {});

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                invoiceId: finalized.id,
                hostedInvoiceUrl: finalized.hosted_invoice_url,
                status: finalized.status,
            }),
        };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Stripe plan invoice failed' }) };
    }
}

// === STRIPE: CREATE SUBSCRIPTION SCHEDULE (fixed-count installments) ===
// Inputs: { planId, amount, currency='usd', count (36), startDate
//           (YYYY-MM-DD), anchorDay?, clientEmail, clientName? }.
// Resolves/reuses a Product + a recurring Price, then creates a
// subscription_schedule with iterations=count and end_behavior=cancel so the
// series is finite — the client-visible TERMINATION DATE (design §B2).
// Returns { scheduleId }.
async function handleCreateSubscriptionSchedule(data, headers) {
    const {
        planId, amount, currency = 'usd', count, startDate, anchorDay,
        clientEmail, clientName,
    } = data || {};

    // --- validation (design §Input validation) ---
    if (amount == null || Number(amount) <= 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'amount must be > 0' }) };
    }
    const iterations = Number(count);
    if (!Number.isInteger(iterations) || iterations < 1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'count must be an integer >= 1' }) };
    }
    if (anchorDay != null && (!Number.isInteger(Number(anchorDay)) || Number(anchorDay) < 1 || Number(anchorDay) > 28)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'anchorDay must be 1-28' }) };
    }
    const startMs = Date.parse(startDate);
    if (!Number.isFinite(startMs)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid startDate' }) };
    }
    if (!planId || !clientEmail) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'planId and clientEmail are required' }) };
    }

    try {
        const customer = await ensureStripeCustomer(clientEmail, clientName);
        const unitAmount = Math.round(Number(amount) * 100);

        // 1) Resolve the reusable installment Product.
        let productId = process.env.ACE_INSTALLMENT_PRODUCT_ID;
        if (!productId) {
            try {
                const found = await stripeGet(
                    '/products/search?query=' + encodeURIComponent("metadata['ace_kind']:'installment'") + '&limit=1',
                );
                if (found?.data?.length) productId = found.data[0].id;
            } catch (searchErr) {
                // product search can be unavailable in some accounts — fall through to create
                console.warn('product search failed, will create product:', searchErr.message);
            }
        }
        if (!productId) {
            const product = await stripeRequest('/products', {
                name: 'ACE Installment',
                'metadata[ace_kind]': 'installment',
            });
            productId = product.id;
        }

        // 2) Look up an existing recurring Price before creating one (NIT-2):
        //    reuse the first active monthly Price with matching unit_amount.
        let priceId;
        const prices = await stripeGet(
            '/prices?product=' + encodeURIComponent(productId)
            + '&currency=' + encodeURIComponent(currency)
            + '&active=true&limit=100',
        );
        const match = (prices?.data || []).find((p) =>
            p.unit_amount === unitAmount
            && p.recurring?.interval === 'month'
            && p.recurring?.interval_count === 1);
        if (match) {
            priceId = match.id;
        } else {
            const price = await stripeRequest('/prices', {
                product: productId,
                currency,
                unit_amount: unitAmount,
                'recurring[interval]': 'month',
                'recurring[interval_count]': 1,
            });
            priceId = price.id;
        }

        // 3) Create the schedule referencing the Price (design §B2 primary
        //    shape; price_data is the documented fallback only if the probe
        //    shows referenced-price is rejected — see probes/RESULTS.md).
        //
        //    endive note (probe-confirmed, verify-then-rely): the API version
        //    2026-09-30.endive REMOVED the phase `iterations` parameter the
        //    design (Rev 4) named; the finite length is expressed as a monthly
        //    `duration` of `count` iterations instead. end_behavior=cancel makes
        //    the series finite (count charges then stop) — the client-visible
        //    TERMINATION DATE. Behavior is identical to iterations=count.
        const schedule = await stripeRequest('/subscription_schedules', {
            customer,
            start_date: Math.floor(startMs / 1000),
            end_behavior: 'cancel',
            'phases[0][items][0][price]': priceId,
            'phases[0][items][0][quantity]': 1,
            'phases[0][duration][interval]': 'month',
            'phases[0][duration][interval_count]': iterations,
            'phases[0][metadata][planId]': planId,
            'phases[0][metadata][kind]': 'installment',
            'metadata[planId]': planId,
            'metadata[kind]': 'installment',
        });

        return { statusCode: 200, headers, body: JSON.stringify({ scheduleId: schedule.id }) };
    } catch (err) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Stripe subscription schedule failed' }) };
    }
}

// === STRIPE: TD-4 UPSERT by stripeInvoiceId ===
// The Invoice table has NO index on stripeInvoiceId (only `id` HASH and
// gsi-Client.invoices), so we Scan with a FilterExpression to find an existing
// row, UpdateItem by its `id` when found, else PutItem a new row. This replaces
// the prior always-create behavior that risked duplicate Invoice rows.
async function upsertInvoiceByStripeId(stripeInvoiceId, fields) {
    const now = new Date().toISOString();

    // Find an existing invoice carrying this stripeInvoiceId (paginate defensively).
    let existing;
    let lastKey;
    do {
        const page = await docClient.send(new ScanCommand({
            TableName: ACE_INVOICE_TABLE,
            FilterExpression: 'stripeInvoiceId = :sid',
            ExpressionAttributeValues: { ':sid': stripeInvoiceId },
            ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }));
        existing = (page.Items || [])[0];
        lastKey = page.LastEvaluatedKey;
    } while (!existing && lastKey);

    if (existing) {
        // UPDATE the found row by its primary key.
        const setFields = { ...fields, updatedAt: now };
        const names = {};
        const values = {};
        const sets = [];
        let i = 0;
        for (const [k, v] of Object.entries(setFields)) {
            if (v === undefined) continue;
            const nk = `#f${i}`;
            const vk = `:v${i}`;
            names[nk] = k;
            values[vk] = v;
            sets.push(`${nk} = ${vk}`);
            i += 1;
        }
        await docClient.send(new UpdateCommand({
            TableName: ACE_INVOICE_TABLE,
            Key: { id: existing.id },
            UpdateExpression: `SET ${sets.join(', ')}`,
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
        }));
        return { id: existing.id, updated: true };
    }

    // CREATE only when no existing row carries this stripeInvoiceId.
    const id = randomUUID();
    const item = {
        id,
        __typename: 'Invoice',
        stripeInvoiceId,
        kind: 'maintenance',
        recurring: true,
        createdAt: now,
        updatedAt: now,
        ...fields,
    };
    for (const k of Object.keys(item)) {
        if (item[k] === undefined) delete item[k];
    }
    await docClient.send(new PutCommand({ TableName: ACE_INVOICE_TABLE, Item: item }));
    return { id, created: true };
}

// Update a MaintenancePlan row by id — only when ACE_MAINTENANCE_TABLE is set
// (that table is NOT yet deployed; see user TODO). Logs and skips otherwise.
async function updateMaintenancePlanFields(planId, fields) {
    if (!ACE_MAINTENANCE_TABLE) {
        console.warn('ACE_MAINTENANCE_TABLE not set — skipping MaintenancePlan write for', planId);
        return;
    }
    if (!planId) {
        console.warn('No planId available — skipping MaintenancePlan write');
        return;
    }
    const now = new Date().toISOString();
    const setFields = { ...fields, updatedAt: now };
    const names = {};
    const values = {};
    const sets = [];
    let i = 0;
    for (const [k, v] of Object.entries(setFields)) {
        if (v === undefined) continue;
        const nk = `#f${i}`;
        const vk = `:v${i}`;
        names[nk] = k;
        values[vk] = v;
        sets.push(`${nk} = ${vk}`);
        i += 1;
    }
    await docClient.send(new UpdateCommand({
        TableName: ACE_MAINTENANCE_TABLE,
        Key: { id: planId },
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
    }));
}

// =========================================================================
// === PAYMENT-PLAN RECONCILIATION HELPERS (design §B5 / §B4) ==============
// =========================================================================
// Env-gated DynamoDB helpers for the two new tables (PaymentPlan /
// PaymentPlanItem). Each begins with the SAME unset-env guard as
// updateMaintenancePlanFields: when the table var is unset it logs a warning
// and SKIPS the write (never throws), so webhook reconciliation is inert until
// the §B5 post-deploy env+IAM TODO sets ACE_PAYMENTPLAN_TABLE /
// ACE_PAYMENTPLANITEM_TABLE. The new tables have NO GSI on
// stripeInvoiceId/stripeSubscriptionId/stripeScheduleId, so reads clone the
// Scan-filter-then-Update/Put pattern of upsertInvoiceByStripeId.
// (getScheduleSubscriptionId / backReconcilePaidInstallments' stripeGet hit
// Stripe, not DynamoDB — not env-gated — but their DB WRITES go through these
// helpers, which are.)

// Seconds since epoch — grace-window arithmetic (design §B4).
function nowSec() {
    return Math.floor(Date.now() / 1000);
}

// Append a timestamped line to a plan's free-text notes (schedule terminal
// events that are not a clean completion — design §B4 subscription_schedule.*).
function appendNote(existing, line) {
    const stamp = new Date().toISOString();
    const entry = `[${stamp}] ${line}`;
    return existing ? `${existing}\n${entry}` : entry;
}

// Build a DynamoDB SET UpdateExpression from a flat field object, skipping
// undefined values. Returns { UpdateExpression, ExpressionAttributeNames,
// ExpressionAttributeValues } or null when nothing to set.
function buildSetExpression(fields) {
    const names = {};
    const values = {};
    const sets = [];
    let i = 0;
    for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue;
        const nk = `#f${i}`;
        const vk = `:v${i}`;
        names[nk] = k;
        values[vk] = v;
        sets.push(`${nk} = ${vk}`);
        i += 1;
    }
    if (!sets.length) return null;
    return {
        UpdateExpression: `SET ${sets.join(', ')}`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
    };
}

// Scan a table with a single-attribute equality filter, paginating defensively,
// returning the first matching item or undefined. Mirrors the find step of
// upsertInvoiceByStripeId (no GSI on the stripe* fields).
async function scanFirstByField(table, field, value) {
    let lastKey;
    do {
        const page = await getDocClient().send(new ScanCommand({
            TableName: table,
            FilterExpression: '#k = :v',
            ExpressionAttributeNames: { '#k': field },
            ExpressionAttributeValues: { ':v': value },
            ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }));
        const hit = (page.Items || [])[0];
        if (hit) return hit;
        lastKey = page.LastEvaluatedKey;
    } while (lastKey);
    return undefined;
}

// Upsert a PaymentPlanItem by stripeInvoiceId (no GSI → Scan-filter-then-
// Update/Put, cloned from upsertInvoiceByStripeId). Returns
// { id, created|updated, wasPaid } — wasPaid reports whether the row was
// ALREADY status==='paid' BEFORE this write, so callers can gate the
// idempotent installment counter increment on a real scheduled->paid
// transition. Env-gated on ACE_PAYMENTPLANITEM_TABLE.
async function upsertPlanItemByStripeId(stripeInvoiceId, fields) {
    if (!ACE_PAYMENTPLANITEM_TABLE) {
        console.warn('ACE_PAYMENTPLANITEM_TABLE not set — skipping PaymentPlanItem upsert for', stripeInvoiceId);
        return { skipped: true };
    }
    const now = new Date().toISOString();
    const existing = await scanFirstByField(ACE_PAYMENTPLANITEM_TABLE, 'stripeInvoiceId', stripeInvoiceId);
    if (existing) {
        const wasPaid = existing.status === 'paid';
        const expr = buildSetExpression({ ...fields, updatedAt: now });
        if (expr) {
            await getDocClient().send(new UpdateCommand({
                TableName: ACE_PAYMENTPLANITEM_TABLE,
                Key: { id: existing.id },
                ...expr,
            }));
        }
        return { id: existing.id, updated: true, wasPaid };
    }
    const id = randomUUID();
    const item = {
        id,
        __typename: 'PaymentPlanItem',
        stripeInvoiceId,
        createdAt: now,
        updatedAt: now,
        ...fields,
    };
    for (const k of Object.keys(item)) {
        if (item[k] === undefined) delete item[k];
    }
    await getDocClient().send(new PutCommand({ TableName: ACE_PAYMENTPLANITEM_TABLE, Item: item }));
    return { id, created: true, wasPaid: false };
}

// MEDIUM-C fallback: find a PaymentPlanItem whose stored stripeInvoiceId equals
// the event invoice id (used when down-payment metadata is absent/relocated).
async function findPlanItemByStripeInvoiceId(invoiceId) {
    if (!ACE_PAYMENTPLANITEM_TABLE) {
        console.warn('ACE_PAYMENTPLANITEM_TABLE not set — skipping PaymentPlanItem lookup for', invoiceId);
        return undefined;
    }
    return scanFirstByField(ACE_PAYMENTPLANITEM_TABLE, 'stripeInvoiceId', invoiceId);
}

// Find a PaymentPlan by its released subscription id (installment matching).
async function findPaymentPlanBySubscriptionId(subId) {
    if (!ACE_PAYMENTPLAN_TABLE) {
        console.warn('ACE_PAYMENTPLAN_TABLE not set — skipping PaymentPlan lookup by subscription', subId);
        return undefined;
    }
    if (!subId) return undefined;
    return scanFirstByField(ACE_PAYMENTPLAN_TABLE, 'stripeSubscriptionId', subId);
}

// Find a PaymentPlan by its subscription-schedule id.
async function findPaymentPlanByScheduleId(scheduleId) {
    if (!ACE_PAYMENTPLAN_TABLE) {
        console.warn('ACE_PAYMENTPLAN_TABLE not set — skipping PaymentPlan lookup by schedule', scheduleId);
        return undefined;
    }
    if (!scheduleId) return undefined;
    return scanFirstByField(ACE_PAYMENTPLAN_TABLE, 'stripeScheduleId', scheduleId);
}

// Update arbitrary fields on a PaymentPlan row by id. Env-gated.
async function updatePaymentPlan(planId, fields) {
    if (!ACE_PAYMENTPLAN_TABLE) {
        console.warn('ACE_PAYMENTPLAN_TABLE not set — skipping PaymentPlan update for', planId);
        return;
    }
    if (!planId) {
        console.warn('No planId — skipping PaymentPlan update');
        return;
    }
    const expr = buildSetExpression({ ...fields, updatedAt: new Date().toISOString() });
    if (!expr) return;
    await getDocClient().send(new UpdateCommand({
        TableName: ACE_PAYMENTPLAN_TABLE,
        Key: { id: planId },
        ...expr,
    }));
}

// Stamp PaymentPlan.stripeSubscriptionId for the plan matching this schedule id
// (HIGH-2). Scans by stripeScheduleId, updates by the row's primary key.
async function setPlanSubscriptionId(scheduleId, subId) {
    if (!ACE_PAYMENTPLAN_TABLE) {
        console.warn('ACE_PAYMENTPLAN_TABLE not set — skipping stripeSubscriptionId stamp for schedule', scheduleId);
        return;
    }
    const plan = await scanFirstByField(ACE_PAYMENTPLAN_TABLE, 'stripeScheduleId', scheduleId);
    if (!plan) {
        console.warn('No PaymentPlan for schedule', scheduleId, '— cannot stamp stripeSubscriptionId');
        return;
    }
    await updatePaymentPlan(plan.id, { stripeSubscriptionId: subId });
}

// Flag a plan as defaulted — FLAG ONLY, no license revocation (design §B4). The
// actual license-end is a manual owner action (TODO(license-revocation)).
async function flagPlanDefault(planId) {
    await updatePaymentPlan(planId, { defaulted: true, status: 'defaulted' });
}

// Mark a down-payment PaymentPlanItem failed (matched by stripeInvoiceId).
async function markPlanItemFailed(planId, stripeInvoiceId) {
    await upsertPlanItemByStripeId(stripeInvoiceId, {
        status: 'failed',
        ...(planId ? { planId } : {}),
    });
}

// Mark an installment PaymentPlanItem failed (matched by stripeInvoiceId).
async function markInstallmentFailed(plan, stripeInvoiceId) {
    await upsertPlanItemByStripeId(stripeInvoiceId, {
        status: 'failed',
        kind: 'installment',
        ...(plan?.id ? { planId: plan.id } : {}),
    });
}

// Reconcile a paid down-payment / one-off PaymentPlanItem by stripeInvoiceId.
// Matching is by stripeInvoiceId (the upsert key); planItemId (when known from
// metadata or the matched row) is carried as the row's own `id` so the webhook
// updates the SAME PaymentPlanItem the admin create flow stamped, rather than
// minting a parallel row.
async function reconcilePlanItemPaid({ stripeInvoiceId, planId, planItemId, kind, amountPaid, paymentIntentId }) {
    await upsertPlanItemByStripeId(stripeInvoiceId, {
        status: 'paid',
        paidAt: new Date().toISOString(),
        ...(planId ? { planId } : {}),
        ...(planItemId ? { planItemId } : {}),
        ...(kind ? { kind } : {}),
        ...(amountPaid != null ? { amount: amountPaid } : {}),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    });
}

// IDEMPOTENT installment reconciliation (design §B4 / NIT-4). Upserts the
// installment PaymentPlanItem by stripeInvoiceId; increments
// PaymentPlan.installmentsPaidCount ONLY on a real scheduled->paid transition
// (wasPaid === false), using the atomic DynamoDB counter
// `SET #c = if_not_exists(#c,:zero) + :one`. Then re-reads the counter to set
// minimumMet (installmentsPaidCount >= minimumPaymentsOwed) and status (the
// PINNED completion predicate: installmentCount > 0 && installmentsPaidCount >=
// installmentCount — read ONLY the plan-level installmentCount, never the
// series-descriptor item). A redelivered invoice.paid updates nothing new and
// does not double-count.
async function reconcileInstallmentPaid(plan, { stripeInvoiceId, amountPaid, paymentIntentId }) {
    const result = await upsertPlanItemByStripeId(stripeInvoiceId, {
        status: 'paid',
        kind: 'installment',
        paidAt: new Date().toISOString(),
        ...(plan?.id ? { planId: plan.id } : {}),
        ...(amountPaid != null ? { amount: amountPaid } : {}),
        ...(paymentIntentId ? { stripePaymentIntentId: paymentIntentId } : {}),
    });

    // No table (env unset) or an already-paid row (redelivery) => do not count.
    if (!result || result.skipped || result.wasPaid) return;
    if (!ACE_PAYMENTPLAN_TABLE || !plan?.id) {
        if (!ACE_PAYMENTPLAN_TABLE) {
            console.warn('ACE_PAYMENTPLAN_TABLE not set — skipping installment counter for', stripeInvoiceId);
        }
        return;
    }

    // Atomic increment of the paid counter on a real transition.
    const updated = await getDocClient().send(new UpdateCommand({
        TableName: ACE_PAYMENTPLAN_TABLE,
        Key: { id: plan.id },
        UpdateExpression: 'SET #c = if_not_exists(#c, :zero) + :one, #u = :now',
        ExpressionAttributeNames: { '#c': 'installmentsPaidCount', '#u': 'updatedAt' },
        ExpressionAttributeValues: { ':zero': 0, ':one': 1, ':now': new Date().toISOString() },
        ReturnValues: 'ALL_NEW',
    }));
    const after = updated?.Attributes || {};
    const paidCount = after.installmentsPaidCount != null
        ? after.installmentsPaidCount
        : (plan.installmentsPaidCount || 0) + 1;

    // minimumMet when the paid count reaches the floor.
    const minOwed = after.minimumPaymentsOwed != null ? after.minimumPaymentsOwed : plan.minimumPaymentsOwed;
    const planFields = {};
    if (minOwed != null && paidCount >= minOwed && !after.minimumMet) {
        planFields.minimumMet = true;
    }
    // PINNED completion predicate — plan-level installmentCount ONLY (NIT-4).
    const installmentCount = after.installmentCount != null ? after.installmentCount : plan.installmentCount;
    if (installmentCount > 0 && paidCount >= installmentCount && after.status !== 'completed') {
        planFields.status = 'completed';
    }
    if (Object.keys(planFields).length) {
        await updatePaymentPlan(plan.id, planFields);
    }
}

// MEDIUM-3 recovery: when the schedule linkage first stamps the subscription
// id, pull EVERY already-emitted paid invoice for that subscription and run
// each through the idempotent reconcileInstallmentPaid, so an invoice.paid that
// arrived BEFORE the schedule event is not lost to event ordering (Stripe never
// re-delivers an already-200'd event). Safe to run over the full list because
// reconcileInstallmentPaid is idempotent. Hits Stripe (stripeGet) — not
// env-gated here; the DB writes it drives are env-gated downstream.
async function backReconcilePaidInstallments(plan, subId) {
    const paid = await stripeGet('/invoices?subscription=' + encodeURIComponent(subId) + '&status=paid&limit=100');
    for (const inv of (paid?.data ?? [])) {
        await reconcileInstallmentPaid(plan, {
            stripeInvoiceId: inv.id,
            amountPaid: inv.amount_paid != null ? inv.amount_paid / 100 : undefined,
            paymentIntentId: inv.payment_intent,
        });
    }
}

// === STRIPE: WEBHOOK ===
// Receives Stripe events. Verifies the Stripe-Signature header against
// STRIPE_WEBHOOK_SECRET (HMAC-SHA256) when set; otherwise parses WITHOUT
// verification as a TEST-MODE fallback (see user TODO). Always returns 200 on
// handled/ignored types so Stripe does not retry; DB writes are wrapped so an
// IAM gap surfaces in logs without 500-looping Stripe.
async function handleStripeWebhook(event, headers) {
    const rawBody = event.body || '';
    const sig = event.headers?.['stripe-signature'] || event.headers?.['Stripe-Signature'];

    if (STRIPE_WEBHOOK_SECRET) {
        if (!verifyStripeSignature(rawBody, sig, STRIPE_WEBHOOK_SECRET)) {
            console.error('Stripe webhook signature verification failed');
            return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid signature' }) };
        }
    } else {
        console.warn('STRIPE_WEBHOOK_SECRET not set — parsing webhook WITHOUT verification (test-mode fallback)');
    }

    let stripeEvent;
    try {
        stripeEvent = JSON.parse(rawBody);
    } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON body' }) };
    }

    try {
        const obj = stripeEvent.data?.object || {};
        switch (stripeEvent.type) {
            case 'checkout.session.completed': {
                const invoiceId = obj.metadata?.invoiceId;
                const stripeInvoiceId = obj.invoice || invoiceId;
                if (stripeInvoiceId) {
                    await upsertInvoiceByStripeId(stripeInvoiceId, {
                        status: 'paid',
                        paidAt: new Date().toISOString(),
                        ...(obj.amount_total != null ? { total: obj.amount_total / 100 } : {}),
                        ...(invoiceId ? { sourceInvoiceId: invoiceId } : {}),
                        ...(obj.metadata?.projectId ? { projectId: obj.metadata.projectId } : {}),
                    });
                }
                break;
            }
            case 'invoice.paid': {
                // 1) Down payment — match by OUR metadata, else fall back to the
                //    stored stripeInvoiceId (MEDIUM-C). Early return on EITHER
                //    match; do NOT fall through to the maintenance upsert (NIT-1).
                const dpByMeta = obj.metadata?.kind === 'down_payment';
                const dpItem = dpByMeta ? null : await findPlanItemByStripeInvoiceId(obj.id);
                if (dpByMeta || (dpItem && dpItem.kind === 'down_payment')) {
                    await reconcilePlanItemPaid({
                        stripeInvoiceId: obj.id,
                        planId: obj.metadata?.planId ?? dpItem?.planId,
                        planItemId: obj.metadata?.planItemId ?? dpItem?.id,
                        kind: 'down_payment',
                        amountPaid: obj.amount_paid != null ? obj.amount_paid / 100 : undefined,
                        paymentIntentId: obj.payment_intent,
                    });
                    break; // EARLY RETURN — matched by metadata OR stripeInvoiceId.
                }
                // 2) Installment — generated by the schedule's subscription;
                //    match by the version-tolerant subscription id (HIGH-1).
                const subId = resolveInvoiceSubscriptionId(obj);
                if (subId) {
                    const plan = await findPaymentPlanBySubscriptionId(subId);
                    if (plan) {
                        await reconcileInstallmentPaid(plan, {
                            stripeInvoiceId: obj.id,
                            amountPaid: obj.amount_paid != null ? obj.amount_paid / 100 : undefined,
                            paymentIntentId: obj.payment_intent,
                        });
                        break; // EARLY RETURN.
                    }
                    // No plan yet (stripeSubscriptionId not stamped — reversed
                    // order). The subscription_schedule.* branch back-reconciles
                    // this exact invoice once it stamps the id (MEDIUM-3). Do NOT
                    // fall through to the maintenance upsert for a subscription
                    // invoice.
                    console.warn('installment invoice.paid', obj.id, 'for sub', subId,
                        'has no matching plan yet — will be back-reconciled on schedule linkage');
                    break;
                }
                // 3) Fall through ONLY for everything else — existing maintenance
                //    path (TD-4 upsert by Stripe invoice id).
                await upsertInvoiceByStripeId(obj.id, {
                    status: 'paid',
                    paidAt: new Date().toISOString(),
                    ...(obj.amount_paid != null ? { total: obj.amount_paid / 100 } : {}),
                });
                break;
            }
            case 'invoice.payment_failed': {
                // Down payment (send_invoice invoices have due_date). Match by
                // metadata, else by stored stripeInvoiceId (MEDIUM-C / NIT-1).
                const dpByMeta = obj.metadata?.kind === 'down_payment';
                const dpItem = dpByMeta ? null : await findPlanItemByStripeInvoiceId(obj.id);
                if (dpByMeta || (dpItem && dpItem.kind === 'down_payment')) {
                    const dpPlanId = obj.metadata?.planId ?? dpItem?.planId;
                    await markPlanItemFailed(dpPlanId, obj.id);
                    const graceAnchor = resolveGraceAnchor(obj); // MEDIUM-1
                    if (graceAnchor && (nowSec() - graceAnchor) > 15 * 24 * 3600) {
                        await flagPlanDefault(dpPlanId);
                    }
                    break; // EARLY RETURN on either match (NIT-1).
                }
                // Installment (auto-charge; due_date is null — resolveGraceAnchor
                // falls to line-level period.end).
                const subId = resolveInvoiceSubscriptionId(obj); // HIGH-1
                if (subId) {
                    const plan = await findPaymentPlanBySubscriptionId(subId);
                    if (plan) {
                        await markInstallmentFailed(plan, obj.id);
                        const graceAnchor = resolveGraceAnchor(obj); // MEDIUM-1
                        if (graceAnchor && (nowSec() - graceAnchor) > 15 * 24 * 3600) {
                            await flagPlanDefault(plan.id);
                        }
                        break;
                    }
                    console.warn('installment invoice.payment_failed', obj.id, 'for sub', subId,
                        'has no matching plan yet — schedule linkage will reconcile');
                    break;
                }
                // Else: existing maintenance behavior (MEDIUM-A planId fallback).
                const planId = obj.metadata?.planId || obj.subscription_details?.metadata?.planId;
                await updateMaintenancePlanFields(planId, { status: 'past_due' });
                break;
            }
            case 'subscription_schedule.updated':
            case 'subscription_schedule.released': {
                // HIGH-2 linkage + MEDIUM-3 back-reconcile.
                const plan = await findPaymentPlanByScheduleId(obj.id);
                if (plan && !plan.stripeSubscriptionId) {
                    // Prefer the event field if present, else READ it from the
                    // schedule object (do NOT assume the event carries it).
                    const subId = obj.subscription ?? await getScheduleSubscriptionId(obj.id);
                    if (subId) {
                        await setPlanSubscriptionId(obj.id, subId);
                        // Recover any installment invoices Stripe already 200'd
                        // before the id was stamped (reversed order).
                        await backReconcilePaidInstallments(plan, subId);
                    }
                }
                break;
            }
            case 'subscription_schedule.completed':
            case 'subscription_schedule.canceled':
            case 'subscription_schedule.aborted': {
                const plan = await findPaymentPlanByScheduleId(obj.id);
                if (plan) {
                    // Treat a terminal event as completion ONLY when every
                    // installment is paid (PINNED predicate, NIT-4). Otherwise a
                    // non-.completed terminal event just records a note.
                    if (plan.installmentCount > 0 && plan.installmentsPaidCount >= plan.installmentCount) {
                        await updatePaymentPlan(plan.id, { status: 'completed' });
                    } else if (stripeEvent.type !== 'subscription_schedule.completed') {
                        await updatePaymentPlan(plan.id, {
                            notes: appendNote(plan.notes,
                                `schedule ${stripeEvent.type} with ${plan.installmentsPaidCount}/${plan.installmentCount} paid`),
                        });
                    }
                }
                break;
            }
            case 'customer.subscription.updated': {
                // MEDIUM-A planId fallback + endive period-end item fallback.
                const planId = obj.metadata?.planId ?? obj.subscription_details?.metadata?.planId;
                const periodEnd = obj.current_period_end ?? obj.items?.data?.[0]?.current_period_end;
                const nextBillingDate = periodEnd ? new Date(periodEnd * 1000).toISOString() : undefined;
                await updateMaintenancePlanFields(planId, {
                    status: obj.status || 'active',
                    nextBillingDate,
                });
                break;
            }
            case 'customer.subscription.deleted': {
                // MEDIUM-A planId fallback.
                const planId = obj.metadata?.planId ?? obj.subscription_details?.metadata?.planId;
                await updateMaintenancePlanFields(planId, {
                    status: 'cancelled',
                    cancelledAt: new Date().toISOString(),
                });
                break;
            }
            default:
                console.log('Unhandled Stripe event type:', stripeEvent.type);
        }
    } catch (err) {
        // Log (e.g. AccessDenied until the IAM TODO is applied) but still 200 so
        // Stripe does not retry-loop.
        console.error('Stripe webhook DB write failed:', err?.message || err);
    }

    return { statusCode: 200, headers, body: JSON.stringify({ received: true }) };
}

// Verify a Stripe-Signature header (t=...,v1=...) via HMAC-SHA256 over
// `${timestamp}.${rawBody}` using the webhook signing secret.
function verifyStripeSignature(rawBody, sigHeader, secret) {
    if (!sigHeader) return false;
    const parts = Object.fromEntries(
        sigHeader.split(',').map((kv) => {
            const idx = kv.indexOf('=');
            return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
        }),
    );
    const t = parts.t;
    const v1 = parts.v1;
    if (!t || !v1) return false;
    const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
    try {
        const a = Buffer.from(expected, 'hex');
        const b = Buffer.from(v1, 'hex');
        return a.length === b.length && timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

// === TEST SURFACE ===
// Named exports used by the *.test.mjs suites (node --test). These do NOT
// change the Lambda runtime: AWS invokes `handler`; the extra named exports are
// inert at runtime and keep the file dependency-free.
export {
    stripeForm,
    stripeGet,
    ensureStripeCustomer,
    resolveInvoiceSubscriptionId,
    resolveGraceAnchor,
    getScheduleSubscriptionId,
    handleCreatePlanInvoice,
    handleCreateSubscriptionSchedule,
    handleStripeSubscription,
    handleStripeCheckout,
    handleStripeWebhook,
    // --- FEAT-002 webhook reconciliation (B4/B5) ---
    nowSec,
    appendNote,
    upsertPlanItemByStripeId,
    findPlanItemByStripeInvoiceId,
    findPaymentPlanBySubscriptionId,
    findPaymentPlanByScheduleId,
    updatePaymentPlan,
    setPlanSubscriptionId,
    flagPlanDefault,
    markPlanItemFailed,
    markInstallmentFailed,
    reconcilePlanItemPaid,
    reconcileInstallmentPaid,
    backReconcilePaidInstallments,
    __setDocClientForTests,
};
