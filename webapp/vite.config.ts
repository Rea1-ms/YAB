import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// 开发时把 /api（含 WebSocket）代理到本地后端：python -m server --api-only --port 8000
export default defineConfig({
  plugins: [svelte()],
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', ws: true },
    },
  },
  build: {
    target: 'es2022',
  },
});
