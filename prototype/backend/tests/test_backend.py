import json
import sys
from pathlib import Path

import pytest
from botocore.exceptions import ClientError
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import app as backend  # noqa: E402
import geo  # noqa: E402
import graph  # noqa: E402
import guardrails  # noqa: E402

PASSAGE = ('In Jakarta, Indonesia, flooding strains drainage in dense neighborhoods. '
           'In Bogota, Colombia, electric buses replaced diesel on main corridors.')
SOURCES = [dict(id='S1', title='T', url=None, page=3, passage=PASSAGE)]
GOOD_QUOTE = 'flooding strains drainage in dense neighborhoods'


def payload(**overrides):
    base = {'answerable': True,
            'claims': [{'text': 'Flooding strains drainage.',
                        'evidence': [{'source_id': 'S1', 'quote': GOOD_QUOTE}]}],
            'locations': [{'name': 'Jakarta', 'issue': 'Urban flooding', 'source_id': 'S1',
                           'quote': 'In Jakarta, Indonesia, flooding strains drainage'}]}
    base.update(overrides)
    return base


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in ('DEMO_MODE', 'GUARDRAIL_ID', 'GUARDRAIL_VERSION', 'BEDROCK_KB_ID', 'KB_ID',
                 'BEDROCK_MODEL_ID', 'MODEL_ID', 'AWS_REGION', 'KB_TYPE', 'KB_SEARCH_TYPE'):
        monkeypatch.delenv(name, raising=False)


# ------------------------------------------------------------ evidence rules
def test_valid_answer_with_pin():
    result = backend.validate_answer(payload(), SOURCES)
    assert result['status'] == 'answered'
    assert [p['name'] for p in result['locations']] == ['Jakarta']
    assert result['locations'][0]['lat'] == pytest.approx(-6.17, abs=0.01)


def test_fabricated_claim_quote_refuses_whole_answer():
    bad = payload()
    bad['claims'][0]['evidence'][0]['quote'] = 'a sentence the passage never contains'
    assert backend.validate_answer(bad, SOURCES)['status'] == 'insufficient_evidence'


def test_location_whose_quote_is_not_in_passage_is_dropped_but_answer_survives():
    bad = payload(locations=[{'name': 'Jakarta', 'issue': 'Urban flooding', 'source_id': 'S1',
                              'quote': 'Jakarta is mentioned in a quote that does not exist'}])
    result = backend.validate_answer(bad, SOURCES)
    assert result['status'] == 'answered' and result['locations'] == []


def test_location_name_must_appear_in_its_quote():
    bad = payload(locations=[{'name': 'Nairobi', 'issue': 'Invented place', 'source_id': 'S1',
                              'quote': 'In Jakarta, Indonesia, flooding strains drainage'}])
    assert backend.validate_answer(bad, SOURCES)['locations'] == []


def test_place_missing_from_gazetteer_is_dropped():
    atlantis = 'Atlantis'
    sources = [dict(id='S1', title='T', url=None, page=None, passage=f'In {atlantis}, floods rise every year.')]
    bad = {'answerable': True,
           'claims': [{'text': 'Floods rise.', 'evidence': [{'source_id': 'S1', 'quote': f'In {atlantis}, floods rise'}]}],
           'locations': [{'name': atlantis, 'issue': 'Floods', 'source_id': 'S1', 'quote': f'In {atlantis}, floods rise'}]}
    result = backend.validate_answer(bad, sources)
    assert result['status'] == 'answered' and result['locations'] == []


def test_model_coordinates_are_ignored():
    sneaky = payload()
    sneaky['locations'][0].update(lat=0.0, lon=0.0)  # extra field -> that location is dropped
    assert backend.validate_answer(sneaky, SOURCES)['locations'] == []


def test_malformed_location_does_not_kill_the_answer():
    result = backend.validate_answer(payload(locations=['nonsense', {'name': 1}]), SOURCES)
    assert result['status'] == 'answered' and result['locations'] == []


def test_not_answerable_is_refusal():
    assert backend.validate_answer({'answerable': False, 'claims': []}, SOURCES)['status'] == 'insufficient_evidence'


def test_unsafe_urls_rejected():
    assert backend.public_wri_url('https://www.wri.org/research/x') is not None
    for url in ('http://wri.org/x', 'https://evil.com/wri.org', 'https://user:pw@wri.org/x', 'javascript:alert(1)'):
        assert backend.public_wri_url(url) is None


# ------------------------------------------------------------ gazetteer
def test_gazetteer_resolution():
    assert geo.lookup('Jakarta')['kind'] == 'city'
    assert geo.lookup('USA')['name'] == 'United States of America'
    assert geo.resolve_in_quote('US', 'Buses in the US are mostly diesel')['kind'] == 'country'
    assert geo.resolve_in_quote('US', 'Tell us about it') is None  # short aliases are case-sensitive
    assert geo.lookup('Atlantis') is None
    assert geo.pin(geo.lookup('Latin America'))['precision'] == 'approximate'


def test_city_country_names_from_the_model_resolve_to_the_most_specific_place():
    for written, expected in [('Jakarta, Indonesia', 'Jakarta'), ('Bogota, Colombia', 'Bogota'), ('Brazil', 'Brazil')]:
        entry = geo.resolve_in_quote(written, f'In {written}, floods rise.')
        assert entry and entry['name'] == expected, written
    assert geo.resolve_in_quote('Nairobi, Kenya', 'In Jakarta, Indonesia, floods rise.') is None


def test_compound_location_name_makes_a_pin_end_to_end():
    quote = 'In Jakarta, Indonesia, flooding strains drainage'
    result = backend.validate_answer(payload(locations=[
        {'name': 'Jakarta, Indonesia', 'issue': 'Urban flooding', 'source_id': 'S1', 'quote': quote}]), SOURCES)
    assert [p['name'] for p in result['locations']] == ['Jakarta']


@pytest.mark.parametrize('raw', [
    '{"answerable": false, "claims": []}',
    '```json\n{"answerable": false, "claims": []}\n```',
    '```json\n{"answerable": false, "claims": []}\n```\n\nThe passage does not mention this topic.',
    'Here is the result:\n{"answerable": false, "claims": []}\nHope that helps {really}.',
])
def test_model_json_is_extracted_despite_fences_and_commentary(raw):
    assert backend.parse_model_json(raw) == {'answerable': False, 'claims': []}


@pytest.mark.parametrize('raw', ['', 'no json here', '[1, 2]', '{"unrelated": 1}', '{broken'])
def test_unparseable_model_replies_are_rejected(raw):
    with pytest.raises(ValueError):
        backend.parse_model_json(raw)


# ------------------------------------------------------------ configuration
def test_real_mode_without_settings_is_503_and_never_serves_samples():
    response = TestClient(backend.app).post('/api/ask', json={'question': 'electric buses?'})
    assert response.status_code == 503 and 'Setup needed' in response.json()['detail']
    assert 'SAMPLE' not in response.text


def test_demo_mode_is_labeled(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    client = TestClient(backend.app)
    assert client.get('/api/status').json()['demo'] is True
    body = client.post('/api/ask', json={'question': 'electric buses in cities'}).json()
    assert body['demo'] is True and all(s['title'].startswith('SAMPLE') for s in body['sources'])


def test_demo_mode_declines_unanswerable(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    body = TestClient(backend.app).post('/api/ask', json={
        'question': 'What did WRI publish about the 2031 Mars colony water treaty?'}).json()
    assert body['status'] == 'insufficient_evidence' and body['locations'] == []


def test_placeholder_values_count_as_unset(monkeypatch):
    monkeypatch.setenv('BEDROCK_KB_ID', 'REPLACE_AFTER_CREATING_KB')
    assert backend.settings()['BEDROCK_KB_ID'] == ''


def test_retrieval_config_aurora_hybrid_vs_managed(monkeypatch):
    assert backend.retrieval_config(6) == {'vectorSearchConfiguration': {'numberOfResults': 6, 'overrideSearchType': 'HYBRID'}}
    monkeypatch.setenv('KB_SEARCH_TYPE', 'SEMANTIC')
    assert backend.retrieval_config(6)['vectorSearchConfiguration']['overrideSearchType'] == 'SEMANTIC'
    monkeypatch.setenv('KB_TYPE', 'managed')
    assert backend.retrieval_config(6) == {'managedSearchConfiguration': {'numberOfResults': 6}}


def test_unknown_place_rejected(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    client = TestClient(backend.app)
    assert client.post('/api/glance', json={'place': 'Atlantis'}).status_code == 422
    assert client.post('/api/briefing', json={'place': 'Atlantis'}).status_code == 422


def test_temperature_is_not_sent_unless_configured(monkeypatch):
    monkeypatch.delenv('MODEL_TEMPERATURE', raising=False)
    assert backend.inference_config(1800) == {'maxTokens': 1800}  # Sonnet 5.x rejects temperature
    monkeypatch.setenv('MODEL_TEMPERATURE', '0')
    assert backend.inference_config(1800) == {'maxTokens': 1800, 'temperature': 0.0}
    monkeypatch.setenv('MODEL_TEMPERATURE', 'abc')
    assert backend.inference_config(1800) == {'maxTokens': 1800}


# ------------------------------------------------------------ guardrails
class FakeGuard:
    def __init__(self, *responses, error=None):
        self.responses, self.error, self.calls = list(responses), error, []

    def apply_guardrail(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.responses.pop(0)


@pytest.fixture
def guard_env(monkeypatch):
    monkeypatch.setenv('GUARDRAIL_ID', 'gr-123')
    monkeypatch.setenv('GUARDRAIL_VERSION', '1')


def test_input_pii_is_masked_before_retrieval(guard_env):
    guard = FakeGuard({'action': 'GUARDRAIL_INTERVENED', 'outputs': [{'text': 'Contact {EMAIL} about buses'}],
                       'assessments': [{'sensitiveInformationPolicy': {'piiEntities': [{'action': 'ANONYMIZED'}]}}]})
    assert guardrails.check_input(guard, 'Contact a@b.com about buses') == 'Contact {EMAIL} about buses'
    assert guard.calls[0]['source'] == 'INPUT'


def test_denied_topic_is_blocked(guard_env):
    guard = FakeGuard({'action': 'GUARDRAIL_INTERVENED', 'outputs': [{'text': 'blocked'}],
                       'assessments': [{'topicPolicy': {'topics': [{'action': 'BLOCKED'}]}}]})
    with pytest.raises(guardrails.Blocked):
        guardrails.check_input(guard, 'Who will win the election?')


def test_guardrail_failure_fails_closed(guard_env):
    error = ClientError({'Error': {'Code': 'ThrottlingException', 'Message': 'x'}}, 'ApplyGuardrail')
    with pytest.raises(guardrails.GuardrailError):
        guardrails.check_input(FakeGuard(error=error), 'electric buses')


def test_guardrails_off_passes_text_through():
    assert guardrails.configured() is False
    assert guardrails.check_input(FakeGuard(), 'electric buses') == 'electric buses'


def test_output_check_sends_grounding_qualifiers_and_declines_on_intervention(guard_env):
    guard = FakeGuard({'action': 'GUARDRAIL_INTERVENED', 'outputs': [], 'assessments': []})
    assert guardrails.check_output(guard, 'claim', 'question', ['passage']) is False
    qualifiers = [c['text'].get('qualifiers') for c in guard.calls[0]['content']]
    assert qualifiers == [['grounding_source'], ['query'], ['guard_content']]


def test_blocked_question_never_reaches_retrieval(guard_env, monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')

    class Retriever:
        def retrieve(self, **_):
            raise AssertionError('retrieval must not run for a blocked question')

    guard = FakeGuard({'action': 'GUARDRAIL_INTERVENED', 'outputs': [{'text': 'x'}],
                       'assessments': [{'topicPolicy': {'topics': [{'action': 'BLOCKED'}]}}]})
    result = backend.answer_question('Who will win the election?', Retriever(), None, 'kb', 'm', guard)
    assert result['status'] == 'out_of_scope' and result['sources'] == []


def test_grounding_failure_turns_answer_into_refusal(guard_env):
    class Retriever:
        def retrieve(self, **_):
            return {'retrievalResults': [{'content': {'text': PASSAGE}, 'metadata': {'title': 'T'}}]}

    class Generator:
        def converse(self, **_):
            return {'output': {'message': {'content': [{'text': json.dumps(payload())}]}}}

    guard = FakeGuard({'action': 'NONE'}, {'action': 'GUARDRAIL_INTERVENED', 'outputs': [], 'assessments': []})
    result = backend.answer_question('flooding in Jakarta', Retriever(), Generator(), 'kb', 'm', guard)
    assert result['status'] == 'insufficient_evidence' and result['locations'] == []


def test_api_returns_503_when_guardrail_cannot_run(guard_env, monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    error = ClientError({'Error': {'Code': 'AccessDenied', 'Message': 'secret account detail'}}, 'ApplyGuardrail')
    monkeypatch.setattr(backend, 'aws_clients', lambda region: (None, FakeGuard(error=error)))
    response = TestClient(backend.app).post('/api/ask', json={'question': 'electric buses in cities'})
    assert response.status_code == 503 and 'secret account detail' not in response.text


# ------------------------------------------------------------ graph
def test_graph_has_topic_hubs_and_deduplicated_publications():
    data = graph.build_graph()
    topics = [n for n in data['nodes'] if n['type'] == 'topic']
    pubs = [n for n in data['nodes'] if n['type'] == 'publication']
    assert {t['label'] for t in topics} >= {'Cities', 'Freshwater', 'Food', 'Ocean'}
    assert len({p['id'] for p in pubs}) == len(pubs) and len(pubs) >= 5
    ids = {n['id'] for n in data['nodes']}
    assert all(e['source'] in ids and e['target'] in ids and e['reason'] for e in data['edges'])
    assert {'topic', 'related'} <= {e['kind'] for e in data['edges']}
