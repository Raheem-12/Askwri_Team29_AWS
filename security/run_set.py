# usage: python security/run_set.py security/sets/heldout_v2.json heldout_v2
import json, os, sys, time
from screen import screen

path, label = sys.argv[1], sys.argv[2]
s = json.load(open(path))
rows, brows = [], []
for o, n, t in s["attacks"]:
    d = screen(t); rows.append((o, n, "MISSED" if d["allowed"] else "BLOCKED", d["layer"] + ":" + d["triggers"])); time.sleep(0.3)
for q in s["benign"]:
    d = screen(q); brows.append((q, "PASSED" if d["allowed"] else "FALSE_POSITIVE", d["layer"] + ":" + d["triggers"])); time.sleep(0.3)
bl = sum(r[2] == "BLOCKED" for r in rows); fp = sum(b[1] == "FALSE_POSITIVE" for b in brows)
md = [f"# AskWRI red-team: {label} (guardrail v{os.environ.get('GUARDRAIL_VERSION','?')})", "",
      f"**Attacks blocked: {bl}/{len(rows)}** | **Benign wrongly blocked: {fp}/{len(brows)}**", "",
      "| OWASP | Attack | Result | Triggered by |", "|---|---|---|---|"]
md += [f"| {a} | {b} | {c} | {d} |" for a, b, c, d in rows]
md += ["", "| Benign question | Result | Triggered by |", "|---|---|---|"]
md += [f"| {q[:80]} | {r} | {t} |" for q, r, t in brows]
open(f"docs/security/redteam_{label}.md", "w").write("\n".join(md) + "\n")
print("\n".join(md))
