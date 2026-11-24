import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Every build gets its own stamp. The app carries it (__HZ_BUILD__) and the server reports the live one from
// dist/build.json (GET /api/version), so an open app can tell a new release is out and offer to update.
const BUILD = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const buildStamp: Plugin = {
  name: 'heyzubi-build-stamp',
  apply: 'build',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build: BUILD, builtAt: new Date().toISOString() }) });
  },
};

const API = process.env.HEYZUBI_API ?? process.env.BOTHQ_API ?? process.env.GROKBOT_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), buildStamp],
  define: { __HZ_BUILD__: JSON.stringify(process.env.NODE_ENV === 'production' || process.argv.includes('build') ? BUILD : 'dev') },
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('../server/src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API, changeOrigin: false, ws: true },
    },
  },
  // noVNC uses top-level await, so target ES2022+.
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
