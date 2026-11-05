"""Small text helpers shared by mock retrieval, catalog matching and Demand Radar clustering.

Keyword based on purpose: it runs offline with no models. Swap in Bedrock embeddings
for cross-language matching once the sandbox is available.
"""
import re
import unicodedata

STOPWORDS = set("""
a about above after again against all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further had has
have having he her here hers him his how i if in into is it its itself just me more most my no nor
not now of off on once only or other our ours out over own same she should so some such than that
the their them then there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your yours
wri wri's world resources institute publish published publication publications report reports
research paper papers study studies say says said tell know find show anything something any
latest recent new current give list summary summarize explain describe question
studied recommend recommendation best way ways work works help happen much many good
estudio estudios estudos pode podem tratam quais hay publicou
""".split())

# minimal function words per language, for a cheap language guess
LANG_HINTS = {
    "es": set("el la los las que de del en por para con una uno sobre como qué cómo cuál es son hay ha han publicado al se pueden puede".split()),
    "pt": set("o a os as que de do da dos das em no na para com uma um sobre como qual quais são há não publicou".split()),
    "fr": set("le la les des du de en pour avec une un sur comment quel quelle quels est sont dans publié".split()),
    "id": set("yang dan di ke dari untuk dengan apa bagaimana tentang adalah ini itu".split()),
}


def fold(s):
    """Lowercase and strip accents so 'Qué' and 'que' match."""
    s = unicodedata.normalize("NFKD", s.lower())
    return "".join(c for c in s if not unicodedata.combining(c))


# function words in those languages are not topic terms either
STOPWORDS |= {fold(w) for hint in LANG_HINTS.values() for w in hint}
_HINTS_FOLDED = {lang: {fold(w) for w in hint} for lang, hint in LANG_HINTS.items()}


def stem(w):
    if len(w) > 4 and w.endswith("ies"):
        return w[:-3] + "y"
    if len(w) > 4 and w.endswith(("sses", "shes", "ches", "xes", "uses")):
        return w[:-2]
    if len(w) > 3 and w.endswith("s") and not w.endswith("ss"):
        return w[:-1]
    if len(w) > 6 and w.endswith("ing"):
        return w[:-3]
    return w


def terms(s):
    """Content terms: folded, stemmed, stopwords and short tokens dropped."""
    words = re.findall(r"[a-z0-9]+", fold(s))
    return [stem(w) for w in words if w not in STOPWORDS and len(w) > 2 and not w.isdigit()]


def surface_forms(s):
    """Map each content term back to a word as written (accents kept), for readable labels."""
    out = {}
    for w in re.findall(r"\w+", s.lower()):
        f = fold(w)
        if f in STOPWORDS or len(f) <= 2 or f.isdigit() or not re.fullmatch(r"[a-z0-9]+", f):
            continue
        out.setdefault(stem(f), w)
    return out


def guess_language(s):
    words = re.findall(r"[a-z]+", fold(s))
    if not words:
        return "en"
    best, hits = "en", 0
    for lang, hint in _HINTS_FOLDED.items():
        n = sum(w in hint for w in words)
        if n > hits:
            best, hits = lang, n
    # need a real signal, not one shared word like "a"
    return best if hits >= 2 and hits / len(words) >= 0.2 else "en"


_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PHONE = re.compile(r"\+?\d[\d\s().-]{7,}\d")


def scrub(s):
    """Remove emails and phone numbers before a question is stored."""
    return _PHONE.sub("[phone]", _EMAIL.sub("[email]", s))
