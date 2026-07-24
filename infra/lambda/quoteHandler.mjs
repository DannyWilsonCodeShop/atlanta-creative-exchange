/**
 * ACE Quote Handler Lambda
 * 1. Saves quote request to DynamoDB
 * 2. Calls Bedrock (Claude) for AI analysis — pricing estimate + tailored questions
 * 3. Sends owner email with full details + AI analysis
 * 4. Sends customer confirmation email
 */

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { randomUUID } from 'crypto';

const REGION = process.env.AWS_REGION || 'us-east-1';
const TABLE_NAME = process.env.TABLE_NAME || 'ACE-Quotes';
const OWNER_EMAIL = process.env.OWNER_EMAIL || 'wilson.danny@me.com';
const FROM_EMAIL = process.env.FROM_EMAIL || 'wilson.danny@me.com';
const REPLY_TO_EMAIL = 'info@atlantacreativeexchange.com';
const BEDROCK_MODEL_ID = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const dynamo = new DynamoDBClient({ region: REGION });
const ses = new SESClient({ region: REGION });
const bedrock = new BedrockRuntimeClient({ region: REGION });

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
        const body = JSON.parse(event.body);
        const quoteId = randomUUID();

        // 1. Save to DynamoDB
        await saveQuote(quoteId, body);

        // 2. Call Bedrock for AI analysis
        const aiAnalysis = await analyzeWithBedrock(body);

        // 3. Send owner email (full details + AI analysis)
        await sendOwnerEmail(quoteId, body, aiAnalysis);

        // 4. Send customer confirmation
        await sendCustomerConfirmation(body);

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
        item.eventDate = { S: data.eventDate || '' };
        item.startTime = { S: data.startTime || '' };
        item.endTime = { S: data.endTime || '' };
        item.services = { S: JSON.stringify(data.services || []) };
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

A customer has submitted a digital project request. Using the pricing guide and project details below, provide:

1. RECOMMENDED QUOTE RANGE — A specific dollar range for this project based on their needs, complexity, features, and timeline. Break it down by line item (design, development, integrations, hosting, etc.). Show a low and high estimate.

2. TAILORED FOLLOW-UP QUESTIONS — 5-8 intelligent questions specific to THIS project that the sales team should ask on the discovery call. Consider technical requirements, user flows, content needs, and scope gaps.

3. PROJECT ANALYSIS — Brief assessment: complexity level (simple/moderate/complex/enterprise), estimated timeline, potential technical challenges, and recommended tech stack.

4. UPSELL OPPORTUNITIES — Additional services that would benefit this project (branding, ongoing maintenance, content, analytics, SEO, etc.).

${PRICING_GUIDE}

${eventSummary}

Format your response clearly with headers and bullet points. Be specific with dollar amounts.`;
    } else {
    } else {
        eventSummary = `
EVENT DETAILS:
- Type: ${data.eventType}
- Date: ${data.eventDate}
- Time: ${data.startTime} to ${data.endTime}
- Services Requested: ${data.services.join(', ')}
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

A customer has submitted a quote request. Using the pricing guide and event details below, provide:

1. **RECOMMENDED QUOTE RANGE** — A specific dollar range for this event based on their services, room size, duration, and equipment needs. Break it down by line item (e.g., DJ base rate, mic add-ons, delivery, etc.). Show a low estimate and high estimate.

2. **TAILORED FOLLOW-UP QUESTIONS** — 5-8 intelligent questions specific to THIS event that the sales team should ask on the follow-up call. These should help refine the quote and uncover upsell opportunities. Consider the event type, venue, services requested, and any gaps in the information provided.

3. **EVENT ANALYSIS** — A brief assessment of this event: complexity level (simple/moderate/complex), any potential challenges (outdoor power, stairs for load-in, large room coverage, etc.), and recommended approach.

4. **UPSELL OPPORTUNITIES** — Any additional services that would make sense for this event that the customer didn't request.

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
    const duration = calculateDuration(data.startTime, data.endTime);

    const htmlBody = `
<html>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #111; color: #f0f0f0; padding: 32px;">
<div style="max-width: 700px; margin: 0 auto; background: #1e1e1e; border-radius: 12px; padding: 36px; border: 1px solid #333;">

<h1 style="color: #7b2ff7; margin-bottom: 8px;">New Quote Request</h1>
<p style="color: #a0a0a0; margin-bottom: 32px;">Quote ID: ${quoteId}</p>

<h2 style="color: #00b4d8; border-bottom: 1px solid #333; padding-bottom: 8px;">Customer</h2>
<table style="width: 100%; color: #f0f0f0; margin-bottom: 24px;">
<tr><td style="color:#a0a0a0;padding:4px 0;">Name:</td><td>${data.firstName} ${data.lastName}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Email:</td><td><a href="mailto:${data.email}" style="color:#00b4d8;">${data.email}</a></td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Phone:</td><td><a href="tel:${data.phone}" style="color:#00b4d8;">${data.phone}</a></td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Organization:</td><td>${data.organization || 'N/A'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">How heard:</td><td>${data.howHeard || 'Not specified'}</td></tr>
</table>

<h2 style="color: #00b4d8; border-bottom: 1px solid #333; padding-bottom: 8px;">Event Details</h2>
<table style="width: 100%; color: #f0f0f0; margin-bottom: 24px;">
<tr><td style="color:#a0a0a0;padding:4px 0;">Type:</td><td>${data.eventType}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Date:</td><td>${data.eventDate}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Time:</td><td>${data.startTime} – ${data.endTime} (${duration})</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Services:</td><td><strong>${data.services.join(', ')}</strong></td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Genre:</td><td>${data.genre || 'Not specified'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Speeches:</td><td>${data.speeches || 'Not specified'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Budget:</td><td>${data.budget || 'Not disclosed'}</td></tr>
</table>

<h2 style="color: #00b4d8; border-bottom: 1px solid #333; padding-bottom: 8px;">Venue</h2>
<table style="width: 100%; color: #f0f0f0; margin-bottom: 24px;">
<tr><td style="color:#a0a0a0;padding:4px 0;">Venue:</td><td>${data.venueName}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Address:</td><td>${data.venueAddress}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Room:</td><td>${data.roomName || 'N/A'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Floor/Access:</td><td>${data.floorAccess || 'Not specified'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Indoor/Outdoor:</td><td>${data.indoorOutdoor}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Room Size:</td><td><strong>${data.roomSize}</strong></td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Power:</td><td>${data.powerAvailability || 'Not specified'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Load-in:</td><td>${data.loadInTime || 'Not specified'}</td></tr>
</table>

<h2 style="color: #00b4d8; border-bottom: 1px solid #333; padding-bottom: 8px;">Equipment</h2>
<table style="width: 100%; color: #f0f0f0; margin-bottom: 24px;">
<tr><td style="color:#a0a0a0;padding:4px 0;">Wireless Mics:</td><td>${data.micWireless}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Wired Mics:</td><td>${data.micWired}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Aux/Inputs:</td><td>${data.auxInputs || 'None'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Monitors:</td><td>${data.monitorSpeakers || 'Not specified'}</td></tr>
<tr><td style="color:#a0a0a0;padding:4px 0;">Notes:</td><td>${data.additionalNotes || 'None'}</td></tr>
</table>

<h2 style="color: #e91e8c; border-bottom: 1px solid #333; padding-bottom: 8px;">🤖 AI Quote Analysis</h2>
<div style="background: #161616; border: 1px solid #333; border-radius: 8px; padding: 24px; white-space: pre-wrap; font-size: 14px; line-height: 1.7; color: #e0e0e0;">
${aiAnalysis}
</div>

<p style="color: #a0a0a0; margin-top: 32px; font-size: 12px; text-align: center;">Atlanta Creative Exchange — Quote System</p>
</div>
</body>
</html>`;

    await ses.send(new SendEmailCommand({
        Source: FROM_EMAIL,
        ReplyToAddresses: [REPLY_TO_EMAIL],
        Destination: { ToAddresses: [OWNER_EMAIL] },
        Message: {
            Subject: { Data: `[ACE Quote] ${data.eventType} — ${data.firstName} ${data.lastName} — ${data.eventDate}` },
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

<img src="https://atlantacreativeexchange.com/Resources/Final%20Drafts-03.png" alt="Atlanta Creative Exchange" style="height: 48px; margin-bottom: 24px;">

<h1 style="font-size: 24px; color: #111; margin-bottom: 8px;">Thanks, ${data.firstName}!</h1>
<p style="color: #555; font-size: 16px; line-height: 1.6;">We've received your quote request and a member of our sales team will reach out within <strong>24 hours</strong> with a personalized quote or any follow-up questions.</p>

<div style="background: #f0f0f0; border-radius: 8px; padding: 20px; margin: 24px 0;">
<h3 style="font-size: 14px; color: #333; margin-bottom: 12px;">Here's what you submitted:</h3>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Event:</strong> ${data.eventType}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Date:</strong> ${data.eventDate}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Time:</strong> ${data.startTime} – ${data.endTime}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Services:</strong> ${data.services.join(', ')}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Venue:</strong> ${data.venueName}</p>
<p style="color: #555; font-size: 14px; margin: 4px 0;"><strong>Size:</strong> ${data.roomSize}</p>
</div>

<p style="color: #555; font-size: 14px; line-height: 1.6;"><strong>Payment Terms:</strong> A deposit is required to secure your date. The remaining balance is due within 24 hours of event completion. We'll provide full payment details with your quote.</p>

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
