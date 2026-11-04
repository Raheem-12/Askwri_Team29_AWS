# usage: python scripts/build_manifest.py data/urls.txt data/manifest_extra.csv
# Opens each WRI publication page and reads the PDF link, title, date and topic from its metadata.
import csv, html, os, re, sys, time
from datetime import datetime
import requests

urls_file, out_file = sys.argv[1], sys.argv[2]
headers = {"User-Agent": "Mozilla/5.0 (AWS hackathon research prototype)"}


def meta(page, name):
    # works whether the tag is name= or property=, and whichever attribute comes first
    n = re.escape(name)
    pats = [
        r'<meta[^>]+(?:name|property)=["\']%s["\'][^>]*content=["\']([^"\']*)["\']' % n,
        r'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:name|property)=["\']%s["\']' % n,
    ]
    for p in pats:
        m = re.search(p, page, re.I)
        if m:
            return html.unescape(m.group(1)).strip()
    return ""


def parse_date(page):
    raw = meta(page, "wri_published")
    for fmt in ("%B %d %Y", "%B %d, %Y"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    m = re.search(r"(\d{4}-\d{2}-\d{2})", meta(page, "article:published_time"))
    return m.group(1) if m else ""


already = set()
if os.path.exists("data/manifest.csv"):
    already = {r["url"] for r in csv.DictReader(open("data/manifest.csv", encoding="utf-8"))}

rows, problems = [], []
for u in [l.strip() for l in open(urls_file) if l.strip()]:
    if u in already:
        print("skip (already in manifest):", u)
        continue
    try:
        r = requests.get(u, headers=headers, timeout=30)
        r.raise_for_status()
        page = r.text
    except Exception as e:
        print("FAILED to open", u, e)
        problems.append(u)
        continue
    pdf = meta(page, "citation_pdf_url")
    title = meta(page, "citation_title") or meta(page, "og:title")
    title = re.sub(r"\s*\|\s*World Resources Institute\s*$", "", title)
    if not pdf or not title:
        print("no PDF link or title on page:", u)
        problems.append(u)
        continue
    lang = re.search(r'<html[^>]+lang=["\']([a-zA-Z]{2})', page)
    rows.append({
        "title": title, "url": u, "pdf_url": pdf, "date": parse_date(page),
        "program": meta(page, "wri_topic") or "General",
        "language": lang.group(1).lower() if lang else "en",
    })
    print("ok", title[:70], "|", rows[-1]["date"], "|", rows[-1]["program"])
    time.sleep(1.5)  # be gentle with their server

with open(out_file, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=["title", "url", "pdf_url", "date", "program", "language"])
    w.writeheader()
    w.writerows(rows)

print(f"\n{len(rows)} documents written to {out_file}, {len(problems)} need attention")
for p in problems:
    print("  ", p)
