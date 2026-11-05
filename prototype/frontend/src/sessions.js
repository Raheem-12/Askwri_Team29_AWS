// Research sessions, kept only in this browser. A session is one chat: the question that began
// it and any follow-ups. Stored data can be edited by anyone with the browser's dev tools, so
// everything read back is checked again; links still go through safeURL when rendered.
import { validClaims } from './render.js';
import { cleanPlaces } from './places.js';
import { cleanSafety } from './safety.js';

const KEY = 'askwri.sessions.v1';
export const MAX_SESSIONS = 20;
const STATUSES = ['answered', 'insufficient_evidence', 'out_of_scope'];

function storage() {
  try { return window.localStorage; } catch { return null; }
}

function cleanTurn(turn) {
  const data = turn && turn.data;
  if (!data || typeof turn.question !== 'string' || !STATUSES.includes(data.status)) return null;
  if (data.status === 'answered' && !validClaims(data.claims)) return null;
  return {
    question: turn.question,
    data: {
      status: data.status,
      answer: typeof data.answer === 'string' ? data.answer : '',
      claims: Array.isArray(data.claims) ? data.claims : [],
      sources: Array.isArray(data.sources) ? data.sources : [],
      locations: cleanPlaces(data.locations),
      safety: cleanSafety(data.safety),
      language: data.language,
      requested_language: data.requested_language
    }
  };
}

function cleanSession(session) {
  if (!session || typeof session.id !== 'string' || !Number.isFinite(session.startedAt)) return null;
  const turns = (Array.isArray(session.turns) ? session.turns : []).map(cleanTurn).filter(Boolean);
  return turns.length ? { id: session.id, startedAt: session.startedAt, demo: session.demo === true, turns } : null;
}

export function loadSessions() {
  try {
    const parsed = JSON.parse(storage()?.getItem(KEY) || '[]');
    return (Array.isArray(parsed) ? parsed : []).map(cleanSession).filter(Boolean);
  } catch {
    return [];
  }
}

function write(sessions) {
  // A full browser store drops the oldest sessions. History must never cost anyone an answer.
  for (let list = sessions; list.length; list = list.slice(0, -1)) {
    try {
      storage().setItem(KEY, JSON.stringify(list));
      return true;
    } catch { /* full or unavailable: try with less */ }
  }
  return false;
}

// Newest first. Saved after every turn, so reloading the page loses nothing.
export function saveSession(session) {
  return write([session, ...loadSessions().filter(s => s.id !== session.id)].slice(0, MAX_SESSIONS));
}

export function clearSessions(keepId = null) {
  const kept = loadSessions().filter(s => s.id === keepId);
  try {
    if (kept.length) storage().setItem(KEY, JSON.stringify(kept));
    else storage().removeItem(KEY);
  } catch { /* nothing to clear */ }
}

export function newSession() {
  return { id: `s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, startedAt: Date.now(), demo: false, turns: [] };
}

// A turn holds the guardrail-masked question, never the text as typed. A blocked question has no
// masked form and may contain a secret, so it is stored empty.
export function makeTurn(data) {
  return cleanTurn({ question: typeof data.topic === 'string' ? data.topic : '', data });
}

// What a follow-up may send: this session's earlier turns only. Blocked turns add nothing.
export function historyOf(session, limit = 6) {
  return session.turns.filter(t => t.data.status !== 'out_of_scope' && t.question).slice(-limit)
    .map(t => ({ question: t.question.slice(0, 2000),
      answer: t.data.status === 'answered' ? t.data.answer.slice(0, 2000) : '' }));
}
