"""Seed Demand Radar with simulated demand so the /radar page has something to show.

usage: ASKWRI_MOCK=1 python scripts/seed_radar.py [--reset] [--days 14]

The questions are written to match WRI's user types (researchers, comms, global offices).
Every one runs through the real answer + classification path; only the traffic is simulated.
Rows are stored with source='seed' and the page labels them as simulated.
Replace or extend TOPICS with real questions from WRI staff when you can get them.
"""
import argparse
import json
import os
import random
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "src"))
from askwri import radar, retrieval  # noqa: E402
from askwri.app import answer  # noqa: E402

TEAMS = ["Cities", "Food", "Forests", "Water", "Climate", "Energy", "Communications",
         "Brazil office", "India office", "Africa office", "Mexico office", "Indonesia office"]

# (templates, fills, how many, trend, teams to draw from)
# trend: "up" = mostly last week, "down" = mostly the week before, "flat" = even
TOPICS = [
    # gaps that should come out as "no match in catalog"
    (["How should {x} prepare for extreme heat?",
      "What does WRI recommend on heat resilience in {x}?",
      "Has WRI studied urban heat islands in {x}?",
      "How can informal settlements in {x} stay cool during extreme heat?"],
     ["Lagos", "Nairobi", "Accra", "Dakar", "Kampala", "Addis Ababa", "African cities"],
     38, "up", ["Cities", "Africa office", "Climate", "Communications", "Water", "Energy"]),
    (["How much water do AI data centers use in {x}?",
      "What is the water footprint of data centers in {x}?",
      "Do data centers increase water stress in {x}?"],
     ["Arizona", "Chile", "India", "Ireland", "drought regions"],
     17, "new", ["Water", "Energy", "Communications"]),
    (["What are the risks of critical minerals mining for {x}?",
      "How does lithium mining affect water and communities in {x}?",
      "What has WRI said about critical minerals supply chains for {x}?"],
     ["batteries", "the Andes", "Indonesia", "the energy transition"],
     14, "flat", ["Energy", "Indonesia office", "Climate"]),
    (["¿Qué ha publicado WRI sobre calor extremo en {x}?",
      "¿Cómo pueden {x} adaptarse al calor extremo?",
      "¿Hay estudios de WRI sobre olas de calor en {x}?"],
     ["ciudades de México", "Monterrey", "Bogotá", "Lima"],
     11, "up", ["Mexico office", "Cities"]),
    (["Quais estudos do WRI tratam de enchentes urbanas em {x}?",
      "Como {x} pode reduzir o risco de enchentes?"],
     ["Porto Alegre", "São Paulo", "Recife"],
     8, "up", ["Brazil office", "Water"]),
    # gaps that should come out as "not loaded yet" (in data/catalog.csv, not in the corpus)
    (["How much food loss and waste happens {x}?",
      "What did WRI find about reducing food loss and waste {x}?",
      "What are the best ways to cut food loss and waste {x}?"],
     ["in the supply chain", "in developing countries", "after harvest", "globally"],
     15, "flat", ["Food", "Communications", "India office"]),
    (["How should companies account for {x} under the Greenhouse Gas Protocol corporate standard?",
      "What does the Greenhouse Gas Protocol corporate standard say about {x}?"],
     ["scope 3 emissions", "purchased electricity", "subsidiaries", "base year recalculation"],
     12, "down", ["Climate", "Energy"]),
    (["What are the economics and finance of restoring degraded land in {x}?",
      "How do you finance restoring land and landscapes in {x}?"],
     ["Africa", "India", "Latin America"],
     9, "flat", ["Forests", "Africa office", "India office"]),
    (["How can cities be safer by design for {x}?",
      "What street design makes cities safer by design for {x}?"],
     ["pedestrians", "cyclists", "children", "bus riders"],
     8, "down", ["Cities", "Mexico office"]),
    # weak coverage: the corpus touches it, but only thinly
    (["What are the grid impacts of electric bus charging in {x}?",
      "How does electric bus charging affect the power grid in {x}?"],
     ["Santiago", "Shenzhen", "London", "Bogotá"],
     9, "up", ["Cities", "Energy"]),
    (["Can drought insurance offset water risk?",
      "How does drought insurance reduce water risk?"],
     [""],
     7, "up", ["Water", "Food"]),
    # answered well: these keep the "% answered" honest
    (["What are the barriers to adopting electric buses in {x}?",
      "How can {x} enable electric bus adoption?"],
     ["Latin America", "Indian cities", "Africa", "Europe", "cities"],
     90, "flat", ["Cities", "Communications", "India office", "Mexico office"]),
    (["How can US school districts electrify school bus fleets {x}?",
      "What does the electric school bus market study say about {x}?"],
     ["equitably", "costs", "fleet electrification"],
     60, "flat", ["Cities", "Communications"]),
    (["What do Aqueduct global water risk indicators show for {x}?",
      "Which Aqueduct water risk indicators matter for {x}?"],
     ["India", "Mexico", "the Middle East", "agriculture"],
     70, "flat", ["Water", "India office", "Communications"]),
    (["What does Creating a Sustainable Food Future say about {x}?",
      "How can we create a sustainable food future with {x}?"],
     ["diets", "crop yields", "land use", "2050"],
     60, "flat", ["Food", "Communications"]),
]


def _ts(rng, trend, days, now):
    recent = {"up": 0.75, "new": 1.0, "down": 0.25, "flat": 0.5}[trend]
    lo, hi = (0, days / 2) if rng.random() < recent else (days / 2, days)
    return now - rng.uniform(lo, hi) * radar.DAY


def eval_questions():
    path = os.path.join(radar.catalog.ROOT, "eval", "questions.jsonl")
    out = []
    for line in open(path, encoding="utf-8"):
        if line.strip() and "FILL IN" not in line:
            out.append(json.loads(line)["question"])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reset", action="store_true", help="delete earlier seed rows first")
    ap.add_argument("--days", type=int, default=14, help="spread questions over this many days")
    ap.add_argument("--seed", type=int, default=29)
    args = ap.parse_args()

    if not retrieval.mock_mode():
        print("note: ASKWRI_MOCK is off, so every question calls Bedrock")
    if args.reset:
        radar.clear(source="seed")

    rng = random.Random(args.seed)
    now = time.time()
    jobs = []
    for templates, fills, n, trend, teams in TOPICS:
        for _ in range(n):
            q = rng.choice(templates).format(x=rng.choice(fills))
            jobs.append((q, rng.choice(teams), _ts(rng, trend, args.days, now)))
    for q in eval_questions():
        jobs.append((q, None, now - rng.uniform(0, args.days) * radar.DAY))

    counts = {}
    for q, team, ts in jobs:
        out = answer(q, team=team, log=False)
        res = radar.log_answer(q, out, team=team, ts=ts, source="seed")
        key = res["gap_type"] or "answered"
        counts[key] = counts.get(key, 0) + 1
    print(f"seeded {len(jobs)} questions into {radar.db_path()}: {counts}")


if __name__ == "__main__":
    main()
