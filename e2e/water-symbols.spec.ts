import { expect, test } from '@playwright/test';
import { canvasStats, clickCanvas, clickSubmenu, clickWidget, expectViewportInteractions, login } from './helpers';

/**
 * `water-symbols.html` 的端到端回归。
 *
 * 同样是整页画布化的 admin console：侧栏分类菜单、顶栏按钮、画布上的分段控件全都要按坐标点。
 * 这一页把**图形**（域包的记法）与**业务语义**（本仓符号目录）拼在一起，
 * 所以断言既看"图例画全了 21 种"，也看"点一个符号能带出它的作用 / 设计关注 / 巡检要点"。
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
  await page.waitForTimeout(400);
  // 每个用例都是新上下文：sessionStorage 空的，所以先过登录门（走真实输入路径）
  await login(page, { name: '演示员 张三' });
});

test('图例：21 种符号全部渲染，分类计数 10 / 3 / 6 / 2', async ({ page }) => {
  const state = await page.evaluate(() => {
    const symbols = (window as any).__symbols;
    return {
      total: symbols.total,
      stats: symbols.stats.map((item: any) => [item.id, item.count]),
      cells: symbols.legend.getLayout().cells.length,
    };
  });
  expect(state.total).toBe(21);
  expect(state.cells).toBe(21);
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
    return { presets: Object.keys(symbols.presets || {}).length, catalog: symbols.total };
  });
  expect(parity.presets).toBe(21);
  expect(parity.catalog).toBe(parity.presets);
  expect((page as any).__errors).toEqual([]);
});

test('点图例里的符号：点亮该格并带出业务语义（作用 / 设计关注 / 巡检要点）', async ({ page }) => {
  const cell = await page.evaluate(() => {
    const cells = (window as any).__symbols.legend.getLayout().cells;
    const target = cells.filter((item: any) => item.kind === 'aerobicTank')[0];
    return { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  });
  await clickCanvas(page, '#canvas-legend', cell.x, cell.y);

  const state = await page.evaluate(() => {
    const symbols = (window as any).__symbols;
    const selected = symbols.selected();
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

test('侧栏分类菜单（画布控件）：点「污泥线单元」只剩 3 个符号', async ({ page }) => {
  await clickSubmenu(page, "window.__symbols.shell.find('menu')", 'cats', 'filter:sludge');
  const state = await page.evaluate(() => {
    const cells = (window as any).__symbols.legend.getLayout().cells;
    return {
      count: cells.length,
      categories: Array.from(new Set(cells.map((cell: any) => cell.category))),
      filter: (window as any).__symbols.currentFilter(),
    };
  });
  expect(state.filter).toBe('sludge');
  expect(state.count).toBe(3);
  expect(state.categories).toEqual(['sludge']);
  expect((page as any).__errors).toEqual([]);
});

test('卡片里的分段控件（画布控件）：切到「设备」只剩 6 个符号', async ({ page }) => {
  // ICESegmented 的每一档是一个按钮子节点；第 4 档是「设备」（全部/水线/泥线/设备/边界）
  // 注意：表达式在浏览器里求值，必须写纯 JS
  await clickWidget(page, '#canvas-shell', "window.__symbols.shell.find('symbol-filter').childNodes[3]");
  const state = await page.evaluate(() => {
    const cells = (window as any).__symbols.legend.getLayout().cells;
    return { count: cells.length, filter: (window as any).__symbols.currentFilter() };
  });
  expect(state.filter).toBe('equipment');
  expect(state.count).toBe(6);
  expect((page as any).__errors).toEqual([]);
});

test('顶栏「导出 SVG」：导出后画面恢复，SVG 里有符号图形', async ({ page }) => {
  await clickWidget(page, '#canvas-shell', "window.__symbols.shell.find('action-svg')");
  const svg = await page.evaluate(() => (window as any).__exportedSvg || '');
  expect(svg.length).toBeGreaterThan(2000);
  const cells = await page.evaluate(() => (window as any).__symbols.legend.getLayout().cells.length);
  expect(cells).toBe(21);
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
    viewportExpr: 'window.__symbols.ice',
    resetExpr: "window.__symbols.shell.find('action-reset')",
  });
  expect((page as any).__errors).toEqual([]);
});
