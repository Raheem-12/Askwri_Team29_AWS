import './styles.css';
import { createGlobe } from './globe.js';
import { initApp } from './app.js';
import { $ } from './util.js';

let globe = null;
const message = $('globe-message');
try {
  globe = createGlobe($('globe-viewport'), {
    onStatus: text => { message.hidden = !text; message.textContent = text || ''; },
    isActive: () => document.body.dataset.view !== 'graph'
  });
} catch {
  // Search, pins-as-list and briefings all still work without WebGL.
  message.hidden = false;
  message.textContent = 'The interactive Earth needs WebGL 2. Enable browser graphics acceleration or try another browser. Search and answers still work.';
  document.querySelectorAll('.globe-controls button').forEach(b => { b.disabled = true; });
}
initApp({ globe });
