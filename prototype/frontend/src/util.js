// Small DOM and URL helpers. Everything user- or model-supplied goes through
// textContent (el), never innerHTML.
export const $ = id => document.getElementById(id);

export function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

export function announce(text) {
  const live = $('announcement');
  if (live) live.textContent = text;
}

// Only https links on wri.org domains are ever rendered as links.
export function safeURL(value) {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (!(url.hostname === 'wri.org' || url.hostname.endsWith('.wri.org'))) return null;
    return url;
  } catch {
    return null;
  }
}

// Our own route to a citation's original PDF. Saved sessions can be edited, so the shape is checked.
export function documentURL(value) {
  return typeof value === 'string' && /^\/api\/document\/docs\/\d{4}_publications\/[^/?#\\]+\.pdf$/.test(value) ? value : null;
}

export function pageNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export function externalLink(text, url) {
  const a = el('a', text);
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

export function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
