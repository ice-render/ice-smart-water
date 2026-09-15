/**
 * 抓 ice-smart-water 的界面截图，写入 screenshots/，供 README 引用。
 *
 * 用法：先 `npm run build` 并起一个静态服务（例如 `npx http-server dist -p 8093 -c-1`），
 *       再把 BASE 指过去，然后 `node scripts/shoot-screenshots.mjs`。
 *
 * 用系统 Chrome（channel:'chrome'），绕开 Playwright 自带无头壳与本地缓存版本对不上的坑
 * （与 e2e/playwright.config.ts 一致）。
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8093';
const OUT = 'screenshots';
const VIEWPORT = { width: 1600, height: 950 };

mkdirSync(OUT, { recursive: true });

/** canvas 内部坐标 → 页面坐标，并把鼠标移过去（与 e2e/helpers.ts 同口径） */
async function canvasPoint(page, selector, x, y) {
  const point = await page.evaluate(
    ({ selector, x, y }) => {
      const canvas = document.querySelector(selector);
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round(rect.left + x), y: Math.round(rect.top + y) };
    },
    { selector, x, y }
  );
  await page.mouse.move(point.x, point.y);
  return point;
}

/** 按「表达式求出的画布组件」点一下（走引擎命中测试路径，与 e2e 一致） */
async function clickWidget(page, selector, expression) {
  const center = await page.evaluate(
    (expr) => {
      // eslint-disable-next-line no-new-func
      const node = new Function(`return ${expr}`)();
      if (!node || !node.state) return null;
      let left = 0;
      let top = 0;
      let cursor = node;
      while (cursor && cursor.state) {
        left += Number(cursor.state.left) || 0;
        top += Number(cursor.state.top) || 0;
        cursor = cursor.parentNode;
      }
      return { x: left + (Number(node.state.width) || 0) / 2, y: top + (Number(node.state.height) || 0) / 2 };
    },
    expression
  );
  if (!center) throw new Error(`控件没找到，点不到：${expression}`);
  const point = await canvasPoint(page, selector, center.x, center.y);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(320);
}

async function login(page, name = '演示用户') {
  await page.waitForFunction(() => !!window.__login);
  await page.waitForTimeout(600);
  await clickWidget(page, '#canvas-login', "window.__login.find('login-username')");
  await page.keyboard.type(name);
  await clickWidget(page, '#canvas-login', "window.__login.find('login-submit')");
  await page.waitForFunction(() => !window.__login.visible());
  // 登录后会弹一条「欢迎，xxx」的顶部消息（3s）；截图不该带这种瞬时浮层，等它消失再拍
  await page.waitForTimeout(3400);
}

/**
 * 切页：两级导航 —— 先点侧栏的「域」，再点顶栏该域的**页签**。
 * 页签在 `#page-tabs` 分段控件里，用组件自己的 `getSegmentNode(key)` 取到那一档的按钮节点。
 */
async function gotoPage(page, key) {
  const domain = await page.evaluate((k) => {
    const shell = window.__water.shell;
    const found = shell.domains().filter((d) => d.pages.some((p) => p.key === k))[0];
    return found ? found.key : null;
  }, key);
  if (!domain) throw new Error(`没有域包含页「${key}」`);
  const current = await page.evaluate(() => window.__water.shell.currentDomain());
  if (current !== domain) {
    await clickWidget(page, '#canvas-shell', `window.__water.shell.find('menu').getItemNode('${domain}')`);
    await page.waitForTimeout(320);
  }
  await clickWidget(page, '#canvas-shell', `window.__water.shell.find('page-tabs').getSegmentNode('${key}')`);
  await page.waitForTimeout(900);
}

async function shot(page, file) {
  await page.screenshot({ path: `${OUT}/${file}`, fullPage: false });
  console.log('  ✓', file);
}

async function main() {
  const browser = await chromium.launch({
    channel: 'chrome',
    args: ['--force-color-profile=srgb', '--hide-scrollbars'],
  });
  const page = await browser.newPage({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
  });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('→ 打开', BASE);
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });

  // 1) 登录门
  await page.waitForFunction(() => !!window.__login);
  await page.waitForTimeout(900);
  await shot(page, '01-login.png');

  await login(page);

  // 2) 工艺流程图（选中二沉池，展示「单元检视」面板 + 选择总线联动）
  await gotoPage(page, 'process');
  await page.evaluate(() => window.__water.selection.select('sec'));
  await page.waitForTimeout(700);
  await shot(page, '02-process.png');

  // 3) 运行数据（24h 看板 + 沿程 + 达标）
  await gotoPage(page, 'data');
  await page.waitForTimeout(800);
  await shot(page, '03-data.png');

  // 4) 实时监视（SCADA 推送：趋势 / 仪表 / 热力图）
  await gotoPage(page, 'live');
  await page.waitForTimeout(1500);
  await shot(page, '04-live.png');

  // 5) 工艺试算（参数扫动曲线）
  await gotoPage(page, 'calc');
  await page.waitForTimeout(700);
  await shot(page, '05-calc.png');

  // 6) 事件中心（报警工单闭环）
  await gotoPage(page, 'events');
  await page.waitForTimeout(700);
  await shot(page, '06-events.png');

  // 7) 符号库（31 种给排水符号图例）
  await gotoPage(page, 'legend');
  await page.waitForTimeout(700);
  await shot(page, '07-legend.png');

  await browser.close();

  console.log('\n控制台错误数：', errors.length);
  if (errors.length) {
    console.log(errors.slice(0, 10).join('\n'));
    process.exitCode = 1;
  } else {
    console.log('全部页面截图完成，无控制台错误。');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
