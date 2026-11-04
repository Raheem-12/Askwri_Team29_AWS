import base64, os, re
import boto3

REGION = os.environ.get("AWS_REGION", "us-west-2")
GR_ID = os.environ["GUARDRAIL_ID"]
GR_VER = os.environ.get("GUARDRAIL_VERSION", "1")
MAX_LEN = 500
rt = boto3.client("bedrock-runtime", region_name=REGION)
CTRL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")
B64 = re.compile(r"[A-Za-z0-9+/]{16,}={0,2}")

def has_encoded_payload(text):
    """True if the text contains a base64 blob that decodes to readable text with spaces."""
    for m in B64.findall(text):
        try:
            d = base64.b64decode(m + "=" * (-len(m) % 4), validate=True).decode("utf-8")
        except Exception:
            continue
        if d.isprintable() and " " in d:
            return True
    return False

def _guard(text):
    r = rt.apply_guardrail(guardrailIdentifier=GR_ID, guardrailVersion=GR_VER,
                           source="INPUT", content=[{"text": {"text": text}}])
    trig, actions = set(), set()
    for a in r.get("assessments", []):
        for kind, key, label in (("topicPolicy", "topics", "topic"),
                                 ("contentPolicy", "filters", "content"),
                                 ("sensitiveInformationPolicy", "piiEntities", "pii")):
            for x in a.get(kind, {}).get(key, []):
                trig.add(f"{label}:{x.get('name') or x.get('type')}")
                actions.add(x.get("action"))
    intervened = r["action"] == "GUARDRAIL_INTERVENED"
    blocked = intervened and actions != {"ANONYMIZED"}   # email/phone are masked, not blocked
    masked = "".join(o.get("text", "") for o in r.get("outputs", [])) if intervened and not blocked else text
    return blocked, masked, ",".join(sorted(trig)) or "-"

def screen(text):
    text = CTRL.sub("", (text or "").strip())
    if not 1 <= len(text) <= MAX_LEN:
        return {"allowed": False, "layer": "input_validation", "triggers": "length", "text": ""}
    if has_encoded_payload(text):
        return {"allowed": False, "layer": "encoded_payload", "triggers": "base64", "text": ""}
    blocked, masked, trig = _guard(text)
    if blocked:
        return {"allowed": False, "layer": "guardrail", "triggers": trig, "text": ""}
    return {"allowed": True, "layer": "-", "triggers": trig, "text": masked}
