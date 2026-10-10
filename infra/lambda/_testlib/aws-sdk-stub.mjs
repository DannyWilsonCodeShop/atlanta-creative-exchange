// Minimal in-memory stubs for the @aws-sdk/* packages that quoteHandler.mjs
// imports at module load. The Lambda runtime provides these packages; locally
// (dependency-free, no node_modules) the test loader (loader.mjs) resolves the
// bare '@aws-sdk/*' specifiers to this file so `node --test` can import the
// handler module without installing the SDK.
//
// None of the Stripe routes under test touch these clients: handleCreatePlanInvoice
// and handleCreateSubscriptionSchedule call Stripe via the global `fetch` only,
// and the resolvers are pure. The stubs exist purely so the top-level
// `new XClient(...)` constructions and command imports succeed.

class StubClient {
    constructor() {}
    async send() {
        throw new Error('aws-sdk stub: unexpected AWS SDK call in a unit test');
    }
}

// Command classes — constructed in the handler but never sent in these tests.
class StubCommand {
    constructor(input) { this.input = input; }
}

export const DynamoDBClient = StubClient;
export const PutItemCommand = StubCommand;
export const SESClient = StubClient;
export const SendEmailCommand = StubCommand;
export const SNSClient = StubClient;
export const PublishCommand = StubCommand;
export const PinpointSMSVoiceV2Client = StubClient;
export const SendTextMessageCommand = StubCommand;
export const CognitoIdentityProviderClient = StubClient;
export const AdminCreateUserCommand = StubCommand;
export const AdminAddUserToGroupCommand = StubCommand;
export const BedrockRuntimeClient = StubClient;
export const InvokeModelCommand = StubCommand;
export const ScanCommand = StubCommand;
export const UpdateCommand = StubCommand;
export const PutCommand = StubCommand;

// lib-dynamodb DocumentClient surface.
export const DynamoDBDocumentClient = {
    from() { return new StubClient(); },
};
