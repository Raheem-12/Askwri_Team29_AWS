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


# ------------------------------------------------------------ tightened matching
@pytest.mark.parametrize('quote, passage', [
    ('no table food supply', 'a notable food supply remains'),         # a space inside a word changes the word
    ('reduced by 5-10%', 'it was reduced by 510% overall'),             # a range is not one number
    ('reduced by 510% overall', 'it was reduced by 5-10% overall'),
    ('heat risk of flooding', 'the wheat risk of flooding grows'),      # starts inside a word
    ('the risk of flood', 'the risk of flooding grows here'),           # ends inside a word
    ('5 percent of land', 'about 0.5 percent of land is left'),         # starts inside a decimal
    ('rose to 3 percent', 'rose to 3.5 percent in total'),              # different number
    ('prices rose to 3', 'prices rose to 3.5 percent'),                 # ends inside a decimal
    ('fell by 5 percent', 'fell by -5 percent overall'),                # loses a minus sign
    ('5 percent change', 'a -5 percent change here'),
    ('rose to 3. 5 percent', 'rose to 3.5 percent'),                    # a space inside a number
    ('count of 1 000 cities', 'a count of 1000 cities'),
])
def test_quotes_that_change_the_meaning_are_rejected(quote, passage):
    assert quotes.locate(quote, passage) is None


@pytest.mark.parametrize('quote, passage, expected', [
    ('rate rose by 2 %', 'the rate rose by 2% here', 'rate rose by 2%'),                         # space by punctuation
    ('between 2019-2023 data', 'between 2019–2023 data', 'between 2019–2023 data'),    # dash style in a range
    ('between 5 - 10 percent', 'between 5-10 percent', 'between 5-10 percent'),
    ('levels from pre-1990 onward', 'levels from pre 1990 onward', 'levels from pre 1990 onward'),
    ('the COVID-19 pandemic', 'the COVID‑19 pandemic', 'the COVID‑19 pandemic'),
    ('electric pursuing fleets', 'electric pursu-\ning fleets', 'electric pursu-\ning fleets'),   # line-break hyphen
    ('soft hyphen breaks here', 'soft hy­ phen breaks here', 'soft hy­ phen breaks here'),
    ('fell by -5 percent', 'fell by −5 percent', 'fell by −5 percent'),                # minus style
    ('ends in a sentence.', 'it ends in a sentence. Then more', 'ends in a sentence.'),
    ('a repeat that matches', 'not a repeat that matchesx but a repeat that matches', 'a repeat that matches'),
    ('城市需要更好的基础', '所有城市需要更好的基础设施',
     '城市需要更好的基础'),                                   # Chinese has no word spaces
    ('शहरों को बेहतर', 'सभी शहरों को बेहतर ढांचा',
     'शहरों को बेहतर'),               # Hindi marks are part of a word
])
def test_honest_quotes_still_match_and_return_the_passages_text(quote, passage, expected):
    assert quotes.locate(quote, passage) == expected
