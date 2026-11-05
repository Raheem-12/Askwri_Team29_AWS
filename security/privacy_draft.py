import json, os
from pathlib import Path

INVENTORY = Path(__file__).resolve().parents[1] / "docs" / "data-inventory.json"

def privacy_report():
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    inv["live"] = {
        "radar_retention_days": int(os.getenv("RADAR_RETENTION_DAYS", "90")),
        "guardrails_active": bool(os.getenv("GUARDRAIL_ID") and os.getenv("GUARDRAIL_VERSION")),
        "demo_mode": os.getenv("DEMO_MODE", "false").lower() == "true",
    }
    return inv
