import { defineConfig, devices } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Generated for this disposable CI server; no repository/production secrets used.
process.env.CI_BROWSER_PASSWORD ||= randomBytes(24).toString('hex');

export default defineConfig({
  testDir: './tests',
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:8069',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node ../../server/index.js',
    url: 'http://127.0.0.1:8069',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: '8069',
      MIZAN_DB: join(tmpdir(), `mizan-browser-${randomBytes(8).toString('hex')}.sqlite`),
      MIZAN_ADMIN_PASSWORD: process.env.CI_BROWSER_PASSWORD,
    },
  },
});
