import { $, el, announce, prefersReducedMotion } from './util.js';
import { api as defaultApi } from './api.js';
import { indexSources, validClaims, renderClaims, renderSources, copyableText } from './render.js';
import { createPins } from './pins.js';
import { createGlance } from './glance.js';
import { createGraph } from './graph.js';

const noop = () => {};
const NO_GLOBE = {
  setPoints: noop, onFrame: () => noop, setInsets: noop, hold: noop, focus: noop, frame: noop,
  reset: noop, zoomBy: noop, toggleRotation: () => false, rotating: false
};
const MOBILE = '(max-width: 760px)';

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
  const state = { places: new Map(), lookup: null, topic: null, sources: [], busy: false, view: 'globe', holding: false };
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
      b.setAttribute('aria-label', `${p.name}: ${p.issues.length} ${p.issues.length === 1 ? 'issue' : 'issues'}. Open summary.`);
      b.addEventListener('click', () => selectPlace(p.id));
      return b;
    }));
    if (places.length) setTimeout(() => g.frame(places.map(p => p.id)), 250); // after the panel has made room
  }

  // ---------------------------------------------------------------- answers
  function resetAnswerUI() {
    lastCopy = '';
    $('copy-answer').hidden = true;
    $('copy-label').textContent = 'Copy';
    clearTimeout(copyTimer);
  }

  function showMessage(title, message, className = '') {
    $('answer-body').replaceChildren(el('h3', title, 'state-title ' + className), el('p', message, 'state-message'));
    $('sources').replaceChildren();
    $('source-count').textContent = '';
    $('sources-section').hidden = true;
  }

  function renderAnswer(data, question) {
    glance.close();
    state.topic = data.topic || null;
    state.sources = [];
    state.lookup = null;
    $('answer-heading').textContent = 'Answer';
    document.body.dataset.hasAnswer = 'true';
    if (data.status === 'out_of_scope') {
      showMessage('Outside what AskWRI covers', data.answer || 'Try a question about WRI research topics.');
      showPlaces([]);
      announce('That question is outside what AskWRI covers.');
      return;
    }
    if (data.status === 'insufficient_evidence') {
      showMessage('Insufficient evidence in the sample',
        (typeof data.answer === 'string' && data.answer) || 'The retrieved passages do not support an answer to this question.');
      $('answer-body').append(el('p', 'Try narrowing the question or checking which publications are included.', 'state-message'));
      showPlaces([]);
      announce('Insufficient evidence in the sample.');
      return;
    }
    if (!validClaims(data.claims)) throw new Error('The server returned an answer without valid claim-level citations. Please try again.');
    const { lookup, list } = indexSources(data.sources, 'evidence');
    state.lookup = lookup;
    state.sources = list;
    const body = document.createDocumentFragment();
    body.append(el('p', question, 'result-query'), renderClaims(data.claims, lookup));
    $('answer-body').replaceChildren(body);
    $('sources-section').hidden = false;
    $('sources').replaceChildren(list.length ? renderSources(list, data.claims)
      : el('p', 'The response did not include source details. Treat the answer as unverified.', 'state-message'));
    $('source-count').textContent = `${list.length} ${list.length === 1 ? 'source' : 'sources'}`;
    lastCopy = copyableText(data.claims, lookup, list);
    $('copy-answer').hidden = false;
    const places = cleanPlaces(data.locations);
    showPlaces(places);
    announce(`Research answer ready. ${list.length} sources returned. ${places.length} ${places.length === 1 ? 'place' : 'places'} on the globe.`);
    if (graph) graph.highlight(list);
  }

  const form = $('ask-form'), question = $('question');
  function setBusy(busy) {
    state.busy = busy;
    $('ask-button').disabled = busy;
    question.readOnly = busy;
    document.querySelectorAll('[data-question]').forEach(b => { b.disabled = busy; });
    $('ask-button-text').textContent = busy ? 'Searching…' : 'Find evidence';
    $('search-progress').hidden = !busy;
    $('answer-panel').setAttribute('aria-busy', String(busy));
    document.body.dataset.state = busy ? 'searching' : 'idle';
  }

  async function submit() {
    if (state.busy) return;
    if (state.view !== 'globe') setView('globe'); // answers and pins live on the globe view
    const text = question.value.trim();
    if (text.length < 3) {
      question.setCustomValidity('Enter a research question with at least 3 characters.');
      question.reportValidity();
      return;
    }
    setBusy(true);
    resetAnswerUI();
    announce('Searching WRI publications.');
    setPanel(true);
    $('answer-body').replaceChildren(el('div', '', 'loader'), el('h3', 'Finding supporting evidence…', 'state-title'),
      el('p', 'Searching the publication sample and preparing a cited answer.', 'state-message'));
    try {
      renderAnswer(await api.ask(text), text);
    } catch (error) {
      resetAnswerUI();
      showMessage('We couldn’t complete this search', error.message || 'Check your connection and try again.', 'error-title');
      const retry = el('button', 'Try again', 'link-button');
      retry.type = 'button';
      retry.addEventListener('click', submit);
      $('answer-body').append(retry);
      announce('Search failed. Your question is preserved for retry.');
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
      $('copy-label').textContent = 'Copied';
      announce('Answer and publication references copied.');
    } catch {
      $('copy-label').textContent = 'Select text to copy';
      announce('Clipboard access unavailable. Select the answer text and copy it manually.');
    }
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('copy-label').textContent = 'Copy'; }, 2500);
  });

  // ---------------------------------------------------------------- globe controls
  const rotate = $('globe-rotate');
  const syncRotate = () => { rotate.setAttribute('aria-pressed', String(g.rotating)); rotate.title = g.rotating ? 'Pause rotation' : 'Resume rotation'; };
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
    $('graph-status').textContent = 'Loading connections…';
    try {
      const data = await api.graph();
      graph.load(data);
      graph.highlight(state.sources);
      graphLoaded = true;
      $('graph-status').textContent = '';
      $('graph-list').replaceChildren(...data.nodes.filter(n => n.type === 'publication').map(n =>
        el('li', `${n.label} (${[n.program, n.year].filter(Boolean).join(', ')})`)));
    } catch (error) {
      $('graph-status').textContent = error.message || 'Could not load the connection map.';
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
        text.textContent = data.demo ? 'Sample data mode'
          : data.connection_verified === true ? 'Research connection verified' : 'Configured · Connection will be checked when you search.';
      } else {
        dot.dataset.state = 'checking';
        const missing = Array.isArray(data.missing) ? data.missing.filter(x => typeof x === 'string').join(', ') : '';
        text.textContent = 'Setup needed' + (missing ? ' · ' + missing : '') + '. Follow your project setup instructions.';
      }
    } catch {
      dot.dataset.state = 'error';
      text.textContent = 'Connection status unavailable · Check that your FastAPI server is running.';
    }
  }

  setPanel(false);
  glanceEl.inert = true;
  checkStatus();
  return { state, selectPlace, setView, submit, glance, pins, layout, ready: () => graphLoaded };
}
