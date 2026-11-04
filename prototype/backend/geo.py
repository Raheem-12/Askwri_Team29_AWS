"""Resolve place names to map coordinates using the bundled gazetteer.

The model never supplies coordinates. A place becomes a pin only if its name
resolves here AND the name appears in the quote the model cited for it.
"""
import json
import re
from functools import lru_cache
from pathlib import Path

GAZETTEER = Path(__file__).with_name('gazetteer.json')
SHORT_ALIAS = 3  # aliases this short (US, UK, DRC) must match case-sensitively


@lru_cache(maxsize=1)
def _load():
    try:
        entries = json.loads(GAZETTEER.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return [], {}
    index = {}
    for entry in entries:
        for alias in entry.get('aliases', []):
            index.setdefault(alias.casefold(), []).append(entry)
    return entries, index


def slug(name):
    return re.sub(r'[^a-z0-9]+', '-', name.casefold()).strip('-')


def _alias_in_text(alias, text):
    flags = 0 if len(alias) <= SHORT_ALIAS else re.IGNORECASE
    return re.search(r'(?<!\w)' + re.escape(alias) + r'(?!\w)', text, flags) is not None


def lookup(name):
    """Best gazetteer entry for a name (largest population wins ties), or None."""
    if not isinstance(name, str):
        return None
    candidates = _load()[1].get(name.strip().casefold(), [])
    return max(candidates, key=lambda e: e.get('pop', 0)) if candidates else None


def _name_candidates(name):
    """The name as written, then its parts: "Jakarta, Indonesia" -> Jakarta, Indonesia.
    Models often append the country. The most specific part comes first."""
    whole = name.strip()
    parts = [p.strip() for p in re.split(r'\s*(?:,|;|/|\(|\)|\band\b)\s*', whole) if p.strip()]
    return [whole] + [p for p in parts if p != whole][:3]


def resolve_in_quote(name, quote):
    """Entry for `name` only if one of its aliases literally appears in `quote`."""
    if not isinstance(name, str) or not isinstance(quote, str):
        return None
    index = _load()[1]
    for candidate in _name_candidates(name):
        matching = [e for e in index.get(candidate.casefold(), [])
                    if any(_alias_in_text(alias, quote) for alias in e.get('aliases', []))]
        if matching:
            return max(matching, key=lambda e: e.get('pop', 0))
    return None


def pin(entry):
    return {'id': slug(entry['name'] + '-' + entry['kind']), 'name': entry['name'],
            'kind': entry['kind'], 'country': entry.get('country'),
            'lat': entry['lat'], 'lon': entry['lon'],
            'precision': 'approximate' if entry['kind'] == 'region' else 'exact'}
