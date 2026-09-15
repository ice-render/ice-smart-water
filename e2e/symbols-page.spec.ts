import { expect, test } from '@playwright/test';
import { canvasStats, clickCanvas, clickSubmenu, clickWidget, expectViewportInteractions, login, openPage } from './helpers';

/**
 * 符号库页（`index.html` 壳里的第三个页签）的端到端回归。
 *
 * 整个系统只有一个 HTML：符号库不再是独立页面，而是外壳里的一个页签
 * —— 所以这里要先"切到符号库页"，其余断言与页面无关的（侧栏菜单、画布控件）
 * 都仍然按坐标点，走真实交互。
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  (page as any).__errors = errors;
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__water);
  await page.waitForTimeout(400);
  // 每个用例都是新上下文：sessionStorage 空的，所以先过登录门（走真实输入路径）
  await login(page, { name: '演示员 张三' });
  // 单页应用：进应用后停在「工艺流程图」，先切到符号库页签（两级导航：域 → 页签）
  await openPage(page, 'legend');
});

test('图例：31 种符号全部渲染，分类计数 12 / 4 / 13 / 2', async ({ page }) => {
  const state = await page.evaluate(() => {
    const symbols = (window as any).__water;
    return {
      total: symbols.symbolTotal,
      stats: symbols.symbolStats.map((item: any) => [item.id, item.count]),
      cells: symbols.legend.getLayout().cells.length,
    };
  });
  expect(state.total).toBe(31);
  expect(state.cells).toBe(31);
  expect(state.stats).toEqual([
    ['water', 12],
    ['sludge', 4],
    ['equipment', 13],
    ['boundary', 2],
  ]);
  expect((page as any).__errors).toEqual([]);
});

test('与域包的符号预设一一对应（奇偶校验放在这里做，单测不依赖兄弟仓库）', async ({ page }) => {
  const parity = await page.evaluate(() => {
    const symbols = (window as any).__water;
    return { presets: Object.keys(symbols.presets || {}).length, catalog: symbols.symbolTotal };
  });
  expect(parity.presets).toBe(31);
  expect(parity.catalog).toBe(parity.presets);
  expect((page as any).__errors).toEqual([]);
});

test('点图例里的符号：点亮该格并带出业务语义（作用 / 设计关注 / 巡检要点）', async ({ page }) => {
  const cell = await page.evaluate(() => {
    const cells = (window as any).__water.legend.getLayout().cells;
    const target = cells.filter((item: any) => item.kind === 'aerobicTank')[0];
    return { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  });
  await clickCanvas(page, '#canvas-legend', cell.x, cell.y);

  const state = await page.evaluate(() => {
    const symbols = (window as any).__water;
    const selected = symbols.selectedSymbol();
    return {
      kind: selected && selected.kind,
      highlighted: symbols.legend.getSelected() && symbols.legend.getSelected().kind,
      role: selected && selected.role,
      focus: selected ? selected.designFocus.length : 0,
      checks: selected ? selected.checks.length : 0,
    };
  });
  expect(state.kind).toBe('aerobicTank');
  expect(state.highlighted).toBe('aerobicTank');
  expect(state.role).toContain('硝化');
  expect(state.focus).toBeGreaterThan(0);
  expect(state.checks).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});

test('侧栏分类菜单（画布控件）：点「污泥线单元」只剩 4 个符号', async ({ page }) => {
  await clickSubmenu(page, "window.__water.shell.find('menu')", 'cats', 'filter:sludge');
  const state = await page.evaluate(() => {
    const cells = (window as any).__water.legend.getLayout().cells;
    return {
      count: cells.length,
      categories: Array.from(new Set(cells.map((cell: any) => cell.category))),
      filter: (window as any).__water.currentFilter(),
    };
  });
  expect(state.filter).toBe('sludge');
  expect(state.count).toBe(4);
  expect(state.categories).toEqual(['sludge']);
  expect((page as any).__errors).toEqual([]);
});

test('卡片里的分段控件（画布控件）：切到「设备」只剩 13 个符号', async ({ page }) => {
  // ICESegmented 的每一档是一个按钮子节点；第 4 档是「设备」（全部/水线/泥线/设备/边界）
  // 注意：表达式在浏览器里求值，必须写纯 JS
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('symbol-filter').childNodes[3]");
  const state = await page.evaluate(() => {
    const cells = (window as any).__water.legend.getLayout().cells;
    return { count: cells.length, filter: (window as any).__water.currentFilter() };
  });
  expect(state.filter).toBe('equipment');
  expect(state.count).toBe(13);
  expect((page as any).__errors).toEqual([]);
});

test('顶栏「导出 SVG」：导出后画面恢复，SVG 里有符号图形', async ({ page }) => {
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('action-svg')");
  const svg = await page.evaluate(() => (window as any).__exportedSvg || '');
  expect(svg.length).toBeGreaterThan(2000);
  const cells = await page.evaluate(() => (window as any).__water.legend.getLayout().cells.length);
  expect(cells).toBe(31);
  expect((page as any).__errors).toEqual([]);
});

test('图例视口与像素：滚轮缩放 / 拖拽平移 / 复位，画面真的画出来了', async ({ page }) => {
  const ink = await canvasStats(page, '#canvas-legend');
  expect(ink.colors).toBeGreaterThan(60);
  expect(ink.opaqueRatio).toBeGreaterThan(0.05);
  expect(ink.inkRatio).toBeGreaterThan(0.01);

  const shellInk = await canvasStats(page, '#canvas-shell');
  expect(shellInk.colors).toBeGreaterThan(30);
  expect(shellInk.opaqueRatio).toBeGreaterThan(0.5);

  await expectViewportInteractions(page, '#canvas-legend', {
    viewportExpr: 'window.__water.legendIce',
    resetExpr: "window.__water.shell.find('action-reset')",
  });
  expect((page as any).__errors).toEqual([]);
});
