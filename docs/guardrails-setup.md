# Guardrails and PII protection for AskWRI

This is the step-by-step setup for the safety layer. AskWRI uses **Amazon Bedrock Guardrails** through the standalone `ApplyGuardrail` API. Until you create a guardrail and put its ID in `.env`, the app runs with safety filters **off** and shows a "Safety filters are off" note.

> Status: created in the team sandbox (account `390190675482`, us-east-1) as guardrail **`ne8dji5ugt8j`**. **Use version `2`** (the tested one). Put `GUARDRAIL_ID=ne8dji5ugt8j` and `GUARDRAIL_VERSION=2` in `.env`. The commands below are for recreating it in another account.

## 1. What is protected, and where

```
question ──► [A] ApplyGuardrail INPUT ──► masked question ──► Knowledge Base search ──► Claude Sonnet
                 mask PII, block secrets,                                                    │
                 deny off-topic requests                                                     ▼
answer shown ◄── [C] quote check (app) ◄── claims ◄───────────────────────────────── JSON claims
      ▲
      └──────── [B] ApplyGuardrail OUTPUT: grounding against the cited passages
```

| Stage | Done by | What it does |
|---|---|---|
| **A. Input** | `ApplyGuardrail`, source `INPUT` | Masks PII in the question (`{EMAIL}`), blocks secrets and off-topic requests. Runs **before retrieval**, so raw PII never reaches the search query, the model, or the briefing URL. |
| **B. Output** | `ApplyGuardrail`, source `OUTPUT` | Checks the answer text is grounded in the passages it cites, and applies the content and PII filters. |
| **C. Quote check** | the app (`prototype/backend/app.py`) | Every claim needs a verbatim quote from a retrieved passage, or the whole answer becomes a refusal. This is independent of the guardrail and always on. |

Why `ApplyGuardrail` and not `guardrailConfig` on the model call: a guardrail attached to the model call only sees the model's input and output. It never sees the text sent to the Knowledge Base search, so PII in a question would still be sent to retrieval. Calling `ApplyGuardrail` first fixes that.

**Fail closed.** If a guardrail is configured and the call fails (throttled, permission denied), the request returns HTTP 503 and nothing is processed. It never silently skips the check.

## 2. Prerequisites

- Bedrock access in your region (the sandbox default is `us-east-1`).
- IAM permission for whoever runs the app:
  ```json
  {
    "Effect": "Allow",
    "Action": "bedrock:ApplyGuardrail",
    "Resource": "arn:aws:bedrock:us-east-1:<ACCOUNT_ID>:guardrail/<GUARDRAIL_ID>"
  }
  ```
  Add `bedrock:InvokeModel` and `bedrock:Retrieve` as the rest of the app needs. Scope to the specific ARN, not `*`.
- AWS CLI v2 (`aws --version`).

## 3. Create the guardrail

### Option A: one command (recommended)

From the repo root:

```bash
aws bedrock create-guardrail --region us-east-1 \
  --cli-input-json file://docs/guardrail.json \
  --query '{id:guardrailId,arn:guardrailArn,version:version}'
```

Then publish an **immutable numbered version**. `DRAFT` can change under you, so never point production at it:

```bash
aws bedrock create-guardrail-version --region us-east-1 \
  --guardrail-identifier <GUARDRAIL_ID> \
  --description "AskWRI v1" \
  --query version
```

Put both values in `.env` (repo root, git-ignored):

```
GUARDRAIL_ID=<the id from create-guardrail>
GUARDRAIL_VERSION=1
```

Restart the backend. `GET /api/status` should now report `"guardrails": true` and the "Safety filters are off" note disappears.

### Option B: the console

1. Open **Amazon Bedrock → Guardrails → Create guardrail**. Name it `askwri-guardrail`.
2. Set the blocked-message text for prompts and responses (copy from `docs/guardrail.json`).
3. **Content filters:** turn on Hate (High), Insults (Medium), Sexual (High), Violence (Medium), Misconduct (Medium), and **Prompt attacks (High, input only)**.
4. **Denied topics:** add the four topics from `docs/guardrail.json` (definition plus example phrases for each).
5. **Sensitive information filters:** add the PII types in the table in section 4.
6. **Contextual grounding check:** enable **Grounding only**, at 0.7. Leave Relevance off (see section 4b).
7. Create the guardrail, then **Create version**. Copy the ID and the version number into `.env`.

## 4. The PII masking choices, and why

| PII type | On the question (input) | On the answer (output) | Reasoning |
|---|---|---|---|
| EMAIL, PHONE, IP_ADDRESS | **Anonymize** (becomes `{EMAIL}`) | off | Researchers may paste an email into a question by accident. Masking keeps the question usable. Public WRI reports legitimately contain author contact details, so masking the output would break correct answers. |
| US_SOCIAL_SECURITY_NUMBER, CREDIT_DEBIT_CARD_NUMBER | **Block** | **Block** | There is never a reason for these in a research question. |
| PASSWORD, AWS_ACCESS_KEY, AWS_SECRET_KEY, API-key regex | **Block** | **Block** | Secrets pasted by mistake must not reach a model, a log, or an answer. |
| ADDRESS | **not enabled** | **not enabled** | Found by live testing: the ADDRESS filter treats country and city names as addresses. "forest restoration in Brazil and Kenya" became "forest restoration in {ADDRESS} and {ADDRESS}", which ruins retrieval for an app built around places. |
| NAME | **not enabled** | **not enabled** | Questions like "what did Jane Doe write?" are normal in a research tool, and WRI authors are named in the sources. Masking names would break citations. Enable it only if your policy requires it. |

**Block vs anonymize:** *Block* rejects the whole request. *Anonymize* replaces the value with a tag and continues. You can mix them per type, as above.

**What the app does with each outcome**
- Input **anonymized**: the masked question is used for retrieval, the model and everything after. The response includes it as `topic`, and the briefing link carries only that masked text.
- Input **blocked**: returns status `out_of_scope` with the blocked message. Retrieval never runs. Covered by a test.
- Output **any intervention** (blocked, or failed grounding): the answer becomes the standard refusal. The app never rewrites claim text, because that would break the verbatim quote check.

### 4b. Why there is no Relevance filter

The contextual grounding check has two scores, Grounding and Relevance. Grounding is kept. Relevance was **removed after measuring it** on 7 test answers with the live guardrail:

| Case | Grounding | Relevance |
|---|---|---|
| relevant answers (4) | 1.0 | 0.28, 0.84, 0.89, 0.97 |
| irrelevant answers (3) | 0.99 to 1.0 | 0.00, 0.45, 0.62 |

Scores overlap (a relevant answer scored 0.28, an irrelevant one 0.62), so no threshold separates them; at 0.7 it refused good answers. That is a small sample, so re-measure with real WRI questions before turning it back on. Hallucination is already covered by Grounding plus the app's verbatim-quote check.

## 5. Keeping questions to WRI's topics

The expectations call for restricting search to WRI's topics (cities, climate, energy, food, forests, freshwater, ocean). Be aware of one limit:

> **Denied topics are a deny-list, not an allow-list.** Bedrock Guardrails cannot say "only allow these seven topics". They can only block named categories.

So AskWRI uses two layers together:
1. **Denied topics** block the common off-topic categories (party politics, medical/legal/financial advice, questions about private individuals, unrelated tasks like coding help).
2. **Retrieval grounding** handles everything else. A question outside WRI's research returns no relevant passages and the app answers "Insufficient evidence in the sample". Nothing is invented.

If you see off-topic requests slipping through, add another denied topic with 3 to 5 realistic example questions, create a new version, and update `GUARDRAIL_VERSION`.

## 6. Test it

Test the guardrail alone, without the app. The `<...>` values are yours.

```bash
# a. PII is masked (expect action GUARDRAIL_INTERVENED and {EMAIL} in the output)
aws bedrock-runtime apply-guardrail --region us-east-1 \
  --guardrail-identifier <ID> --guardrail-version <VERSION> --source INPUT \
  --content '[{"text":{"text":"Email me at jane@example.org about electric buses"}}]' \
  --query '{action:action,out:outputs[0].text}'

# b. A secret is blocked
aws bedrock-runtime apply-guardrail --region us-east-1 \
  --guardrail-identifier <ID> --guardrail-version <VERSION> --source INPUT \
  --content '[{"text":{"text":"My card is 4111 1111 1111 1111"}}]' --query action

# c. An off-topic request is blocked
aws bedrock-runtime apply-guardrail --region us-east-1 \
  --guardrail-identifier <ID> --guardrail-version <VERSION> --source INPUT \
  --content '[{"text":{"text":"Who should I vote for in the election?"}}]' --query action

# d. A normal research question passes untouched (expect NONE)
aws bedrock-runtime apply-guardrail --region us-east-1 \
  --guardrail-identifier <ID> --guardrail-version <VERSION> --source INPUT \
  --content '[{"text":{"text":"What does WRI say about electric school buses?"}}]' --query action
```

Then through the app (`/api/ask`): ask a question that includes an email address. The JSON response's `topic` field must show `{EMAIL}` (or similar) instead of the address.

**Tune with real questions:** if good questions get blocked, loosen the content-filter strengths or lower the grounding threshold. To see actual scores for a case, call `apply-guardrail` with `--source OUTPUT` and read `assessments[].contextualGroundingPolicy.filters[]` (do this for debugging only; assessments can echo user text). If hallucinated answers pass, raise the grounding threshold toward 0.8. Run `eval/run_eval.py` after each change.

## 7. Hardening before real users

- **Pin a numbered version.** Never `DRAFT` in `.env`.
- **Do not turn on trace output.** `trace: enabled` returns the original text that triggered a filter, including the PII. This app never enables it.
- **PII and logs.** Masking only changes what the API *returns*. If you enable **Bedrock model invocation logging**, the original unmasked text goes to CloudWatch or S3. Encrypt that log group or bucket with a customer-managed KMS key, restrict access with least-privilege IAM, set a short retention, or leave invocation logging off. The app's own question log is Demand Radar (`data/radar.db`, git-ignored): it stores the masked question and an optional team, never a name, and never a blocked question. Rows are deleted after `RADAR_RETENTION_DAYS`. With no guardrail configured, Radar's own filter still removes emails and phone numbers, but nothing else is masked.
- **Encrypt the guardrail** with a customer-managed KMS key by adding `"kmsKeyId": "<key ARN>"` to `docs/guardrail.json`. Creators need `kms:Decrypt`, `kms:GenerateDataKey`, `kms:DescribeKey`, `kms:CreateGrant`; callers need `kms:Decrypt`.
- **Enforcing the guardrail with IAM does not fit this design yet.** The usual control is a deny on `bedrock:InvokeModel` / `Converse` unless the call carries the `bedrock:GuardrailIdentifier` condition. AskWRI applies its guardrail with a separate `ApplyGuardrail` call and does not attach one to the model call, so that deny would block the app's own model calls. Do not add it unless you also attach `guardrailConfig` to the `converse` call in `app.py`. Account-wide enforcement (`PutEnforcedGuardrailConfiguration`) is the other option, and needs the same check.
- **Audit.** Management events (`CreateGuardrail`, `UpdateGuardrail`, `DeleteGuardrail`) are in CloudTrail by default. Add data events for `AWS::Bedrock::Guardrail` to log `ApplyGuardrail` calls, and alarm on guardrail changes.
- **Source documents.** Guardrails do not scan the raw passages returned by retrieval. Remove PII from documents **before** they are ingested into the Knowledge Base.

## 8. What the code does where

| File | Role |
|---|---|
| `prototype/backend/guardrails.py` | `check_input` (mask or block), `check_output` (grounding), fail-closed errors. |
| `prototype/backend/app.py` | Calls them around retrieval and generation. Maps failures to 503. |
| `prototype/backend/tests/test_backend.py` | Tests for masking before retrieval, blocking, fail-closed, and grounding refusal, using a fake client. |
