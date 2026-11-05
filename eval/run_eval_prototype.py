"""Evaluate the REAL pipeline (prototype/backend answer_question) on eval/questions.jsonl.

Usage (from the repo root, with AWS credentials and .env set up):
    python eval/run_eval_prototype.py                # one pass
    python eval/run_eval_prototype.py --runs 3       # repeat to measure flip-flopping
    python eval/run_eval_prototype.py --count 10     # retrieval depth for this run (default 6)
    python eval/run_eval_prototype.py --tag baseline # name of the saved results file

Question fields: id, question, answerable (bool), expected_sources (substrings of titles),
language (optional, default en), history (optional list of {question, answer}).

Reports, per run and overall:
  false refusal rate    answerable questions that were refused          (want: low)
  correct decline rate  unanswerable questions that were refused        (want: high)
  recall / precision    expected sources found in / cited by the answer
  refusal reasons       which layer refused (no_sources, quote_mismatch, grounding, ...)
  consistency           share of questions with the same outcome in every run
"""
import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'prototype' / 'backend'))
import app as backend  # noqa: E402  (loads .env)


def run_once(questions, count):
    retriever, generator, guard, kb, model = backend.clients()
    out = {}
    for q in questions:
        history = [backend.Turn(**t) for t in q.get('history', [])]
        started = time.time()
        try:
            res = backend.answer_question(q['question'], retriever, generator, kb, model, guard,
                                          language=q.get('language', 'en'), history=history, count=count)
        except Exception as error:  # keep going: one failure should not hide the others
            res = {'status': 'error', 'refusal_reason': type(error).__name__, 'sources': []}
        titles = [s['title'].lower() for s in res.get('sources', [])]
        want = [w.lower() for w in q.get('expected_sources', [])]
        found = [w for w in want if any(w in t for t in titles)]
        good = [t for t in titles if any(w in t for w in want)]
        out[q['id']] = {
            'status': res['status'], 'reason': res.get('refusal_reason'),
            'recall': len(found) / len(want) if want else None,
            'precision': len(good) / len(titles) if titles and want else None,
            'seconds': round(time.time() - started, 1), 'dropped': res.get('dropped_claims', 0)}
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else float('nan')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--runs', type=int, default=1)
    ap.add_argument('--count', type=int, default=6)
    ap.add_argument('--tag', default='run')
    ap.add_argument('--file', default=str(ROOT / 'eval' / 'questions.jsonl'))
    args = ap.parse_args()
    questions = [json.loads(l) for l in open(args.file, encoding='utf-8') if l.strip() and 'FILL IN' not in l]
    answerable = {q['id'] for q in questions if q['answerable']}
    runs = [run_once(questions, args.count) for _ in range(args.runs)]

    flat = [(qid, r) for run in runs for qid, r in run.items()]
    ans = [r for qid, r in flat if qid in answerable]
    una = [r for qid, r in flat if qid not in answerable]
    refused = lambda r: r['status'] != 'answered'  # noqa: E731
    print(f'questions: {len(questions)} ({len(answerable)} answerable)   runs: {args.runs}   count: {args.count}')
    print(f'false refusal rate : {mean([refused(r) for r in ans]):.0%}   (answerable questions refused)')
    print(f'correct decline    : {mean([refused(r) for r in una]):.0%}   (unanswerable questions refused)')
    print(f'recall {mean([r["recall"] for r in ans]):.0%}   precision {mean([r["precision"] for r in ans]):.0%}')
    print('refusal reasons    :', dict(Counter(r['reason'] for _, r in flat if refused(r))))
    print(f'avg seconds        : {mean([r["seconds"] for _, r in flat]):.1f}')
    if args.runs > 1:
        same = [len({run[qid]['status'] for run in runs}) == 1 for qid in runs[0]]
        print(f'consistency        : {sum(same)}/{len(same)} questions gave the same outcome every run')
    print('\nanswerable questions that were refused:')
    for qid in runs[0]:
        bad = [run[qid]['reason'] for run in runs if qid in answerable and run[qid]['status'] != 'answered']
        if bad:
            print(f'  {qid}: {bad}')

    results = ROOT / 'eval' / 'results'
    results.mkdir(exist_ok=True)
    (results / f'{args.tag}.json').write_text(json.dumps(runs, indent=1), encoding='utf-8')
    print(f'\nsaved eval/results/{args.tag}.json')


if __name__ == '__main__':
    main()
