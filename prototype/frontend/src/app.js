import { $, el, announce, prefersReducedMotion } from './util.js';
import { api as defaultApi } from './api.js';
import { indexSources, validClaims, renderClaims, renderSources, copyableText } from './render.js';
import { createPins } from './pins.js';
import { createGlance } from './glance.js';
import { createGraph } from './graph.js';
import { t, tn, getLanguage, languageName, onLanguageChange } from './i18n.js';
import { cleanPlaces } from './places.js';
import { loadSessions, saveSession, clearSessions, newSession, makeTurn, historyOf } from './sessions.js';
import { renderSafety, safetyAnnouncement } from './safety.js';

const noop = () => {};
const NO_GLOBE = {
  setPoints: noop, onFrame: () => noop, setInsets: noop, hold: noop, focus: noop, frame: noop,
  reset: noop, zoomBy: noop, toggleRotation: () => false, rotating: false
};
const MOBILE = '(max-width: 760px)';
const GAP_KEYS = { not_loaded: 'gap.not_loaded', weak: 'gap.weak', never_published: 'gap.never_published' };

export { cleanPlaces };

export function initApp({ globe = null, api = defaultApi } = {}) {
  const g = globe || NO_GLOBE;
  const stage = $('stage'), panel = $('answer-panel'), glanceEl = $('glance'), safetyCard = $('safety-card');
  const state = { places: new Map(), lookup: null, topic: null, sources: [], busy: false, view: 'globe', holding: false,
    lastQuestion: null, answerLanguage: null, session: null, viewing: null, tab: 'answer', safety: null };
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
      // The safety card shares the glance card's column and steps aside for it (see styles.css).
      const column = glanceOpen ? glanceEl.offsetWidth : safetyCard.offsetWidth;
      right = column ? column + 16 : 0;
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
    [$('ask-form'), $('top-stack'), panel, glanceEl, safetyCard].forEach(node => watcher.observe(node));
  }
  document.fonts?.ready.then(layout);
  window.addEventListener('load', layout);

  // One summary, two places: beside the globe, or inside the answer sheet on a phone.
  function showSafety(safety) {
    state.safety = safety || null;
    for (const host of [safetyCard, $('safety-inline')]) {
      host.hidden = !safety;
      host.replaceChildren();
      if (safety) {
        host.setAttribute('aria-label', t('safety.title'));
        host.append(renderSafety(safety));
      }
    }
    layout();
  }

  function setPanel(open) {
    panel.classList.toggle('is-open', open);
    panel.inert = !open;
    panel.setAttribute('aria-hidden', String(!open));
    // With nothing on screen, the button reaches the sessions kept from earlier visits.
    const hasCurrent = Boolean(state.session || document.body.dataset.hasAnswer);
    $('answer-reopen-label').textContent = t(hasCurrent ? 'answer.show' : 'sessions.tab');
    $('answer-reopen').hidden = open || !(hasCurrent || pastSessions().length);
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
    setTab('answer');
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
    if (!state.lastQuestion || !state.session || state.viewing || state.busy || state.answerLanguage === getLanguage()) return;
    const button = el('button', t('translation.rerun', { lang: languageName(getLanguage()) }), 'link-button rerun');
    button.type = 'button';
    button.id = 'rerun-language';
    const text = state.lastQuestion;
    const rerun = () => ask(text, 'rerun', rerun);
    button.addEventListener('click', rerun);
    $('answer-body').prepend(button);
  }

  // ---------------------------------------------------------------- one answer on screen
  // #answer-body and #sources hold the newest turn. Earlier turns stack above it in #session-turns.
  function paintLatest(data, text, { live }) {
    const english = getLanguage() === 'en'; // the server's own message is English
    resetAnswerUI();
    if (data.status === 'out_of_scope') {
      showMessage(t('scope.title'), (english && data.answer) || t('scope.default'));
      if (live) announce(t('scope.announce'));
      return [];
    }
    if (data.status === 'insufficient_evidence') {
      showMessage(t('insufficient.title'),
        (english && typeof data.answer === 'string' && data.answer) || t('insufficient.default'));
      if (text) $('answer-body').prepend(el('p', text, 'result-query'));
      $('answer-body').append(el('p', t('insufficient.hint'), 'state-message'));
      if (live) { appendRadarNote(data); announce(t('insufficient.announce')); }
      return [];
    }
    const { lookup, list } = indexSources(data.sources, 'evidence');
    const body = document.createDocumentFragment();
    body.append(el('p', text, 'result-query'), renderClaims(data.claims, lookup));
    $('answer-body').replaceChildren(body);
    appendLanguageNote(data);
    if (live) appendRadarNote(data);
    $('sources-section').hidden = false;
    $('sources').replaceChildren(list.length ? renderSources(list, data.claims)
      : el('p', t('answer.no_sources'), 'state-message'));
    $('source-count').textContent = tn('sources.count', list.length);
    lastCopy = copyableText(data.claims, lookup, list);
    $('copy-answer').hidden = false;
    return list;
  }

  function earlierTurn(turn, prefix) {
    const article = el('article', '', 'turn');
    article.append(el('p', turn.question || t('sessions.blocked_question'), 'result-query'));
    const { data } = turn;
    if (data.status === 'answered') {
      const { lookup, list } = indexSources(data.sources, prefix);
      article.append(renderClaims(data.claims, lookup));
      if (list.length) article.append(el('h3', t('sources.heading'), 'section-label'), renderSources(list, data.claims));
    } else {
      article.append(el('p', t(data.status === 'out_of_scope' ? 'scope.title' : 'insufficient.title'), 'state-message'));
    }
    return article;
  }

  // Pins come from the newest turn that has any. Source ids restart every turn, so mixing turns
  // would point a pin at another turn's source. Citations on a pin use that turn's anchors.
  function showSessionPlaces(turns) {
    const index = turns.findLastIndex(turn => turn.data.locations.length);
    if (index < 0) { state.lookup = null; showPlaces([]); return; }
    state.lookup = indexSources(turns[index].data.sources, index === turns.length - 1 ? 'evidence' : `turn-${index + 1}`).lookup;
    showPlaces(turns[index].data.locations);
  }

  function paintSession(session, { live = false, text = null, data = null } = {}) {
    const turns = session.turns, last = turns[turns.length - 1];
    glance.close();
    $('session-turns').replaceChildren(...turns.slice(0, -1).map((turn, i) => earlierTurn(turn, `turn-${i + 1}`)));
    const list = paintLatest(data || last.data, text || last.question, { live }); // the stored turn has no Radar note
    state.sources = list;
    state.topic = turns[0].question || null; // a briefing is about the session's subject, not "show the map"
    state.answerLanguage = last.data.requested_language || getLanguage();
    showSessionPlaces(turns);
    showSafety(last.data.safety);
    $('answer-heading').textContent = t('answer.heading');
    document.body.dataset.hasAnswer = 'true';
    if (graph) graph.highlight(list);
    syncSessionUI();
    return list;
  }

  function syncSessionUI() {
    const readOnly = Boolean(state.viewing);
    $('past-banner').hidden = !readOnly;
    $('past-back').textContent = t(state.session ? 'sessions.back' : 'sessions.back_list');
    $('followup-form').hidden = readOnly || !state.session;
    setPlaceholder();
    renderPast();
    offerRerun();
  }

  // ---------------------------------------------------------------- past sessions
  const pastSessions = () => loadSessions().filter(s => s.id !== state.session?.id);

  function renderPast() {
    const sessions = pastSessions();
    $('clear-sessions').hidden = sessions.length === 0;
    if (!sessions.length) { $('past-list').replaceChildren(el('p', t('sessions.empty'), 'state-message')); return; }
    $('past-list').replaceChildren(...sessions.map(session => {
      const button = el('button', '', 'past-item');
      button.type = 'button';
      button.setAttribute('aria-current', String(state.viewing === session.id));
      const first = session.turns[0].question || t('sessions.blocked_question');
      let when = '';
      try { when = new Date(session.startedAt).toLocaleString(getLanguage(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { /* unknown locale */ }
      const meta = el('span', [when, tn('sessions.turns', session.turns.length)].filter(Boolean).join(' · '), 'past-meta');
      button.append(el('span', first, 'past-question'), meta);
      if (session.demo) meta.append(el('span', t('sessions.sample'), 'past-sample'));
      button.addEventListener('click', () => openPast(session.id));
      return button;
    }));
  }

  function openPast(id) {
    const session = loadSessions().find(s => s.id === id);
    if (!session) { renderPast(); return; }
    state.viewing = id;
    paintSession(session);
    setTab('answer');
    $('answer-scroll').scrollTop = 0;
  }

  function clearPanel() {
    glance.close();
    state.lookup = null; state.sources = []; state.topic = null; state.lastQuestion = null;
    resetAnswerUI();
    showSafety(null);
    $('session-turns').replaceChildren();
    $('answer-body').replaceChildren();
    $('sources').replaceChildren();
    $('source-count').textContent = '';
    $('sources-section').hidden = true;
    showPlaces([]);
    if (graph) graph.highlight([]);
  }

  // Leaving a past session returns to the live one, or to the list if there isn't one.
  function closePast() {
    state.viewing = null;
    if (state.session) {
      paintSession(state.session);
    } else {
      clearPanel();
      delete document.body.dataset.hasAnswer;
      syncSessionUI();
      setTab('past');
    }
  }

  function setTab(tab) {
    state.tab = tab;
    const past = tab === 'past';
    $('panel-tabs').dataset.active = tab;
    $('panel-panes').dataset.active = tab;
    $('tab-answer').setAttribute('aria-selected', String(!past));
    $('tab-past').setAttribute('aria-selected', String(past));
    $('tab-answer').tabIndex = past ? -1 : 0;
    $('tab-past').tabIndex = past ? 0 : -1;
    $('pane-answer').inert = past;
    $('pane-past').inert = !past;
    $('copy-answer').classList.toggle('is-away', past);
    if (past) renderPast();
  }

  $('tab-answer').addEventListener('click', () => setTab('answer'));
  $('tab-past').addEventListener('click', () => setTab('past'));
  $('panel-tabs').addEventListener('keydown', event => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = state.tab === 'answer' ? 'past' : 'answer';
    setTab(next);
    $(next === 'past' ? 'tab-past' : 'tab-answer').focus();
  });
  $('past-back').addEventListener('click', closePast);
  let clearArmed = false, clearTimer;
  $('clear-sessions').addEventListener('click', () => {
    clearTimeout(clearTimer);
    if (!clearArmed) {
      clearArmed = true;
      $('clear-sessions').textContent = t('sessions.clear_confirm');
      clearTimer = setTimeout(() => { clearArmed = false; $('clear-sessions').textContent = t('sessions.clear'); }, 4000);
      return;
    }
    clearArmed = false;
    $('clear-sessions').textContent = t('sessions.clear');
    clearSessions(state.session?.id);
    if (state.viewing) closePast();
    renderPast();
  });

  const form = $('ask-form'), question = $('question');
  // the long placeholder wraps and clips on phones
  const setPlaceholder = () => {
    if (state.session) question.placeholder = t('question.placeholder_new');
    else question.placeholder = t(window.matchMedia(MOBILE).matches ? 'question.placeholder_short' : 'question.placeholder');
  };
  setPlaceholder();
  function setBusy(busy) {
    state.busy = busy;
    $('ask-button').disabled = busy;
    question.readOnly = busy;
    $('followup-send').disabled = busy;
    $('followup-input').readOnly = busy;
    document.querySelectorAll('[data-question]').forEach(b => { b.disabled = busy; });
    $('ask-button-text').textContent = t(busy ? 'ask.busy' : 'ask.button');
    $('search-progress').hidden = !busy;
    $('answer-panel').setAttribute('aria-busy', String(busy));
    document.body.dataset.state = busy ? 'searching' : 'idle';
  }

  // kind: 'new' starts a chat, 'followup' adds to this session, 'rerun' replaces its newest turn.
  async function ask(text, kind, retry) {
    if (state.busy) return false;
    if (state.view !== 'globe') setView('globe'); // answers and pins live on the globe view
    const previous = state.session;
    let earlier = previous?.turns || [];
    if (kind === 'rerun') earlier = earlier.slice(0, -1);
    if (kind === 'new') {
      // The bottom box begins again. The old session is already saved; it now shows under Past sessions.
      state.session = null;
      earlier = [];
      clearPanel();
    }
    state.viewing = null;
    setBusy(true);
    resetAnswerUI();
    showSafety(null); // never beside a new answer, or a failed request
    announce(t('search.announce'));
    setPanel(true);
    setTab('answer');
    $('past-banner').hidden = true;
    $('followup-form').hidden = kind === 'new';
    $('session-turns').replaceChildren(...earlier.map((turn, i) => earlierTurn(turn, `turn-${i + 1}`)));
    $('sources-section').hidden = true;
    $('answer-body').replaceChildren(el('div', '', 'loader'), el('h3', t('search.loading_title'), 'state-title'),
      el('p', t('search.loading_text'), 'state-message'));
    $('answer-body').scrollIntoView?.({ block: 'nearest' });
    let ok = false;
    try {
      const history = kind === 'new' ? [] : historyOf({ turns: earlier });
      const data = await api.ask(text, $('team').value || undefined, getLanguage(), history);
      if (data.status === 'answered' && !validClaims(data.claims)) throw new Error(t('answer.bad_citations'));
      const turn = makeTurn(data);
      const session = state.session || newSession();
      session.demo = session.demo || data.demo === true;
      session.turns = [...earlier, turn];
      state.session = session;
      // From here on, only the masked question: on screen, in the store, and in a re-run. It shows what the search and the model were given.
      const shown = data.status === 'out_of_scope' ? '' : (turn.question || text);
      state.lastQuestion = turn.question || text;
      saveSession(session);
      const list = paintSession(session, { live: true, data, text: shown });
      // The newest answer starts in view; earlier turns are a scroll away.
      if (earlier.length) $('answer-scroll').scrollTop = $('answer-body').offsetTop - $('answer-scroll').offsetTop;
      if (data.status === 'answered') {
        announce(t('answer.ready', { n: list.length }) + ' ' + tn('answer.ready_places', turn.data.locations.length));
      }
      const safetyNote = safetyAnnouncement(turn.data.safety);
      if (safetyNote) announce(`${$('announcement').textContent} ${safetyNote}`.trim());
      ok = true;
    } catch (error) {
      resetAnswerUI();
      showMessage(t('search.failed_title'), error.message || t('search.failed_default'), 'error-title');
      if (kind !== 'new') $('answer-body').prepend(el('p', text, 'result-query'));
      if (!earlier.length && !state.session) showPlaces([]); // nothing from an older answer may linger
      const button = el('button', t('retry'), 'link-button');
      button.type = 'button';
      button.addEventListener('click', retry);
      $('answer-body').append(button);
      announce(t('search.failed_announce'));
      syncSessionUI();
    } finally {
      setBusy(false);
    }
    return ok;
  }

  async function submit() {
    const text = question.value.trim();
    if (!state.busy && text.length < 3) {
      question.setCustomValidity(t('question.too_short'));
      question.reportValidity();
      return;
    }
    if (await ask(text, 'new', submit)) { question.value = ''; question.dispatchEvent(new Event('input')); }
  }

  async function followUp() {
    const input = $('followup-input'), text = input.value.trim();
    if (text.length < 3 || !state.session) return;
    if (await ask(text, 'followup', followUp)) input.value = '';
    input.focus({ preventScroll: true });
  }
  $('followup-form').addEventListener('submit', event => { event.preventDefault(); followUp(); });

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
    syncSessionUI();
    showSafety(state.safety);
    checkStatus();
  });

  setPanel(false);
  syncSessionUI();
  glanceEl.inert = true;
  checkStatus();
  return { state, selectPlace, setView, submit, followUp, openPast, setTab, glance, pins, layout, ready: () => graphLoaded };
}
