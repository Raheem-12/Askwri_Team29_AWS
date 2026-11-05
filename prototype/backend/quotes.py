"""Find a model's quote inside a retrieved passage, tolerating PDF-extraction noise.

Why this exists: passages come from PDFs. They contain line-break hyphens ("infra- structure"),
ligatures ("ﬁnancing"), curly quotes, non-breaking spaces and soft hyphens. Models tend to
"tidy" these when they copy a quote, and a plain string comparison then rejects an honest quote.

The rule is still *verbatim*: the quote must match the passage letter for letter (same case,
same words, same order). Only characters that carry no meaning are ignored when comparing:
whitespace, hyphens/dashes, zero-width characters, and the difference between curly and
straight quotes. A match returns the passage's OWN text for that span, so what the reader sees
as "the evidence" is always exactly what the document says, never the model's copy.
"""
import unicodedata

# Characters dropped before comparing. They never change what a sentence says.
_DROP = set('\u00ad\u200b\u200c\u200d\u2060\ufeff')          # soft hyphen, zero-width, BOM
_HYPHENS = set('-\u2010\u2011\u2012\u2013\u2014\u2212')      # hyphen, dashes, minus
_QUOTES = {'\u2018': "'", '\u2019': "'", '\u201a': "'", '\u201b': "'",
           '\u201c': '"', '\u201d': '"', '\u201e': '"', '\u201f': '"', '`': "'"}

MIN_SKELETON = 8  # a match shorter than this proves nothing


def _skeleton(text):
    """(folded characters, index in `text` each one came from)."""
    chars, where = [], []
    for i, ch in enumerate(text):
        if ch in _DROP or ch in _HYPHENS or ch.isspace():
            continue
        for folded in unicodedata.normalize('NFKC', ch):  # 'ﬁ' -> 'f', 'i'
            if folded.isspace() or folded in _HYPHENS or folded in _DROP:
                continue
            chars.append(_QUOTES.get(folded, folded))
            where.append(i)
    return ''.join(chars), where


def locate(quote, passage):
    """The passage's own text for `quote`, or None if the quote is not in the passage."""
    if not isinstance(quote, str) or not isinstance(passage, str):
        return None
    wanted, _ = _skeleton(quote)
    if len(wanted) < MIN_SKELETON:
        return None
    haystack, where = _skeleton(passage)
    start = haystack.find(wanted)
    if start < 0:
        return None
    first, last = where[start], where[start + len(wanted) - 1]
    return passage[first:last + 1]
