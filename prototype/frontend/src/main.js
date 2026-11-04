import './styles.css';
import { createGlobe } from './globe.js';
import { initApp } from './app.js';
import { $ } from './util.js';
import { t, setLanguage, detectLanguage, bindPicker } from './i18n.js';

setLanguage(detectLanguage(), { save: false });
bindPicker($('language'), { short: window.matchMedia('(max-width: 760px)').matches });

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
  message.textContent = t('globe.no_webgl');
  document.querySelectorAll('.globe-controls button').forEach(b => { b.disabled = true; });
}
initApp({ globe });
