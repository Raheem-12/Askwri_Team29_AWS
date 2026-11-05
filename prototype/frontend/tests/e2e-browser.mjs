// Optional end-to-end check in real Chrome (not part of `npm test`).
//   1. Start the backend in demo mode:  cd prototype/backend && python -m uvicorn app:app --port 8001
//   2. npm run build
//   3. node tests/e2e-browser.mjs            (set CHROME=/path/to/chrome if not on macOS default)
// Uses Chrome's DevTools protocol directly (no dependencies) and sends REAL mouse
// events at pin coordinates, so a pin that something covers fails the test.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'node_modules', '.cache', 'e2e');
fs.mkdirSync(out, { recursive: true });
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8001/';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(out, 'profile')}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist',
  '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
process.on('exit', () => chrome.kill());

async function connect() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
      const { webSocketDebuggerUrl } = await r.json();
      const ws = new WebSocket(webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
      return ws;
    } catch { await sleep(200); }
  }
  throw new Error('Could not reach Chrome DevTools');
}

const ws = await connect();
let id = 0; const pending = new Map(), listeners = [], problems = [];
ws.onmessage = ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.id && pending.has(msg.id)) { const { res, rej } = pending.get(msg.id); pending.delete(msg.id); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); }
  else {
    if (msg.method === 'Runtime.exceptionThrown') problems.push('exception: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') problems.push('console.error: ' + msg.params.args.map(a => a.value ?? a.description).join(' '));
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') problems.push('log: ' + msg.params.entry.text + ' ' + (msg.params.entry.url || ''));
    listeners.forEach(l => l(msg));
  }
};
const send = (method, params = {}) => new Promise((res, rej) => { const n = ++id; pending.set(n, { res, rej }); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJS = async expression => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expression, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await evalJS(expression)) return true; } catch {} await sleep(120); } return false; };
const shot = async name => fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
const mouse = async (x, y) => { for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); };
const navigate = async url => { const loaded = new Promise(r => { const l = m => { if (m.method === 'Page.loadEventFired') { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); }); await send('Page.navigate', { url }); await loaded; };
const center = sel => evalJS(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

// Pins a person could actually click right now, plus whether each is the topmost element at its centre.
const visiblePins = () => evalJS(`[...document.querySelectorAll('.pin')].filter(p => !p.classList.contains('is-hidden') && Number(p.style.opacity) > 0.6).map(p => {
  const r = p.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2, top = document.elementFromPoint(x, y);
  return { id: p.dataset.id, x, y, topmost: !!(top && top.closest('.pin') === p) }; })`);

try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await navigate(BASE);

  // ---- landing
  check('WebGL canvas created', await waitFor(`!!document.querySelector('#globe-viewport canvas')`));
  check('Earth texture loaded', await waitFor(`document.querySelector('#globe-viewport canvas')?.dataset.textureLoaded === 'true'`, 10000));
  check('sample-data banner visible in demo mode', await evalJS(`!document.getElementById('demo-banner').hidden`));
  await sleep(800);
  const landing = await evalJS(`(() => { const c = document.querySelector('#globe-viewport canvas'); return { inset: c.dataset.inset, dist: c.dataset.distance, azimuth: c.dataset.azimuth, askH: document.getElementById('ask-form').offsetHeight, canvasH: c.clientHeight, stageInsets: [document.getElementById('stage').style.getPropertyValue('--inset-l'), document.getElementById('stage').style.getPropertyValue('--inset-r')] }; })()`);
  console.log('landing metrics', JSON.stringify(landing));
  const [, insetY] = landing.inset.split(',').map(Number);
  check('globe settles in the free space at landing (inset not runaway)', Math.abs(insetY) < 150, `inset y = ${insetY}`);
  await shot('1-landing');

  // ---- ask (real click on the button)
  await evalJS(`(() => { const q = document.getElementById('question'); q.value = 'forest restoration in Brazil and Kenya'; q.dispatchEvent(new Event('input')); })()`);
  await mouse(...Object.values(await center('#ask-button')));
  check('answer panel opens with citations', await waitFor(`document.getElementById('answer-panel').classList.contains('is-open') && !!document.querySelector('#answer-body a.cite')`));
  check('pins appear for the places in the sources', await waitFor(`document.querySelectorAll('.pin').length >= 2`));
  await sleep(2600); // camera flight + pin entrance
  await shot('2-answered');

  let pins = await visiblePins();
  check('at least one pin is on the visible side of the globe', pins.length >= 1, JSON.stringify(pins.map(p => p.id)));
  check('every visible pin is clickable (nothing covers it)', pins.length > 0 && pins.every(p => p.topmost));

  // ---- safety card (demo mode has no guardrail, so it must admit that rather than claim a pass)
  check('safety card appears after an answer', await evalJS(`!document.getElementById('safety-card').hidden && document.getElementById('safety-card').offsetWidth > 0`));
  check('safety card says the check was limited, not passed', await evalJS(`/Basic check only/.test(document.getElementById('safety-card').textContent) && /Not run/.test(document.getElementById('safety-card').textContent)`));
  const safetyBox = await evalJS(`(() => { const r = document.getElementById('safety-card').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth }; })()`);
  check('safety card sits on the right of the screen', safetyBox.l > safetyBox.w / 2 && safetyBox.r <= safetyBox.w, JSON.stringify(safetyBox));
  const underCard = pins.filter(p => p.x > safetyBox.l && p.x < safetyBox.r && p.y > safetyBox.t && p.y < safetyBox.b);
  check('safety card does not cover any pin', underCard.length === 0, underCard.map(p => p.id).join());

  // ---- glance card
  await mouse(pins[0].x, pins[0].y);
  check('clicking a pin opens the glance card', await waitFor(`document.getElementById('glance').classList.contains('is-open')`));
  check('glance shows a cited summary', await waitFor(`!!document.querySelector('#glance-summary a.cite')`));
  check('safety card steps aside for the glance card', await evalJS(`document.getElementById('safety-card').offsetWidth === 0`));
  await sleep(1800); await shot('3-glance');
  const title1 = await evalJS(`document.getElementById('glance-title').textContent`);
  pins = await visiblePins();
  const card = await evalJS(`(() => { const r = document.getElementById('glance').getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; })()`);
  const covered = pins.filter(p => p.x > card.l && p.x < card.r && p.y > card.t && p.y < card.b);
  check('glance card does not cover any pin', covered.length === 0, covered.map(p => p.id).join());
  check('every visible pin is still clickable with the card open', pins.every(p => p.topmost));
  check('leader line connects the pin to the card', await evalJS(`document.getElementById('leader-line').style.opacity === '1'`));

  const other = pins.find(p => p.id && !title1.toLowerCase().includes(p.id.split('-')[0]));
  if (other) {
    await mouse(other.x, other.y);
    check('clicking a second pin swaps the card in place', await waitFor(`document.getElementById('glance-title').textContent !== ${JSON.stringify(title1)}`));
    await sleep(1200); await shot('4-second-pin');
  } else console.log('SKIP  second visible pin (only one pin on the near side)');

  // ---- follow-up question inside the bubble
  await evalJS(`document.getElementById('glance-input').value = 'What can be done about this?'`);
  await mouse(...Object.values(await center('#glance-send')));
  check('follow-up is answered inside the card', await waitFor(`document.querySelectorAll('#glance-thread .thread-a .claim').length >= 1`));
  await shot('5-followup');

  // ---- full briefing page
  const href = await evalJS(`document.getElementById('glance-brief').href`);
  await navigate(href);
  check('briefing page renders cited sections', await waitFor(`document.querySelectorAll('#b-body .claim').length >= 1 && !!document.querySelector('#b-body a.cite')`));
  check('briefing lists related publications', await evalJS(`document.querySelectorAll('#b-sources .source').length >= 1`));
  await sleep(300); await shot('6-briefing');

  // ---- Demand Radar sees the question asked on the globe
  await navigate(new URL('radar', BASE).href);
  check('Radar page loads and counts the globe question', await waitFor(`fetch('/api/radar').then(r => r.json()).then(d => d.stats.questions >= 1)`));
  check('Radar labels demo traffic as simulated', await waitFor(`!document.getElementById('sim').hidden`));
  await sleep(500); await shot('6b-radar');

  // ---- connection map
  await navigate(BASE);
  await waitFor(`!!document.getElementById('view-graph')`);
  await mouse(...Object.values(await center('#view-graph')));
  check('safety card is not shown on the connections view', await evalJS(`document.getElementById('safety-card').offsetWidth === 0`));
  check('connections view shows the map canvas', await waitFor(`!!document.querySelector('#graph-host canvas') && !document.getElementById('connections').hidden`));
  await sleep(2500); await shot('7-connections');
  const drawn = await evalJS(`(() => { const c = document.querySelector('#graph-host canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i]) n++; return n; })()`);
  check('map canvas has drawn content', drawn > 50, `${drawn} sampled pixels`);

  // ---- sessions: follow-up, slide toggle, new chat, past session
  await navigate(BASE); await sleep(1200);
  const typeAndAsk = async text => { await evalJS(`(() => { const q = document.getElementById('question'); q.value = ${JSON.stringify(text)}; q.dispatchEvent(new Event('input')); })()`); await mouse(...Object.values(await center('#ask-button'))); };
  await typeAndAsk('forest restoration in Brazil and Kenya');
  check('session: follow-up box shows under the answer', await waitFor(`!document.getElementById('followup-form').hidden && !!document.querySelector('#answer-body a.cite')`));
  const followupBox = await evalJS(`(() => { const f = document.getElementById('followup-form').getBoundingClientRect(), p = document.getElementById('answer-panel').getBoundingClientRect(); return { inside: f.bottom <= p.bottom + 1 && f.top > p.top, h: f.height }; })()`);
  check('session: follow-up box is pinned inside the panel', followupBox.inside && followupBox.h > 30, JSON.stringify(followupBox));
  await evalJS(`document.getElementById('followup-input').value = 'forest restoration in Kenya'`);
  await mouse(...Object.values(await center('#followup-send')));
  check('session: follow-up stacks the earlier answer', await waitFor(`document.querySelectorAll('#session-turns .turn').length === 1 && !!document.querySelector('#answer-body a.cite') && document.getElementById('answer-panel').getAttribute('aria-busy') === 'false'`));
  await sleep(600); await shot('11-follow-up');
  await mouse(...Object.values(await center('#tab-past')));
  // Sample the whole slide: one sample can land before it starts on a busy machine.
  const positions = await evalJS(`new Promise(resolve => { const track = document.querySelector('.panel-track'), seen = [], until = performance.now() + 900; const step = () => { seen.push(new DOMMatrix(getComputedStyle(track).transform).m41); performance.now() < until ? requestAnimationFrame(step) : resolve(seen); }; step(); })`, true);
  const end = positions.at(-1), partway = positions.filter(x => x < -1 && x > end + 1).length;
  check('toggle: the panes slide (still moving partway through)', end < -100 && partway >= 3 && await evalJS(`document.getElementById('panel-panes').dataset.active === 'past'`), `${partway} frames partway, ends at ${Math.round(end)}px`);
  const settled = await evalJS(`(() => { const a = document.getElementById('pane-past').getBoundingClientRect(), p = document.getElementById('answer-panel').getBoundingClientRect(); return Math.abs(a.left - p.left) < 2; })()`);
  check('toggle: Past sessions pane lands inside the panel', settled);
  await shot('12-past-empty');
  await mouse(...Object.values(await center('#tab-answer')));
  await sleep(600);
  await typeAndAsk('urban flooding in Jakarta');
  check('new chat: the bottom box clears old answers', await waitFor(`document.querySelectorAll('#session-turns .turn').length === 0 && /flooding/i.test(document.getElementById('answer-body').textContent) && document.getElementById('answer-panel').getAttribute('aria-busy') === 'false'`));
  await mouse(...Object.values(await center('#tab-past')));
  await sleep(700);
  check('new chat: the old session is under Past sessions', await waitFor(`[...document.querySelectorAll('#past-list .past-item')].some(i => /forest restoration/.test(i.textContent) && /2 questions/.test(i.textContent))`));
  await shot('13-past-list');
  await mouse(...Object.values(await center('.past-item')));
  check('past session: opens read-only with no follow-up box', await waitFor(`!document.getElementById('past-banner').hidden && document.getElementById('followup-form').hidden && document.querySelectorAll('#session-turns .turn').length === 1`));
  await sleep(700); await shot('14-past-open');
  await mouse(...Object.values(await center('#past-back')));
  check('past session: back returns to the live session', await waitFor(`/flooding/i.test(document.getElementById('answer-body').textContent) && !document.getElementById('followup-form').hidden`));
  await navigate(BASE); await sleep(800);
  check('reload: earlier sessions are still reachable', await waitFor(`!document.getElementById('answer-reopen').hidden`));

  // ---- phone
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await navigate(BASE); await sleep(1500); await shot('8-mobile-landing');
  await evalJS(`(() => { const q = document.getElementById('question'); q.value = 'forest restoration in Brazil and Kenya'; q.dispatchEvent(new Event('input')); document.getElementById('ask-form').requestSubmit(); })()`);
  await waitFor(`document.querySelectorAll('.pin').length >= 2`); await sleep(2800); await shot('9-mobile-answer');
  check('phone: the safety summary is in the answer sheet, not beside it', await evalJS(`document.getElementById('safety-card').offsetWidth === 0 && document.getElementById('safety-inline').offsetHeight > 0`));
  check('no horizontal overflow on a phone', await evalJS(`document.documentElement.scrollWidth <= window.innerWidth`));
  const sheet = await evalJS(`(() => { const s = document.getElementById('answer-scroll'), f = document.getElementById('followup-form').getBoundingClientRect(); return { scrolls: s.scrollHeight >= s.clientHeight && s.clientHeight > 60, formVisible: f.bottom <= window.innerHeight + 1 && f.height > 30 }; })()`);
  check('phone: the answer scrolls and the follow-up box stays on screen', sheet.scrolls && sheet.formVisible, JSON.stringify(sheet));
  pins = await visiblePins();
  if (pins.length) {
    await mouse(pins[0].x, pins[0].y);
    check('phone: pin opens the glance sheet', await waitFor(`document.getElementById('glance').classList.contains('is-open')`));
    await sleep(1500); await shot('10-mobile-glance');
  }
} catch (error) {
  check('script ran to completion', false, error.message);
}

check('no console errors or exceptions', problems.length === 0, problems.slice(0, 5).join(' | '));
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${out}`);
ws.close(); chrome.kill();
process.exit(failed ? 1 : 0);
