import { defineConfig, devices } from '@playwright/test';

// Report E2E runs in Chromium; the marks carry-over test (tagged @carry) runs in all three engines (eng delta DE4).
export default defineConfig({
  testDir: 'test/e2e',
  timeout: 30_000,
  reporter: [['list']],
  use: { acceptDownloads: true },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] }, grep: /@carry/ },
    { name: 'webkit', use: { ...devices['Desktop Safari'] }, grep: /@carry/ },
  ],
});
