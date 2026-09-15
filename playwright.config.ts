import { defineConfig } from '@playwright/test';

/**
 * ice-smart-water 端到端回归。
 *
 * 只有一个页面：`dist/index.html`（单入口的整页画布外壳）。
 * 三个页签（工艺流程图 / 运行数据 / 符号库）与登录门都在同一个 HTML 里：
 * - `e2e/login.spec.ts`    登录门
 * - `e2e/app.spec.ts`      外壳、工艺图岛、运行数据页与看板岛
 * - `e2e/symbols-page.spec.ts` 符号库页签与图例岛
 *
 * 前置：`npm run build`（页面吃的是打包产物，不是 src）
 * 运行：`npm run test:e2e`
 *
 * 端口 8092 与家族其它仓库错开（引擎 8090 / 实体设计器 8091），可以同时跑。
 * `channel: 'chrome'`：用系统 Chrome，绕开 Playwright 自带无头壳与本地缓存版本对不上的坑。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  reporter: [['list']],
  webServer: {
    command: 'npx http-server dist -p 8092 -c-1 --silent',
    port: 8092,
    reuseExistingServer: false,
    timeout: 30_000,
  },
  use: {
    baseURL: 'http://localhost:8092',
    viewport: { width: 1600, height: 950 },
    deviceScaleFactor: 1,
    channel: 'chrome',
  },
});
