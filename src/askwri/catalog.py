"""What WRI has published (the catalog) vs what AskWRI can search (the loaded corpus).

- Loaded corpus: data/manifest*.csv, the documents we downloaded and ingested.
- Catalog: data/catalog.csv, metadata for every WRI publication (title, year, program, url).
  It needs no full text. The checked-in file is a small sample; replace it with the full list.
"""
import csv
import glob
import os
from functools import lru_cache

import re

from .text import fold, terms

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _read(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _key(title):
    # keep digits and every word, so "Aqueduct 3.0" and "Aqueduct 4.0" stay separate
    return " ".join(re.findall(r"[a-z0-9]+", fold(title)))


@lru_cache(maxsize=1)
def loaded():
    """Documents in the searchable corpus, de-duplicated by title."""
    docs = {}
    for path in sorted(glob.glob(os.path.join(ROOT, "data", "manifest*.csv"))):
        for r in _read(path):
            docs.setdefault(_key(r["title"]), r)
    return list(docs.values())


@lru_cache(maxsize=1)
def catalog():
    """Every known WRI publication. Loaded documents count as catalog entries too."""
    rows = {}
    path = os.getenv("CATALOG_CSV", os.path.join(ROOT, "data", "catalog.csv"))
    if os.path.exists(path):
        for r in _read(path):
            rows.setdefault(_key(r["title"]), r)
    for r in loaded():
        rows.setdefault(_key(r["title"]), r)
    loaded_keys = {_key(r["title"]) for r in loaded()}
    out = []
    for k, r in rows.items():
        out.append({
            "title": r["title"],
            "year": (r.get("year") or r.get("date") or "")[:4],
            "program": r.get("program", ""),
            "url": r.get("url", ""),
            "loaded": k in loaded_keys,
            "terms": set(terms(r["title"])),
        })
    return out


def match(text, min_shared=2, min_cover=0.5):
    """Catalog entries whose title is mostly covered by the question's terms, best first.

    A title like "Reducing Food Loss and Waste" matches "what did WRI find on food loss and waste".
    Keyword matching is a stand-in: a match is "found in the catalog", never proof of coverage.
    """
    q = set(terms(text))
    hits = []
    for doc in catalog():
        if not doc["terms"]:
            continue
        shared = q & doc["terms"]
        cover = len(shared) / len(doc["terms"])
        enough = len(shared) >= min(min_shared, len(doc["terms"]))
        # long titles rarely get half-covered by a question, so 3 shared terms also counts
        if enough and (cover >= min_cover or len(shared) >= 3):
            hits.append((len(shared) + cover, doc))
    hits.sort(key=lambda h: -h[0])
    return [d for _, d in hits]


def closest(words, min_shared=2):
    """Best catalog entry for a bag of terms. None unless it shares at least min_shared terms,
    so a single common word like "data" doesn't produce a misleading match."""
    words = set(words)
    best, score = None, min_shared - 1
    for doc in catalog():
        s = len(words & doc["terms"])
        if s > score:
            best, score = doc, s
    return best


def clear_cache():
    loaded.cache_clear()
    catalog.cache_clear()
