import os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(root, "src"))

from fastapi import FastAPI
from fastapi.responses import FileResponse
from pydantic import BaseModel
from askwri.app import answer

app = FastAPI()


class Chat(BaseModel):
    prompt: str


@app.post("/api/chat")
def chat(body: Chat):
    return answer(body.prompt)


@app.get("/")
def index():
    return FileResponse(os.path.join(root, "ui", "index.html"))
