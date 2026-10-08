/**
 * @see {@link https://playwright.dev/docs/chrome-extensions Chrome extensions | Playwright}
 */
import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  retries: 2,
  webServer: {
    command: 'pnpm run dev',
    // start e2e test after the Vite server is fully prepared
    // ⚠ 这里必须指向一个**当前存在**的入口：曾经写的是已删除的 popup/main.ts，
    // 结果探针永远 404，60 秒后超时 —— e2e 等于完全跑不起来。
    url: 'http://localhost:3303/popup/main.ts',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
