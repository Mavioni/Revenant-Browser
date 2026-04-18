import { defineConfig } from '@playwright/test';
import path from 'path';

/**
 * Playwright config for Revenant Browser Electron smoke tests.
 *
 * We do NOT use browser projects — Electron is launched in-test via
 * `_electron.launch()` from `@playwright/test`. This config is mostly
 * test discovery + reporter setup.
 */
export default defineConfig({
  testDir: path.join(__dirname, 'e2e'),
  testMatch: /.*\.spec\.ts$/,
  // Electron boot is serial by nature — one app instance per worker.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: [
    ['list'],
    ['html', { outputFolder: path.join(__dirname, '..', 'playwright-report'), open: 'never' }],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
