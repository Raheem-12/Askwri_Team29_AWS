"""Pure-code input checks. No AWS calls, so it is fast and testable offline."""
import base64, codecs, re

MAX_LEN = 500
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
B64 = re.compile(r"[A-Za-z0-9+/]{16,}={0,2}")
INJECTION = re.compile(
    r"(ignore|disregard|forget).{0,30}(instructions|rules|guidelines|prompt)"
    r"|system prompt|hidden (instructions|rules)", re.I | re.S)

def has_encoded_payload(text):
    for m in B64.findall(text):
        try:
            d = base64.b64decode(m + "=" * (-len(m) % 4), validate=True).decode("utf-8")
        except Exception:
            continue
        if d.isprintable() and " " in d:
            return True
    return False

HEX = re.compile(r"(?:[0-9a-fA-F]{2}){16,}")

def has_hex_payload(text):
    for m in HEX.findall(text):
        try:
            d = bytes.fromhex(m).decode("utf-8")
        except Exception:
            continue
        if d.isprintable() and " " in d:
            return True
    return False

def precheck(text):
    """Return (ok, reason, cleaned_text)."""
    t = CTRL.sub("", (text or "").strip())
    if not 1 <= len(t) <= MAX_LEN:
        return False, "length", ""
    if has_encoded_payload(t):
        return False, "base64", ""
    if has_hex_payload(t):
        return False, "hex", ""
    for name, variant in (("rot13", codecs.decode(t, "rot_13")), ("reversed", t[::-1])):
        if INJECTION.search(variant):
            return False, name, ""
    return True, "-", t
