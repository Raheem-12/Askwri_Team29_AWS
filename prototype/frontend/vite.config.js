import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const backend = process.env.ASKWRI_BACKEND_URL || 'http://127.0.0.1:8001';
const proxy = { '/api': { target: backend, changeOrigin: true, timeout: 180000, proxyTimeout: 180000 } };

export default defineConfig({
  server: { proxy, allowedHosts: ['terminal.local'] },
  preview: { proxy },
  build: {
    chunkSizeWarningLimit: 800, // three.js is large by nature
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), briefing: resolve(import.meta.dirname, 'briefing.html') } }
  }
});
