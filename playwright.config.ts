import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: 'http://127.0.0.1:4317',
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    },
  },
  webServer: {
    command: 'npm run start',
    wait: { stdout: /Living Memory local server listening/ },
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      LM_PORT: '4317',
      LM_DATA_DIR: resolve('.cache', `e2e-${randomUUID()}`),
      LM_KG_ROOT: resolve('fixtures/demo-kg'),
      LM_KG_LIMIT: '20',
      LM_KG_INCLUDE: '',
    },
  },
});
