"""Demand Radar: log questions AskWRI can't answer well and turn them into a ranked list of gaps.

Three kinds of "no good answer", each with a different owner and action:
  not_loaded       found in the WRI catalog but not in the searchable corpus -> Data Lab loads it
  weak             answered thinly, or WRI has the report but it didn't answer -> update/extend research
  never_published  no match in the catalog                                   -> possible new research area

Storage is SQLite (RADAR_DB, default data/radar.db). No names or user ids are stored: only the
question (emails and phone numbers removed), an optional team label, and the retrieval outcome.
"""
import json
import math
import os
import sqlite3
import time
from collections import Counter, defaultdict

from . import catalog
from .text import guess_language, scrub, surface_forms, terms

WEAK_SCORE = float(os.getenv("RADAR_WEAK_SCORE", "0.5"))  # answered, but top passage below this = weak
RETENTION_DAYS = int(os.getenv("RADAR_RETENTION_DAYS", "90"))
MIN_CLUSTER = int(os.getenv("RADAR_MIN_CLUSTER", "3"))
SIMILARITY = float(os.getenv("RADAR_SIMILARITY", "0.25"))
DAY = 86400

GAPS = {
    "not_loaded": {"label": "Not loaded yet", "owner": "Data Lab",
                   "action": "Load this report into AskWRI"},
    "weak": {"label": "Weak coverage", "owner": "Research teams",
             "action": "Update or extend existing research"},
    "never_published": {"label": "No match in catalog", "owner": "Research leadership",
                        "action": "Possible new research area"},
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  ts REAL NOT NULL,
  question TEXT NOT NULL,
  language TEXT,
  team TEXT,
  endpoint TEXT,
  answered INTEGER NOT NULL,
  top_score REAL,
  cited TEXT,
  gap_type TEXT,
  matched_title TEXT,
  source TEXT NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS questions_ts ON questions(ts);
"""


def db_path():
    # a relative RADAR_DB is relative to the repo, not to wherever the server was started
    return os.path.join(catalog.ROOT, os.getenv("RADAR_DB") or os.path.join("data", "radar.db"))


def connect():
    con = sqlite3.connect(db_path())
    con.row_factory = sqlite3.Row
    con.executescript(SCHEMA)
    return con


# ---------- classify ----------

def classify(question, answered, top_score, cited_titles=()):
    """Return (gap_type, matched_title). gap_type is None when the answer was good."""
    if answered:
        if top_score is not None and top_score < WEAK_SCORE:
            return "weak", (cited_titles[0] if cited_titles else None)
        return None, None
    hits = catalog.match(question)
    if not hits:
        return "never_published", None
    missing = [h for h in hits if not h["loaded"]]
    if missing:
        return "not_loaded", missing[0]["title"]
    # WRI has it and we searched it, but it didn't support an answer
    return "weak", hits[0]["title"]


# ---------- log ----------

def log(question, answered, top_score=None, cited_titles=(), team=None, endpoint="ask",
        language=None, ts=None, source="live"):
    question = scrub(question.strip())[:1000]
    gap, matched = classify(question, answered, top_score, list(cited_titles))
    with connect() as con:
        con.execute(
            "INSERT INTO questions (ts, question, language, team, endpoint, answered, top_score,"
            " cited, gap_type, matched_title, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (ts or time.time(), question, language or guess_language(question),
             (team or "").strip()[:60] or None, endpoint, int(bool(answered)), top_score,
             json.dumps(list(cited_titles)), gap, matched, source))
        con.execute("DELETE FROM questions WHERE ts < ?", (time.time() - RETENTION_DAYS * DAY,))
    return {"gap_type": gap, "matched_title": matched}


def log_answer(question, result, team=None, endpoint="ask", ts=None, source="live"):
    """Log an app.answer() result. Uses the retrieval details the app attaches under _radar."""
    meta = result.get("_radar", {})
    return log(question, not result["declined"], meta.get("top_score"),
               [s["title"] for s in result.get("sources", [])], team=team,
               endpoint=endpoint, ts=ts, source=source)


def clear(source=None):
    with connect() as con:
        if source:
            con.execute("DELETE FROM questions WHERE source = ?", (source,))
        else:
            con.execute("DELETE FROM questions")


# ---------- cluster ----------

def _vectors(rows):
    docs = [set(terms(r["question"])) for r in rows]
    df = Counter(t for d in docs for t in d)
    n = len(docs)
    idf = {t: math.log((1 + n) / (1 + c)) + 1 for t, c in df.items()}
    vecs = []
    for d in docs:
        # words seen in only one question can't link it to anything; they just add noise
        keep = {t for t in d if df[t] > 1} or d
        v = {t: idf[t] for t in keep}
        norm = math.sqrt(sum(x * x for x in v.values())) or 1
        vecs.append({t: x / norm for t, x in v.items()})
    return vecs, docs, idf


def _cos(a, b):
    if len(a) > len(b):
        a, b = b, a
    return sum(x * b.get(t, 0) for t, x in a.items())


def _centroid(vecs):
    c = defaultdict(float)
    for v in vecs:
        for t, x in v.items():
            c[t] += x
    norm = math.sqrt(sum(x * x for x in c.values())) or 1
    return {t: x / norm for t, x in c.items()}


def cluster(rows, threshold=SIMILARITY, min_size=MIN_CLUSTER):
    """Keyword clustering: greedy assignment, then merge groups whose centroids are close.

    Stand-in for embeddings + LLM naming. Groups smaller than min_size go to "Other".
    Keyword matching can't link languages; multilingual embeddings fix that.
    """
    vecs, docs, idf = _vectors(rows)
    groups = []  # lists of row indexes
    cents = []
    for i, v in enumerate(vecs):
        sims = [_cos(v, c) for c in cents]
        j = max(range(len(sims)), key=sims.__getitem__) if sims else None
        if j is not None and sims[j] >= threshold:
            groups[j].append(i)
            cents[j] = _centroid([vecs[k] for k in groups[j]])
        else:
            groups.append([i])
            cents.append(v)

    merged = True
    while merged:
        merged = False
        for a in range(len(groups)):
            for b in range(a + 1, len(groups)):
                if _cos(cents[a], cents[b]) >= threshold + 0.1:
                    groups[a] += groups.pop(b)
                    cents.pop(b)
                    cents[a] = _centroid([vecs[k] for k in groups[a]])
                    merged = True
                    break
            if merged:
                break

    # questions in groups too small to stand alone join the nearest real group if they are
    # loosely related ("heat resilience plans" -> heat); truly unrelated ones go to Other
    big = [k for k, g in enumerate(groups) if len(g) >= min_size]
    leftovers = []
    for k, g in enumerate(groups):
        if len(g) >= min_size:
            continue
        for i in g:
            sims = [(_cos(vecs[i], cents[b]), b) for b in big]
            s, b = max(sims) if sims else (0, None)
            if b is not None and s >= threshold * 0.6:
                groups[b].append(i)
            else:
                leftovers.append(i)
    groups = [groups[b] for b in big] + ([leftovers] if leftovers else [])

    out, other = [], []
    for g in groups:
        members = [rows[i] for i in g]
        if len(members) >= min_size and g is not leftovers:
            # name by the words most members share; rarer words break ties
            cover = Counter(t for i in g for t in docs[i])
            top = sorted(cover, key=lambda t: (-cover[t], -idf[t]))[:6]
            words = defaultdict(Counter)
            for r in members:
                for t, w in surface_forms(r["question"]).items():
                    words[t][w] += 1
            label = [words[t].most_common(1)[0][0] if words[t] else t for t in top]
            out.append({"terms": top, "label": label, "rows": members})
        else:
            other.extend(members)
    if other:
        out.append({"terms": [], "rows": other, "other": True})
    return out


def _name(words):
    return " · ".join(w.capitalize() for w in words[:3]) or "Other questions"


# ---------- report ----------

def _filters(gap=None, team=None, language=None):
    where, args = [], []
    if gap:
        where.append("gap_type = ?")
        args.append(gap)
    if team:
        where.append("team = ?")
        args.append(team)
    if language:
        where.append("language = ?")
        args.append(language)
    return where, args


def report(days=7, gap=None, team=None, language=None, now=None):
    """Stats for the window, plus ranked gap clusters with trend vs the previous window."""
    now = now or time.time()
    start, prev_start = now - days * DAY, now - 2 * days * DAY
    where, args = _filters(None, team, language)
    with connect() as con:
        cond = " AND ".join(["ts >= ?"] + where)
        all_rows = [dict(r) for r in con.execute(
            f"SELECT * FROM questions WHERE {cond} ORDER BY ts", [prev_start] + args)]
        facets = {
            "teams": [r[0] for r in con.execute(
                "SELECT DISTINCT team FROM questions WHERE team IS NOT NULL ORDER BY team")],
            "languages": [r[0] for r in con.execute(
                "SELECT DISTINCT language FROM questions ORDER BY language")],
        }
        simulated = con.execute("SELECT COUNT(*) FROM questions WHERE source = 'seed'").fetchone()[0]

    current = [r for r in all_rows if r["ts"] >= start]
    answered_ok = sum(1 for r in current if r["gap_type"] is None)
    gap_rows = [r for r in all_rows if r["gap_type"] and (not gap or r["gap_type"] == gap)]

    cards = []
    for c in cluster(gap_rows):
        cur = [r for r in c["rows"] if r["ts"] >= start]
        prev = len(c["rows"]) - len(cur)
        if not cur:
            continue
        n = len(cur)
        teams = {r["team"] for r in cur if r["team"]}
        if prev == 0:
            trend = "new"
        elif n >= prev * 1.25 and n - prev >= 2:
            trend = "up"
        elif n <= prev * 0.75 and prev - n >= 2:
            trend = "down"
        else:
            trend = "flat"
        mult = {"new": 1.5, "up": 1.5, "flat": 1.0, "down": 0.75}[trend]
        types = Counter(r["gap_type"] for r in cur)
        status = types.most_common(1)[0][0]
        to_load = Counter(r["matched_title"] for r in cur
                          if r["gap_type"] == "not_loaded" and r["matched_title"])
        near = catalog.closest(c["terms"]) if c["terms"] else None
        langs = Counter(r["language"] for r in cur)
        cards.append({
            "name": "Other questions" if c.get("other") else _name(c.get("label") or c["terms"]),
            "other": bool(c.get("other")),
            "keywords": c["terms"],
            "questions": n,
            "previous": prev,
            "teams": sorted(teams),
            "trend": trend,
            "score": round(n * max(1, len(teams)) * mult, 1),
            "status": status,
            "status_label": GAPS[status]["label"],
            "owner": GAPS[status]["owner"],
            "action": GAPS[status]["action"],
            "gap_mix": dict(types),
            "languages": dict(langs),
            "load_next": [t for t, _ in to_load.most_common(3)],
            "closest": {"title": near["title"], "year": near["year"], "loaded": near["loaded"]}
            if near else None,
            "examples": [r["question"] for r in sorted(cur, key=lambda r: -r["ts"])[:5]],
        })
    # "Other" always sorts last; it is a leftover bucket, not a topic
    cards.sort(key=lambda c: (c["other"], -c["score"]))

    return {
        "window_days": days,
        "stats": {
            "questions": len(current),
            "answered_pct": round(100 * answered_ok / len(current)) if current else 0,
            "gaps": len(current) - answered_ok,
            "by_type": dict(Counter(r["gap_type"] for r in current if r["gap_type"])),
        },
        "simulated": simulated > 0,
        "facets": facets,
        "clusters": cards,
    }


def export_markdown(rep, top=10):
    s = rep["stats"]
    lines = [f"# Demand Radar: top {top} gaps (last {rep['window_days']} days)", ""]
    if rep["simulated"]:
        lines += ["_Includes simulated demand (seed data). Classification is real._", ""]
    lines += [f"{s['questions']} questions · {s['answered_pct']}% answered well · {s['gaps']} gaps", ""]
    arrows = {"up": "↑", "down": "↓", "flat": "→", "new": "new"}
    for i, c in enumerate([c for c in rep["clusters"] if not c["other"]][:top], 1):
        nt = len(c["teams"])
        lines.append(f"{i}. **{c['name']}** ({c['questions']} questions, {nt} team{'' if nt == 1 else 's'}, "
                     f"trend {arrows[c['trend']]})")
        lines.append(f"   - Status: {c['status_label']} → {c['action']} ({c['owner']})")
        if c["load_next"]:
            lines.append(f"   - Load next: {'; '.join(c['load_next'])}")
        elif c["closest"]:
            lines.append(f"   - Closest WRI work: {c['closest']['title']} ({c['closest']['year']})")
        lines.append(f"   - Example: \"{c['examples'][0]}\"")
    return "\n".join(lines) + "\n"
