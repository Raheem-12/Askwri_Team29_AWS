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

function boot({ api = {}, mobile = false, seed = null } = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:5173', pretendToBeVisual: true });
  const w = dom.window;
  if (seed !== null) w.localStorage.setItem('askwri.sessions.v1', typeof seed === 'string' ? seed : JSON.stringify(seed));
  w.Element.prototype.scrollIntoView = () => {}; // jsdom has no layout; real browsers do
  w.matchMedia = query => ({ matches: query.includes('max-width') ? mobile : false, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, { window: w, document: w.document, Event: w.Event, CustomEvent: w.CustomEvent, HTMLElement: w.HTMLElement });
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  const calls = { ask: [], glance: [], status: 0 };
  const fake = {
    status: async () => { calls.status++; return { configured: true, connection_verified: false, demo: false, guardrails: true }; },
    ask: async (q, team) => { calls.ask.push(q); calls.team = team; return answer(); },
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

test('the optional team goes with the question, and is left out when not chosen', async () => {
  const t = boot(); await settle();
  await t.ask('Where is flooding?');
  assert.equal(t.calls.team, undefined);
  t.$('team').value = 'Cities';
  await t.ask('Where is flooding?');
  assert.equal(t.calls.team, 'Cities');
  t.close();
});

test('people can see their question was logged to Demand Radar', async () => {
  const withGap = answer({ radar: { gap_type: 'weak', matched_title: null } });
  let t = boot({ api: { ask: async () => withGap } }); await settle();
  await t.ask('Where is flooding?');
  assert.match(t.$('answer-body').textContent, /without your name to Demand Radar as weak coverage/);
  assert.equal(t.$('answer-body').querySelector('.radar-note a').getAttribute('href'), '/radar');
  t.close();
  t = boot({ api: { ask: async () => answer({ radar: { gap_type: null } }) } }); await settle();
  await t.ask('Where is flooding?');
  assert.match(t.$('answer-body').textContent, /Question logged without your name/);
  t.close();
  t = boot(); await settle(); // a blocked question has no radar field and no note
  await t.ask('Where is flooding?');
  assert.equal(t.$('answer-body').querySelector('.radar-note'), null);
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

// ---------- sessions: follow-ups, the slide toggle, past sessions
const asker = () => {
  const sent = [];
  return { sent, ask: async (q, team, language, history) => {
    sent.push({ q, history });
    return answer({ topic: `masked: ${q}`, answer: `Answer to ${q}`,
      locations: q.includes('no places') ? [] : [place('jakarta-city', 'Jakarta', -6.17, 106.83)] });
  } };
};
const followUp = async (t, text) => {
  t.$('followup-input').value = text;
  t.$('followup-form').dispatchEvent(new t.w.Event('submit', { bubbles: true, cancelable: true }));
  await settle();
};
const stored = t => JSON.parse(t.w.localStorage.getItem('askwri.sessions.v1') || '[]');
const pastSession = (over = {}) => ({ id: 'old', startedAt: 1790000000000, demo: false,
  turns: [{ question: 'Old question', data: answer({ answer: 'Old answer' }) }], ...over });

test('the follow-up box appears only once a session has an answer', async () => {
  const t = boot({ api: asker() }); await settle();
  assert.equal(t.$('followup-form').hidden, true);
  await t.ask('First question');
  assert.equal(t.$('followup-form').hidden, false);
  t.close();
});

test('a follow-up sends only this session, stacks the earlier answer, and clears its box', async () => {
  const a = asker();
  const t = boot({ api: a }); await settle();
  await t.ask('First question');
  await followUp(t, 'Place the pins please');
  assert.equal(a.sent[0].history.length, 0);
  assert.deepEqual(a.sent[1].history, [{ question: 'masked: First question', answer: 'Answer to First question' }]);
  assert.equal(t.$('session-turns').querySelectorAll('.turn').length, 1);
  assert.match(t.$('session-turns').textContent, /masked: First question/);
  assert.match(t.$('answer-body').textContent, /Place the pins please/);
  assert.equal(t.$('followup-input').value, '');
  assert.ok(t.$('session-turns').querySelector('a.cite').getAttribute('href').startsWith('#turn-1-'));
  const ids = [...t.d.querySelectorAll('[id]')].map(e => e.id);
  assert.equal(new Set(ids).size, ids.length, 'citation anchors stay unique');
  t.close();
});

test('the bottom box starts a new chat: old answers leave, and the old session is in Past sessions', async () => {
  const a = asker();
  const t = boot({ api: a }); await settle();
  await t.ask('First question');
  await followUp(t, 'A follow-up');
  await t.ask('A brand new question');
  assert.equal(a.sent[2].history.length, 0, 'nothing from the old session is sent');
  assert.equal(t.$('session-turns').children.length, 0);
  assert.doesNotMatch(t.$('answer-panel').querySelector('#pane-answer').textContent, /First question/);
  assert.equal(stored(t).length, 2);
  t.$('tab-past').click();
  const items = t.$('past-list').querySelectorAll('.past-item');
  assert.equal(items.length, 1, 'the live session is not listed as past');
  assert.match(items[0].textContent, /masked: First question/);
  assert.match(items[0].textContent, /2 questions/);
  t.close();
});

test('the toggle slides between panes, and only the visible pane can be reached', async () => {
  const t = boot({ api: asker() }); await settle();
  await t.ask('First question');
  t.$('tab-past').click();
  assert.equal(t.$('panel-panes').dataset.active, 'past');
  assert.equal(t.$('panel-tabs').dataset.active, 'past');
  assert.equal(t.$('tab-past').getAttribute('aria-selected'), 'true');
  assert.equal(t.$('pane-answer').inert, true);
  assert.equal(t.$('pane-past').inert, false);
  t.$('panel-tabs').dispatchEvent(new t.w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(t.$('panel-panes').dataset.active, 'answer');
  assert.equal(t.$('pane-past').inert, true);
  t.close();
});

test('a past session opens read-only with its pins, and a live session survives the visit', async () => {
  const a = asker();
  const t = boot({ api: a, seed: [pastSession()] }); await settle();
  await t.ask('Live question');
  t.$('tab-past').click();
  t.$('past-list').querySelector('.past-item').click();
  assert.equal(t.$('panel-panes').dataset.active, 'answer');
  assert.equal(t.$('past-banner').hidden, false);
  assert.equal(t.$('followup-form').hidden, true);
  assert.match(t.$('answer-body').textContent, /Old question/);
  assert.equal(t.globe.points.length, 2, 'the old answer has two places');
  t.$('past-back').click();
  assert.match(t.$('answer-body').textContent, /masked: Live question/);
  assert.equal(t.$('followup-form').hidden, false);
  assert.equal(t.globe.points.length, 1);
  assert.equal(a.sent.length, 1, 'looking at history costs no model call');
  t.close();
});

test('sessions from an earlier visit can be reached from a fresh page', async () => {
  const t = boot({ seed: [pastSession()] }); await settle();
  assert.equal(t.$('answer-reopen').hidden, false);
  assert.match(t.$('answer-reopen').textContent, /Past sessions/);
  t.close();
  const fresh = boot(); await settle();
  assert.equal(fresh.$('answer-reopen').hidden, true);
  fresh.close();
});

test('a failed follow-up keeps the session and pins and offers a retry that keeps the text', async () => {
  let fail = false; const a = asker();
  const t = boot({ api: { ask: async (...args) => { if (fail) throw new Error('The model returned an invalid evidence response. Please retry.'); return a.ask(...args); } } }); await settle();
  await t.ask('First question');
  fail = true;
  await followUp(t, 'A follow-up');
  assert.match(t.$('answer-body').textContent, /invalid evidence/);
  assert.equal(t.$('session-turns').querySelectorAll('.turn').length, 1);
  assert.equal(t.globe.points.length, 1, 'pins from the earlier turn stay');
  assert.equal(t.$('followup-input').value, 'A follow-up');
  assert.equal(stored(t)[0].turns.length, 1, 'failed turns are not saved');
  fail = false;
  t.$('answer-body').querySelector('.link-button').click();
  await settle();
  assert.equal(stored(t)[0].turns.length, 2);
  t.close();
});

test('a failed new search leaves no chips or pins from the older answer', async () => {
  let fail = false;
  const t = boot({ api: { ask: async () => { if (fail) throw new Error('nope'); return answer(); } } }); await settle();
  await t.ask('First question');
  assert.equal(t.$('places-section').hidden, false);
  fail = true;
  await t.ask('Second question');
  assert.equal(t.$('places-section').hidden, true);
  assert.equal(t.$('places').children.length, 0);
  assert.equal(t.globe.points.length, 0);
  assert.equal(t.$('question').value, 'Second question', 'the question is kept for retry');
  t.close();
});

test('a follow-up with no places keeps the pins, and their citations reach the earlier turn', async () => {
  const t = boot({ api: asker() }); await settle();
  await t.ask('First question');
  await followUp(t, 'tell me about no places');
  assert.equal(t.globe.points.length, 1);
  assert.equal(t.app.state.lookup.get('S1').anchor, 'turn-1-1');
  assert.ok(t.d.getElementById('turn-1-1'));
  t.close();
});

test('storage holds the masked question, and a blocked question is never stored', async () => {
  const typed = 'my card is 4111 1111 1111 1111';
  const t = boot({ api: { ask: async () => ({ status: 'out_of_scope', answer: 'No.', claims: [], sources: [], locations: [], topic: null }) } }); await settle();
  await t.ask(typed);
  assert.equal(t.w.localStorage.getItem('askwri.sessions.v1').includes('4111'), false);
  assert.equal(stored(t)[0].turns[0].question, '');
  t.close();
  const a = asker();
  const m = boot({ api: a }); await settle();
  await m.ask('Email me at someone@example.com');
  assert.equal(stored(m)[0].turns[0].question, 'masked: Email me at someone@example.com');
  m.close();
});

test('tampered or corrupt storage is ignored and cannot break the page', async () => {
  for (const seed of ['{not json', '{"a":1}', JSON.stringify([{ id: 'x', startedAt: 'soon', turns: [] },
    { id: 'y', startedAt: 1, turns: [{ question: 'q', data: { status: 'answered', claims: 'nope' } }] },
    { id: 'z', startedAt: 1, turns: [{ question: 7, data: { status: 'answered', claims: [] } }] }])]) {
    const t = boot({ seed }); await settle();
    t.app.setTab('past');
    assert.equal(t.$('past-list').querySelectorAll('.past-item').length, 0);
    t.close();
  }
});

test('stored markup stays text and a stored unsafe link is not rendered as a link', async () => {
  const evil = pastSession({ turns: [{ question: '<img src=x onerror=alert(1)>', data: answer({
    sources: [{ id: 'S1', title: '<b>T</b>', url: 'javascript:alert(1)', page: 1, passage: 'p' }] }) }] });
  const t = boot({ seed: [evil] }); await settle();
  t.app.openPast('old');
  assert.equal(t.$('pane-answer').querySelector('img'), null);
  assert.equal(t.$('sources').querySelector('a[href^="javascript"]'), null);
  t.close();
});

test('a full or missing browser store never costs the answer', async () => {
  const t = boot({ api: asker() }); await settle();
  t.w.Storage.prototype.setItem = () => { throw new t.w.DOMException('full', 'QuotaExceededError'); };
  await t.ask('First question');
  assert.match(t.$('answer-body').textContent, /First question/);
  await followUp(t, 'A follow-up');
  assert.equal(t.$('session-turns').querySelectorAll('.turn').length, 1, 'the session still works in memory');
  t.close();
});

test('only 20 sessions are kept', async () => {
  const many = Array.from({ length: 20 }, (_, i) => pastSession({ id: `s${i}` }));
  const t = boot({ api: asker(), seed: many }); await settle();
  await t.ask('One more');
  assert.equal(stored(t).length, 20);
  assert.equal(stored(t)[0].turns[0].question, 'masked: One more');
  assert.equal(stored(t).some(s => s.id === 's19'), false, 'the oldest goes first');
  t.close();
});

test('clearing takes two clicks and keeps the live session', async () => {
  const t = boot({ api: asker(), seed: [pastSession()] }); await settle();
  await t.ask('Live question');
  t.$('tab-past').click();
  t.$('clear-sessions').click();
  assert.equal(stored(t).length, 2);
  t.$('clear-sessions').click();
  assert.equal(stored(t).length, 1);
  assert.equal(stored(t)[0].turns[0].question, 'masked: Live question');
  assert.equal(t.$('past-list').querySelectorAll('.past-item').length, 0);
  t.close();
});

test('sample-mode sessions stay labeled as sample data', async () => {
  const t = boot({ seed: [pastSession({ demo: true })] }); await settle();
  t.app.setTab('past');
  assert.match(t.$('past-list').textContent, /SAMPLE/);
  t.close();
});

// ---------- safety card
const { cleanSafety } = await import('../src/safety.js');
const summary = (verdict = 'clear', input = 'passed', quotes = { result: 'passed' }, grounding = 'passed') => ({ verdict,
  checks: [{ id: 'input', result: input }, { id: 'quotes', ...quotes }, { id: 'grounding', result: grounding }] });
const safetyApi = safety => ({ ask: async () => answer({ safety }) });

test('the safety card shows each check and its result', async () => {
  const t = boot({ api: safetyApi(summary('review', 'masked', { result: 'removed', count: 2 })) }); await settle();
  await t.ask('A question');
  const card = t.$('safety-card');
  assert.equal(card.hidden, false);
  assert.match(card.textContent, /Worth reviewing/);
  assert.match(card.textContent, /Personal details masked/);
  assert.match(card.textContent, /2 claims removed/);
  assert.match(card.textContent, /not a security audit/);
  assert.equal(t.$('safety-inline').hidden, false, 'phones show the same summary in the answer sheet');
  t.close();
});

test('the safety card is announced only when there is something to notice', async () => {
  let t = boot({ api: safetyApi(summary('review', 'masked')) }); await settle();
  await t.ask('A question');
  assert.match(t.$('announcement').textContent, /Safety check: Worth reviewing/);
  t.close();
  t = boot({ api: safetyApi(summary()) }); await settle();
  await t.ask('A question');
  assert.doesNotMatch(t.$('announcement').textContent, /Safety check/);
  t.close();
});

test('the safety card clears while searching, and stays clear if the request fails', async () => {
  let fail = false;
  const t = boot({ api: { ask: async () => { if (fail) throw new Error('down'); return answer({ safety: summary() }); } } }); await settle();
  await t.ask('First');
  assert.equal(t.$('safety-card').hidden, false);
  fail = true;
  await t.ask('Second');
  assert.equal(t.$('safety-card').hidden, true);
  assert.equal(t.$('safety-card').textContent, '');
  t.close();
});

test('an answer with no summary shows no card, rather than a guess', async () => {
  const t = boot(); await settle();
  await t.ask('A question');
  assert.equal(t.$('safety-card').hidden, true);
  t.close();
});

test('a past session reopens with its own summary, and older ones with none', async () => {
  const withCard = pastSession({ turns: [{ question: 'Q', data: answer({ safety: summary('review', 'limited', { result: 'passed' }, 'not_run') }) }] });
  let t = boot({ seed: [withCard] }); await settle();
  t.app.openPast('old');
  assert.match(t.$('safety-card').textContent, /Basic check only/);
  assert.match(t.$('safety-card').textContent, /Not run/);
  t.close();
  t = boot({ seed: [pastSession()] }); await settle();
  t.app.openPast('old');
  assert.equal(t.$('safety-card').hidden, true);
  t.close();
});

test('tampered summaries are rejected', () => {
  const bad = [null, 'clear', {}, { verdict: 'clear' }, { verdict: 'nope', checks: summary().checks },
    summary('clear', 'masked'), summary('clear', 'passed', { result: 'not_run' }), summary('clear', 'passed', { result: 'passed' }, 'failed'),
    summary('blocked', 'passed'), summary('review', 'blocked'), summary('review', '<img src=x>'),
    summary('review', 'passed', { result: 'removed' }), summary('review', 'passed', { result: 'removed', count: 0 }),
    summary('review', 'passed', { result: 'removed', count: '2' }),
    { verdict: 'clear', checks: [...summary().checks].reverse() }, { verdict: 'clear', checks: summary().checks.slice(1) }];
  for (const value of bad) assert.equal(cleanSafety(value), null, JSON.stringify(value));
  assert.deepEqual(cleanSafety(summary()), summary());
});

test('a stored summary keeps only known fields, and bad ones show no card', async () => {
  const extra = summary();
  extra.note = '<b>flagged text</b>';
  extra.checks[0].detail = 'a@b.com';
  assert.equal(JSON.stringify(cleanSafety(extra)).includes('a@b.com'), false);
  assert.equal(JSON.stringify(cleanSafety(extra)).includes('flagged'), false);
  const t = boot({ seed: [pastSession({ turns: [{ question: 'Q', data: answer({ safety: summary('clear', 'blocked') }) }] })] }); await settle();
  t.app.openPast('old');
  assert.equal(t.$('safety-card').hidden, true);
  t.close();
});

// ---------- masked question and original PDFs
const withDocument = (document, over = {}) => answer({ sources: [{ id: 'S1', title: 'T', url: null, page: 7, passage: 'TEST FIXTURE supporting passage.', document, ...over }] });

test('the panel shows the masked question, never the typed one', async () => {
  const t = boot({ api: { ask: async () => answer({ topic: 'Is {EMAIL} affected?' }) } }); await settle();
  await t.ask('Is a@b.com affected?');
  assert.match(t.$('answer-body').textContent, /Is \{EMAIL\} affected\?/);
  assert.doesNotMatch(t.d.body.textContent, /a@b\.com/);
  assert.doesNotMatch(t.w.localStorage.getItem('askwri.sessions.v1'), /a@b\.com/);
  t.close();
});

test('a blocked question is not repeated on screen', async () => {
  const t = boot({ api: { ask: async () => ({ status: 'out_of_scope', answer: 'Try again.', claims: [], sources: [], locations: [], topic: null }) } }); await settle();
  await t.ask('my card is 4111 1111 1111 1111');
  assert.doesNotMatch(t.$('answer-body').textContent, /4111/);
  t.close();
});

test('a source links to its original PDF, opened at the cited page', async () => {
  const doc = '/api/document/docs/2024_publications/a%20b.pdf';
  const t = boot({ api: { ask: async () => withDocument(doc) } }); await settle();
  await t.ask('A question');
  const links = [...t.$('sources').querySelectorAll('.source-meta a')].map(a => [a.textContent, a.getAttribute('href'), a.rel, a.target]);
  assert.deepEqual(links[0], ['PDF page 7 ↗', `${doc}#page=7`, 'noopener noreferrer', '_blank']);
  assert.deepEqual(links[1], ['Open original PDF ↗', doc, 'noopener noreferrer', '_blank']);
  assert.doesNotMatch(t.$('sources').textContent, /Public link unavailable/);
  assert.ok(t.$('sources').querySelector('summary .source-meta a'), 'the links show on a closed source');
  t.close();
});

test('a source with both keeps its wri.org link beside the PDF', async () => {
  const t = boot({ api: { ask: async () => withDocument('/api/document/docs/2024_publications/a.pdf', { url: 'https://www.wri.org/research/a' }) } }); await settle();
  await t.ask('A question');
  const hrefs = [...t.$('sources').querySelectorAll('.source-meta a')].map(a => a.getAttribute('href'));
  assert.ok(hrefs.includes('https://www.wri.org/research/a') && hrefs.includes('/api/document/docs/2024_publications/a.pdf'));
  t.close();
});

test('unexpected document links are never rendered, including from a saved session', async () => {
  for (const bad of ['https://evil.example/a.pdf', '//evil.example/docs/2024_publications/a.pdf', 'javascript:alert(1)',
    '/api/document/../secret.pdf', '/api/document/docs/2024_publications/../../a.pdf', '/api/document/Resources.pdf',
    '/api/document/docs/2024_publications/a.pdf?x=1', '/api/ask', 7, null]) {
    const t = boot({ seed: [pastSession({ turns: [{ question: 'Q', data: withDocument(bad) }] })] }); await settle();
    t.app.openPast('old');
    assert.equal(t.$('sources').querySelectorAll('.source-meta a').length, 0, String(bad));
    assert.match(t.$('sources').textContent, /Public link unavailable/);
    t.close();
  }
});
