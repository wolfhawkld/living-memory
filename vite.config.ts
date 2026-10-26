import { defineConfig } from 'vite';
import { createHash } from 'node:crypto';
import react from '@vitejs/plugin-react';
import { STATIC_BUILD_MANIFEST_FILE, STATIC_BUILD_MANIFEST_FORMAT, STATIC_BUILD_MANIFEST_VERSION,
  STATIC_BUILD_LEARNING_PROTOCOLS, type StaticBuildManifest } from './src/shared/static-build-compatibility';
import { DARK_THEME, themeCssRule, themeRootCss } from './src/web/theme-palette';
import { themeBootstrapScript } from './src/web/theme-bootstrap';
import { lightWorkspaceVariables } from './src/web/theme-workspace';

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
        children: `${themeRootCss(DARK_THEME)}\n${themeCssRule(
          ':root[data-theme="light"]', lightWorkspaceVariables(),
        )}`,
        injectTo: 'head',
      }, {
        tag: 'script',
        attrs: { id: 'lm-theme-init' },
        children: themeBootstrapScript(),
        injectTo: 'head',
      }],
    },
    {
      name: 'living-memory-static-build-compatibility',
      apply: 'build',
      enforce: 'post',
      generateBundle: {
        order: 'post',
        handler(_options, bundle) {
          const entry = bundle['index.html'];
          if (!entry || entry.type !== 'asset') throw new Error('STATIC_BUILD_ENTRY_MISSING');
          const manifest: StaticBuildManifest = {
            format: STATIC_BUILD_MANIFEST_FORMAT, version: STATIC_BUILD_MANIFEST_VERSION,
            supportedLearningProtocols: [...STATIC_BUILD_LEARNING_PROTOCOLS],
            indexHtmlSha256: createHash('sha256').update(entry.source).digest('hex'),
          };
          this.emitFile({ type: 'asset', fileName: STATIC_BUILD_MANIFEST_FILE, source: JSON.stringify(manifest, null, 2) + '\n' });
        },
      },
    },
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.LM_PORT || 4317}`, changeOrigin: true } },
  },
  build: { outDir: 'dist', chunkSizeWarningLimit: 1500 },
});
