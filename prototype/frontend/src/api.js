// Thin client for the FastAPI backend. Errors become readable Error messages;
// raw server details never reach the page beyond the backend's own `detail`.
export async function jsonResponse(response) {
  try {
    return await response.json();
  } catch {
    throw new Error(response.ok
      ? 'The server returned an unreadable response. Please try again.'
      : 'The research service could not complete the request (HTTP ' + response.status + '). Please try again.');
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
        : 'The research request failed (HTTP ' + response.status + '). Please try again.');
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The request took too long. Please try again.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const ANSWER_STATUSES = ['answered', 'insufficient_evidence', 'out_of_scope'];

export function checkAnswer(data) {
  if (!data || !ANSWER_STATUSES.includes(data.status)) {
    throw new Error('The server returned an unexpected answer format. Please try again.');
  }
  return data;
}

export const api = {
  status: () => request('/api/status', { timeout: 10000 }),
  ask: (question, team) => request('/api/ask', {
    method: 'POST', body: team ? { question, team } : { question } }).then(checkAnswer),
  glance: (place, question) => request('/api/glance', {
    method: 'POST', body: question ? { place, question } : { place } }).then(checkAnswer),
  briefing: (place, topic) => request('/api/briefing', {
    method: 'POST', body: topic ? { place, topic } : { place } }),
  graph: () => request('/api/graph', { timeout: 20000 })
};
