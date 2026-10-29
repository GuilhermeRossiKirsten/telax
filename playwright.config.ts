import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

/**
 * Ambiente do servidor de TESTE do painel de admin. Os e2e importam esta constante e ASSINAM a própria sessão com o
 * mesmo segredo (não existe "modo de teste" no código de produção): testam tudo, menos o redirecionamento ao GitHub,
 * que tem teste unitário com `fetch` falso.
 */
export const ADMIN_TEST_ENV = {
  ADMIN_SESSION_SECRET: 'segredo-de-teste-do-admin-com-mais-de-32-caracteres',
  ADMIN_GITHUB_USER: 'telax-test-admin',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
};

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  workers: 1, // o armazenamento de salas é em memória de um único servidor; testes usam salas distintas
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: true,
    timeout: 300_000,
    env: ADMIN_TEST_ENV,
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
