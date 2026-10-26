import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-v3', testMatch: '*.spec.ts', workers: 1, fullyParallel: false,
  timeout: 60_000, expect: { timeout: 15_000 }, outputDir: 'test-results-v3',
  use: { baseURL: 'http://127.0.0.1:4319', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce',
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    launchOptions: { args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] } },
  webServer: { command: 'node --import tsx tests/e2e-v3/server.ts', wait: { stdout: /Living Memory synthetic v3 ready/ },
    reuseExistingServer: false, timeout: 30_000 },
});
