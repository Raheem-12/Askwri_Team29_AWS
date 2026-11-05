"""Tolerant quote matching, per-claim dropping, retry with feedback, refusal reasons."""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as backend  # noqa: E402
import quotes  # noqa: E402
from test_backend import Replies, SOURCES, ask, payload  # noqa: E402

PDF = ('Cities need better infra- structure for electric buses. The \u201cready\u201d \ufb01nancing gap is '
       'large\u00a0in\nmost countries. Long\u2010term plans cut costs.')


def test_quote_survives_pdf_noise_and_returns_the_passages_own_text():
    got = quotes.locate('better infrastructure for electric buses', PDF)
    assert got == 'better infra- structure for electric buses'
    assert quotes.locate('The "ready" financing gap is large in most countries', PDF).startswith('The \u201cready\u201d')
    assert quotes.locate('Long-term plans cut costs', PDF) == 'Long\u2010term plans cut costs'


@pytest.mark.parametrize('bad', [
    'better INFRASTRUCTURE for electric buses',      # case is meaning: still must match
    'better infrastructure for diesel buses',         # different word
    'electric buses for better infrastructure',       # different order
    'short',                                          # too short to prove anything
    '',
])
def test_quote_that_is_not_in_the_passage_is_rejected(bad):
    assert quotes.locate(bad, PDF) is None


def test_non_strings_are_rejected():
    assert quotes.locate(None, PDF) is None and quotes.locate('long enough quote', None) is None


def _two_claims(second_quote):
    return {'answerable': True, 'claims': [
        {'text': 'Flooding strains drainage.', 'evidence': [{'source_id': 'S1', 'quote': 'flooding strains drainage in dense neighborhoods'}]},
        {'text': 'Second claim.', 'evidence': [{'source_id': 'S1', 'quote': second_quote}]}], 'locations': []}


def test_one_bad_claim_is_dropped_and_the_good_one_survives():
    result = backend.validate_answer(_two_claims('a sentence the passage never contains'), SOURCES)
    assert result['status'] == 'answered' and len(result['claims']) == 1 and result['dropped_claims'] == 1


def test_strict_mode_restores_whole_answer_refusal(monkeypatch):
    monkeypatch.setenv('QUOTE_MODE', 'strict')
    result = backend.validate_answer(_two_claims('a sentence the passage never contains'), SOURCES)
    assert result['status'] == 'insufficient_evidence' and result['refusal_reason'] == 'quote_mismatch'


def test_claim_with_one_good_and_one_bad_quote_is_dropped_whole():
    mixed = {'answerable': True, 'claims': [{'text': 'Mixed.', 'evidence': [
        {'source_id': 'S1', 'quote': 'flooding strains drainage in dense neighborhoods'},
        {'source_id': 'S1', 'quote': 'something invented by the model'}]}], 'locations': []}
    assert backend.validate_answer(mixed, SOURCES)['refusal_reason'] == 'quote_mismatch'


def test_failed_quotes_trigger_one_retry_that_tells_the_model_why():
    bad = payload()
    bad['claims'][0]['evidence'][0]['quote'] = 'a sentence the passage never contains'
    generator = Replies(bad, payload())
    result = ask(generator)
    assert result['status'] == 'answered' and len(generator.bodies) == 2
    assert 'correction' not in generator.bodies[0] and 'character for character' in generator.bodies[1]['correction']


def test_refusal_reasons_are_labelled():
    assert backend.validate_answer({'answerable': False, 'claims': []}, SOURCES)['refusal_reason'] == 'model_unanswerable'
    assert backend.refusal('no_sources')['refusal_reason'] == 'no_sources'
    bad = payload()
    bad['claims'][0]['evidence'][0]['quote'] = 'a sentence the passage never contains'
    assert ask(Replies(bad, bad))['refusal_reason'] == 'quote_mismatch'
