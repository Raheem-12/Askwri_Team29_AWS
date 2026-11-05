// Interface translation. English (locales/en.js) is the source of truth; every other locale
// must have exactly the same keys and {placeholders} (tests/i18n.test.mjs checks this).
//
// In HTML:  data-i18n="key" sets textContent; data-i18n-attr="placeholder:key;aria-label:key2"
//           sets attributes. Example question chips use data-i18n-question for the question text.
// In JS:    t('key', { n: 3 }) and tn('key', count, vars) for plurals (key.one / key.other).
//
// Answers themselves are written by the model in the chosen language (see the backend's
// with_language); quotes always stay in the source's original language.
import en from './locales/en.js';
import es from './locales/es.js';
import pt from './locales/pt.js';
import fr from './locales/fr.js';
import id from './locales/id.js';
import hi from './locales/hi.js';
import zh from './locales/zh.js';

export const LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'pt', name: 'Português' },
  { code: 'fr', name: 'Français' },
  { code: 'id', name: 'Bahasa Indonesia' },
  { code: 'hi', name: 'हिन्दी' },
  { code: 'zh', name: '中文' }
];
export const LOCALES = { en, es, pt, fr, id, hi, zh };
const STORAGE_KEY = 'askwri.lang';
const HTML_LANG = { zh: 'zh-Hans', pt: 'pt-BR' };

let current = 'en';
const listeners = new Set();

export const supported = code => Object.hasOwn(LOCALES, code);

function stored() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

// ?lang= (shared briefing links) wins, then the saved choice, then the browser's language.
export function detectLanguage() {
  try {
    const fromURL = new URLSearchParams(location.search).get('lang');
    if (supported(fromURL)) return fromURL;
  } catch { /* no location in some test setups */ }
  const saved = stored();
  if (supported(saved)) return saved;
  const browser = (typeof navigator !== 'undefined' && navigator.languages) || [];
  for (const tag of browser) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (supported(base)) return base;
  }
  return 'en';
}

export const getLanguage = () => current;
// Spanish, Portuguese and French don't capitalise language names mid-sentence ("en español").
const LOWERCASE_IN_SENTENCE = new Set(['es', 'pt', 'fr']);
export const languageName = code => {
  const name = (LANGUAGES.find(l => l.code === code) || LANGUAGES[0]).name;
  return LOWERCASE_IN_SENTENCE.has(current) && LOWERCASE_IN_SENTENCE.has(code) ? name.toLowerCase() : name;
};

export function t(key, vars = {}) {
  const raw = LOCALES[current][key] ?? en[key];
  if (raw === undefined) return key;
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
}

export function tn(key, count, vars = {}) {
  let form = 'other';
  try { form = new Intl.PluralRules(HTML_LANG[current] || current).select(count); } catch { /* keep other */ }
  const k = `${key}.${form}`;
  const chosen = (LOCALES[current][k] ?? en[k]) !== undefined ? k : `${key}.other`;
  return t(chosen, { n: count, ...vars });
}

// Apply translations to every marked element under root.
export function translatePage(root = document) {
  document.documentElement.lang = HTML_LANG[current] || current;
  for (const node of root.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll('[data-i18n-attr]')) {
    for (const pair of node.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map(s => s.trim());
      if (attr && key) node.setAttribute(attr, t(key));
    }
  }
  for (const node of root.querySelectorAll('[data-i18n-question]')) node.dataset.question = t(node.dataset.i18nQuestion);
}

export function setLanguage(code, { save = true } = {}) {
  if (!supported(code)) code = 'en';
  const changed = code !== current;
  current = code;
  if (save) { try { localStorage.setItem(STORAGE_KEY, code); } catch { /* private mode */ } }
  if (typeof document !== 'undefined') translatePage();
  if (changed) for (const fn of listeners) fn(code);
}

export function onLanguageChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Fill a <select> with the languages and keep it in sync. `short` shows codes (ES, PT…)
// for a phone's narrow question bar; the full names stay in each option's title.
export function bindPicker(select, { short = false } = {}) {
  if (!select) return;
  select.replaceChildren(...LANGUAGES.map(({ code, name }) => {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = short && code !== 'zh' && code !== 'hi' ? code.toUpperCase() : name;
    option.title = name;
    option.lang = HTML_LANG[code] || code;
    return option;
  }));
  select.value = current;
  select.addEventListener('change', () => setLanguage(select.value));
  onLanguageChange(code => { select.value = code; });
}
