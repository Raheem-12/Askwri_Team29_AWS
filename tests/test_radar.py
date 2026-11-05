import sqlite3
import time

from fastapi.testclient import TestClient

from askwri import catalog, radar, text
from askwri.app import answer


def rows(path):
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    return [dict(r) for r in con.execute("SELECT * FROM questions")]


# ---------- text helpers ----------

def test_terms_stem_and_drop_stopwords():
    assert text.terms("What has WRI published on electric buses in cities?") == ["electric", "bus", "city"]


def test_guess_language():
    assert text.guess_language("¿Qué ha publicado WRI sobre calor extremo en las ciudades?") == "es"
    assert text.guess_language("Quais estudos do WRI tratam de enchentes em São Paulo?") == "pt"
    assert text.guess_language("How should Lagos prepare for extreme heat?") == "en"


def test_scrub_removes_contact_details():
    s = text.scrub("Email jane.doe@wri.org or call +1 202 555 0100 about heat")
    assert "@" not in s and "555" not in s and "heat" in s


# ---------- catalog ----------

def test_catalog_keeps_versioned_titles_apart():
    titles = {d["title"] for d in catalog.loaded()}
    assert any("Aqueduct 3.0" in t for t in titles) and any("Aqueduct 4.0" in t for t in titles)


def test_catalog_match_flags_unloaded_report():
    hits = catalog.match("What did WRI find about reducing food loss and waste?")
    assert hits and hits[0]["title"] == "Reducing Food Loss and Waste" and not hits[0]["loaded"]


def test_closest_needs_more_than_one_shared_word():
    assert catalog.closest(["data", "center", "water"]) is None or \
        len({"data", "center", "water"} & catalog.closest(["data", "center", "water"])["terms"]) >= 2


# ---------- classification ----------

def test_classify_answered_well():
    assert radar.classify("electric buses", True, 0.8, ["Barriers to Adopting Electric Buses"]) == (None, None)


def test_classify_weak_when_low_score():
    gap, title = radar.classify("electric bus charging grid", True, 0.4, ["Barriers to Adopting Electric Buses"])
    assert gap == "weak" and title == "Barriers to Adopting Electric Buses"


def test_classify_not_loaded():
    gap, title = radar.classify("How much food loss and waste happens after harvest?", False, None)
    assert gap == "not_loaded" and title == "Reducing Food Loss and Waste"


def test_classify_never_published():
    assert radar.classify("How much water do AI data centers use?", False, None) == ("never_published", None)


def test_classify_declined_but_loaded_is_weak():
    gap, _ = radar.classify("Aqueduct 4.0 updated decision relevant global water risk indicators", False, None)
    assert gap == "weak"


# ---------- logging ----------

def test_answer_logs_without_identity(radar_db):
    out = answer("How much water do AI data centers use in Arizona?", team="Water")
    assert out["declined"] and out["radar"]["gap_type"] == "never_published"
    [r] = rows(radar_db)
    assert r["team"] == "Water" and r["answered"] == 0 and r["source"] == "live"
    assert not {"user", "user_id", "name", "email"} & set(r)


def test_answer_logs_answered_question(radar_db):
    out = answer("What do Aqueduct global water risk indicators show for India?")
    assert not out["declined"] and out["radar"]["gap_type"] is None
    [r] = rows(radar_db)
    assert r["answered"] == 1 and r["top_score"] >= radar.WEAK_SCORE


def test_answer_can_skip_logging(radar_db):
    answer("How much water do AI data centers use?", log=False)
    assert not radar_db.exists() or rows(radar_db) == []


def test_retention_deletes_old_rows(radar_db):
    old = time.time() - (radar.RETENTION_DAYS + 1) * radar.DAY
    radar.log("old question about heat", False, ts=old)
    radar.log("new question about heat", False)
    assert [r["question"] for r in rows(radar_db)] == ["new question about heat"]


# ---------- clustering and report ----------

def _seed(questions, days_ago=1, team=None, answered=False):
    for q in questions:
        radar.log(q, answered, 0.9 if answered else None, team=team,
                  ts=time.time() - days_ago * radar.DAY, source="seed")


HEAT = ["How should Lagos prepare for extreme heat?", "Heat resilience plans for Nairobi?",
        "Extreme heat in Accra: what works?", "Urban heat islands in Dakar and extreme heat"]
DATA = ["How much water do AI data centers use?", "Water footprint of data centers in Chile",
        "Do data centers raise water stress?"]


def test_cluster_groups_topics():
    rws = [{"question": q} for q in HEAT + DATA]
    groups = [g for g in radar.cluster(rws) if not g.get("other")]
    assert len(groups) == 2
    names = {g["terms"][0] for g in groups}
    assert "heat" in names and ({"water", "data", "center"} & names)


def test_small_groups_go_to_other():
    rws = [{"question": q} for q in HEAT + ["Lithium mining in the Andes"]]
    out = radar.cluster(rws)
    assert out[-1].get("other") and out[-1]["rows"][0]["question"].startswith("Lithium")


def test_report_ranks_by_demand_and_trend():
    _seed(HEAT, team="Cities")
    _seed(HEAT[:2], team="Africa office")
    _seed(DATA, team="Water", days_ago=10)        # previous window only
    _seed(DATA, team="Water")
    _seed(["What are the barriers to adopting electric buses?"] * 4, answered=True)
    rep = radar.report(days=7)
    assert rep["simulated"] is True
    assert rep["stats"]["questions"] == 13 and rep["stats"]["gaps"] == 9
    top = rep["clusters"][0]
    assert "Heat" in top["name"] and top["questions"] == 6 and top["trend"] == "new"
    assert top["teams"] == ["Africa office", "Cities"] and top["status"] == "never_published"
    data = next(c for c in rep["clusters"] if "Water" in c["name"] or "Data" in c["name"])
    assert data["trend"] == "flat" and data["previous"] == 3


def test_report_filters_by_gap_type():
    _seed(HEAT)
    _seed(["What did WRI find about reducing food loss and waste?"] * 3)
    rep = radar.report(gap="not_loaded")
    assert len(rep["clusters"]) == 1
    assert rep["clusters"][0]["load_next"] == ["Reducing Food Loss and Waste"]


def test_export_markdown():
    _seed(HEAT, team="Cities")
    md = radar.export_markdown(radar.report())
    assert md.startswith("# Demand Radar") and "simulated demand" in md and "Heat" in md


# ---------- API ----------

def test_api_chat_logs_question_without_mode_prefix(radar_db):
    from api.server import app
    c = TestClient(app)
    r = c.post("/api/chat", json={"prompt": "Heat resilience in Lagos", "mode": "brief", "team": "Cities"})
    assert r.status_code == 200 and "_radar" not in r.json()
    [row] = rows(radar_db)
    assert row["question"] == "Heat resilience in Lagos" and row["endpoint"] == "brief"


def test_api_radar_and_page():
    from api.server import app
    _seed(HEAT, team="Cities")
    c = TestClient(app)
    d = c.get("/api/radar", params={"days": 7}).json()
    assert d["clusters"] and d["stats"]["questions"] == 4
    assert c.get("/api/radar/export").text.startswith("# Demand Radar")
    assert "Demand Radar" in c.get("/radar").text
