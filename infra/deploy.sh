#!/bin/bash
set -e

REGION="us-east-1"
STACK_NAME="ACE-QuoteSystem"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OWNER_EMAIL="wilson.danny@me.com"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="ace-deploy-${ACCOUNT_ID}"

echo ""
echo "🎵 Atlanta Creative Exchange — Quote System Deployment"
echo "======================================================="
echo "   Architecture: API Gateway → Step Functions → DynamoDB + Bedrock + SES"
echo ""

# --- 1. Create S3 bucket for artifacts (if needed) ---
echo "📦 Ensuring deployment bucket exists..."
aws s3 mb "s3://${BUCKET_NAME}" --region "$REGION" 2>/dev/null || true

# --- 2. Upload Step Functions definition ---
echo "📤 Uploading Step Functions definition..."
aws s3 cp "$SCRIPT_DIR/step-functions-definition.json" "s3://${BUCKET_NAME}/step-functions-definition.json" --region "$REGION"

# --- 3. Deploy CloudFormation stack ---
echo ""
echo "📦 Deploying CloudFormation stack..."
aws cloudformation deploy \
  --template-file "$SCRIPT_DIR/template.yaml" \
  --stack-name "$STACK_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --parameter-overrides OwnerEmail="$OWNER_EMAIL" \
  --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/cdk-hnb659fds-cfn-exec-role-${ACCOUNT_ID}-${REGION}" \
  --no-fail-on-empty-changeset

echo ""
echo "📋 Getting stack outputs..."
OUTPUTS=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs')

API_ENDPOINT=$(echo "$OUTPUTS" | python3 -c "import json,sys; print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='ApiEndpoint'][0])")
STATE_MACHINE=$(echo "$OUTPUTS" | python3 -c "import json,sys; print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='StateMachineArn'][0])")
TABLE_NAME=$(echo "$OUTPUTS" | python3 -c "import json,sys; print([o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='TableName'][0])")

echo "  API Endpoint: $API_ENDPOINT"
echo "  State Machine: $STATE_MACHINE"
echo "  DynamoDB Table: $TABLE_NAME"

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
echo "⚡ State Machine: $STATE_MACHINE"
echo "📧 Owner Email: $OWNER_EMAIL"
echo ""
echo "⚠️  NOTES:"
echo "  1. SES sandbox: customer emails only work to verified addresses."
echo "     Request production access: https://console.aws.amazon.com/ses/home#/account"
echo ""
echo "  2. Bedrock: Ensure Claude Haiku 4.5 is accessible."
echo "     First invocation may prompt for use case details."
echo ""
echo "  3. Commit and push to deploy frontend:"
echo "     cd '$PROJECT_DIR'"
echo "     git add -A && git commit -m 'Deploy quote system' && git push"
echo ""
