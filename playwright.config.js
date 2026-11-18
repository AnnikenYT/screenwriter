import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  use: { baseURL: 'http://localhost:3100', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node server/index.js',
    url: 'http://localhost:3100/api/health',
    env: { PORT: '3100', PUBLIC_URL: 'http://localhost:3100', DATA_DIR: `/tmp/screenwriter/e2e-${process.pid}`, AUTH_MODE: 'none' },
    reuseExistingServer: false,
    timeout: 30000,
  },
})
