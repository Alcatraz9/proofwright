import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

/**
 * The dashboard is built to static assets and served by the same Node process
 * that serves the API, the event streams and the application under test. One
 * port, one container, no CORS.
 *
 * In development Vite sits in front and proxies the three server-owned prefixes
 * through, so the code makes the same same-origin requests in both modes and no
 * base URL has to be configured anywhere.
 */

const API = 'http://127.0.0.1:7860';

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    proxy: {
      // `/api/runs/:id/stream` is server-sent events. Buffering it would deliver
      // a whole run in one lump at the end, which is indistinguishable from a
      // hung run, so compression stays off for the proxied paths.
      '/api': { target: API, changeOrigin: false },
      '/artifacts': { target: API, changeOrigin: false },
      '/app': { target: API, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Named chunks with hashes: the Node static handler caches hashed assets
    // hard and revalidates index.html every time.
    sourcemap: false,
  },
});
