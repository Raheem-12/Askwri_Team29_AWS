"""Report (and optionally suggest fixes for) metadata gaps in data/manifest_corpus.csv.

    python scripts/audit_manifest.py                 # print a summary
    python scripts/audit_manifest.py --write         # also write data/manifest_corpus.todo.csv

Why it matters: a row with no `url` gives citations with no link, no `language` makes language
filters useless, no `program` hides the document from program filters, and duplicate titles
make source matching and the Connections map ambiguous. This script never edits the manifest:
it writes a separate TODO file with a `suggested_language` column that a person must confirm.
"""
import argparse
import csv
import re
from collections import Counter
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / 'data' / 'manifest_corpus.csv'
CJK = re.compile(r'[\u4e00-\u9fff]')


def suggest_language(row):
    title = row['title']
    if CJK.search(title) or re.search(r'\bCN\b', title):
        return 'zh'
    return ''  # do not guess other languages; ask whoever owns the PDF


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--write', action='store_true')
    args = ap.parse_args()
    rows = list(csv.DictReader(open(SRC, encoding='utf-8-sig')))
    titles = Counter(r['title'].strip().lower() for r in rows)
    print(f'{len(rows)} documents in {SRC.name}')
    for col in ('url', 'date', 'program', 'language'):
        print(f'  missing {col:9}: {sum(1 for r in rows if not (r.get(col) or "").strip())}')
    dups = {t: n for t, n in titles.items() if n > 1}
    print(f'  duplicate titles: {len(dups)}')
    for t, n in sorted(dups.items(), key=lambda kv: -kv[1])[:10]:
        print(f'    x{n}  {t[:90]}')
    if args.write:
        out = SRC.with_name('manifest_corpus.todo.csv')
        fields = list(rows[0].keys()) + ['problems', 'suggested_language']
        with open(out, 'w', newline='', encoding='utf-8') as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            for r in rows:
                problems = [c for c in ('url', 'date', 'program', 'language') if not (r.get(c) or '').strip()]
                if titles[r['title'].strip().lower()] > 1:
                    problems.append('duplicate_title')
                if problems:
                    w.writerow({**r, 'problems': ' '.join(problems), 'suggested_language': suggest_language(r)})
        print(f'wrote {out}')


if __name__ == '__main__':
    main()
