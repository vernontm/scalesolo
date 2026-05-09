// Playwright config for ScaleSolo smoke tests.
//
// Defaults:
//   - Local: spins up `npm run preview` on :5180 and runs against it.
//   - CI / prod: set BASE_URL=https://www.scalesolo.ai and skip the
//     local server boot (the test runner won't try to start one if
//     BASE_URL points at a public host).
//
// Run:
//   npm run test:e2e            (headless)
//   npm run test:e2e:headed     (watches in a real browser)
//   npm run test:e2e:ui         (Playwright's UI mode)

import { defineConfig, devices } from '@playwright/test'

const BASE_URL = process.env.BASE_URL || 'http://localhost:5180'
const isLocal = BASE_URL.startsWith('http://localhost')

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? 'github' : 'list',

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  // Only boot a local preview server when targeting localhost.
  webServer: isLocal ? {
    command: 'npm run build && npm run preview',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  } : undefined,
})
