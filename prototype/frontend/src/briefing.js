import './styles.css';
import { $, el, announce } from './util.js';
import { api } from './api.js';
import { indexSources, validClaims, renderClaim, renderSources } from './render.js';
import { t, getLanguage, languageName, setLanguage, detectLanguage, bindPicker, onLanguageChange } from './i18n.js';

setLanguage(detectLanguage(), { save: false });
bindPicker($('language'));
// Section headings arrive in English from the server; show them in the page's language.
const HEADINGS = { Overview: 'briefing.overview', 'Key findings': 'briefing.key_findings' };

const params = new URLSearchParams(location.search);
const place = (params.get('place') || '').trim().slice(0, 120);
const topic = (params.get('topic') || '').trim().slice(0, 300);
let copyText = '', run = 0;

function fail(message) {
  $('b-title').textContent = t('briefing.failed_title');
  $('b-body').replaceChildren(el('p', message, 'state-message error'));
  announce(t('briefing.failed_announce'));
}

function render(data) {
  $('demo-banner').hidden = data.demo !== true;
  if (data.status === 'out_of_scope' || data.status === 'insufficient_evidence') {
    $('b-title').textContent = t(data.status === 'out_of_scope' ? 'scope.title' : 'insufficient.title');
    $('b-body').replaceChildren(el('p', (getLanguage() === 'en' && data.message) || t('briefing.no_support'), 'state-message'));
    return;
  }
  if (data.status !== 'answered' || !Array.isArray(data.sections)) throw new Error(t('briefing.bad_format'));
  const { lookup, list } = indexSources(data.sources, 'src');
  const all = data.sections.flatMap(s => s.claims || []);
  if (!validClaims(all)) throw new Error(t('briefing.bad_citations'));
  $('b-title').textContent = place + (topic ? ' · ' + topic : '');
  document.title = t('briefing.page_title_place', { place });
  const body = document.createDocumentFragment();
  for (const section of data.sections) {
    if (!section.claims || !section.claims.length) continue;
    const block = el('section', '', 'b-section');
    const heading = HEADINGS[section.heading] ? t(HEADINGS[section.heading]) : section.heading;
    block.append(el('h2', heading, 'section-label'));
    for (const claim of section.claims) block.append(renderClaim(claim, lookup, 'claim'));
    body.append(block);
  }
  $('b-body').replaceChildren(body);
  const asked = data.requested_language || getLanguage();
  if (asked !== 'en') {
    const written = data.language || 'en';
    $('b-body').append(el('p', written === 'en' ? t('translation.demo', { lang: languageName(asked) })
      : t('translation.note', { lang: languageName(written) }), 'translation-note'));
  }
  $('b-sources').replaceChildren(renderSources(list, all));
  $('b-related').hidden = list.length === 0;
  copyText = data.sections.map(s => (HEADINGS[s.heading] ? t(HEADINGS[s.heading]) : s.heading) + '\n' + s.claims.map(c => '- ' + c.text + ' ' +
    c.evidence.map(r => { const x = lookup.get(r.source_id); return x ? '[' + x.number + ']' : ''; }).join('')).join('\n')).join('\n\n')
    + '\n\n' + t('sources.heading') + '\n' + list.map(s => '[' + s.number + '] ' + s.title).join('\n');
  $('b-copy').hidden = false;
  $('b-print').hidden = false;
  announce(t('briefing.ready'));
}

async function main() {
  if (!place) { fail(t('briefing.no_place')); return; }
  const my = ++run; // a language switch mid-load must not let the older reply win
  $('b-title').textContent = place;
  $('b-meta').textContent = t('briefing.building');
  $('b-copy').hidden = true;
  $('b-print').hidden = true;
  try {
    const data = await api.briefing(place, topic, getLanguage());
    if (my !== run) return;
    $('b-meta').textContent = '';
    render(data);
  } catch (error) {
    if (my !== run) return;
    $('b-meta').textContent = '';
    fail(error.message || t('please_retry'));
  }
}

// A briefing is one page with one job, so a language switch simply rebuilds it.
onLanguageChange(() => {
  const url = new URL(location.href);
  url.searchParams.set('lang', getLanguage());
  history.replaceState(null, '', url);
  main();
});

$('b-copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(copyText); $('b-copy').textContent = t('copied'); }
  catch { $('b-copy').textContent = t('copy.manual'); }
  setTimeout(() => { $('b-copy').textContent = t('copy'); }, 2500);
});
$('b-print').addEventListener('click', () => window.print());
main();
