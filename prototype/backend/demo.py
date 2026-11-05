"""Clearly labeled SAMPLE data so the UI can be built and tested before the
Knowledge Base exists. Enabled only by DEMO_MODE=true.

Only the two boto3 clients are replaced. The real prompts, JSON schema, quote
verification, gazetteer lookup and guardrail wiring still run, so what you see
in demo mode exercises the production code path. Nothing here is WRI research:
every title starts with "SAMPLE" and every passage states what it is.
"""
import json
import re

# sentences are verbatim passage text; places point at a sentence that names them
DOCS = [
    {'title': 'SAMPLE - Electric bus corridors in Bogota', 'program': 'Cities', 'year': 2024, 'page': 4,
     'sentences': ['SAMPLE TEXT: This invented passage stands in for a WRI study on electric buses.',
                   'In Bogota, Colombia, the sample scenario describes electric buses replacing diesel buses on main corridors.',
                   'The sample scenario links the change to lower tailpipe air pollution along those corridors.'],
     'places': [('Bogota', 'Electric bus adoption on main corridors', 1)]},
    {'title': 'SAMPLE - Urban flooding and drainage in Jakarta', 'program': 'Cities', 'year': 2023, 'page': 11,
     'sentences': ['SAMPLE TEXT: This invented passage stands in for a WRI study on urban flood risk.',
                   'In Jakarta, Indonesia, the sample scenario describes repeated flooding that strains drainage in dense neighborhoods.',
                   'The sample scenario recommends pairing drainage upgrades with land-use planning.'],
     'places': [('Jakarta', 'Urban flooding and strained drainage', 1)]},
    {'title': 'SAMPLE - Water stress indicators for river basins', 'program': 'Freshwater', 'year': 2023, 'page': 7,
     'sentences': ['SAMPLE TEXT: This invented passage stands in for a WRI water risk assessment.',
                   'In India, the sample scenario describes groundwater withdrawals that exceed natural recharge in several regions.',
                   'In Mexico, the sample scenario describes competition between farms and cities for river water.'],
     'places': [('India', 'Groundwater withdrawals exceeding recharge', 1),
                ('Mexico', 'Farm and city competition for river water', 2)]},
    {'title': 'SAMPLE - Forest restoration on degraded land', 'program': 'Forests', 'year': 2022, 'page': 15,
     'sentences': ['SAMPLE TEXT: This invented passage stands in for a WRI forest restoration report.',
                   'In Brazil, the sample scenario describes restoring degraded pasture to forest along the Amazon Basin.',
                   'In Kenya, the sample scenario describes farmer-led tree regrowth on cropland.'],
     'places': [('Brazil', 'Restoring degraded pasture to forest', 1),
                ('Kenya', 'Farmer-led tree regrowth on cropland', 2)]},
    {'title': 'SAMPLE - Clean energy policy in Southeast Asia', 'program': 'Energy', 'year': 2024, 'page': 9,
     'sentences': ['SAMPLE TEXT: This invented passage stands in for a WRI clean energy policy brief.',
                   'In Southeast Asia, the sample scenario describes grid limits that slow the connection of new solar projects.',
                   'In South Africa, the sample scenario describes power shortages that raise interest in rooftop solar.'],
     'places': [('Southeast Asia', 'Grid limits slowing new solar', 1),
                ('South Africa', 'Power shortages and rooftop solar', 2)]},
    {'title': 'SAMPLE - Food loss in supply chains', 'program': 'Food', 'year': 2021, 'page': 5,
     'sentences': ['SAMPLE TEXT: This invented passage stands in for a WRI food systems report.',
                   'In Nigeria, the sample scenario describes crop losses between harvest and market caused by poor storage.',
                   'The sample scenario suggests shared cold storage as a low-cost response.'],
     'places': [('Nigeria', 'Crop losses from poor storage', 1)]},
]

PROGRAM_SAMPLE_DOCS = [{'title': d['title'], 'program': d['program'], 'year': d['year']} for d in DOCS]
_STOP = {'what', 'does', 'about', 'with', 'from', 'that', 'this', 'have', 'wri', 'research', 'say', 'says',
         'tell', 'main', 'issues', 'issue', 'there', 'their', 'which', 'would', 'could', 'should', 'your'}


def _terms(text):
    return {w for w in re.findall(r'[a-z]{4,}', text.lower()) if w not in _STOP}


def _passage(doc):
    return ' '.join(doc['sentences'])


class DemoRetriever:
    def retrieve(self, knowledgeBaseId=None, retrievalQuery=None, retrievalConfiguration=None, **_):
        query = _terms(retrievalQuery['text'])
        # One shared word is not evidence. Require two shared terms once the query has several,
        # so an off-topic question is declined the way the real pipeline declines it.
        needed = 2 if len(query) >= 3 else 1
        scored = []
        for doc in DOCS:
            text = _passage(doc)
            score = len(query & _terms(text + ' ' + doc['title'] + ' ' + doc['program']))
            if score >= needed:
                scored.append((score, doc))
        scored.sort(key=lambda pair: -pair[0])
        return {'retrievalResults': [
            {'content': {'text': _passage(doc)},
             'metadata': {'title': doc['title'], 'public_url': None, '_excerpt_page_number': doc['page']}}
            for _, doc in scored[:6]]}


class DemoGenerator:
    """Builds the same JSON a model would, using only sentences from the passages."""

    def converse(self, modelId=None, system=None, messages=None, inferenceConfig=None, **_):
        mode = re.match(r'MODE:\s*(\w+)', system[0]['text']).group(1)
        payload = json.loads(messages[0]['content'][0]['text'])
        passages = payload['passages']
        by_text = {_passage(d): d for d in DOCS}

        def claim(source, sentence):
            return {'text': sentence.replace('SAMPLE TEXT: ', ''),
                    'evidence': [{'source_id': source['id'], 'quote': sentence}]}

        def sentences(source):
            return by_text[source['passage']]['sentences']

        if mode == 'briefing':
            overview = [claim(s, sentences(s)[0]) for s in passages[:2]]
            findings = [claim(s, x) for s in passages for x in sentences(s)[1:]][:5]
            body = {'answerable': bool(passages), 'overview': overview, 'key_findings': findings}
        elif mode == 'glance':
            place = payload.get('place', '').casefold()
            claims = []
            for s in passages[:3]:
                hit = next((x for x in sentences(s) if place and place in x.casefold()), None)
                if hit:
                    claims.append(claim(s, hit))
            body = {'answerable': bool(claims), 'claims': claims}
        else:
            claims, locations = [], []
            for s in passages[:3]:
                doc = by_text[s['passage']]
                claims.append(claim(s, doc['sentences'][1]))
                for name, issue, index in doc['places']:
                    locations.append({'name': name, 'issue': issue, 'source_id': s['id'],
                                      'quote': doc['sentences'][index]})
            body = {'answerable': bool(claims), 'claims': claims, 'locations': locations}
        return {'output': {'message': {'content': [{'text': json.dumps(body)}]}}}
