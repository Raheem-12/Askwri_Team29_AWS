#!/usr/bin/env bash
# Run from the repo root with AWS credentials loaded. Writes reproducible proof to docs/security/evidence/
set -u; set -a; source .env; set +a
E=docs/security/evidence; mkdir -p $E
aws sts get-caller-identity --query Arn --output text            > $E/identity.txt
aws s3api get-public-access-block --bucket $CORPUS_BUCKET         > $E/s3_public_block.json
aws s3api get-bucket-versioning   --bucket $CORPUS_BUCKET         > $E/s3_versioning.json
aws s3api get-bucket-encryption   --bucket $CORPUS_BUCKET         > $E/s3_encryption.json
aws s3api get-bucket-policy       --bucket $CORPUS_BUCKET --query Policy --output text > $E/s3_policy.json
aws bedrock get-guardrail --guardrail-identifier $GUARDRAIL_ID --guardrail-version $GUARDRAIL_VERSION > $E/guardrail.json
( aws s3 ls s3://$CORPUS_BUCKET --endpoint-url http://s3.$AWS_REGION.amazonaws.com 2>&1 | head -2 ) > $E/tls_denied.txt
( curl -sI "https://$CORPUS_BUCKET.s3.$AWS_REGION.amazonaws.com/docs/" | head -1 ) > $E/public_access_403.txt
python security/verify_corpus.py verify                           > $E/integrity.txt
python -m pytest security/tests -q                                > $E/unit_tests.txt
echo "secret check:"; grep -rEi "AKIA[0-9A-Z]{12,}|aws_secret|session_token" $E || echo "none found"
