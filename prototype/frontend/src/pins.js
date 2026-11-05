import { el } from './util.js';

const CLUSTER_PX = 30;   // pins closer than this merge into one count marker
const MIN_FACING = 0.02; // pins on the far side of the globe are hidden

// Pins are real <button>s positioned over the canvas from the globe's projection.
// That keeps them keyboard-focusable and labelled, and lets CSS animate them.
export function createPins(layer, { onSelect, onCluster }) {
  const entries = new Map();   // id -> { place, button, count, members, last }
  const positions = new Map(); // id -> { x, y, facing }
  let selectedId = null;

  const describe = (place, n = 1) => n > 1
    ? `${n} places close together. Zoom in.`
    : `${place.name}${place.precision === 'approximate' ? ' (approximate area)' : ''}, ${place.issues.length} `
      + `${place.issues.length === 1 ? 'issue' : 'issues'} in these sources. Open summary.`;

  function setPlaces(places) {
    layer.replaceChildren();
    entries.clear();
    positions.clear();
    selectedId = null;
    places.forEach((place, index) => {
      const button = el('button', '', 'pin');
      button.type = 'button';
      button.dataset.id = place.id;
      button.style.setProperty('--i', String(index));
      button.setAttribute('aria-label', describe(place));
      const core = el('span', '', 'pin-core');
      core.append(el('span', '', 'pin-pulse'), el('span', '', 'pin-dot'));
      const count = el('span', '', 'pin-count');
      count.hidden = true;
      button.append(core, count, el('span', place.name + (place.precision === 'approximate' ? ' · approx.' : ''), 'pin-label'));
      const entry = { place, button, count, members: [place.id], last: '' };
      button.addEventListener('click', () => (entry.members.length > 1 ? onCluster(entry.members) : onSelect(place.id)));
      entries.set(place.id, entry);
      layer.append(button);
    });
  }

  function select(id) {
    selectedId = id;
    for (const [key, entry] of entries) {
      entry.button.classList.toggle('is-selected', key === id);
      entry.button.setAttribute('aria-pressed', String(key === id));
    }
  }

  // Called every frame with the globe's projected positions.
  function update(projected) {
    const near = projected.filter(p => p.facing > MIN_FACING && entries.has(p.id));
    near.sort((a, b) => (a.id === selectedId ? -1 : b.id === selectedId ? 1 : b.facing - a.facing));
    const assigned = new Set(), leaders = new Map();
    for (const p of near) {
      if (assigned.has(p.id)) continue;
      assigned.add(p.id);
      const members = [p.id];
      if (p.id !== selectedId) { // the selected pin stays on its own so it is never hidden in a cluster
        for (const q of near) {
          if (assigned.has(q.id) || q.id === selectedId) continue;
          if (Math.hypot(p.x - q.x, p.y - q.y) < CLUSTER_PX) { members.push(q.id); assigned.add(q.id); }
        }
      }
      leaders.set(p.id, { p, members });
    }
    const byId = new Map(projected.map(p => [p.id, p]));
    for (const [id, entry] of entries) {
      const lead = leaders.get(id), p = byId.get(id);
      if (p) positions.set(id, { x: p.x, y: p.y, facing: p.facing });
      const shown = Boolean(lead);
      const interactive = shown && p.facing > 0.35;
      entry.button.classList.toggle('is-hidden', !shown);
      entry.button.tabIndex = interactive ? 0 : -1;
      entry.button.style.pointerEvents = interactive ? '' : 'none';
      if (!shown) continue;
      const style = `translate3d(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px,0)`;
      if (style !== entry.last) { entry.button.style.transform = style; entry.last = style; }
      entry.button.style.opacity = p.facing.toFixed(2);
      if (entry.members.length !== lead.members.length || entry.members[0] !== lead.members[0]) {
        entry.members = lead.members;
        entry.count.hidden = lead.members.length < 2;
        entry.count.textContent = String(lead.members.length);
        entry.button.setAttribute('aria-label', describe(entry.place, lead.members.length));
      }
    }
  }

  return {
    setPlaces, update, select,
    position: id => positions.get(id),
    get selected() { return selectedId; },
    clear() { setPlaces([]); }
  };
}
