# usage: python security/verify_corpus.py baseline        -> record trusted hashes
#        python security/verify_corpus.py verify [prefix]  -> compare S3 against the baseline
import boto3, hashlib, json, os, sys

BUCKET = os.environ["CORPUS_BUCKET"]
BASELINE = "security/baseline.sha256.json"
s3 = boto3.client("s3")

def sha(key):
    h = hashlib.sha256()
    body = s3.get_object(Bucket=BUCKET, Key=key)["Body"]
    for chunk in iter(lambda: body.read(1 << 20), b""):
        h.update(chunk)
    return h.hexdigest()

def snapshot(prefix):
    out = {}
    for page in s3.get_paginator("list_objects_v2").paginate(Bucket=BUCKET, Prefix=prefix):
        for o in page.get("Contents", []):
            if not o["Key"].endswith("/"):
                out[o["Key"][len(prefix):]] = sha(o["Key"])
    return out

mode = sys.argv[1] if len(sys.argv) > 1 else "verify"
prefix = sys.argv[2] if len(sys.argv) > 2 else "docs/"

if mode == "baseline":
    cur = snapshot("docs/")
    for name, h in cur.items():          # cross-check PDFs against the originals you downloaded from WRI
        local = os.path.join("data/raw", name)
        if name.endswith(".pdf") and os.path.exists(local):
            if hashlib.sha256(open(local, "rb").read()).hexdigest() != h:
                print("WARNING: S3 copy differs from your local download:", name)
    json.dump(cur, open(BASELINE, "w"), indent=1, sort_keys=True)
    print(len(cur), "objects recorded in", BASELINE)
else:
    base = json.load(open(BASELINE))
    cur = snapshot(prefix)
    bad = 0
    for name, h in sorted(cur.items()):
        if name not in base:
            print("NEW        ", name); bad += 1
        elif base[name] != h:
            print("TAMPERED   ", name); bad += 1
        else:
            print("OK         ", name)
    if prefix == "docs/":
        for name in sorted(base.keys() - cur.keys()):
            print("MISSING    ", name); bad += 1
    print(f"\n{len(cur)} objects checked, {bad} problem(s)")
    sys.exit(1 if bad else 0)
