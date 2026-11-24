import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/electron',
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  ...(process.env['NEWEDITOR_TEST_DEV'] === '1'
    ? {
        webServer: {
          command: 'electron-vite dev --rendererOnly',
          url: 'http://127.0.0.1:5173/',
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }
    : {}),
});
