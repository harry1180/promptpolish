import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // keep workspace packages out of prebundling so their TS source is transformed directly
  optimizeDeps: { include: [] },
  server: {
    // org account/dashboard API (apps/server); relative /api keeps dev same-origin
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
});
