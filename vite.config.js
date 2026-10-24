import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api is proxied to the Mizan server (npm start). Without it the app runs in browser-only demo mode.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://localhost:8069' } },
});
