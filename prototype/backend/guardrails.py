"""Amazon Bedrock Guardrails via the standalone ApplyGuardrail API.

Why ApplyGuardrail and not guardrailConfig on Converse: the question must be
checked and PII-masked BEFORE it reaches Knowledge Base retrieval, which a
Converse guardrail would never see. See docs/guardrails-setup.md.

Rules enforced here:
  * If a guardrail is configured and the call fails, FAIL CLOSED (GuardrailError).
  * Never log or return assessments: they can echo the PII that triggered them.
  * The output check runs on the claim text, not the raw JSON, and cited passages
    are passed as grounding sources. Masking inside quotes would break quote
    verification, so quotes are never rewritten.
"""
import os

from botocore.exceptions import BotoCoreError, ClientError

OUT_OF_SCOPE = ('AskWRI answers questions about WRI research on cities, climate, energy, '
                'food, forests, freshwater and the ocean. Try rephrasing your question.')
MAX_GROUNDING_CHARS = 100_000


class GuardrailError(Exception):
    """A configured guardrail could not be applied; the request must not proceed."""


class Blocked(Exception):
    """The guardrail blocked the content (denied topic, prompt attack, blocked PII...)."""


def identifiers():
    return os.getenv('GUARDRAIL_ID', '').strip(), os.getenv('GUARDRAIL_VERSION', '').strip()


def configured():
    gid, version = identifiers()
    return bool(gid and version)


def _blocked(assessments):
    """True if any policy blocked content; False if the only action was masking."""
    for assessment in assessments or []:
        for item in assessment.get('topicPolicy', {}).get('topics', []):
            if item.get('action') == 'BLOCKED':
                return True
        for item in assessment.get('contentPolicy', {}).get('filters', []):
            if item.get('action') == 'BLOCKED':
                return True
        for item in assessment.get('wordPolicy', {}).get('customWords', []) + \
                assessment.get('wordPolicy', {}).get('managedWordLists', []):
            if item.get('action') == 'BLOCKED':
                return True
        pii = assessment.get('sensitiveInformationPolicy', {})
        for item in pii.get('piiEntities', []) + pii.get('regexes', []):
            if item.get('action') == 'BLOCKED':
                return True
        for item in assessment.get('contextualGroundingPolicy', {}).get('filters', []):
            if item.get('action') == 'BLOCKED':
                return True
    return False


def _apply(client, source, content):
    gid, version = identifiers()
    try:
        return client.apply_guardrail(guardrailIdentifier=gid, guardrailVersion=version,
                                      source=source, content=content)
    except (BotoCoreError, ClientError) as error:
        raise GuardrailError('Guardrail could not be applied.') from error


def check_input(client, text):
    """Return the question to use downstream (PII masked). Raises Blocked / GuardrailError."""
    return _checked(client, 'INPUT', text)


def check_earlier_answer(client, text):
    """Check an earlier answer sent back by the browser. It is model output, so it is checked as
    output: the prompt-attack filter reads a question-and-answer transcript as an attack."""
    return _checked(client, 'OUTPUT', text)


def _checked(client, source, text):
    if not configured():
        return text
    response = _apply(client, source, [{'text': {'text': text}}])
    if response.get('action') != 'GUARDRAIL_INTERVENED':
        return text
    if _blocked(response.get('assessments')):
        raise Blocked(OUT_OF_SCOPE)
    masked = ''.join(o.get('text', '') for o in response.get('outputs', []))
    if not masked.strip():
        raise Blocked(OUT_OF_SCOPE)
    return masked


def check_output(client, answer_text, question, passages):
    """False if the answer is blocked or fails grounding; True otherwise. Raises GuardrailError."""
    if not configured():
        return True
    grounding = '\n\n'.join(passages)[:MAX_GROUNDING_CHARS]
    content = [{'text': {'text': grounding, 'qualifiers': ['grounding_source']}},
               {'text': {'text': question, 'qualifiers': ['query']}},
               {'text': {'text': answer_text, 'qualifiers': ['guard_content']}}]
    response = _apply(client, 'OUTPUT', content)
    # Any intervention declines the answer. Rewriting claim text would desync it from
    # its verbatim quotes, and returning PII that was meant to be masked is worse
    # than a decline.
    return response.get('action') != 'GUARDRAIL_INTERVENED'
