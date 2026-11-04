import './styles.css';
import { $, el, announce } from './util.js';
import { api } from './api.js';
import { indexSources, validClaims, renderClaim, renderSources } from './render.js';

const params = new URLSearchParams(location.search);
const place = (params.get('place') || '').trim().slice(0, 120);
const topic = (params.get('topic') || '').trim().slice(0, 300);
let copyText = '';

function fail(message) {
  $('b-title').textContent = 'We couldn’t build this briefing';
  $('b-body').replaceChildren(el('p', message, 'state-message error'));
  announce('Briefing failed.');
}

function render(data) {
  $('demo-banner').hidden = data.demo !== true;
  if (data.status === 'out_of_scope' || data.status === 'insufficient_evidence') {
    $('b-title').textContent = data.status === 'out_of_scope' ? 'Outside what AskWRI covers' : 'Insufficient evidence in the sample';
    $('b-body').replaceChildren(el('p', data.message || 'The retrieved passages do not support a briefing.', 'state-message'));
    return;
  }
  if (data.status !== 'answered' || !Array.isArray(data.sections)) throw new Error('The server returned an unexpected briefing format. Please try again.');
  const { lookup, list } = indexSources(data.sources, 'src');
  const all = data.sections.flatMap(s => s.claims || []);
  if (!validClaims(all)) throw new Error('The briefing came back without valid citations. Please try again.');
  $('b-title').textContent = place + (topic ? ' · ' + topic : '');
  document.title = `Briefing: ${place} — AskWRI`;
  const body = document.createDocumentFragment();
  for (const section of data.sections) {
    if (!section.claims || !section.claims.length) continue;
    const block = el('section', '', 'b-section');
    block.append(el('h2', section.heading, 'section-label'));
    for (const claim of section.claims) block.append(renderClaim(claim, lookup, 'claim'));
    body.append(block);
  }
  $('b-body').replaceChildren(body);
  $('b-sources').replaceChildren(renderSources(list, all));
  $('b-related').hidden = list.length === 0;
  copyText = data.sections.map(s => s.heading + '\n' + s.claims.map(c => '- ' + c.text + ' ' +
    c.evidence.map(r => { const x = lookup.get(r.source_id); return x ? '[' + x.number + ']' : ''; }).join('')).join('\n')).join('\n\n')
    + '\n\nSources\n' + list.map(s => '[' + s.number + '] ' + s.title).join('\n');
  $('b-copy').hidden = false;
  $('b-print').hidden = false;
  announce('Briefing ready.');
}

async function main() {
  if (!place) { fail('No place was given. Open a briefing from a pin on the globe.'); return; }
  $('b-title').textContent = place;
  $('b-meta').textContent = 'Building a cited briefing from WRI publications…';
  try {
    const data = await api.briefing(place, topic);
    $('b-meta').textContent = '';
    render(data);
  } catch (error) {
    $('b-meta').textContent = '';
    fail(error.message || 'Please try again.');
  }
}

$('b-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(copyText); $('b-copy').textContent = 'Copied'; }
  catch { $('b-copy').textContent = 'Select text to copy'; }
  setTimeout(() => { $('b-copy').textContent = 'Copy'; }, 2500);
});
$('b-print').addEventListener('click', () => window.print());
main();
