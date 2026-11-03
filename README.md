# AskWRI

Research assistant over WRI publications. Every answer cites the passages it came from, and it
declines when the corpus doesn't have an answer. Bedrock + AgentCore, Python 3.12.

```
ui/index.html -> api/server.py (or AgentCore runtime) -> supervisor agent
    supervisor -> ask / briefing / gap / translate agents -> search_wri -> Bedrock Knowledge Base -> S3
```

Passages get numbered when they're retrieved. The model has to cite those numbers, and `app.py`
checks that it did. No valid citations means the answer is replaced with the decline message.

## Setup

1. Turn on Bedrock model access (generation + embeddings).
2. Private, encrypted S3 bucket -> `CORPUS_BUCKET`.
3. Fill in `data/manifest.csv` and run `python scripts/download_corpus.py data/manifest.csv`.
4. Create the Knowledge Base on that bucket. Hybrid search needs OpenSearch Serverless or Aurora
   pgvector; with S3 Vectors remove `overrideSearchType` in `retrieval.py`.
5. Copy `.env.example`, set `KB_ID` / `KB_DATA_SOURCE_ID`, then `python scripts/ingest.py`.
6. `pip install -r requirements.txt && uvicorn api.server:app --port 8000`
7. Deploy: `agentcore configure -e src/askwri/app.py` then `agentcore launch`.

## Eval

Put 15-25 questions in `eval/questions.jsonl` (include at least one unanswerable), then
`python eval/run_eval.py`.

## To check

- Which model IDs the sandbox actually allows.
- `MIN_SCORE` is a guess. Scores differ by store and search type.
- Page numbers only show up for some parser settings.
