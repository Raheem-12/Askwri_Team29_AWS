# AskWRI — Interactive Earth frontend

A complete Vite + Three.js frontend for your existing AskWRI FastAPI backend.
This folder does not contain or modify app.py, AWS settings, or credentials.

## Start in VS Code (Windows PowerShell)

You run two terminals: your existing Python backend, and this frontend.

### Terminal 1 — your existing backend

Open your existing AskWRI project. In the terminal where your working AWS sandbox environment is configured, activate your existing Python environment if necessary. From the folder containing app.py, run:

```powershell
python -m uvicorn app:app --reload --port 8001
```

If it is already running on port 8001, leave it running. Keep your existing credentials and AWS_REGION / BEDROCK_KB_ID / BEDROCK_MODEL_ID settings exactly as before. Do not put AWS keys into the frontend.

### Terminal 2 — this new frontend

Extract the ZIP. Open the extracted `askwri-globe` folder in VS Code (the one containing package.json).
Use Node.js 22.12 or newer. Check with `node --version`.

```powershell
npm ci
npm run dev
```

Open the Local URL printed by Vite, normally http://localhost:5173. Keep both terminals running.
Do not replace your old static/index.html with this source index.html: this version uses Vite modules and a separate development server.

Vite forwards both `/api/status` and `/api/ask` to http://127.0.0.1:8001. The browser only talks to the frontend origin, so no backend CORS change is needed. Source URLs are kept exactly as returned by the backend; safe HTTPS links on WRI domains are allowed. Missing or rejected links remain plain text. Page anchors are added only to PDF URLs.

If your backend must use another port, set this non-secret override before starting Vite:

```powershell
$env:ASKWRI_BACKEND_URL="http://127.0.0.1:8000"
npm run dev
```

## What works

- A real Three.js WebGL 2 Earth sphere, local Earth surface, normal, ocean-specular and cloud textures, and a transparent atmospheric shell.
- Mouse drag rotates the camera; wheel zooms. One-finger drag and two-finger pinch/rotate are handled by OrbitControls. Scroll the page outside the globe on touch screens.
- Zoom buttons, reset, pause/resume idle rotation. Focus the globe and use arrows to rotate; +/- zoom. Idle rotation resumes five seconds after interaction ends, unless paused.
- Reduced-motion preference disables idle rotation by default and disables the layout animation.
- Q&A calls POST /api/ask with `{ "question": "..." }`. There are no demonstration answers or AWS-response fallbacks in the application.
- During retrieval the globe stays interactive and “Searching WRI publications...” is visible. After an answer or refusal, the same globe/camera moves into the evidence column. On a narrow screen, columns stack.
- Claim-level numbered citations, supporting quotes, full retrieved passages, PDF page numbers, safe nullable URLs, loading, refusal, errors, retries, and copying answers with source references.
- Generate Briefing and Review Claims are explicitly labeled Coming Soon. They send no requests.
- No geographic markers, inference, highlighting, or research-location claims.

The backend remains responsible for evidence quality and URL provenance. The frontend validates URL syntax/domain; it does not claim to have checked remote document availability or scientific support.

## Verify locally before your presentation

1. Open the frontend. Confirm the Earth texture renders, not a blank sphere or an image.
2. Drag the globe horizontally and vertically. Zoom with the wheel and +/- buttons. Use Reset view. Pause and resume rotation. After releasing a drag, wait five seconds and check that rotation resumes.
3. Ask a real question covered by your sample. The globe must remain visible while loading. When the response arrives, check the split layout and drag/zoom the smaller globe again. Open a numbered citation and its PDF page when provided.
4. Ask a question outside the sample. Check the insufficient-evidence state. A backend failure must display an error, never a fabricated answer.
5. Test on a phone: one-finger rotate, two-finger pinch, and scrolling outside the globe. Research content should stack without horizontal overflow.
6. Open the other tabs. Confirm they say Coming Soon and their action buttons are disabled.

## Testing performed and remaining limit

`npm test` runs 20 frontend assertions using explicitly labeled unit-test fixtures. These test the request contract, null/unsafe URLs, inline references, error/refusal states, duplicate request prevention, placeholder navigation, and moving the same globe panel after a response. Test fixtures exist only under tests/ and are not imported by the application.

`npm run build` validates the production bundle. A browser inspection confirmed the page and its explicit WebGL-unavailable state. The remote test browser reports GL_VENDOR and GL_RENDERER as Disabled, so actual GPU rendering, mouse/touch globe controls, and a live AWS answer could not be verified here. Run the checklist above on your local WebGL-enabled browser. This is a verification limitation, not a static-image substitution: src/globe.js uses real Three.js geometry, WebGLRenderer, textures, lights, shaders, and OrbitControls.

If you see the WebGL message locally, enable graphics acceleration in your browser and restart it, or try another WebGL 2-capable browser. If a texture fails, confirm public/textures contains all four bundled files. Q&A remains usable if graphics are unavailable.

## Build or preview the production output

```powershell
npm test
npm run build
npm run preview
```

Preview also proxies /api to your backend. `dist/` is a static production bundle; if deployed elsewhere it needs hosting that routes /api to FastAPI. Copying dist into the old FastAPI static folder alone is not sufficient unless that server also serves its asset paths. No backend edits or deployment are included.

## Files

- index.html: semantic page structure, navigation and placeholders.
- src/research.js: existing API contract, safe rendering and request lifecycle events.
- src/globe.js: real interactive Earth renderer and accessibility controls.
- src/main.js: connects research events to the responsive globe layout.
- src/base.css and src/globe.css: research UI and dark forest/cream/gold styling.
- public/textures/: bundled Earth textures; no runtime image CDN.
- vite.config.js: API proxy. `terminal.local` is an allowed hostname solely for the build environment's preview; localhost works normally.
- package-lock.json: reproducible dependency versions.

## Asset provenance

Earth textures were downloaded without alteration from the official Three.js example assets:

- https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg
- https://threejs.org/examples/textures/planets/earth_normal_2048.jpg
- https://threejs.org/examples/textures/planets/earth_specular_2048.jpg
- https://threejs.org/examples/textures/planets/earth_clouds_1024.png

Three.js library license is included as THREE-LICENSE.txt. Asset provenance is recorded here separately from the library license. No map data or image-generation assets are used.
