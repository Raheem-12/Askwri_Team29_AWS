import './base.css';
import './globe.css';
import './research.js';
import { mountGlobe } from './globe.js';

const panel = document.getElementById('panel-ask');
const globePanel = document.getElementById('globe-panel');
const stack = document.getElementById('evidence-stack');
const progress = document.getElementById('search-progress');
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
mountGlobe(document.getElementById('globe-viewport'));
document.addEventListener('research:start', () => {
  panel.classList.add('is-searching');
  panel.classList.remove('has-error');
  progress.hidden = false;
});
document.addEventListener('research:end', () => {
  panel.classList.remove('is-searching');
  progress.hidden = true;
});
document.addEventListener('research:error', () => panel.classList.add('has-error'));
document.addEventListener('research:result', () => {
  if (panel.classList.contains('has-results')) return;
  const before = globePanel.getBoundingClientRect();
  panel.classList.add('has-results');
  stack.prepend(globePanel); // Same canvas, camera and controls; no WebGL remount.
  const after = globePanel.getBoundingClientRect();
  if (!reduced.matches && before.width && after.width) {
    globePanel.animate([
      { transformOrigin: 'top left', transform: `translate(${before.left-after.left}px, ${before.top-after.top}px) scale(${before.width/after.width}, ${before.height/after.height})`, opacity: .65 },
      { transformOrigin: 'top left', transform: 'none', opacity: 1 }
    ], { duration: 700, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
});
