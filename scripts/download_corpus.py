# usage: python scripts/download_corpus.py data/manifest.csv
# manifest columns: title,url,pdf_url,date,program,language
import csv, json, os, re, sys
import boto3, requests

bucket = os.environ["CORPUS_BUCKET"]
s3 = boto3.client("s3")


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:80]


os.makedirs("data/raw", exist_ok=True)

for row in csv.DictReader(open(sys.argv[1], encoding="utf-8")):
    name = slug(row["title"]) + ".pdf"
    path = "data/raw/" + name
    try:
        if not os.path.exists(path):
            r = requests.get(row["pdf_url"], timeout=60)
            r.raise_for_status()
            open(path, "wb").write(r.content)
        s3.upload_file(path, bucket, "docs/" + name)

        # Bedrock KB reads metadata from <file>.metadata.json next to the doc
        meta = {"metadataAttributes": {
            "title": row["title"],
            "url": row["url"],
            "year": row["date"][:4],
            "program": row["program"],
            "language": row["language"] or "en",
        }}
        s3.put_object(Bucket=bucket, Key=f"docs/{name}.metadata.json", Body=json.dumps(meta))
        print("ok", name)
    except Exception as e:
        print("failed", row["title"], e)
