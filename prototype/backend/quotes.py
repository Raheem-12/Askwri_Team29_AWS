"""Find a model's quote inside a retrieved passage, tolerating PDF-extraction noise.

Why this exists: passages come from PDFs. They contain line-break hyphens ("infra- structure"),
ligatures ("ﬁnancing"), curly quotes, non-breaking spaces and soft hyphens. Models tend to
"tidy" these when they copy a quote, and a plain string comparison then rejects an honest quote.

The rule is still *verbatim*: same case, same words, same order, same numbers. Noise is ignored
only where it can't change what a sentence says:

  * Zero-width characters and curly versus straight quotes never matter.
  * A run of whitespace counts as one space between two letters or digits ("no table" is not
    "notable"). Beside punctuation it doesn't count ("2 %" is "2%"), except inside a number
    ("3. 5" is not "3.5").
  * A hyphen joining two letters may vanish, with any line break after it ("infra- structure" is
    "infrastructure"). Between two digits it stays ("5-10" is not "510"), and all dash styles
    are the same there. A minus sign stays ("-5" is not "5").
  * A match must start and end on a word and number boundary ("heat risk" is not in "wheat risk",
    and "5 percent" is not in "0.5 percent").

A match returns the passage's OWN text for that span, so what the reader sees as "the evidence"
is always exactly what the document says, never the model's copy.
"""
import unicodedata

_DROP = set('​‌‍⁠﻿')                # zero-width characters, BOM
_JOINERS = set('-­‐‑')                        # hyphens that can split or join a word
_DASHES = set('‒–—―−')              # figure, en and em dashes, minus
_QUOTES = {'‘': "'", '’': "'", '‚': "'", '‛': "'",
           '“': '"', '”': '"', '„': '"', '‟': '"', '`': "'"}
_ANY_DASH = _JOINERS | _DASHES

MIN_SKELETON = 8  # a match shorter than this proves nothing


def _is_word(ch):
    """A letter, digit or combining mark. Hindi vowel signs are marks, and they are part of a word."""
    return ch.isalnum() or unicodedata.category(ch).startswith('M')


def _no_spaces(ch):
    """Chinese and Japanese don't put spaces between words, so word boundaries don't apply."""
    return '぀' <= ch <= 'ヿ' or '㐀' <= ch <= '鿿' or '豈' <= ch <= '﫿'


def _fold(text):
    """(characters, index in `text` each one came from), with ligatures and quote styles undone."""
    chars, where = [], []
    for i, ch in enumerate(text):
        for folded in unicodedata.normalize('NFKC', ch):
            if folded not in _DROP:
                chars.append(_QUOTES.get(folded, folded))
                where.append(i)
    return chars, where


def _space_counts(out, after):
    """Whether whitespace between the text so far and the next character is significant."""
    if not out or not after:
        return False
    before = out[-1]
    if _is_word(before) and _is_word(after):
        return not (_no_spaces(before) and _no_spaces(after))
    return after.isdigit() and before in '.,' and len(out) > 1 and out[-2].isdigit()  # "3. 5" is not "3.5"


def _separator(run, out, after):
    """What a run of whitespace and dashes between two characters compares as."""
    dashes = [ch for ch in run if ch in _ANY_DASH]
    before = out[-1] if out else None
    if dashes:
        if before and after and before.isdigit() and after.isdigit():
            return '-'
        if after and after.isdigit() and run[-1] in _ANY_DASH and (not before or not _is_word(before) or run[0].isspace()):
            return (' -' if before and _is_word(before) else '-')  # a minus sign
        if before and after and before.isalpha() and after.isalpha() and run[0] in _JOINERS and len(dashes) == 1:
            return ''  # "infra- structure"
    return ' ' if _space_counts(out, after) else ''


def _canonical(text):
    """(comparable text, index in `text` each character came from)."""
    chars, where = _fold(text)
    out, source, i = [], [], 0
    while i < len(chars):
        if not (chars[i].isspace() or chars[i] in _ANY_DASH):
            out.append(chars[i])
            source.append(where[i])
            i += 1
            continue
        end = i
        while end < len(chars) and (chars[end].isspace() or chars[end] in _ANY_DASH):
            end += 1
        for ch in _separator(chars[i:end], out, chars[end] if end < len(chars) else None):
            out.append(ch)
            source.append(where[i])
        i = end
    return ''.join(out), source


def _on_boundaries(haystack, start, end):
    """False if the match cuts a word or a number in two, or loses a minus sign."""
    first, last = haystack[start], haystack[end - 1]
    if start:
        before = haystack[start - 1]
        if _is_word(first) and _is_word(before) and not (_no_spaces(first) and _no_spaces(before)):
            return False
        if first.isdigit() and (before == '-' or (before in '.,' and start > 1 and haystack[start - 2].isdigit())):
            return False
    if end < len(haystack):
        after = haystack[end]
        if _is_word(last) and _is_word(after) and not (_no_spaces(last) and _no_spaces(after)):
            return False
        if last.isdigit() and (after == '-' or (after in '.,' and end + 1 < len(haystack) and haystack[end + 1].isdigit())):
            return False
    return True


def locate(quote, passage):
    """The passage's own text for `quote`, or None if the quote is not in the passage."""
    if not isinstance(quote, str) or not isinstance(passage, str):
        return None
    wanted, _ = _canonical(quote)
    if len(wanted.replace(' ', '')) < MIN_SKELETON:
        return None
    haystack, source = _canonical(passage)
    start = haystack.find(wanted)
    while start >= 0:
        end = start + len(wanted)
        if _on_boundaries(haystack, start, end):
            return passage[source[start]:source[end - 1] + 1]
        start = haystack.find(wanted, start + 1)
    return None
