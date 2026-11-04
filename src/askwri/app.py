import re

from . import radar, retrieval
from .retrieval import DECLINE

try:
    from bedrock_agentcore.runtime import BedrockAgentCoreApp
    app = BedrockAgentCoreApp()
except ImportError:  # local mock runs don't need the AgentCore SDK
    app = None

agent = None


def _mock_agent(prompt):
    """Offline stand-in for the supervisor: cite the top passages, or decline."""
    hits = retrieval.search(prompt)[:2]
    if not hits:
        return DECLINE
    return " ".join(f"WRI covers this in \"{h['title']}\" ({h['year']}) [{h['n']}]." for h in hits)


def answer(prompt, team=None, endpoint="ask", log=True):
    global agent
    seen = retrieval.reset()

    if retrieval.mock_mode():
        text = _mock_agent(prompt)
    else:
        from .agents import supervisor
        agent = agent or supervisor()
        text = str(agent(prompt)).strip()

    cited = {int(n) for n in re.findall(r"\[(\d+)\]", text)}
    declined = text.startswith(DECLINE[:30])

    # don't trust the model on this: no citations, or a citation we never
    # retrieved, means we decline
    if not declined and (not cited or not cited <= set(seen)):
        text, declined, cited = DECLINE, True, set()

    sources = [] if declined else [seen[n] for n in sorted(cited)]
    top = max((p["score"] for p in seen.values()), default=None)
    out = {"answer": text, "declined": declined, "sources": sources,
           "_radar": {"top_score": top}}
    if log:
        out["radar"] = radar.log_answer(prompt, out, team=team, endpoint=endpoint)
    return out


if app is not None:
    @app.entrypoint
    def invoke(payload):
        out = answer(payload.get("prompt", ""), team=payload.get("team"))
        out.pop("_radar", None)
        return out

if __name__ == "__main__" and app is not None:
    app.run()
