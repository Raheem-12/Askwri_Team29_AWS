#!/usr/bin/env bash
# usage: BUCKET=<name> REGION=<region> bash security/harden_bucket.sh
set -euo pipefail
: "${BUCKET:?set BUCKET}"; : "${REGION:?set REGION}"
if aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" >/dev/null 2>&1; then
  echo "Bucket already has a policy, so I will NOT overwrite it. Add a DenyInsecureTransport statement by hand:"
  aws s3api get-bucket-policy --bucket "$BUCKET" --region "$REGION" --query Policy --output text
  exit 1
fi
aws s3api put-public-access-block --bucket "$BUCKET" --region "$REGION" --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket "$BUCKET" --region "$REGION" --versioning-configuration Status=Enabled
cat > /tmp/tls-policy.json <<JSON
{"Version":"2012-10-17","Statement":[{"Sid":"DenyInsecureTransport","Effect":"Deny","Principal":"*",
"Action":"s3:*","Resource":["arn:aws:s3:::$BUCKET","arn:aws:s3:::$BUCKET/*"],
"Condition":{"Bool":{"aws:SecureTransport":"false"}}}]}
JSON
aws s3api put-bucket-policy --bucket "$BUCKET" --region "$REGION" --policy file:///tmp/tls-policy.json
echo "--- verify"
aws s3api get-public-access-block --bucket "$BUCKET" --region "$REGION" --query PublicAccessBlockConfiguration
aws s3api get-bucket-versioning --bucket "$BUCKET" --region "$REGION" --query Status
if aws s3 ls "s3://$BUCKET" --endpoint-url "http://s3.$REGION.amazonaws.com" >/dev/null 2>&1; then
  echo "FAIL: plain HTTP was allowed"; else echo "OK: plain HTTP denied"; fi
