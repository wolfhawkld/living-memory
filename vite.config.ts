import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { DARK_THEME, themeRootCss } from './src/web/theme-palette';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'living-memory-theme-css',
      // Both dev HTML and the production document get the same palette before
      // the app loads, with no copied CSS values or JavaScript paint delay.
      transformIndexHtml: () => [{
        tag: 'style',
        attrs: { id: 'lm-default-theme' },
        children: themeRootCss(DARK_THEME),
        injectTo: 'head',
      }],
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.LM_PORT || 4317}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
