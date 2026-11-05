import { $, el, announce } from './util.js';
import { indexSources, validClaims, renderClaims, renderSources } from './render.js';

const KIND = { country: 'Country', state: 'State or province · approximate area', city: 'City', region: 'Region · approximate area' };
let uid = 0;

function skeleton() {
  const box = el('div', '', 'skeleton');
  box.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) box.append(el('span'));
  return box;
}

// Renders one glance response (summary or follow-up answer) into `target`.
function renderResult(target, data, place) {
  const prefix = 'g' + (++uid);
  if (data.status !== 'answered') {
    const text = data.status === 'out_of_scope' ? data.answer
      : `The WRI sources available here don't say more about ${place.name} for this question.`;
    target.replaceChildren(el('p', text, 'state-message'));
    return;
  }
  if (!validClaims(data.claims)) throw new Error('The server returned an answer without valid citations. Please try again.');
  const { lookup, list } = indexSources(data.sources, prefix);
  const fragment = document.createDocumentFragment();
  fragment.append(renderClaims(data.claims, lookup));
  if (list.length) {
    const sources = el('details', '', 'glance-sources');
    sources.append(el('summary', `Sources (${list.length})`), renderSources(list, data.claims));
    fragment.append(sources);
  }
  target.replaceChildren(fragment);
}

// The glance card is docked beside the globe, never over it, so any number of
// pins can be clicked in turn: opening another pin simply swaps the content.
export function createGlance(root, { api, context, onClose = () => {} }) {
  const cache = new Map(); // place id -> last good summary response
  let current = null, token = 0, pending = false;

  const title = $('glance-title'), kind = $('glance-kind'), issues = $('glance-issues');
  const summary = $('glance-summary'), thread = $('glance-thread');
  const form = $('glance-form'), input = $('glance-input'), send = $('glance-send'), brief = $('glance-brief');

  function briefingURL(place) {
    const params = new URLSearchParams({ place: place.name });
    const topic = context().topic;
    if (topic) params.set('topic', topic.slice(0, 300)); // already PII-masked by the server
    return 'briefing.html?' + params;
  }

  function renderIssues(place) {
    const { lookup } = context();
    const list = el('ul', '', 'issue-list');
    for (const item of place.issues) {
      const li = el('li');
      li.append(el('span', item.issue));
      const source = lookup && lookup.get(item.source_id);
      if (source) {
        const cite = el('a', String(source.number), 'cite');
        cite.href = '#' + source.anchor;
        cite.setAttribute('aria-label', 'Source ' + source.number + ': ' + source.title);
        cite.addEventListener('click', () => document.dispatchEvent(
          new CustomEvent('glance:cite', { detail: source.anchor })));
        li.append(cite);
      }
      list.append(li);
    }
    issues.replaceChildren(list);
  }

  async function load(place, my) {
    summary.replaceChildren(skeleton());
    try {
      let data = cache.get(place.id);
      if (!data) {
        data = await api.glance(place.name);
        if (data.status === 'answered') cache.set(place.id, data);
      }
      if (my !== token) return; // another pin was opened meanwhile
      renderResult(summary, data, place);
      announce(`${place.name}: summary ready.`);
    } catch (error) {
      if (my !== token) return;
      const retry = el('button', 'Try again', 'link-button');
      retry.type = 'button';
      retry.addEventListener('click', () => load(place, my));
      summary.replaceChildren(el('p', error.message || 'Could not load this summary.', 'state-message error'), retry);
    }
  }

  function open(place) {
    const same = current && current.id === place.id;
    current = place;
    const my = ++token;
    root.classList.add('is-open');
    root.removeAttribute('aria-hidden');
    root.inert = false;
    title.textContent = place.name;
    kind.textContent = KIND[place.kind] || '';
    brief.href = briefingURL(place);
    renderIssues(place);
    if (!same) thread.replaceChildren();
    pending = false;
    send.disabled = false;
    input.value = '';
    load(place, my);
  }

  function close() {
    if (!current) return;
    current = null;
    token++;
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
    root.inert = true;
    onClose();
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const question = input.value.trim();
    if (!current || pending || question.length < 3) return;
    const place = current, my = token;
    pending = true;
    send.disabled = true;
    input.value = '';
    const answer = el('div', '', 'thread-a');
    answer.append(skeleton());
    thread.append(el('p', question, 'thread-q'), answer);
    answer.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    try {
      const data = await api.glance(place.name, question);
      if (my !== token) return;
      renderResult(answer, data, place);
    } catch (error) {
      if (my !== token) return;
      answer.replaceChildren(el('p', error.message || 'Could not answer that.', 'state-message error'));
    } finally {
      if (my === token) { pending = false; send.disabled = false; input.focus({ preventScroll: true }); }
    }
  });

  $('glance-close').addEventListener('click', close);
  return { open, close, get current() { return current; } };
}
