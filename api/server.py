import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(root, "src"))

from typing import Optional
from fastapi import FastAPI, Query
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from askwri import radar
from askwri.app import answer

app = FastAPI()

# request type -> instruction for the supervisor; the user's question is logged without it
MODES = {
    "ask": "",
    "brief": "Write a research briefing on: ",
    "gaps": "Where is WRI's work thin, and what could come next, on: ",
}


class Chat(BaseModel):
    prompt: str
    mode: str = "ask"
    team: Optional[str] = None


@app.post("/api/chat")
def chat(body: Chat):
    mode = body.mode if body.mode in MODES else "ask"
    out = answer(MODES[mode] + body.prompt, team=body.team, endpoint=mode, log=False)
    out["radar"] = radar.log_answer(body.prompt, out, team=body.team, endpoint=mode)
    out.pop("_radar", None)
    return out


@app.get("/api/radar")
def radar_report(days: int = Query(7, ge=1, le=90), gap: Optional[str] = None,
                 team: Optional[str] = None, language: Optional[str] = None):
    return radar.report(days=days, gap=gap or None, team=team or None, language=language or None)


@app.get("/api/radar/export", response_class=PlainTextResponse)
def radar_export(days: int = Query(7, ge=1, le=90), gap: Optional[str] = None,
                 team: Optional[str] = None, language: Optional[str] = None):
    rep = radar.report(days=days, gap=gap or None, team=team or None, language=language or None)
    return radar.export_markdown(rep)


@app.get("/radar")
def radar_page():
    return FileResponse(os.path.join(root, "ui", "radar.html"))


@app.get("/")
def index():
    return FileResponse(os.path.join(root, "ui", "index.html"))
