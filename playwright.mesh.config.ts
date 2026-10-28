import { defineConfig, devices } from '@playwright/test';

const PORT = 3200;

export default defineConfig({
  testDir: './e2e-mesh',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1, // o armazenamento de salas é em memória de um único servidor; testes usam salas distintas
  reporter: [['list']],
  outputDir: './test-results-mesh',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--auto-select-desktop-capture-source=Entire screen',
          ],
        },
      },
    },
  ],
});
