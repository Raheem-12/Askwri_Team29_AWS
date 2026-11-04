# AskWRI frontend: the globe

A minimalist Vite + Three.js interface for the AskWRI backend (`../backend`). Ask a question and the places named in the cited WRI sources appear as pins on a real 3D Earth. Click a pin for an at-a-glance summary and follow-up questions, or open a full briefing.

## Run it

Two terminals, from the repo root. Node 22.12 or newer.

```bash
# 1. backend (see ../backend; DEMO_MODE=true in .env serves clearly labeled sample data)
cd prototype/backend && source .venv/bin/activate && python -m uvicorn app:app --port 8001

# 2. frontend
cd prototype/frontend && npm ci && npm run dev      # http://localhost:5173
```

Vite forwards `/api/*` to `http://127.0.0.1:8001`. Use another port with `ASKWRI_BACKEND_URL=http://127.0.0.1:8000 npm run dev`. AWS credentials stay in the backend; the browser never sees them.

To serve everything from the backend instead: `npm run build`, and the backend serves `dist/` at `http://127.0.0.1:8001/`.

## What it does

- **Globe:** a WebGL Earth with bundled textures (no CDN). Drag to rotate, scroll or pinch to zoom, arrow keys and `+`/`-` work when it has focus. Every camera move is eased; idle rotation resumes 5 seconds after you let go.
- **Pins:** each place named inside a cited passage becomes a pin. Pins are real buttons (keyboard-focusable, labelled). Pins close together merge into a count badge; click it to zoom in. Pins on the far side of the globe fade out. The places are also listed as buttons in the answer panel.
- **Glance card:** clicking a pin opens a card docked **beside** the globe, never over it, joined to the pin by a thin leader line. Click another pin and the card swaps in place, so you can move through many pins quickly. The card shows the issues from your answer, a cited summary from WRI sources only, a follow-up box, and a "Full briefing" link that opens a new tab.
- **Panels never cover the globe:** when the answer panel or card opens, the globe shifts and zooms out just enough to stay fully visible in the free space.
- **Briefing page:** `briefing.html?place=…&topic=…` shows an overview, key findings and related publications, all cited. The topic in the link is the PII-masked question from the server, never the raw text.
- **Connections view:** an Obsidian-style map. Topic hubs link to publications; dashed lines link publications that share title terms (hover a line to see why); gold rings mark sources cited in your latest answer. Drag nodes, scroll to zoom, double-click to refit.
- **Honest states:** loading, refusal ("insufficient evidence"), out-of-scope, errors with retry. A permanent banner marks sample data. The UI never fabricates an answer.
- **Accessibility:** skip link, live-region announcements, reduced-motion support, keyboard operation. Phones get bottom sheets instead of side panels.

Without WebGL the globe shows a message; search, answers, the places list and briefings still work.

## Tests

```bash
npm test            # 23 unit/UI tests (jsdom, no browser needed)
npm run build       # production bundle

# Optional: real Chrome end-to-end check with REAL mouse clicks on pins.
# Needs the backend running in demo mode on :8001 and `npm run build` first.
node tests/e2e-browser.mjs          # set CHROME=/path/to/chrome if not on macOS
```

`tests/geo.test.mjs` proves the latitude/longitude math against real three.js sphere vertices, so a pin cannot land on the wrong continent. `tests/app.test.mjs` drives the UI with a fake globe and API, including stale-response and XSS cases. The Chrome check saves screenshots to `node_modules/.cache/e2e/`.

## Files

| File | Role |
|---|---|
| `index.html`, `briefing.html` | The two pages (Vite multi-page build) |
| `src/main.js` | Creates the globe and starts the app |
| `src/app.js` | Controller: ask flow, panels, layout, status, view switching |
| `src/globe.js` | The WebGL Earth, camera flights, pin projection, panel fitting |
| `src/pins.js` | Pin buttons, clustering, far-side fade |
| `src/glance.js` | The docked card, summary, follow-ups |
| `src/graph.js` | The connection map (canvas + `d3-force`) |
| `src/render.js` | Cited claims and sources (all text via `textContent`) |
| `src/api.js`, `src/util.js`, `src/geo.js` | Backend client, small helpers, lat/lon math |
| `src/styles.css` | All styling |
| `public/textures/` | Earth textures |

## Asset provenance

The Earth textures are the unaltered official three.js example assets:

- https://threejs.org/examples/textures/planets/earth_atmos_2048.jpg
- https://threejs.org/examples/textures/planets/earth_normal_2048.jpg
- https://threejs.org/examples/textures/planets/earth_specular_2048.jpg
- https://threejs.org/examples/textures/planets/earth_clouds_1024.png

The three.js license is in `THREE-LICENSE.txt`. No map data or generated imagery is used.
