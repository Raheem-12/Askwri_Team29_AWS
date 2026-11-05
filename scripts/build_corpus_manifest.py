"""Write data/manifest_corpus.csv: one row for each publication in the Knowledge Base.

Connections and Demand Radar read this to know what is really loaded. It comes from the same
.metadata.json files uploaded to S3, so its titles match what retrieval returns, which is how an
answer's cited sources light up on the map. Run it again whenever the corpus changes.

    python scripts/build_corpus_manifest.py ["WRI Data/research_241"]

No link is ever guessed: only https links on wri.org domains are kept.
"""
import csv
import json
import sys
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "manifest_corpus.csv"
FIELDS = ["title", "url", "pdf_url", "date", "program", "language"]


def wri_link(value):
    if not isinstance(value, str):
        return ""
    parts = urlsplit(value)
    host = parts.hostname or ""
    return value if parts.scheme == "https" and (host == "wri.org" or host.endswith(".wri.org")) else ""


def row(metadata_file):
    attributes = json.loads(metadata_file.read_text(encoding="utf-8")).get("metadataAttributes", {})
    title = str(attributes.get("title") or "").strip()
    if not title:
        return None
    return {"title": title, "url": wri_link(attributes.get("public_url")), "pdf_url": "",
            "date": str(attributes.get("year") or ""), "program": str(attributes.get("program") or ""),
            "language": str(attributes.get("language") or "")}


def main():
    folder = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "WRI Data" / "research_241"
    rows = [r for r in map(row, sorted(folder.rglob("*.metadata.json"))) if r]
    if not rows:
        sys.exit(f"no metadata files found in {folder}")
    with OUT.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    print(f"wrote {OUT.relative_to(ROOT)}: {len(rows)} publications")


if __name__ == "__main__":
    main()
