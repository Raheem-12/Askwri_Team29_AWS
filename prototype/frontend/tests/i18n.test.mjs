import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/<script type="module".*?<\/script>/, '');
const i18n = await import('../src/i18n.js');
const { initApp } = await import('../src/app.js');
const { renderSource } = await import('../src/render.js');

const tick = () => new Promise(r => setImmediate(r));
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };
const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

// ---------- every language is complete
for (const { code } of i18n.LANGUAGES) {
  test(`locale ${code}: same keys and placeholders as English`, () => {
    const en = i18n.LOCALES.en, loc = i18n.LOCALES[code];
    assert.deepEqual(Object.keys(loc).sort(), Object.keys(en).sort());
    for (const key of Object.keys(en)) {
      assert.equal(placeholders(loc[key]), placeholders(en[key]), `${code} ${key}`);
      assert.ok(loc[key].trim(), `${code} ${key} is empty`);
    }
  });
}

test('every key used in the HTML pages exists in English', () => {
  for (const page of ['index.html', 'briefing.html']) {
    const text = fs.readFileSync(path.join(root, page), 'utf8');
    const keys = [...text.matchAll(/data-i18n(?:-question)?="([^"]+)"/g)].map(m => m[1])
      .concat([...text.matchAll(/data-i18n-attr="([^"]+)"/g)].flatMap(m => m[1].split(';').map(p => p.split(':')[1])));
    for (const key of keys) assert.ok(key in i18n.LOCALES.en, `${page}: ${key}`);
  }
});

test('plurals follow each language', () => {
  i18n.setLanguage('en', { save: false });
  assert.equal(i18n.tn('sources.count', 1), '1 source');
  assert.equal(i18n.tn('sources.count', 3), '3 sources');
  i18n.setLanguage('fr', { save: false });
  assert.equal(i18n.tn('sources.count', 1), '1 source');
  i18n.setLanguage('en', { save: false });
});

// ---------- the page
function boot(answerOverrides = {}) {
  const dom = new JSDOM(html, { url: 'http://localhost:5173', pretendToBeVisual: true });
  const w = dom.window;
  w.Element.prototype.scrollIntoView = () => {};
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  Object.assign(globalThis, { window: w, document: w.document, Event: w.Event, CustomEvent: w.CustomEvent, HTMLElement: w.HTMLElement });
  Object.defineProperty(globalThis, 'navigator', { value: w.navigator, configurable: true });
  const calls = { ask: [], glance: [] };
  const api = {
    status: async () => ({ configured: true, demo: false, guardrails: true }),
    ask: async (q, team, language) => {
      calls.ask.push({ q, team, language });
      return { status: 'answered', topic: q, demo: false, language, requested_language: language,
        claims: [{ text: 'Afirmación.', evidence: [{ source_id: 'S1', quote: 'TEST FIXTURE original quote.', translation: 'Cita traducida.' }] }],
        sources: [{ id: 'S1', title: 'TEST FIXTURE - Publication', url: null, page: 2, passage: 'TEST FIXTURE original quote.' }],
        locations: [], ...answerOverrides };
    },
    glance: async (place, q, language) => { calls.glance.push({ place, q, language }); return { status: 'insufficient_evidence', claims: [], sources: [] }; },
    graph: async () => ({ nodes: [], edges: [] })
  };
  i18n.setLanguage('en', { save: false });
  const picker = w.document.getElementById('language');
  i18n.bindPicker(picker);
  const app = initApp({ globe: null, api });
  const $ = id => w.document.getElementById(id);
  const ask = async text => {
    $('question').value = text;
    $('ask-form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };
  const choose = async code => { picker.value = code; picker.dispatchEvent(new w.Event('change')); await settle(); };
  return { w, $, app, calls, ask, choose, close: () => { i18n.setLanguage('en', { save: false }); w.close(); } };
}

test('the picker lists every language and switching translates the page in place', async () => {
  const t = boot(); await settle();
  assert.equal(t.$('language').options.length, i18n.LANGUAGES.length);
  await t.choose('es');
  assert.equal(t.w.document.documentElement.lang, 'es');
  assert.equal(t.w.document.querySelector('#intro h1').textContent, 'Un mundo de investigación.');
  assert.equal(t.$('question').placeholder, '¿Qué te gustaría entender?');
  assert.equal(t.$('ask-button-text').textContent, 'Buscar evidencia');
  assert.equal(t.$('connection-text').textContent, 'Configurado · La conexión se comprobará cuando busques.');
  assert.equal(t.$('globe-in').getAttribute('aria-label'), 'Acercar');
  const chip = t.w.document.querySelector('[data-i18n-question="example.flood.q"]');
  assert.equal(chip.dataset.question, '¿Dónde son un problema las inundaciones urbanas?');
  // team labels are translated but the logged value stays English for Demand Radar
  const water = [...t.$('team').options].find(o => o.value === 'Water');
  assert.equal(water.textContent, 'Agua');
  await t.choose('zh');
  assert.equal(t.w.document.documentElement.lang, 'zh-Hans');
  assert.equal(t.$('ask-button-text').textContent, '查找证据');
  t.close();
});

test('the chosen language goes to the API with every question', async () => {
  const t = boot(); await settle();
  await t.ask('flooding in Jakarta');
  assert.equal(t.calls.ask[0].language, 'en');
  await t.choose('pt');
  await t.ask('enchentes em Jacarta');
  assert.equal(t.calls.ask[1].language, 'pt');
  t.close();
});

test('a translated answer says so, and each quote shows its original and a labeled translation', async () => {
  const t = boot(); await settle();
  await t.choose('es');
  await t.ask('inundaciones en Yakarta');
  const body = t.$('answer-body').textContent;
  assert.match(body, /redactadas automáticamente en español/);
  const sources = t.$('sources').textContent;
  assert.match(sources, /TEST FIXTURE original quote\./);
  assert.match(sources, /Cita traducida\./);
  assert.match(sources, /Traducción automática/);
  t.close();
});

test('sample mode admits answers stay in English', async () => {
  const t = boot({ language: 'en' }); await settle();
  await t.choose('fr');
  await t.ask('inondations à Jakarta');
  assert.match(t.$('answer-body').textContent, /uniquement en anglais/);
  t.close();
});

test('switching language with an answer on screen offers to re-run it, and the offer works', async () => {
  const t = boot(); await settle();
  await t.ask('flooding in Jakarta');
  assert.equal(t.$('rerun-language'), null);
  await t.choose('id');
  const rerun = t.$('rerun-language');
  assert.ok(rerun && /Bahasa Indonesia/.test(rerun.textContent));
  rerun.click(); await settle();
  assert.equal(t.calls.ask.length, 2);
  assert.equal(t.calls.ask[1].q, 'flooding in Jakarta');
  assert.equal(t.calls.ask[1].language, 'id');
  assert.equal(t.$('rerun-language'), null);
  t.close();
});

test('an English answer with no translation renders exactly as before', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  i18n.setLanguage('en', { save: false });
  const node = renderSource({ id: 'S1', number: 1, anchor: 'a-1', title: 'T', passage: 'P' },
    [{ text: 'c', evidence: [{ source_id: 'S1', quote: 'An English quote.' }] }]);
  assert.equal(node.querySelector('.quote-translation'), null);
  assert.equal(node.querySelector('.quote').textContent, 'An English quote.');
});

test('language names follow each language\'s capitalisation in sentences', () => {
  i18n.setLanguage('es', { save: false });
  assert.equal(i18n.t('translation.rerun', { lang: i18n.languageName('es') }), 'Obtener esta respuesta en español');
  i18n.setLanguage('id', { save: false });
  assert.equal(i18n.languageName('id'), 'Bahasa Indonesia');
  i18n.setLanguage('en', { save: false });
  assert.equal(i18n.languageName('es'), 'Español');
});
