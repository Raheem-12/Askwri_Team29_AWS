# Builds prototype/backend/gazetteer.json from Natural Earth (public domain).
# usage: python scripts/build_gazetteer.py
#
# The backend never trusts model-supplied coordinates. A pin is only placed when
# the place name resolves in this file, so it is generated once and committed.
import json
import urllib.request
from pathlib import Path

BASE = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/"
OUT = Path(__file__).resolve().parents[1] / "prototype" / "backend" / "gazetteer.json"
MIN_CITY_POP = 1_000_000

# Short forms that appear in research text but not in Natural Earth name fields.
COUNTRY_ALIASES = {
    "United States of America": ["United States", "US", "U.S.", "USA", "U.S.A."],
    "United Kingdom": ["UK", "U.K.", "Britain", "Great Britain"],
    "Democratic Republic of the Congo": ["DRC", "DR Congo", "D.R. Congo"],
    "Republic of the Congo": ["Congo-Brazzaville"],
    "Czechia": ["Czech Republic"],
    "Myanmar": ["Burma"],
    "eSwatini": ["Eswatini", "Swaziland"],
    "South Korea": ["Republic of Korea"],
    "Russia": ["Russian Federation"],
    "Vietnam": ["Viet Nam"],
    "Turkey": ["Turkiye"],
    "Ivory Coast": ["Cote d'Ivoire"],
}

# Approximate centres. These are drawn as "region" pins, labeled approximate in the UI.
REGIONS = {
    "Latin America": (-10.0, -60.0),
    "Sub-Saharan Africa": (2.0, 20.0),
    "East Africa": (1.0, 37.0),
    "West Africa": (10.0, -3.0),
    "Southern Africa": (-22.0, 24.0),
    "North Africa": (28.0, 12.0),
    "Middle East": (29.0, 45.0),
    "Southeast Asia": (6.0, 110.0),
    "South Asia": (23.0, 80.0),
    "East Asia": (35.0, 115.0),
    "Central Asia": (43.0, 68.0),
    "Europe": (50.0, 15.0),
    "North America": (45.0, -100.0),
    "Central America": (14.0, -87.0),
    "Caribbean": (18.0, -75.0),
    "Pacific Islands": (-15.0, 165.0),
    "Amazon Basin": (-5.0, -62.0),
    "Congo Basin": (-1.0, 22.0),
}


def fetch(name):
    with urllib.request.urlopen(BASE + name, timeout=60) as response:
        return json.load(response)


def clean(*names):
    seen, out = set(), []
    for name in names:
        if isinstance(name, str) and name.strip() and name.strip() not in seen:
            seen.add(name.strip())
            out.append(name.strip())
    return out


def build():
    entries = []
    for feature in fetch("ne_50m_admin_0_countries.geojson")["features"]:
        p = feature["properties"]
        lon, lat = p.get("LABEL_X"), p.get("LABEL_Y")
        if lon is None or lat is None:
            continue
        name = p.get("NAME_LONG") or p.get("NAME")
        names = clean(p.get("NAME"), p.get("NAME_LONG"), p.get("ADMIN"), p.get("FORMAL_EN"), p.get("NAME_EN"))
        extra = []
        for key in names:
            extra += COUNTRY_ALIASES.get(key, [])
        entries.append({"name": p.get("NAME") or name, "kind": "country", "lat": round(lat, 2),
                        "lon": round(lon, 2), "pop": int(p.get("POP_EST") or 0),
                        "aliases": clean(*names, *extra)})

    for feature in fetch("ne_50m_populated_places_simple.geojson")["features"]:
        p = feature["properties"]
        pop = int(p.get("pop_max") or 0)
        if pop < MIN_CITY_POP:
            continue
        lon, lat = feature["geometry"]["coordinates"]
        entries.append({"name": p["name"], "kind": "city", "country": p.get("adm0name"),
                        "lat": round(lat, 2), "lon": round(lon, 2), "pop": pop,
                        "aliases": clean(p["name"], p.get("nameascii"))})

    for name, (lat, lon) in REGIONS.items():
        entries.append({"name": name, "kind": "region", "lat": lat, "lon": lon, "pop": 0,
                        "aliases": [name]})
    return entries


def main():
    entries = build()
    OUT.write_text(json.dumps(entries, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    kinds = {k: sum(e["kind"] == k for e in entries) for k in ("country", "city", "region")}
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {kinds}")


if __name__ == "__main__":
    main()
