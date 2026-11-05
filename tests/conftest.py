import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, ROOT)
os.environ["ASKWRI_MOCK"] = "1"


@pytest.fixture(autouse=True)
def radar_db(tmp_path, monkeypatch):
    """Every test gets its own empty Demand Radar database."""
    path = tmp_path / "radar.db"
    monkeypatch.setenv("RADAR_DB", str(path))
    return path
