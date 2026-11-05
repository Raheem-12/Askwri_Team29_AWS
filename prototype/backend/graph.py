"""Data for the Research Connection Map.

Parent -> child: WRI topic hubs -> publications (from data/manifest*.csv).
Cross-links come only from evidence in data, never from a model:
  * shared title terms between publications (metadata overlap), and
  * data/graph.json if present (written by an offline job from retrieval results).
Every edge carries a human-readable `reason` shown on hover.
"""
import csv
import json
import re
from itertools import combinations
from pathlib import Path

DATA = Path(__file__).resolve().parents[2] / 'data'
TOPICS = ['Cities', 'Climate', 'Energy', 'Food', 'Forests', 'Freshwater', 'Ocean']
STOP = {'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'how', 'what', 'who', 'are', 'use',
        'a', 'an', 'of', 'to', 'in', 'on', 'by', 'us', 'report', 'guide', 'updated', 'resource', 'framework'}
MIN_SHARED_TERMS = 2


def _terms(title):
    return {w for w in re.findall(r'[a-z]{3,}', title.casefold()) if w not in STOP}


def _read_manifests():
    seen, docs = set(), []
    for name in ('manifest.csv', 'manifest_extra.csv'):
        path = DATA / name
        if not path.exists():
            continue
        with path.open(encoding='utf-8', newline='') as handle:
            for row in csv.DictReader(handle):
                key = (row.get('url') or row.get('title') or '').strip().casefold()
                if not key or key in seen:
                    continue  # manifest_extra repeats rows from manifest
                seen.add(key)
                docs.append(row)
    return docs


def _node_id(prefix, value):
    return prefix + ':' + re.sub(r'[^a-z0-9]+', '-', value.casefold()).strip('-')[:80]


def build_graph(extra_docs=()):
    nodes = {_node_id('topic', t): {'id': _node_id('topic', t), 'type': 'topic', 'label': t} for t in TOPICS}
    edges, docs = [], []
    for row in _read_manifests():
        docs.append({'title': row['title'].strip(), 'program': (row.get('program') or '').strip(),
                     'year': (row.get('date') or '')[:4], 'url': row.get('url') or None, 'sample': False})
    for doc in extra_docs:
        docs.append({'title': doc['title'], 'program': doc['program'], 'year': str(doc.get('year', '')),
                     'url': None, 'sample': True})

    for doc in docs:
        pid = _node_id('pub', doc['title'])
        nodes[pid] = {'id': pid, 'type': 'publication', 'label': doc['title'], 'program': doc['program'],
                      'year': doc['year'], 'url': doc['url'], 'sample': doc['sample']}
        hub = _node_id('topic', doc['program']) if doc['program'] else None
        if hub in nodes:
            edges.append({'source': hub, 'target': pid, 'kind': 'topic',
                          'reason': f"Published under the {doc['program']} program"})

    pubs = [n for n in nodes.values() if n['type'] == 'publication']
    for a, b in combinations(pubs, 2):
        shared = sorted(_terms(a['label']) & _terms(b['label']))
        if len(shared) >= MIN_SHARED_TERMS:
            edges.append({'source': a['id'], 'target': b['id'], 'kind': 'related',
                          'reason': 'Shared title terms: ' + ', '.join(shared)})

    evidence = DATA / 'graph.json'
    if evidence.exists():
        try:
            for edge in json.loads(evidence.read_text(encoding='utf-8')).get('edges', []):
                if edge.get('source') in nodes and edge.get('target') in nodes and edge.get('reason'):
                    edges.append({'source': edge['source'], 'target': edge['target'],
                                  'kind': 'evidence', 'reason': str(edge['reason'])[:200]})
        except (OSError, ValueError):
            pass
    return {'nodes': list(nodes.values()), 'edges': edges}
