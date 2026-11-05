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
def clean_env(monkeypatch, tmp_path):
    monkeypatch.setenv('RADAR_DB', str(tmp_path / 'radar.db'))  # never touch the real log
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


def test_states_and_provinces_resolve_but_vague_names_do_not():
    entry = geo.resolve_in_quote('Rajasthan', 'Solar pumps in Rajasthan are growing.')
    assert entry and entry['kind'] == 'state' and entry['country'] == 'India'
    assert 24 < entry['lat'] < 30 and 69 < entry['lon'] < 79
    assert geo.pin(entry)['precision'] == 'approximate'
    assert geo.lookup('Brazil')['kind'] == 'country'  # countries still win over same-named provinces
    assert geo.lookup('Central') is None and geo.lookup('Northern') is None
    assert geo.resolve_in_quote('Punjab', 'Farmers in Punjab, India use groundwater.')['country'] == 'India'
    assert geo.resolve_in_quote('Punjab', 'Farmers in Punjab, Pakistan use groundwater.')['country'] == 'Pakistan'


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


# ------------------------------------------------------------ Demand Radar
def radar_rows():
    with backend.radar.connect() as con:
        return [dict(r) for r in con.execute('SELECT * FROM questions')]


def test_globe_question_reaches_radar_with_team_and_is_labeled_simulated_in_demo(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    body = TestClient(backend.app).post('/api/ask', json={'question': 'electric buses in cities', 'team': 'Cities'}).json()
    assert '_top_score' not in body and 'radar' in body
    row = radar_rows()[0]
    assert row['question'] == 'electric buses in cities' and row['team'] == 'Cities' and row['endpoint'] == 'ask'
    assert row['answered'] == 1 and row['source'] == 'seed'
    assert TestClient(backend.app).get('/api/radar').json()['simulated'] is True


def test_real_mode_rows_are_live_and_keep_the_retrieval_score(monkeypatch):
    class Retriever:
        def retrieve(self, **_):
            return {'retrievalResults': [{'score': 0.2, 'content': {'text': PASSAGE}, 'metadata': {'title': 'T'}},
                                         {'score': 0.4, 'content': {'text': PASSAGE}, 'metadata': {'title': 'U'}}]}

    class Generator:
        def converse(self, **_):
            return {'output': {'message': {'content': [{'text': json.dumps(payload())}]}}}

    result = backend.answer_question('flooding in Jakarta', Retriever(), Generator(), 'kb', 'm')
    assert result['sources'][0].keys() == {'id', 'title', 'url', 'page', 'passage'}  # no score sent to the model
    logged = backend.log_to_radar(result)
    assert logged['radar']['gap_type'] == 'weak'  # below RADAR_WEAK_SCORE
    row = radar_rows()[0]
    assert row['source'] == 'live' and row['top_score'] == 0.4


def test_radar_stores_the_masked_question_never_the_raw_one(guard_env, monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    guard = FakeGuard({'action': 'GUARDRAIL_INTERVENED', 'outputs': [{'text': 'electric buses in cities, ask {EMAIL}'}],
                       'assessments': [{'sensitiveInformationPolicy': {'piiEntities': [{'action': 'ANONYMIZED'}]}}]},
                      {'action': 'NONE'})
    monkeypatch.setattr(backend, 'aws_clients', lambda region: (None, guard))
    TestClient(backend.app).post('/api/ask', json={'question': 'electric buses in cities, ask secret-person@example.org'})
    rows = radar_rows()
    assert len(rows) == 1 and 'secret-person' not in rows[0]['question'] and '{EMAIL}' in rows[0]['question']


def test_blocked_questions_are_never_logged(guard_env, monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    guard = FakeGuard({'action': 'GUARDRAIL_INTERVENED', 'outputs': [{'text': 'x'}],
                       'assessments': [{'sensitiveInformationPolicy': {'piiEntities': [{'action': 'BLOCKED'}]}}]})
    monkeypatch.setattr(backend, 'aws_clients', lambda region: (None, guard))
    body = TestClient(backend.app).post('/api/ask', json={'question': 'My card is 4111 1111 1111 1111'}).json()
    assert body['status'] == 'out_of_scope' and 'radar' not in body and radar_rows() == []


def test_glance_summary_searches_by_place_name_and_follow_ups_by_question(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    seen = []

    class Retriever:
        def retrieve(self, **kwargs):
            seen.append(kwargs['retrievalQuery']['text'])
            return {'retrievalResults': []}

    monkeypatch.setattr(backend.demo, 'DemoRetriever', Retriever)
    client = TestClient(backend.app)
    client.post('/api/glance', json={'place': 'Rajasthan'})
    client.post('/api/glance', json={'place': 'Rajasthan', 'question': 'What are the challenges?'})
    assert seen == ['Rajasthan', 'Rajasthan: What are the challenges?']


def test_only_typed_glance_questions_count_as_demand(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    client = TestClient(backend.app)
    client.post('/api/glance', json={'place': 'Jakarta'})
    client.post('/api/briefing', json={'place': 'Jakarta'})
    assert radar_rows() == []
    client.post('/api/glance', json={'place': 'Jakarta', 'question': 'How should drainage be improved?'})
    rows = radar_rows()
    assert len(rows) == 1 and rows[0]['endpoint'] == 'glance' and 'Jakarta' in rows[0]['question']


def test_radar_failure_does_not_cost_the_answer(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')

    def broken(*_, **__):
        raise backend.sqlite3.OperationalError('unable to open database file')

    monkeypatch.setattr(backend.radar, 'log', broken)
    response = TestClient(backend.app).post('/api/ask', json={'question': 'electric buses in cities'})
    assert response.status_code == 200 and response.json()['status'] == 'answered' and response.json()['radar'] is None


def test_relative_radar_db_resolves_to_the_repo_root(monkeypatch):
    monkeypatch.setenv('RADAR_DB', 'data/radar.db')
    assert backend.radar.db_path() == str(backend.REPO / 'data' / 'radar.db')
    monkeypatch.delenv('RADAR_DB')
    assert backend.radar.db_path() == str(backend.REPO / 'data' / 'radar.db')


def test_radar_page_and_api_respond():
    client = TestClient(backend.app)
    assert client.get('/radar').status_code == 200 and 'Demand Radar' in client.get('/radar').text
    assert client.get('/api/radar').json()['stats']['questions'] == 0
    assert 'Demand Radar' in client.get('/api/radar/export').text


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


# ------------------------------------------------------------ answer language
class CapturingGenerator:
    """Records the system prompt and replies with a Spanish claim backed by an English quote."""

    def __init__(self):
        self.systems = []

    def converse(self, system=None, **_):
        self.systems.append(system[0]['text'])
        body = {'answerable': True,
                'claims': [{'text': 'Las inundaciones saturan el drenaje.',
                            'evidence': [{'source_id': 'S1', 'quote': GOOD_QUOTE,
                                          'translation': 'las inundaciones saturan el drenaje'}]}],
                'locations': [{'name': 'Jakarta', 'issue': 'Inundaciones urbanas', 'source_id': 'S1',
                               'quote': 'In Jakarta, Indonesia, flooding strains drainage'}]}
        return {'output': {'message': {'content': [{'text': json.dumps(body)}]}}}


class OnePassageRetriever:
    def retrieve(self, **_):
        return {'retrievalResults': [{'content': {'text': PASSAGE}, 'score': 0.8,
                                      'metadata': {'title': 'T', '_excerpt_page_number': 3}}]}


def live(monkeypatch):
    for name, value in (('AWS_REGION', 'us-east-1'), ('BEDROCK_KB_ID', 'kb'), ('BEDROCK_MODEL_ID', 'm')):
        monkeypatch.setenv(name, value)
    generator = CapturingGenerator()
    monkeypatch.setattr(backend, 'clients', lambda: (OnePassageRetriever(), generator, None, 'kb', 'm'))
    return generator


def test_english_prompt_is_unchanged():
    assert backend.with_language(backend.SYSTEM_ASK, 'en') == backend.SYSTEM_ASK


def test_other_languages_translate_claims_but_never_quotes():
    prompt = backend.with_language(backend.SYSTEM_ASK, 'pt')
    assert 'Brazilian Portuguese' in prompt and 'never translate a quote' in prompt
    assert '"translation"' in prompt and '{{' not in prompt  # the f-string braces rendered


def test_translated_claim_with_original_quote_passes_verification(monkeypatch):
    generator = live(monkeypatch)
    body = TestClient(backend.app).post('/api/ask', json={'question': 'Inundaciones en Yakarta?',
                                                          'language': 'es'}).json()
    assert 'Spanish' in generator.systems[0]
    assert body['status'] == 'answered' and body['language'] == 'es' and body['requested_language'] == 'es'
    assert body['claims'][0]['text'].startswith('Las inundaciones')
    assert body['claims'][0]['evidence'][0]['quote'] == GOOD_QUOTE  # still verbatim English
    assert body['claims'][0]['evidence'][0]['translation'] == 'las inundaciones saturan el drenaje'
    assert body['locations'][0]['name'] == 'Jakarta'


def test_quote_translation_is_never_used_for_verification():
    bad = payload()
    bad['claims'][0]['evidence'][0] = {'source_id': 'S1', 'quote': 'texto que el pasaje no contiene',
                                       'translation': GOOD_QUOTE}
    assert backend.validate_answer(bad, SOURCES)['status'] == 'insufficient_evidence'


def test_glance_and_briefing_pass_the_language_to_the_model(monkeypatch):
    generator = live(monkeypatch)
    client = TestClient(backend.app)
    client.post('/api/glance', json={'place': 'Jakarta', 'language': 'fr'})
    client.post('/api/briefing', json={'place': 'Jakarta', 'language': 'zh'})
    assert 'French' in generator.systems[0] and 'Simplified Chinese' in generator.systems[1]


def test_language_defaults_to_english(monkeypatch):
    generator = live(monkeypatch)
    body = TestClient(backend.app).post('/api/ask', json={'question': 'flooding in Jakarta?'}).json()
    assert body['language'] == 'en' and 'OUTPUT LANGUAGE' not in generator.systems[0]


def test_unknown_language_is_rejected(monkeypatch):
    live(monkeypatch)
    response = TestClient(backend.app).post('/api/ask', json={'question': 'flooding?', 'language': 'xx'})
    assert response.status_code == 422


def test_demo_mode_says_answers_stay_in_english(monkeypatch):
    monkeypatch.setenv('DEMO_MODE', 'true')
    client = TestClient(backend.app)
    assert 'hi' in client.get('/api/status').json()['languages']
    body = client.post('/api/ask', json={'question': 'electric buses in cities', 'language': 'es'}).json()
    assert body['language'] == 'en' and body['requested_language'] == 'es'
