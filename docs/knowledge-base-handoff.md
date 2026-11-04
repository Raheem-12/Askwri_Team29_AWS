# Handoff: what the app needs from the S3 + Aurora Knowledge Base work

For the teammates building the document store and the Bedrock Knowledge Base. The prototype app (`prototype/backend`) already knows how to use a KB; this is the contract it expects.

## Target architecture (from `the-expectation.md`)

S3 (PDF/doc storage) → Bedrock Knowledge Base → Aurora PostgreSQL with pgvector → Claude Sonnet 5.5 on Bedrock.

## 1. What the app reads from every retrieved chunk

`prototype/backend/app.py` → `evidence_sources()` reads these from each result:

| Field | Where | Used for | If missing |
|---|---|---|---|
| passage text | `content.text` | the quote check and the "full retrieved passage" view | the chunk is skipped |
| `title` (or `_document_title`) | `metadata` | citation title | the chunk is skipped |
| `public_url` | `metadata` | citation link. Must be `https` on `wri.org` or a subdomain, otherwise it is shown as plain text | citation shows "Public link unavailable" |
| `_excerpt_page_number` | `metadata` | "PDF page N" | citation shows "Page not provided" |

Also from the expectations: `date`, `program` and `language` metadata. Put them in as **filterable** attributes when creating the KB, because Bedrock cannot filter on attributes that were not declared. The app does not filter on them yet; the supporting code for filters is the `retrievalConfiguration` in `retrieve_sources()`.

Metadata is attached to an S3 object with a sidecar file named `<document>.pdf.metadata.json`:

```json
{ "metadataAttributes": { "title": "…", "public_url": "https://www.wri.org/research/…",
                          "program": "Cities", "language": "en", "date": "2024-07-01" } }
```

`data/manifest.csv` already has `title, url, pdf_url, date, program, language` for the 10 starter documents; `scripts/download_corpus.py` fetches them into `data/raw/` and uploads to the bucket in `CORPUS_BUCKET`.

## 2. Retrieval settings (Aurora pgvector)

For a customer-managed KB on Aurora, the app sends `vectorSearchConfiguration` with `overrideSearchType: HYBRID` (keyword plus vector). Aurora/RDS supports `HYBRID` when the text field is filterable. Set in `.env`:

```
KB_TYPE=vector        # customer-managed KB on Aurora pgvector (default)
KB_SEARCH_TYPE=HYBRID # use SEMANTIC for stores that only support vector search, such as S3 Vectors
```

If a Bedrock **Managed** Knowledge Base is used instead, set `KB_TYPE=managed`. The old code always sent the managed form, which an Aurora-backed KB does not accept; this is now configurable.

## 3. Chunking and place names (matters for the map)

Pins come from place names that appear **inside a quoted passage**. A chunk that cuts a sentence in half ("In Jakarta, Indon…") will fail the quote check and drop the pin. Prefer chunking that keeps sentences whole: hierarchical or semantic chunking, with a parent chunk large enough to hold full paragraphs. Figures and tables parse best with the FM-based parser.

## 4. Switch the app from sample data to the real KB

1. Create the KB, ingest, and confirm a `Retrieve` call returns results with the metadata above.
2. In `.env`: set `BEDROCK_KB_ID` (and `KB_ID` for the agents app) to the real ID, then **remove or set `DEMO_MODE=false`**.
3. Restart the backend. `GET /api/status` must show `"demo": false, "configured": true`. The yellow "Sample data" banner disappears.
4. Grant the app's role `bedrock:Retrieve` on the KB, `bedrock:InvokeModel` on the Sonnet 5.5 inference profile, and `bedrock:ApplyGuardrail` on the guardrail (see `docs/guardrails-setup.md`).
5. Run `eval/run_eval.py` after filling in `eval/questions.jsonl` (the first two entries are still placeholders).

## 5. Demand Radar

Questions asked on the globe and in the agents chat page both feed Demand Radar at `/radar`. It decides "not loaded yet" by comparing `data/manifest*.csv` with `data/catalog.csv`, so keep the manifests in step with what is actually ingested, and replace the 5-row sample catalog with the full WRI list. It also marks answers as weak coverage when the top retrieval score is below `RADAR_WEAK_SCORE` (0.5), so check that value against your KB's real scores. Delete `data/radar.db` when you leave demo mode: rows from demo mode are labeled simulated.

## 6. Connection map

`GET /api/graph` builds the map from `data/manifest.csv` and `data/manifest_extra.csv`: topic hubs → publications, plus links between publications that share title terms. For stronger, evidence-based links, an offline job can write `data/graph.json`:

```json
{ "edges": [ { "source": "pub:aqueduct-4-0-updated-decision-relevant-global-water-risk-indicators",
               "target": "pub:aqueduct-3-0-…", "reason": "Cited together in 14 retrieved answers" } ] }
```

Node ids are `pub:` plus the title lowercased, with every run of non-alphanumeric characters turned into `-`, cut to 80 characters (see `_node_id` in `prototype/backend/graph.py`). Topic hubs are `topic:<name>`, for example `topic:cities`. Only edges whose `source` and `target` match existing node ids, and that have a `reason`, are used. The app never asks a model to invent relationships.
