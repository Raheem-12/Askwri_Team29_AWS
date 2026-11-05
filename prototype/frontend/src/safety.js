// The safety card: what each check found for the question and answer on screen.
// It only ever shows fixed labels, never the text that was flagged. Saved sessions can be edited
// in dev tools, so a summary is checked against these lists whenever it is read back.
import { el } from './util.js';
import { t, tn } from './i18n.js';

const VERDICTS = ['clear', 'review', 'blocked', 'declined'];
const RESULTS = {
  input: ['passed', 'masked', 'blocked', 'limited'],
  quotes: ['passed', 'removed', 'failed', 'not_run'],
  grounding: ['passed', 'failed', 'not_run']
};
const IDS = Object.keys(RESULTS);
const TONES = { passed: 'ok', masked: 'warn', removed: 'warn', limited: 'warn', blocked: 'danger', failed: 'danger', not_run: 'muted' };
const VERDICT_TONES = { clear: 'ok', review: 'warn', blocked: 'danger', declined: 'muted' };
const MAX_REMOVED = 100;

// A clean copy of the summary, or null if anything in it is unexpected.
export function cleanSafety(value) {
  if (!value || !VERDICTS.includes(value.verdict) || !Array.isArray(value.checks) || value.checks.length !== IDS.length) return null;
  const checks = [];
  for (const [i, id] of IDS.entries()) {
    const check = value.checks[i];
    if (!check || check.id !== id || !RESULTS[id].includes(check.result)) return null;
    if (check.result === 'removed') {
      if (!Number.isInteger(check.count) || check.count < 1 || check.count > MAX_REMOVED) return null;
      checks.push({ id, result: check.result, count: check.count });
    } else {
      checks.push({ id, result: check.result });
    }
  }
  // An edited summary must not be able to show "no problems" over a failed check.
  if (value.verdict === 'clear' && checks.some(c => c.result !== 'passed')) return null;
  if ((value.verdict === 'blocked') !== (checks[0].result === 'blocked')) return null;
  return { verdict: value.verdict, checks };
}

function resultText({ id, result, count }) {
  if (result === 'not_run') return t('safety.not_run');
  if (result === 'removed') return tn('safety.quotes.removed', count);
  return t(`safety.${id}.${result}`);
}

export function renderSafety(safety) {
  const body = document.createDocumentFragment();
  const head = el('div', '', 'safety-head');
  const verdict = el('span', t(`safety.verdict.${safety.verdict}`), 'safety-verdict');
  verdict.dataset.tone = VERDICT_TONES[safety.verdict];
  head.append(el('h2', t('safety.title'), 'section-label'), verdict);
  const list = el('ul', '', 'safety-checks');
  for (const check of safety.checks) {
    const row = el('li');
    row.dataset.check = check.id;
    row.dataset.tone = TONES[check.result];
    row.append(el('span', t(`safety.check.${check.id}`), 'safety-name'), el('span', resultText(check), 'safety-result'));
    list.append(row);
  }
  body.append(head, list, el('p', t('safety.note'), 'safety-note'));
  return body;
}

// Said aloud only when there is something to notice.
export function safetyAnnouncement(safety) {
  if (!safety || !['review', 'blocked'].includes(safety.verdict)) return '';
  return `${t('safety.title')}: ${t(`safety.verdict.${safety.verdict}`)}.`;
}
