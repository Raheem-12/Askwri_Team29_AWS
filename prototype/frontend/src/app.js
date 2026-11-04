import { $, el, announce, prefersReducedMotion } from './util.js';
import { api as defaultApi } from './api.js';
import { indexSources, validClaims, renderClaims, renderSources, copyableText } from './render.js';
import { createPins } from './pins.js';
import { createGlance } from './glance.js';
import { createGraph } from './graph.js';
import { t, tn, getLanguage, languageName, onLanguageChange } from './i18n.js';

const noop = () => {};
const NO_GLOBE = {
  setPoints: noop, onFrame: () => noop, setInsets: noop, hold: noop, focus: noop, frame: noop,
  reset: noop, zoomBy: noop, toggleRotation: () => false, rotating: false
};
const MOBILE = '(max-width: 760px)';
const GAP_KEYS = { not_loaded: 'gap.not_loaded', weak: 'gap.weak', never_published: 'gap.never_published' };

export function cleanPlaces(list) {
  return (Array.isArray(list) ? list : [])
    .filter(p => p && typeof p.id === 'string' && typeof p.name === 'string'
      && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180
      && Array.isArray(p.issues))
    .map(p => ({ ...p, issues: p.issues.filter(i => i && typeof i.issue === 'string') }));
}

export function initApp({ globe = null, api = defaultApi } = {}) {
  const g = globe || NO_GLOBE;
  const stage = $('stage'), panel = $('answer-panel'), glanceEl = $('glance');
  const state = { places: new Map(), lookup: null, topic: null, sources: [], busy: false, view: 'globe', holding: false,
    lastQuestion: null, answerLanguage: null };
  let lastCopy = '', copyTimer, graph = null, graphLoaded = false;

  // ---------------------------------------------------------------- layout
  // Panels never cover the globe: the globe's view shifts into the free space instead.
  const TOPBAR = 56;
  function layout() {
    const mobile = window.matchMedia(MOBILE).matches;
    const panelOpen = panel.classList.contains('is-open'), glanceOpen = glanceEl.classList.contains('is-open');
    const W = stage.clientWidth, H = stage.clientHeight, askH = $('ask-form').offsetHeight + 28;
    // Notices and the landing headline sit at the top; keep the globe clear of them.
    const top = Math.max(TOPBAR, Math.ceil($('top-stack').getBoundingClientRect().bottom) + 8);
    let left = 0, right = 0, bottom = askH;
    if (mobile) {
      const sheet = Math.max(panelOpen ? panel.offsetHeight : 0, glanceOpen ? glanceEl.offsetHeight : 0);
      if (sheet) bottom = sheet;
    } else {
      left = panelOpen ? panel.offsetWidth + 16 : 0;
      right = glanceOpen ? glanceEl.offsetWidth + 16 : 0;
    }
    stage.style.setProperty('--inset-l', left + 'px');
    stage.style.setProperty('--inset-r', right + 'px');
    // Centre the globe in the space panels and the ask bar leave free, and zoom out to fit it there.
    g.setInsets((left - right) / 2, (top - bottom) / 2, { width: W - left - right - 24, height: H - top - bottom });
  }
  window.addEventListener('resize', layout);
  // The ask bar, panels and fonts all settle after first paint. Without this the globe is
  // centred using stale sizes and ends up off-centre until the next resize.
  if (typeof ResizeObserver !== 'undefined') {
    const watcher = new ResizeObserver(() => requestAnimationFrame(layout));
    [$('ask-form'), $('top-stack'), panel, glanceEl].forEach(node => watcher.observe(node));
  }
  document.fonts?.ready.then(layout);
  window.addEventListener('load', layout);

  function setPanel(open) {
    panel.classList.toggle('is-open', open);
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
    $('answer-reopen').hidden = open || !state.lookup;
    layout();
  }

  // ---------------------------------------------------------------- pins and glance
  const leader = $('leader-line');
  let leaderShown = false;
  function updateLeader() {
    const place = glance.current, pos = place && pins.position(place.id);
    if (!pos || pos.facing < 0.35 || !glanceEl.classList.contains('is-open')) {
      if (leaderShown) { leader.style.opacity = '0'; leaderShown = false; }
      return;
    }
    const card = glanceEl.getBoundingClientRect(), mobile = window.matchMedia(MOBILE).matches;
    const tx = mobile ? Math.min(Math.max(pos.x, card.left + 24), card.right - 24) : card.left;
    const ty = mobile ? card.top : Math.min(Math.max(pos.y, card.top + 28), card.bottom - 28);
    leader.setAttribute('x1', pos.x.toFixed(1)); leader.setAttribute('y1', pos.y.toFixed(1));
    leader.setAttribute('x2', tx.toFixed(1)); leader.setAttribute('y2', ty.toFixed(1));
    if (!leaderShown) { leader.style.opacity = '1'; leaderShown = true; }
  }

  const pins = createPins($('pin-layer'), {
    onSelect: id => selectPlace(id),
    onCluster: ids => g.frame(ids, { tighten: 0.62 })
  });
  g.onFrame(projected => { pins.update(projected); updateLeader(); });

  const glance = createGlance(glanceEl, {
    api,
    context: () => ({ topic: state.topic, lookup: state.lookup }),
    onClose: () => {
      pins.select(null);
      if (state.holding) { g.hold(false); state.holding = false; }
      updateLeader();
      layout();
    }
  });
  // A citation in the glance card opens the matching source in the answer panel.
  document.addEventListener('glance:cite', event => {
    setPanel(true);
    const target = document.getElementById(event.detail);
    if (target) { if (target.tagName === 'DETAILS') target.open = true; target.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  });

  function selectPlace(id) {
    const place = state.places.get(id);
    if (!place) return;
    pins.select(id);
    if (!state.holding) { g.hold(true); state.holding = true; }
    g.focus(id);
    glance.open(place);
    layout();
  }

  function showPlaces(places) {
    state.places = new Map(places.map(p => [p.id, p]));
    g.setPoints(places);
    pins.setPlaces(places);
    const section = $('places-section'), list = $('places');
    section.hidden = places.length === 0;
    list.replaceChildren(...places.map(p => {
      const b = el('button', '', 'chip');
      b.type = 'button';
      b.append(el('span', p.name), el('span', String(p.issues.length), 'chip-count'));
      b.setAttribute('aria-label', tn('place.chip', p.issues.length, { name: p.name }));
      b.addEventListener('click', () => selectPlace(p.id));
      return b;
    }));
    if (places.length) setTimeout(() => g.frame(places.map(p => p.id)), 250); // after the panel has made room
  }

  // ---------------------------------------------------------------- answers
  function resetAnswerUI() {
    lastCopy = '';
    $('copy-answer').hidden = true;
    $('copy-label').textContent = t('copy');
    clearTimeout(copyTimer);
  }

  function showMessage(title, message, className = '') {
    $('answer-body').replaceChildren(el('h3', title, 'state-title ' + className), el('p', message, 'state-message'));
    $('sources').replaceChildren();
    $('source-count').textContent = '';
    $('sources-section').hidden = true;
  }

  // People should be able to see that their question was recorded.
  function appendRadarNote(data) {
    if (!data.radar) return;
    const key = GAP_KEYS[data.radar.gap_type];
    const note = el('p', t(key ? 'radar.before_gap' : 'radar.before'), 'radar-note');
    const link = el('a', t('radar.link'));
    link.href = '/radar';
    note.append(link, key ? t('radar.after_gap', { label: t(key) }) : t('radar.after'));
    $('answer-body').append(note);
  }

  // Says which language the claims are in, and that the quotes are the original words.
  // Sample mode can't write in another language, so it says that instead.
  function appendLanguageNote(data) {
    const asked = data.requested_language || getLanguage();
    if (asked === 'en') return;
    const written = data.language || 'en';
    const text = written === 'en' ? t('translation.demo', { lang: languageName(asked) })
      : t('translation.note', { lang: languageName(written) });
    $('answer-body').append(el('p', text, 'translation-note'));
  }

  // After a language switch the answer on screen is still in the old language. Offer to
  // re-run it rather than silently spending another model call.
  function offerRerun() {
    $('rerun-language')?.remove();
    if (!state.lastQuestion || state.busy || state.answerLanguage === getLanguage()) return;
    const button = el('button', t('translation.rerun', { lang: languageName(getLanguage()) }), 'link-button rerun');
    button.type = 'button';
    button.id = 'rerun-language';
    button.addEventListener('click', () => { question.value = state.lastQuestion; submit(); });
    $('answer-body').prepend(button);
  }

  function renderAnswer(data, question) {
    glance.close();
    state.topic = data.topic || null;
    state.sources = [];
    state.lookup = null;
    state.lastQuestion = question;
    state.answerLanguage = data.requested_language || getLanguage();
    $('answer-heading').textContent = t('answer.heading');
    document.body.dataset.hasAnswer = 'true';
    // The server's own message is English; outside English the page's wording is used instead.
    const english = getLanguage() === 'en';
    if (data.status === 'out_of_scope') {
      showMessage(t('scope.title'), (english && data.answer) || t('scope.default'));
      showPlaces([]);
      announce(t('scope.announce'));
      return;
    }
    if (data.status === 'insufficient_evidence') {
      showMessage(t('insufficient.title'),
        (english && typeof data.answer === 'string' && data.answer) || t('insufficient.default'));
      $('answer-body').append(el('p', t('insufficient.hint'), 'state-message'));
      appendRadarNote(data);
      showPlaces([]);
      announce(t('insufficient.announce'));
      return;
    }
    if (!validClaims(data.claims)) throw new Error(t('answer.bad_citations'));
    const { lookup, list } = indexSources(data.sources, 'evidence');
    state.lookup = lookup;
    state.sources = list;
    const body = document.createDocumentFragment();
    body.append(el('p', question, 'result-query'), renderClaims(data.claims, lookup));
    $('answer-body').replaceChildren(body);
    appendLanguageNote(data);
    appendRadarNote(data);
    $('sources-section').hidden = false;
    $('sources').replaceChildren(list.length ? renderSources(list, data.claims)
      : el('p', t('answer.no_sources'), 'state-message'));
    $('source-count').textContent = tn('sources.count', list.length);
    lastCopy = copyableText(data.claims, lookup, list);
    $('copy-answer').hidden = false;
    const places = cleanPlaces(data.locations);
    showPlaces(places);
    announce(t('answer.ready', { n: list.length }) + ' ' + tn('answer.ready_places', places.length));
    if (graph) graph.highlight(list);
  }

  const form = $('ask-form'), question = $('question');
  // the long placeholder wraps and clips on phones
  const setPlaceholder = () => { if (window.matchMedia(MOBILE).matches) question.placeholder = t('question.placeholder_short'); };
  setPlaceholder();
  function setBusy(busy) {
    state.busy = busy;
    $('ask-button').disabled = busy;
    question.readOnly = busy;
    document.querySelectorAll('[data-question]').forEach(b => { b.disabled = busy; });
    $('ask-button-text').textContent = t(busy ? 'ask.busy' : 'ask.button');
    $('search-progress').hidden = !busy;
    $('answer-panel').setAttribute('aria-busy', String(busy));
    document.body.dataset.state = busy ? 'searching' : 'idle';
  }

  async function submit() {
    if (state.busy) return;
    if (state.view !== 'globe') setView('globe'); // answers and pins live on the globe view
    const text = question.value.trim();
    if (text.length < 3) {
      question.setCustomValidity(t('question.too_short'));
      question.reportValidity();
      return;
    }
    setBusy(true);
    resetAnswerUI();
    announce(t('search.announce'));
    setPanel(true);
    $('answer-body').replaceChildren(el('div', '', 'loader'), el('h3', t('search.loading_title'), 'state-title'),
      el('p', t('search.loading_text'), 'state-message'));
    try {
      renderAnswer(await api.ask(text, $('team').value || undefined, getLanguage()), text);
    } catch (error) {
      resetAnswerUI();
      showMessage(t('search.failed_title'), error.message || t('search.failed_default'), 'error-title');
      const retry = el('button', t('retry'), 'link-button');
      retry.type = 'button';
      retry.addEventListener('click', submit);
      $('answer-body').append(retry);
      announce(t('search.failed_announce'));
    } finally {
      setBusy(false);
    }
  }

  form.addEventListener('submit', event => { event.preventDefault(); submit(); });
  question.addEventListener('input', () => {
    question.setCustomValidity('');
    question.style.height = 'auto';
    question.style.height = Math.min(question.scrollHeight, 120) + 'px';
  });
  question.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  document.querySelectorAll('[data-question]').forEach(b => b.addEventListener('click', () => {
    question.value = b.dataset.question;
    question.dispatchEvent(new Event('input'));
    question.focus();
  }));

  $('answer-close').addEventListener('click', () => setPanel(false));
  $('answer-reopen').addEventListener('click', () => setPanel(true));
  $('copy-answer').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(lastCopy);
      $('copy-label').textContent = t('copied');
      announce(t('copy.done_announce'));
    } catch {
      $('copy-label').textContent = t('copy.manual');
      announce(t('copy.failed_announce'));
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('copy-label').textContent = t('copy'); }, 2500);
  });

  // ---------------------------------------------------------------- globe controls
  const rotate = $('globe-rotate');
  const syncRotate = () => { rotate.setAttribute('aria-pressed', String(g.rotating)); rotate.title = t(g.rotating ? 'controls.pause' : 'controls.resume'); };
  syncRotate();
  $('globe-in').addEventListener('click', () => g.zoomBy(0.8));
  $('globe-out').addEventListener('click', () => g.zoomBy(1.25));
  $('globe-reset').addEventListener('click', () => g.reset());
  rotate.addEventListener('click', () => { g.toggleRotation(); syncRotate(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (glance.current) glance.close();
    else if (panel.classList.contains('is-open')) setPanel(false);
  });

  // ---------------------------------------------------------------- connections view
  async function ensureGraph() {
    if (graph) return;
    graph = createGraph($('graph-host'), {
      reduced: prefersReducedMotion(),
      onAsk: text => { setView('globe'); question.value = text; question.dispatchEvent(new Event('input')); submit(); }
    });
    $('graph-status').textContent = t('graph.loading');
    try {
      const data = await api.graph();
      graph.load(data);
      graph.highlight(state.sources);
      graphLoaded = true;
      $('graph-status').textContent = '';
      $('graph-list').replaceChildren(...data.nodes.filter(n => n.type === 'publication').map(n =>
        el('li', `${n.label} (${[n.program, n.year].filter(Boolean).join(', ')})`)));
    } catch (error) {
      $('graph-status').textContent = error.message || t('graph.failed');
    }
  }

  function setView(view) {
    state.view = view;
    document.body.dataset.view = view;
    $('view-globe').setAttribute('aria-pressed', String(view === 'globe'));
    $('view-graph').setAttribute('aria-pressed', String(view === 'graph'));
    if (view === 'graph') {
      glance.close();
      $('connections').hidden = false;
      ensureGraph().then(() => graph?.start());
    } else {
      $('connections').hidden = true;
      graph?.stop();
    }
  }
  $('view-globe').addEventListener('click', () => setView('globe'));
  $('view-graph').addEventListener('click', () => setView('graph'));
  $('graph-in').addEventListener('click', () => graph?.zoomBy(1.25));
  $('graph-out').addEventListener('click', () => graph?.zoomBy(0.8));
  $('graph-reset').addEventListener('click', () => graph?.reset());

  // ---------------------------------------------------------------- status
  async function checkStatus() {
    const dot = $('connection'), text = $('connection-text');
    try {
      const data = await api.status();
      $('demo-banner').hidden = data.demo !== true;
      $('guardrail-note').hidden = data.guardrails === true;
      if (data.configured === true) {
        dot.dataset.state = 'ready';
        text.textContent = t(data.demo ? 'status.demo'
          : data.connection_verified === true ? 'status.verified' : 'status.configured');
      } else {
        dot.dataset.state = 'checking';
        const missing = Array.isArray(data.missing) ? data.missing.filter(x => typeof x === 'string').join(', ') : '';
        text.textContent = t('status.setup') + (missing ? ' · ' + missing : '') + t('status.setup_tail');
      }
    } catch {
      dot.dataset.state = 'error';
      text.textContent = t('status.unavailable');
    }
  }

  // Static text is re-translated by i18n.translatePage; these are the bits set from code.
  const stopListening = onLanguageChange(() => {
    // a page that has been torn down (tests boot many) must not be updated
    if (!stage.isConnected || stage.ownerDocument !== document) { stopListening(); return; }
    if (!state.busy) $('ask-button-text').textContent = t('ask.button');
    $('copy-label').textContent = t('copy');
    setPlaceholder();
    syncRotate();
    offerRerun();
    checkStatus();
  });

  setPanel(false);
  glanceEl.inert = true;
  checkStatus();
  return { state, selectPlace, setView, submit, glance, pins, layout, ready: () => graphLoaded };
}
