import os
import boto3
from precheck import precheck

REGION = os.environ.get("AWS_REGION", "us-west-2")
GR_ID = os.environ["GUARDRAIL_ID"]
GR_VER = os.environ.get("GUARDRAIL_VERSION", "1")
rt = boto3.client("bedrock-runtime", region_name=REGION)

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
    blocked = intervened and actions != {"ANONYMIZED"}
    masked = "".join(o.get("text", "") for o in r.get("outputs", [])) if intervened and not blocked else text
    return blocked, masked, ",".join(sorted(trig)) or "-"

def screen(text):
    ok, reason, t = precheck(text)
    if not ok:
        return {"allowed": False, "layer": "precheck", "triggers": reason, "text": ""}
    blocked, masked, trig = _guard(t)
    if blocked:
        return {"allowed": False, "layer": "guardrail", "triggers": trig, "text": ""}
    return {"allowed": True, "layer": "-", "triggers": trig, "text": masked}
