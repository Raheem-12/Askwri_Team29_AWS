import re
from bedrock_agentcore.runtime import BedrockAgentCoreApp

from . import retrieval
from .agents import supervisor, DECLINE

app = BedrockAgentCoreApp()
agent = None


def answer(prompt):
    global agent
    agent = agent or supervisor()
    seen = retrieval.reset()

    text = str(agent(prompt)).strip()
    cited = {int(n) for n in re.findall(r"\[(\d+)\]", text)}
    declined = text.startswith(DECLINE[:30])

    # don't trust the model on this: no citations, or a citation we never
    # retrieved, means we decline
    if not declined and (not cited or not cited <= set(seen)):
        text, declined, cited = DECLINE, True, set()

    sources = [] if declined else [seen[n] for n in sorted(cited)]
    return {"answer": text, "declined": declined, "sources": sources}


@app.entrypoint
def invoke(payload):
    return answer(payload.get("prompt", ""))


if __name__ == "__main__":
    app.run()
