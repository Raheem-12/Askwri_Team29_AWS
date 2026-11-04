import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script type="module".*?<\/script>/, '');
const { initApp } = await import('../src/app.js');
const { matchCited, neighborIds } = await import('../src/graph.js');
const { cleanPlaces } = await import('../src/app.js');

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

// ---------- fixtures (labeled test data; never imported by the app)
const place = (id, name, lat, lon, issues = [{ issue: `Issue in ${name}`, source_id: 'S1', quote: `In ${name}, a TEST FIXTURE quote.` }]) =>
  ({ id, name, kind: 'city', lat, lon, precision: 'exact', country: null, issues });
const answer = (over = {}) => ({
  status: 'answered', answer: 'x', topic: 'masked question text', demo: false,
  claims: [{ text: 'Fixture claim.', evidence: [{ source_id: 'S1', quote: 'TEST FIXTURE supporting passage.' }] }],
  sources: [{ id: 'S1', title: 'TEST FIXTURE - Publication', url: null, page: 7, passage: 'TEST FIXTURE supporting passage.' }],
  locations: [place('jakarta-city', 'Jakarta', -6.17, 106.83), place('bogota-city', 'Bogota', 4.6, -74.09)],
  ...over
});

function boot({ api = {}, mobile = false } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:5173', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.scrollIntoView = () => {}; // jsdom has no layout; real browsers do
  w.matchMedia = query => ({ matches: query.includes('max-width') ? mobile : false, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, { window: w, document: w.document, Event: w.Event, CustomEvent: w.CustomEvent, HTMLElement: w.HTMLElement });
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  const calls = { ask: [], glance: [], status: 0 };
  const fake = {
    status: async () => { calls.status++; return { configured: true, connection_verified: false, demo: false, guardrails: true }; },
    ask: async q => { calls.ask.push(q); return answer(); },
    glance: async (placeName, q) => { calls.glance.push([placeName, q]); return { status: 'answered', place: placeName,
      claims: [{ text: `${placeName} claim.`, evidence: [{ source_id: 'S1', quote: 'TEST FIXTURE glance quote.' }] }],
      sources: [{ id: 'S1', title: 'TEST FIXTURE - Glance source', url: null, page: 2, passage: 'TEST FIXTURE glance quote.' }] }; },
    graph: async () => ({ nodes: [], edges: [] }),
    ...api
  };
  const globe = { points: [], frames: [], focused: [], holds: [], insets: [], listeners: new Set(),
    setPoints(p) { this.points = p; }, onFrame(l) { this.listeners.add(l); return () => this.listeners.delete(l); },
    setInsets(...a) { this.insets.push(a); }, hold(on) { this.holds.push(on); }, focus(id) { this.focused.push(id); },
    frame(ids, o) { this.frames.push([ids, o]); }, reset() {}, zoomBy() {}, toggleRotation() { return true; }, rotating: true };
  const app = initApp({ globe, api: fake });
  const $ = id => w.document.getElementById(id);
  const ask = async text => {
    $('question').value = text;
    $('ask-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };
  return { w, d: w.document, $, app, calls, globe, ask, close: () => w.close() };
}

test('status: configured, not claimed as verified; demo banner hidden', async () => {
  const t = boot(); await settle();
  assert.match(t.$('connection-text').textContent, /will be checked/);
  assert.equal(t.$('demo-banner').hidden, true);
  assert.equal(t.$('guardrail-note').hidden, true);
  t.close();
});

test('status: demo mode shows the sample-data banner; missing guardrails are disclosed', async () => {
  const t = boot({ api: { status: async () => ({ configured: true, demo: true, guardrails: false }) } }); await settle();
  assert.equal(t.$('demo-banner').hidden, false);
  assert.match(t.$('demo-banner').textContent, /not WRI research/);
  assert.equal(t.$('guardrail-note').hidden, false);
  t.close();
});

test('asking sends the trimmed question and opens the answer panel with citations', async () => {
  const t = boot(); await settle();
  await t.ask('  Where is flooding?  ');
  assert.deepEqual(t.calls.ask, ['Where is flooding?']);
  assert.ok(t.$('answer-panel').classList.contains('is-open'));
  const cite = t.$('answer-body').querySelector('a.cite');
  assert.equal(cite.textContent, '1');
  assert.equal(cite.getAttribute('href'), '#evidence-1');
  assert.ok(t.$('evidence-1'));
  assert.match(t.$('sources').textContent, /Public link unavailable/);
  assert.match(t.$('sources').textContent, /PDF page 7/);
  assert.equal(t.$('sources').querySelectorAll('a').length, 0);
  assert.equal(t.$('copy-answer').hidden, false);
  t.close();
});

test('locations become pins and the globe is told to frame them', async () => {
  const t = boot(); await settle();
  await t.ask('Where is flooding?');
  assert.deepEqual(t.globe.points.map(p => p.id), ['jakarta-city', 'bogota-city']);
  assert.equal(t.d.querySelectorAll('#pin-layer .pin').length, 2);
  assert.equal(t.d.querySelectorAll('#places .chip').length, 2);
  assert.match(t.d.querySelector('.pin').getAttribute('aria-label'), /Jakarta.*1 issue/);
  await new Promise(r => setTimeout(r, 300)); // framing waits for the panel to make room
  assert.deepEqual(t.globe.frames.at(-1)[0], ['jakarta-city', 'bogota-city']);
  t.close();
});

test('malformed or out-of-range locations never become pins', () => {
  const kept = cleanPlaces([place('ok', 'Ok', 10, 10), place('bad-lat', 'X', 999, 0), { id: 1 }, null, place('bad-lon', 'Y', 0, -181),
    { ...place('no-issues', 'Z', 1, 1), issues: 'nope' }]);
  assert.deepEqual(kept.map(p => p.id), ['ok']);
});

test('untrusted text is escaped and unsafe URLs are not linked', async () => {
  const evil = answer({
    claims: [{ text: '<img src=x onerror=alert(1)>', evidence: [{ source_id: 'S1', quote: 'q q q q q q' }] }],
    sources: [{ id: 'S1', title: '<script>alert(1)</script>', url: 'javascript:alert(1)', page: null, passage: 'p' }],
    locations: [place('x-city', '<b>Evil</b>', 1, 1)] });
  const t = boot({ api: { ask: async () => evil } }); await settle();
  await t.ask('anything goes');
  assert.equal(t.$('answer-body').querySelector('img'), null);
  assert.equal(t.d.querySelector('script'), null);
  assert.equal(t.$('sources').querySelectorAll('a').length, 0);
  assert.match(t.$('sources').textContent, /Page not provided/);
  assert.equal(t.d.querySelector('.pin b'), null);
  t.close();
});

test('refusal and out-of-scope clear pins, sources and copy', async () => {
  for (const status of ['insufficient_evidence', 'out_of_scope']) {
    const t = boot({ api: { ask: async () => ({ status, answer: 'Nope for ' + status, claims: [], sources: [], locations: [] }) } }); await settle();
    await t.ask('something unanswerable');
    assert.match(t.$('answer-body').textContent, /Nope for/);
    assert.equal(t.d.querySelectorAll('.pin').length, 0);
    assert.equal(t.$('copy-answer').hidden, true);
    assert.equal(t.$('sources-section').hidden, true);
    t.close();
  }
});

test('API errors are shown, retry is offered, and the form recovers', async () => {
  const t = boot({ api: { ask: async () => { throw new Error('Sandbox session expired'); } } }); await settle();
  await t.ask('will fail now');
  assert.match(t.$('answer-body').textContent, /Sandbox session expired/);
  assert.ok(t.$('answer-body').querySelector('.link-button'));
  assert.equal(t.$('ask-button').disabled, false);
  assert.equal(t.$('question').readOnly, false);
  assert.equal(t.$('search-progress').hidden, true);
  t.close();
});

test('unexpected answer shape is rejected, not rendered', async () => {
  const t = boot({ api: { ask: async () => answer({ claims: [{ text: 'no evidence array' }] }) } }); await settle();
  await t.ask('bad payload here');
  assert.match(t.$('answer-body').textContent, /valid claim-level citations/);
  t.close();
});

test('duplicate submissions are ignored while a search is running', async () => {
  let release;
  const t = boot({ api: { ask: q => new Promise(r => { release = () => r(answer()); }) } }); await settle();
  t.$('question').value = 'first question';
  t.$('ask-form').dispatchEvent(new t.w.Event('submit', { cancelable: true })); await tick();
  assert.equal(t.$('ask-button').disabled, true);
  assert.equal(t.$('answer-panel').getAttribute('aria-busy'), 'true');
  t.$('ask-form').dispatchEvent(new t.w.Event('submit', { cancelable: true })); await tick();
  release(); await settle();
  assert.equal(t.$('answer-panel').getAttribute('aria-busy'), 'false');
  t.close();
});

test('clicking a pin opens the glance card beside the globe and loads a cited summary', async () => {
  const t = boot(); await settle();
  await t.ask('Where is flooding?');
  t.d.querySelector('.pin[data-id="jakarta-city"]').click(); await settle();
  assert.ok(t.$('glance').classList.contains('is-open'));
  assert.equal(t.$('glance-title').textContent, 'Jakarta');
  assert.deepEqual(t.calls.glance, [['Jakarta', undefined]]);
  assert.match(t.$('glance-summary').textContent, /Jakarta claim/);
  assert.match(t.$('glance-issues').textContent, /Issue in Jakarta/);
  assert.equal(t.$('glance-issues').querySelector('a.cite').getAttribute('href'), '#evidence-1');
  assert.deepEqual(t.globe.focused, ['jakarta-city']);
  assert.equal(t.globe.holds.at(-1), true);
  t.close();
});

test('clicking another pin swaps the card in place; a slow earlier response cannot overwrite it', async () => {
  const pending = {};
  const t = boot({ api: { glance: (name) => new Promise(r => { pending[name] = () => r({ status: 'answered', place: name,
    claims: [{ text: `${name} summary.`, evidence: [{ source_id: 'S1', quote: 'TEST FIXTURE quote text.' }] }],
    sources: [{ id: 'S1', title: 'T', url: null, page: 1, passage: 'TEST FIXTURE quote text.' }] }); }) } });
  await settle();
  await t.ask('Where is flooding?');
  t.d.querySelector('.pin[data-id="jakarta-city"]').click(); await tick();
  t.d.querySelector('.pin[data-id="bogota-city"]').click(); await tick();
  assert.equal(t.$('glance-title').textContent, 'Bogota');
  pending['Bogota'](); await settle();
  pending['Jakarta'](); await settle(); // stale: must be ignored
  assert.match(t.$('glance-summary').textContent, /Bogota summary/);
  assert.doesNotMatch(t.$('glance-summary').textContent, /Jakarta summary/);
  assert.equal(t.globe.holds.filter(x => x === true).length, 1, 'rotation is held once, not once per click');
  t.close();
});

test('follow-up question is posted for this place and answered inline', async () => {
  const t = boot(); await settle();
  await t.ask('Where is flooding?');
  t.d.querySelector('.pin[data-id="jakarta-city"]').click(); await settle();
  t.$('glance-input').value = 'How should drainage be improved?';
  t.$('glance-form').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true })); await settle();
  assert.deepEqual(t.calls.glance.at(-1), ['Jakarta', 'How should drainage be improved?']);
  assert.match(t.$('glance-thread').textContent, /How should drainage be improved\?/);
  assert.match(t.$('glance-thread').textContent, /Jakarta claim/);
  assert.equal(t.$('glance-send').disabled, false);
  t.close();
});

test('glance failure shows a retry; refusal explains instead of inventing', async () => {
  let n = 0;
  const t = boot({ api: { glance: async () => { if (n++ === 0) throw new Error('AWS request failed.'); return { status: 'insufficient_evidence', answer: 'x', claims: [], sources: [] }; } } });
  await settle();
  await t.ask('Where is flooding?');
  t.d.querySelector('.pin[data-id="jakarta-city"]').click(); await settle();
  assert.match(t.$('glance-summary').textContent, /AWS request failed/);
  t.$('glance-summary').querySelector('.link-button').click(); await settle();
  assert.match(t.$('glance-summary').textContent, /don't say more about Jakarta/);
  t.close();
});

test('full briefing link carries the place and the PII-masked topic, never the raw question', async () => {
  const t = boot(); await settle();
  await t.ask('My email is a@b.com, where is flooding?');
  t.d.querySelector('.pin[data-id="jakarta-city"]').click(); await settle();
  const href = t.$('glance-brief').getAttribute('href');
  assert.match(href, /^briefing\.html\?/);
  const params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('place'), 'Jakarta');
  assert.equal(params.get('topic'), 'masked question text');
  assert.doesNotMatch(href, /a%40b|a@b/);
  assert.equal(t.$('glance-brief').getAttribute('target'), '_blank');
  assert.match(t.$('glance-brief').getAttribute('rel'), /noopener/);
  t.close();
});

test('Escape closes the card first (releasing rotation), then the answer panel', async () => {
  const t = boot(); await settle();
  await t.ask('Where is flooding?');
  t.d.querySelector('.pin[data-id="jakarta-city"]').click(); await settle();
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.$('glance').classList.contains('is-open'), false);
  assert.equal(t.globe.holds.at(-1), false);
  assert.ok(t.$('answer-panel').classList.contains('is-open'));
  t.d.dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(t.$('answer-panel').classList.contains('is-open'), false);
  assert.equal(t.$('answer-reopen').hidden, false);
  t.close();
});

test('nearby pins merge into one count marker and keep the selected pin separate', async () => {
  const t = boot(); await settle();
  await t.ask('Where is flooding?');
  const frame = (a, b) => [{ id: 'jakarta-city', x: 100, y: 100, facing: 1 }, { id: 'bogota-city', x: a, y: b, facing: 1 }];
  for (const l of t.globe.listeners) l(frame(110, 105)); // 11px apart: merged
  const jakarta = t.d.querySelector('.pin[data-id="jakarta-city"]'), bogota = t.d.querySelector('.pin[data-id="bogota-city"]');
  assert.equal(jakarta.querySelector('.pin-count').textContent, '2');
  assert.ok(bogota.classList.contains('is-hidden'));
  for (const l of t.globe.listeners) l(frame(400, 300)); // far apart: separate again
  assert.equal(jakarta.querySelector('.pin-count').hidden, true);
  assert.equal(bogota.classList.contains('is-hidden'), false);
  for (const l of t.globe.listeners) l([{ id: 'jakarta-city', x: 5, y: 5, facing: 0 }, { id: 'bogota-city', x: 9, y: 9, facing: 0.9 }]);
  assert.ok(jakarta.classList.contains('is-hidden'), 'pins on the far side of the globe are hidden');
  t.close();
});

test('graph helpers: cited publications match by title; neighbors include the node itself', () => {
  const nodes = [{ id: 'a', type: 'publication', label: 'Aqueduct 4.0: Water Risk' }, { id: 'b', type: 'publication', label: 'Other' }, { id: 'h', type: 'topic', label: 'Freshwater' }];
  assert.deepEqual([...matchCited(nodes, [{ title: '  aqueduct 4.0:  water RISK ' }, { title: 'Unknown' }, null])], ['a']);
  assert.deepEqual([...matchCited(nodes, undefined)], []);
  const links = [{ source: 'h', target: 'a' }, { source: { id: 'h' }, target: { id: 'b' } }];
  assert.deepEqual([...neighborIds('h', links)].sort(), ['a', 'b', 'h']);
  assert.deepEqual([...neighborIds('a', links)].sort(), ['a', 'h']);
});
