import { defineConfig, devices } from '@playwright/test'

// Mirrors synapse-web-monorepo/apps/portals-e2e/playwright.config.ts: trace always on,
// html report locally. Chromium only — this verifies backend behavior, not browser quirks.
// The Search Lab is rebuilt from ../web into .site/ and served statically on each run.
const port = 3017

export default defineConfig({
  testDir: './e2e',
  expect: { timeout: 30_000 },
  // Every spec drives the same staging indexes; a semantic query per spec is enough load.
  workers: 1,
  timeout: 180_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'on',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1200 } } }],
  webServer: {
    command: 'npm run serve',
    url: `http://localhost:${port}`,
    reuseExistingServer: true,
  },
})
