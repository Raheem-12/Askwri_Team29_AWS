# DEPRECATED: this scores the agents app in src/, not the globe app. Use eval/run_eval_prototype.py.
# usage: python eval/run_eval.py
# recall = expected docs that showed up in the citations
# precision = cited docs that were expected
# matching is just substring on title/url
import json, sys
sys.path.insert(0, "src")
from askwri.app import answer

recalls, precisions = [], []
declined_ok = unanswerable = 0

for line in open("eval/questions.jsonl"):
    if not line.strip() or "FILL IN" in line:
        continue
    q = json.loads(line)
    out = answer(q["question"], log=False)  # eval runs stay out of Demand Radar
    cited = {(s["title"] + " " + s["url"]).lower() for s in out["sources"]}

    if not q["answerable"]:
        unanswerable += 1
        declined_ok += out["declined"]
        print(q["id"], "declined:", out["declined"])
        continue

    want = [w.lower() for w in q["expected_sources"]]
    found = [w for w in want if any(w in c for c in cited)]
    good = [c for c in cited if any(w in c for w in want)]
    r = len(found) / len(want)
    p = len(good) / len(cited) if cited else 0
    recalls.append(r)
    precisions.append(p)
    print(q["id"], f"recall {r:.2f}  precision {p:.2f}")

avg = lambda xs: sum(xs) / len(xs) if xs else 0
print(f"\nrecall {avg(recalls):.0%}  precision {avg(precisions):.0%}  "
      f"declined {declined_ok}/{unanswerable} unanswerable")
