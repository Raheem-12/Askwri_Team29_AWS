import { defineConfig } from 'vite';
const backend = process.env.ASKWRI_BACKEND_URL || 'http://127.0.0.1:8001';
const proxy = { '/api': { target: backend, changeOrigin: true, timeout: 180000, proxyTimeout: 180000 } };
export default defineConfig({server:{proxy,allowedHosts:['terminal.local']},preview:{proxy}});
