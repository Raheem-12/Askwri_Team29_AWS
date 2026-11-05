// Thin client for the FastAPI backend. Errors become readable Error messages;
// raw server details never reach the page beyond the backend's own `detail`.
import { t } from './i18n.js';

// Only send a language when it isn't English, so requests look exactly as before by default.
const withLanguage = (body, language) => (language && language !== 'en' ? { ...body, language } : body);
export async function jsonResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new Error(response.ok ? t('api.unreadable') : t('api.failed_http', { status: response.status }));
  }
}

async function request(path, { method = 'GET', body, timeout = 180000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const data = await jsonResponse(response);
    if (!response.ok) {
      throw new Error(typeof data.detail === 'string' ? data.detail
        : t('api.request_failed', { status: response.status }));
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(t('api.timeout'));
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const ANSWER_STATUSES = ['answered', 'insufficient_evidence', 'out_of_scope'];

export function checkAnswer(data) {
  if (!data || !ANSWER_STATUSES.includes(data.status)) {
    throw new Error(t('api.bad_format'));
  }
  return data;
}

export const api = {
  status: () => request('/api/status', { timeout: 10000 }),
  ask: (question, team, language, history) => request('/api/ask', {
    method: 'POST',
    body: withLanguage({ question, ...(team ? { team } : {}), ...(history?.length ? { history } : {}) }, language)
  }).then(checkAnswer),
  glance: (place, question, language) => request('/api/glance', {
    method: 'POST', body: withLanguage(question ? { place, question } : { place }, language) }).then(checkAnswer),
  briefing: (place, topic, language) => request('/api/briefing', {
    method: 'POST', body: withLanguage(topic ? { place, topic } : { place }, language) }),
  graph: () => request('/api/graph', { timeout: 20000 })
};
