#!/bin/bash
set -e

REGION="us-east-1"
STACK_NAME="ACE-QuoteSystem"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OWNER_EMAIL="wilson.danny@me.com"

echo ""
echo "🎵 Atlanta Creative Exchange — Quote System Deployment"
echo "======================================================="
echo ""

# --- 1. Deploy CloudFormation stack ---
echo "📦 Deploying CloudFormation stack..."
aws cloudformation deploy \
  --template-file "$SCRIPT_DIR/template.yaml" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --parameter-overrides OwnerEmail="$OWNER_EMAIL" \
  --no-fail-on-empty-changeset

echo ""
echo "📋 Getting stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs')

API_ENDPOINT=$(echo "$OUTPUTS" | python3 -c "import json,sys; print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='ApiEndpoint'][0])")
LAMBDA_NAME=$(echo "$OUTPUTS" | python3 -c "import json,sys; print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='LambdaFunction'][0])")
TABLE_NAME=$(echo "$OUTPUTS" | python3 -c "import json,sys; print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='TableName'][0])")

echo "  API Endpoint: $API_ENDPOINT"
echo "  Lambda: $LAMBDA_NAME"
echo "  DynamoDB Table: $TABLE_NAME"

# --- 2. Package and deploy Lambda code ---
echo ""
echo "📦 Packaging Lambda function..."
cd "$SCRIPT_DIR/lambda"
cp quoteHandler.mjs index.mjs
zip -q quoteHandler.zip index.mjs
aws lambda update-function-code \
  --function-name "$LAMBDA_NAME" \
  --zip-file fileb://quoteHandler.zip \
  --region "$REGION" > /dev/null

# Wait for update to complete
echo "  Waiting for Lambda update..."
aws lambda wait function-updated --function-name "$LAMBDA_NAME" --region "$REGION" 2>/dev/null || sleep 5

# Update runtime and handler
aws lambda update-function-configuration \
  --function-name "$LAMBDA_NAME" \
  --handler index.handler \
  --runtime nodejs20.x \
  --region "$REGION" > /dev/null 2>&1 || true

rm index.mjs quoteHandler.zip
echo "  ✅ Lambda deployed"

# --- 3. Verify SES email identity ---
echo ""
echo "📧 Verifying SES email identity..."
aws ses verify-email-identity --email-address "$OWNER_EMAIL" --region "$REGION" 2>/dev/null || true
echo "  ⚠️  If not already verified, check $OWNER_EMAIL for a verification email from AWS."
echo "  (SES sandbox mode: you can only send TO verified addresses. Request production access for customer emails.)"

# --- 4. Update frontend with API endpoint ---
echo ""
echo "🔗 Updating frontend API endpoint..."
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' "s|%%API_ENDPOINT%%|$API_ENDPOINT|g" "$PROJECT_DIR/quote-modal.js"
else
  sed -i "s|%%API_ENDPOINT%%|$API_ENDPOINT|g" "$PROJECT_DIR/quote-modal.js"
fi
echo "  ✅ quote-modal.js updated with: $API_ENDPOINT"

# --- 5. Summary ---
echo ""
echo "======================================================="
echo "✅ Deployment complete!"
echo ""
echo "🌐 API Endpoint: $API_ENDPOINT/quote"
echo "📊 DynamoDB Table: $TABLE_NAME"
echo "⚡ Lambda: $LAMBDA_NAME"
echo "📧 Owner Email: $OWNER_EMAIL"
echo ""
echo "⚠️  IMPORTANT NOTES:"
echo "  1. SES is in sandbox mode by default. To send emails to"
echo "     unverified addresses (customers), request production access:"
echo "     https://console.aws.amazon.com/ses/home#/account"
echo ""
echo "  2. Verify Bedrock model access is enabled:"
echo "     https://console.aws.amazon.com/bedrock/home#/modelaccess"
echo "     Ensure 'Claude 3 Haiku' is enabled."
echo ""
echo "  3. Commit and push to deploy frontend changes:"
echo "     cd '$PROJECT_DIR'"
echo "     git add -A && git commit -m 'Add quote system' && git push"
echo ""
