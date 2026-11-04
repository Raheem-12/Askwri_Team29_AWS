import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY } from 'd3-force';
import { $, el, safeURL, externalLink } from './util.js';
import { t } from './i18n.js';

// Colours for data marks only (topic -> hue). Everything else comes from CSS tokens.
const TOPIC_COLORS = {
  Cities: '#e0b95a', Freshwater: '#6fb6c9', Food: '#d19a74', Energy: '#d9d27a',
  Forests: '#7fb77e', Climate: '#b99be0', Ocean: '#6f98e0'
};
const FALLBACK = '#a9b8a8';
const norm = s => String(s || '').normalize('NFKD').replace(/\s+/g, ' ').trim().toLowerCase();

// Publications the latest answer cited. Matches on title because the Knowledge
// Base and the manifests share titles but not ids.
export function matchCited(nodes, sources) {
  const titles = new Set((Array.isArray(sources) ? sources : []).map(s => norm(s && s.title)).filter(Boolean));
  return new Set(nodes.filter(n => n.type === 'publication' && titles.has(norm(n.label))).map(n => n.id));
}

export function neighborIds(id, links) {
  const ids = new Set([id]);
  for (const l of links) {
    const s = typeof l.source === 'object' ? l.source.id : l.source;
    const t = typeof l.target === 'object' ? l.target.id : l.target;
    if (s === id) ids.add(t);
    if (t === id) ids.add(s);
  }
  return ids;
}

export function createGraph(host, { onAsk, reduced = false }) {
  const canvas = el('canvas');
  canvas.setAttribute('aria-label', t('graph.canvas'));
  host.prepend(canvas);
  const ctx = canvas.getContext('2d');
  const tooltip = $('graph-tooltip'), info = $('graph-info');
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  let nodes = [], links = [], sim = null, cited = new Set();
  let view = { k: 1, x: 0, y: 0 }, w = 1, h = 1, dpr = 1;
  let hover = null, hoverEdge = null, selected = null, drag = null, pan = null, queued = false, running = false;

  const radius = n => (n.type === 'topic' ? 16 : cited.has(n.id) ? 8 : 6);
  const color = n => TOPIC_COLORS[n.type === 'topic' ? n.label : n.program] || FALLBACK;
  const toWorld = (px, py) => [(px - w / 2 - view.x) / view.k, (py - h / 2 - view.y) / view.k];
  const toScreen = (x, y) => [x * view.k + w / 2 + view.x, y * view.k + h / 2 + view.y];

  // Scale and centre the whole graph inside the area the header and ask bar leave free.
  function fit() {
    if (!nodes.length || w < 10 || h < 10) return;
    const margin = { top: 110, bottom: 170, side: 70 };
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const n of nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    const k = Math.min(2.2, Math.max(0.3, Math.min((w - 2 * margin.side) / bw, (h - margin.top - margin.bottom) / bh)));
    view = { k, x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k + (margin.top - margin.bottom) / 2 };
    schedule();
  }

  function schedule() {
    if (queued || !running) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; draw(); });
  }

  function nodeAt(px, py) {
    const [x, y] = toWorld(px, py);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i], r = radius(n) + 4 / view.k;
      if ((n.x - x) ** 2 + (n.y - y) ** 2 <= r * r) return n;
    }
    return null;
  }

  function edgeAt(px, py) {
    let best = null, bestD = 6;
    for (const l of links) {
      const [ax, ay] = toScreen(l.source.x, l.source.y), [bx, by] = toScreen(l.target.x, l.target.y);
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < bestD) { bestD = d; best = l; }
    }
    return best;
  }

  function draw() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const focus = hover || selected;
    const near = focus ? neighborIds(focus.id, links) : null;
    const ink = css('--ink'), bg = css('--bg'), gold = css('--gold'), line = css('--ink-faint');
    ctx.lineCap = 'round';
    for (const l of links) {
      const [ax, ay] = toScreen(l.source.x, l.source.y), [bx, by] = toScreen(l.target.x, l.target.y);
      const lit = !near || (near.has(l.source.id) && near.has(l.target.id) && (l.source.id === focus.id || l.target.id === focus.id));
      ctx.globalAlpha = lit ? (l.kind === 'topic' ? 0.5 : 0.35) : 0.06;
      ctx.strokeStyle = l.kind === 'evidence' ? gold : line;
      ctx.lineWidth = hoverEdge === l ? 2.5 : 1.2;
      ctx.setLineDash(l.kind === 'related' ? [4, 5] : []);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const n of nodes) {
      const [x, y] = toScreen(n.x, n.y), r = radius(n) * Math.min(1.4, Math.max(0.8, view.k));
      const lit = !near || near.has(n.id);
      ctx.globalAlpha = lit ? 1 : 0.14;
      if (cited.has(n.id)) {
        ctx.strokeStyle = gold; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, r + 5, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      if (n.sample) { ctx.strokeStyle = color(n); ctx.lineWidth = 2; ctx.fillStyle = bg; ctx.fill(); ctx.stroke(); }
      else { ctx.fillStyle = color(n); ctx.fill(); }
      if (n === selected || n === hover) { ctx.strokeStyle = ink; ctx.lineWidth = 2; ctx.stroke(); }
      const showLabel = n.type === 'topic' || n === focus || cited.has(n.id) || (near && near.has(n.id)) || view.k > 1.6;
      if (showLabel && lit) {
        const text = n.label.length > 40 ? n.label.slice(0, 38) + '…' : n.label;
        ctx.font = (n.type === 'topic' ? '600 13px ' : '12px ') + 'system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.lineWidth = 4; ctx.strokeStyle = bg; ctx.strokeText(text, x, y + r + 4);
        ctx.fillStyle = ink; ctx.fillText(text, x, y + r + 4);
      }
    }
    ctx.globalAlpha = 1;
  }

  function resize() {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    w = rect.width; h = rect.height; dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    schedule();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(host);

  function showInfo(n) {
    if (!n || n.type !== 'publication') { info.hidden = true; return; }
    const url = safeURL(n.url);
    const close = el('button', '×', 'icon-button');
    close.type = 'button'; close.setAttribute('aria-label', t('graph.close'));
    close.addEventListener('click', () => { selected = null; info.hidden = true; schedule(); });
    const ask = el('button', t('graph.ask'), 'primary small');
    ask.type = 'button';
    ask.addEventListener('click', () => onAsk(t('graph.ask_q', { label: n.label })));
    const meta = [n.program, n.year].filter(Boolean).join(' · ') + (n.sample ? ' · ' + t('graph.sample') : '');
    const actions = el('div', '', 'graph-actions');
    actions.append(ask);
    if (url) actions.append(externalLink(t('source.open'), url.href));
    info.replaceChildren(close, el('h3', n.label), el('p', meta, 'muted'), actions);
    info.hidden = false;
  }

  function point(event) {
    const r = canvas.getBoundingClientRect();
    return [event.clientX - r.left, event.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', event => {
    const [px, py] = point(event);
    canvas.setPointerCapture(event.pointerId);
    const n = nodeAt(px, py);
    if (n) { drag = { n, moved: false, sx: px, sy: py }; if (!reduced) sim.alphaTarget(0.25).restart(); }
    else pan = { sx: px, sy: py, vx: view.x, vy: view.y, moved: false };
  });
  canvas.addEventListener('pointermove', event => {
    const [px, py] = point(event);
    if (drag) {
      if (Math.hypot(px - drag.sx, py - drag.sy) > 4) drag.moved = true;
      if (drag.moved) { [drag.n.fx, drag.n.fy] = toWorld(px, py); if (reduced) { drag.n.x = drag.n.fx; drag.n.y = drag.n.fy; } schedule(); }
      return;
    }
    if (pan) {
      if (Math.hypot(px - pan.sx, py - pan.sy) > 4) pan.moved = true;
      view.x = pan.vx + px - pan.sx; view.y = pan.vy + py - pan.sy; schedule();
      return;
    }
    const n = nodeAt(px, py), edge = n ? null : edgeAt(px, py);
    if (n !== hover || edge !== hoverEdge) { hover = n; hoverEdge = edge; schedule(); }
    canvas.style.cursor = n ? 'pointer' : edge ? 'help' : 'grab';
    const text = n ? n.label : edge ? edge.reason : '';
    tooltip.hidden = !text;
    if (text) {
      tooltip.textContent = text;
      tooltip.style.transform = `translate(${Math.min(px + 14, w - 260)}px, ${py + 14}px)`;
    }
  });
  const release = () => {
    if (drag) {
      const { n, moved } = drag;
      n.fx = n.fy = null;
      if (!moved) { selected = n; showInfo(n); }
      if (!reduced) sim.alphaTarget(0);
      drag = null;
    } else if (pan) {
      if (!pan.moved) { selected = null; info.hidden = true; }
      pan = null;
    }
    schedule();
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('pointerleave', () => { if (!drag && !pan) { hover = hoverEdge = null; tooltip.hidden = true; schedule(); } });
  canvas.addEventListener('wheel', event => {
    event.preventDefault();
    const [px, py] = point(event), [wx, wy] = toWorld(px, py);
    view.k = Math.min(4, Math.max(0.3, view.k * Math.exp(-event.deltaY * 0.0015)));
    view.x = px - w / 2 - wx * view.k; view.y = py - h / 2 - wy * view.k;
    schedule();
  }, { passive: false });
  canvas.addEventListener('dblclick', () => fit());

  return {
    load(data) {
      const topics = data.nodes.filter(n => n.type === 'topic');
      nodes = data.nodes.map((n, i) => {
        // Deterministic seed positions so the layout is stable between visits.
        const hub = n.type === 'topic' ? n : topics.find(t => t.label === n.program);
        const index = hub ? topics.indexOf(hub) : 0, angle = (index / Math.max(1, topics.length)) * Math.PI * 2;
        const spread = n.type === 'topic' ? 170 : 170 + 40 + (i % 5) * 18;
        return { ...n, x: Math.cos(angle) * spread + (i % 7) * 3, y: Math.sin(angle) * spread + (i % 5) * 3 };
      });
      links = data.edges.map(e => ({ ...e }));
      sim?.stop();
      sim = forceSimulation(nodes)
        .force('link', forceLink(links).id(d => d.id).distance(l => (l.kind === 'topic' ? 70 : 130))
          .strength(l => (l.kind === 'topic' ? 0.9 : 0.08)))
        .force('charge', forceManyBody().strength(d => (d.type === 'topic' ? -320 : -70)))
        .force('center', forceCenter(0, 0))
        .force('x', forceX(0).strength(0.07)) // keeps unconnected topic hubs from drifting away
        .force('y', forceY(0).strength(0.07))
        .force('collide', forceCollide(d => radius(d) + 8))
        .on('tick', schedule);
      sim.stop();
      sim.tick(260); // settle before first paint so the map opens already organised
      resize();
      fit();
      if (!reduced) sim.alpha(0.12).restart(); // a gentle final settle
    },
    highlight(sources) { cited = matchCited(nodes, sources); schedule(); },
    zoomBy(f) { view.k = Math.min(4, Math.max(0.3, view.k * f)); view.x *= f; view.y *= f; schedule(); },
    reset() { fit(); },
    start() { running = true; resize(); if (sim && !reduced) sim.alpha(0.3).restart(); schedule(); },
    stop() { running = false; sim?.stop(); },
    get citedCount() { return cited.size; },
    get nodeCount() { return nodes.length; },
    destroy() { observer.disconnect(); sim?.stop(); canvas.remove(); }
  };
}
