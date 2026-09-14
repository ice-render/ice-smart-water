import { expect, test } from '@playwright/test';
import { canvasStats, clickCanvas, clickCanvasChild, expectViewportInteractions } from './helpers';

/**
 * `water-symbols.html` 的端到端回归。
 *
 * 这一页把**图形**（域包的记法）与**业务语义**（本仓的符号目录）拼在一起：
 * 图例必须画全 21 种、点选要能带出"作用 / 设计关注 / 巡检要点"、分类筛选要真的筛。
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  (page as any).__errors = errors;
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/water-symbols.html');
  await page.waitForFunction(() => !!(window as any).__symbols);
  await page.waitForTimeout(300);
});

test('图例：21 种符号全部渲染，分类计数 10 / 3 / 6 / 2', async ({ page }) => {
  const state = await page.evaluate(() => {
    const symbols = (window as any).__symbols;
    return {
      total: symbols.total,
      stats: symbols.stats.map((item: any) => [item.id, item.count]),
      cells: symbols.legend.getLayout().cells.length,
      kinds: symbols.legend.getLayout().cells.map((cell: any) => cell.kind),
    };
  });
  expect(state.total).toBe(21);
  expect(state.cells).toBe(21);
  expect(state.kinds).toContain('aerobicTank');
  expect(state.kinds).toContain('dewateringMachine');
  expect(state.stats).toEqual([
    ['water', 10],
    ['sludge', 3],
    ['equipment', 6],
    ['boundary', 2],
  ]);
  expect((page as any).__errors).toEqual([]);
});

test('与域包的符号预设一一对应（奇偶校验放在这里做，单测不依赖兄弟仓库）', async ({ page }) => {
  const parity = await page.evaluate(() => {
    const symbols = (window as any).__symbols;
    const presetKinds = Object.keys((window as any).__waterPresets || {});
    return { presetKinds: presetKinds.length, catalog: symbols.total };
  });
  // 域包预设由页面注入（见页面脚本末尾），数量必须与业务目录一致
  expect(parity.presetKinds).toBe(parity.catalog);
  expect(parity.presetKinds).toBe(21);
  expect((page as any).__errors).toEqual([]);
});

test('点选符号：详情面板给出作用 / 设计关注 / 巡检要点', async ({ page }) => {
  const cell = await page.evaluate(() => {
    const cells = (window as any).__symbols.legend.getLayout().cells;
    const target = cells.filter((item: any) => item.kind === 'aerobicTank')[0];
    return { x: target.left + target.width / 2, y: target.top + target.height / 2, kind: target.kind };
  });
  await clickCanvas(page, '#canvas-legend', cell.x, cell.y);

  const detail = page.locator('#symbol-detail');
  await expect(detail).toContainText('好氧池');
  await expect(detail).toContainText('设计关注');
  await expect(detail).toContainText('污泥龄');
  await expect(detail).toContainText('运行巡检要点');
  await expect(page.locator('#statusbar')).toContainText('AE');

  const highlighted = await page.evaluate(() => (window as any).__symbols.legend.getSelected()?.kind);
  expect(highlighted).toBe('aerobicTank');
  expect((page as any).__errors).toEqual([]);
});

test('分类筛选（ice-web-components 分段控件）：切到「泥线」只剩 3 个符号', async ({ page }) => {
  // 分段控件的第 3 档是「泥线」（点档位中心，不是组中心 —— 组中心落在档与档之间的缝隙上）
  // 注意：表达式是**在浏览器里**求值的，必须写纯 JS（不能带 TS 的类型断言）
  await clickCanvasChild(page, '#canvas-symbol-console', 'window.__symbols.consoleUi.ice.childNodes[1]', 2);

  const state = await page.evaluate(() => {
    const cells = (window as any).__symbols.legend.getLayout().cells;
    return { count: cells.length, categories: Array.from(new Set(cells.map((cell: any) => cell.category))) };
  });
  expect(state.count).toBe(3);
  expect(state.categories).toEqual(['sludge']);
  expect((page as any).__errors).toEqual([]);
});

test('画布：图例、构成柱状图都真的画出来了；视口可缩放平移', async ({ page }) => {
  // 图例：21 个格子 + 21 个符号，颜色数应上千
  const legend = await canvasStats(page, '#canvas-legend');
  expect(legend.colors).toBeGreaterThan(60);
  expect(legend.opaqueRatio).toBeGreaterThan(0.1);
  expect(legend.inkRatio).toBeGreaterThan(0.01);

  const mix = await canvasStats(page, '#canvas-symbol-mix');
  expect(mix.colors).toBeGreaterThan(10);
  expect(mix.inkRatio).toBeGreaterThan(0.02);

  const consoleStats = await canvasStats(page, '#canvas-symbol-console');
  expect(consoleStats.width).toBe(390);
  expect(consoleStats.colors).toBeGreaterThan(20);

  await expectViewportInteractions(page, '#canvas-legend', '#btn-reset');
  expect((page as any).__errors).toEqual([]);
});

test('矢量导出：导完画面恢复，SVG 里含位号与符号图形', async ({ page }) => {
  await page.click('#btn-export');
  await page.waitForTimeout(300);
  const svg = await page.evaluate(() => (window as any).__exportedSvg || '');
  expect(svg.length).toBeGreaterThan(2000);
  const restored = await page.evaluate(() => (window as any).__symbols.legend.getLayout().cells.length);
  expect(restored).toBe(21);
  const legend = await canvasStats(page, '#canvas-legend');
  expect(legend.opaqueRatio).toBeGreaterThan(0.1);
  expect((page as any).__errors).toEqual([]);
});
