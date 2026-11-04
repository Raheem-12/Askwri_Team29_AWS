import os
from collections import Counter
from strands import Agent, tool
from strands.models import BedrockModel

from . import retrieval

MODEL_ID = os.getenv("MODEL_ID", "us.anthropic.claude-sonnet-4-5-20250929-v1:0")

DECLINE = retrieval.DECLINE

RULES = f"""Only use the passages your search tool returns. No outside knowledge.
End every factual sentence with the passage number, like [2] or [1][3].
Don't make up numbers and don't cite a passage that doesn't back up the sentence.
If the search returns NO_RELEVANT_SOURCES, or the passages don't answer the question,
reply with exactly this and nothing else: {DECLINE}
Keep it short. Don't write a source list, the app builds that."""


def model(temp=0.1):
    return BedrockModel(model_id=MODEL_ID, temperature=temp, region_name=retrieval.REGION)


@tool
def search_wri(query: str, program: str = "", language: str = "") -> str:
    """Search WRI publications and return numbered passages.

    Args:
        query: what to search for
        program: optional WRI program, e.g. Cities
        language: optional language code, e.g. en, es, pt
    """
    return retrieval.as_text(retrieval.search(query, program, language))


@tool
def coverage_stats(topic: str) -> str:
    """Count relevant documents on a topic by program and year (for gap analysis)."""
    hits = retrieval.search(topic, k=30, keep=False)
    docs = {h["uri"]: h for h in hits}.values()
    progs = Counter(d["program"] or "unknown" for d in docs)
    years = Counter(d["year"] or "unknown" for d in docs)
    return (f"{len(docs)} relevant docs in the sample corpus\n"
            f"by program: {dict(progs)}\nby year: {dict(years)}\n"
            "note: this is only the sample, not all of WRI's work")


@tool
def ask_agent(question: str) -> str:
    """Answer a research question using WRI publications."""
    agent = Agent(model=model(), tools=[search_wri], callback_handler=None,
                  system_prompt="You answer questions about WRI research.\n" + RULES)
    return str(agent(question))


@tool
def briefing_agent(topic: str) -> str:
    """Write a short cited briefing on a topic."""
    agent = Agent(model=model(), tools=[search_wri], callback_handler=None,
                  system_prompt="Write a briefing from WRI research. Search a few different angles first. "
                                "Sections: Summary, Key findings, Related publications.\n" + RULES)
    return str(agent("Briefing on: " + topic))


@tool
def gap_agent(topic: str) -> str:
    """Say what WRI has covered on a topic and where it looks thin."""
    agent = Agent(model=model(0.3), tools=[search_wri, coverage_stats], callback_handler=None,
                  system_prompt="Describe what WRI has covered on this topic (cited), using coverage_stats "
                                "and a few searches. Then add a section called 'Suggestions (not from WRI "
                                "sources)' with possible gaps. Say the gaps might just be the sample.\n" + RULES)
    return str(agent("Coverage and gaps: " + topic))


@tool
def translate_agent(text: str, target_language: str) -> str:
    """Translate text, leaving the [n] markers where they are."""
    agent = Agent(model=model(0), callback_handler=None,
                  system_prompt="Translate the text. Keep each [n] marker in place and don't add or drop "
                                "claims. Start with a one-line note, in the target language, that this is "
                                "a machine translation.")
    out = str(agent(f"Translate to {target_language}:\n\n{text}"))
    return out + "\n\n---\nOriginal:\n" + text


def supervisor():
    return Agent(
        model=model(), callback_handler=None,
        tools=[ask_agent, briefing_agent, gap_agent, translate_agent],
        system_prompt="Route the request: questions go to ask_agent, briefings to briefing_agent, "
                      "'where is WRI thin' to gap_agent. If they want another language, get the answer "
                      "first and then call translate_agent. Return the specialist's text unchanged, "
                      "[n] markers included, and add nothing of your own. "
                      "If a specialist declines, return its decline message as is.")
