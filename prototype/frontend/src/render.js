// Shared renderers for cited claims and source evidence. All text goes through
// textContent; links go through safeURL. `prefix` keeps element ids unique when
// several answers (answer panel, glance card, follow-ups) are on the page at once.
import { el, safeURL, pageNumber, externalLink } from './util.js';

const titleOf = s => (typeof s.title === 'string' && s.title.trim() ? s.title : 'Untitled publication');

// Source ids from the server -> numbered entries. Duplicate or malformed sources are skipped.
export function indexSources(sources, prefix) {
  const lookup = new Map(), list = [];
  for (const s of Array.isArray(sources) ? sources : []) {
    if (!s || typeof s.id !== 'string' || lookup.has(s.id)) continue;
    const entry = { ...s, number: list.length + 1, anchor: `${prefix}-${list.length + 1}` };
    lookup.set(s.id, entry);
    list.push(entry);
  }
  return { lookup, list };
}

export function validClaims(claims) {
  return Array.isArray(claims) && claims.length > 0
    && claims.every(c => c && typeof c.text === 'string' && Array.isArray(c.evidence));
}

export function renderClaim(claim, lookup, className = 'claim') {
  const p = el('p', claim.text, className);
  const cited = new Set();
  for (const ref of claim.evidence) {
    if (!ref || typeof ref.source_id !== 'string' || cited.has(ref.source_id)) continue;
    cited.add(ref.source_id);
    const s = lookup.get(ref.source_id);
    if (s) {
      const a = el('a', String(s.number), 'cite');
      a.href = '#' + s.anchor;
      a.setAttribute('aria-label', 'Source ' + s.number + ': ' + titleOf(s));
      a.addEventListener('click', event => {
        const target = document.getElementById(s.anchor);
        if (!target) return;
        event.preventDefault();
        if (target.tagName === 'DETAILS') target.open = true;
        target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        target.focus({ preventScroll: true });
      });
      p.append(a);
    } else {
      p.append(el('span', '[Source unavailable]', 'unresolved'));
    }
  }
  if (!cited.size) p.append(el('span', '[No citation returned]', 'unresolved'));
  return p;
}

export function renderClaims(claims, lookup) {
  const fragment = document.createDocumentFragment();
  for (const claim of claims) fragment.append(renderClaim(claim, lookup));
  return fragment;
}

export function renderSource(s, claims) {
  const section = el('details', '', 'source');
  section.id = s.anchor;
  section.tabIndex = -1;
  const url = safeURL(s.url);
  const summary = el('summary');
  summary.append(el('span', String(s.number), 'source-number'), el('span', titleOf(s), 'source-title'));
  section.append(summary);

  const meta = el('div', '', 'source-meta');
  const page = pageNumber(s.page);
  if (page) {
    if (url && /\.pdf$/i.test(url.pathname)) {
      const pageURL = new URL(url.href);
      pageURL.hash = 'page=' + page;
      meta.append(externalLink('PDF page ' + page + ' ↗', pageURL.href));
    } else {
      meta.append(el('span', 'PDF page ' + page));
    }
  } else {
    meta.append(el('span', 'Page not provided'));
  }
  if (url) meta.append(externalLink('Open publication ↗', url.href));
  else meta.append(el('span', 'Public link unavailable'));
  section.append(meta);

  const quotes = new Set();
  for (const c of claims) {
    for (const ref of c.evidence) {
      if (ref && ref.source_id === s.id && typeof ref.quote === 'string' && ref.quote.trim()) quotes.add(ref.quote);
    }
  }
  for (const quote of quotes) section.append(el('blockquote', quote, 'quote'));
  if (typeof s.passage === 'string' && s.passage.trim()) {
    const more = el('details', '', 'passage');
    more.append(el('summary', 'Full retrieved passage'), el('p', s.passage));
    section.append(more);
  }
  return section;
}

export function renderSources(list, claims) {
  const fragment = document.createDocumentFragment();
  for (const s of list) fragment.append(renderSource(s, claims));
  return fragment;
}

export function copyableText(claims, lookup, list) {
  const refs = c => c.evidence.map(r => {
    const s = r && lookup.get(r.source_id);
    return s ? '[' + s.number + ']' : '[Source unavailable]';
  }).join(' ');
  const sources = list.map(s => {
    const u = safeURL(s.url), p = pageNumber(s.page);
    return '[' + s.number + '] ' + titleOf(s) + (p ? ' - PDF page ' + p : '') + '\n' + (u ? u.href : 'Public link unavailable');
  });
  return claims.map(c => c.text + ' ' + refs(c)).join('\n\n') + '\n\nSources\n' + sources.join('\n\n');
}
