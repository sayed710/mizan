import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api is proxied to the Mizan server (npm start). Without it the app runs in browser-only demo mode.
export default defineConfig({
  plugins: [react()],
  // React rarely changes, so it ships as its own long-cached chunk.
  build: { rollupOptions: { output: { manualChunks: (id) => (/node_modules\/(react|react-dom|scheduler)\//.test(id) ? 'react' : undefined) } } },
  server: { proxy: { '/api': 'http://localhost:8069' } },
});
