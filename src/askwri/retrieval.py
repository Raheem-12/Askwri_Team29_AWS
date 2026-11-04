import os
from contextvars import ContextVar

REGION = os.getenv("AWS_REGION", "us-east-1")
KB_ID = os.getenv("KB_ID")
MIN_SCORE = float(os.getenv("MIN_SCORE", "0.35"))  # TODO tune this on the eval set
TOP_K = int(os.getenv("TOP_K", "8"))

DECLINE = "I couldn't find anything in the WRI publications I have that supports an answer to that."

_kb = None


def mock_mode():
    """ASKWRI_MOCK=1 runs with no AWS: keyword search over the manifest titles."""
    return os.getenv("ASKWRI_MOCK", "") not in ("", "0", "false")


def kb():
    global _kb
    if _kb is None:
        import boto3
        _kb = boto3.client("bedrock-agent-runtime", region_name=REGION)
    return _kb

# passages seen during one request, keyed by the number the model cites
_seen = ContextVar("seen", default=None)


def reset():
    _seen.set({})
    return _seen.get()


def seen():
    s = _seen.get()
    return s if s is not None else reset()


def _mock_results(query, program, language, k):
    """Same shape as kb.retrieve results, scored by keyword overlap with each document title."""
    from . import catalog
    from .text import terms
    q = set(terms(query))
    out = []
    for doc in catalog.loaded():
        if program and doc.get("program") != program:
            continue
        if language and (doc.get("language") or "en") != language:
            continue
        t = set(terms(doc["title"] + " " + doc.get("program", "")))
        if not q or not t:
            continue
        score = len(q & t) / len(q)
        if score:
            out.append({
                "score": round(score, 3),
                "content": {"text": f"(mock passage) {doc['title']}"},
                "location": {"s3Location": {"uri": "mock://" + doc["title"]}},
                "metadata": {"title": doc["title"], "url": doc.get("url", ""),
                             "year": doc.get("date", "")[:4], "program": doc.get("program", ""),
                             "language": doc.get("language") or "en"},
            })
    return sorted(out, key=lambda r: -r["score"])[:k]


def search(query, program="", language="", k=TOP_K, min_score=MIN_SCORE, keep=True):
    if mock_mode():
        return _collect(_mock_results(query, program, language, k), min_score, keep)

    cfg ={"numberOfResults": k, "overrideSearchType": "HYBRID"}  # drop HYBRID if using S3 Vectors

    filters = []
    if program:
        filters.append({"equals": {"key": "program", "value": program}})
    if language:
        filters.append({"equals": {"key": "language", "value": language}})
    if len(filters) == 1:
        cfg["filter"] = filters[0]
    elif len(filters) > 1:
        cfg["filter"] = {"andAll": filters}

    resp = kb().retrieve(
        knowledgeBaseId=KB_ID,
        retrievalQuery={"text": query},
        retrievalConfiguration={"vectorSearchConfiguration": cfg},
    )
    return _collect(resp["retrievalResults"], min_score, keep)


def _collect(results, min_score, keep):
    found = []
    for r in results:
        if r.get("score", 0) < min_score:
            continue
        md = r.get("metadata", {})
        uri = r.get("location", {}).get("s3Location", {}).get("uri", "")
        p = {
            "title": md.get("title") or uri.split("/")[-1],
            "url": md.get("url", ""),
            "year": md.get("year", ""),
            "program": md.get("program", ""),
            "language": md.get("language", ""),
            "page": md.get("x-amz-bedrock-kb-document-page-number", ""),
            "score": round(r["score"], 3),
            "text": r["content"]["text"].strip(),
            "uri": uri,
        }
        if keep:
            # same chunk twice -> reuse its number
            for n, old in seen().items():
                if old["uri"] == uri and old["text"] == p["text"]:
                    p["n"] = n
                    break
            else:
                p["n"] = len(seen()) + 1
                seen()[p["n"]] = p
        found.append(p)
    return found


def as_text(passages):
    if not passages:
        return "NO_RELEVANT_SOURCES"
    out = []
    for p in passages:
        out.append(f"[{p['n']}] {p['title']} ({p['year']}, {p['program']})\n{p['text']}")
    return "\n\n".join(out)
