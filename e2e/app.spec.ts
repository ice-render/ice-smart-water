import { expect, test } from '@playwright/test';
import {
  canvasStats,
  clickSubmenu,
  clickWidget,
  expectLoginCovers,
  expectViewportInteractions,
  islandRect,
  login,
  openPage,
  widgetWorldRect,
} from './helpers';

/**
 * `water-editor.html` 的端到端回归。
 *
 * 这一页是**整页画布化**的 admin console（对齐 ice-web-components 的 examples/admin.html）：
 * 界面里几乎没有可选择的 DOM —— 侧栏菜单、顶栏按钮、卡片里的操作都得按画布坐标点。
 * 所以这里既验证业务（图 → 算 → 面板），也验证"画布控件真的点得动"。
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
});

test('装载：外壳铺满画布，工艺图 34 个单位 / 37 段管线（含信号与动力线），图纸校验与运行审计都干净', async ({ page }) => {
  const state = await page.evaluate(() => {
    const water = (window as any).__water;
    return {
      canvas: [water.graphIce.canvasWidth, water.graphIce.canvasHeight],
      shellCanvas: [(window as any).__water.shell.ice.canvasWidth, (window as any).__water.shell.ice.canvasHeight],
      nodes: water.designer.nodes.length,
      edges: water.designer.edges.length,
      validate: water.designer.validateWater(),
      issues: water.issues.map((issue: any) => issue.code),
      traceConnected: water.trace.connected,
      tracePath: water.trace.path.length,
      currentPage: water.shell.current(),
    };
  });
  expect(state.shellCanvas[0]).toBeGreaterThan(1400);
  expect(state.nodes).toBe(34); // 22 个原单元 + 12 个新增（自控阀门 / 在线仪表 / 事故支路 / 除臭 / 料仓…）
  expect(state.edges).toBe(37); // 34 条工艺管线 + 3 条信号/动力线
  expect(state.validate).toEqual([]);
  expect(state.issues).toEqual([]);
  expect(state.traceConnected).toBe(true);
  expect(state.tracePath).toBe(17); // 主流程 + 出水止回阀
  expect(state.currentPage).toBe('process');
  expect((page as any).__errors).toEqual([]);
});

test('岛：工艺图挖在「工艺流程」卡片的正文区里，且真的画出来了', async ({ page }) => {
  // 关键不变量：洞就在卡片里 —— 岛画的矩形 = 卡片矩形 + 卡片正文内缩
  const card = await widgetWorldRect(page, "window.__water.shell.find('graph-card')");
  const hole = await islandRect(page, 'process');
  expect(hole.left).toBeCloseTo(card.left + 16, 0);
  expect(hole.top).toBeCloseTo(card.top + 44, 0);
  expect(hole.width).toBeCloseTo(card.width - 32, 0);
  expect(hole.height).toBeCloseTo(card.height - 60, 0);

  // 卡片必须落在内容区里（不能压到侧栏或顶栏上）
  const content = await page.evaluate(() => (window as any).__water.layout.content);
  expect(card.left).toBeGreaterThanOrEqual(content.left);
  expect(card.top).toBeGreaterThanOrEqual(content.top);
  expect(card.left + card.width).toBeLessThanOrEqual(content.left + content.width);
  expect(card.top + card.height).toBeLessThanOrEqual(content.top + content.height);

  // 另两个岛不在本页，必须藏起来（单页三岛：藏不好就会"飘"在别的页签上）
  const othersHidden = await page.evaluate(() =>
    ['island-board', 'island-legend'].map(
      (id) => (document.getElementById(id) as HTMLElement).style.display === 'none'
    )
  );
  expect(othersHidden).toEqual([true, true]);

  const ink = await canvasStats(page, '#canvas-process');
  expect(ink.colors).toBeGreaterThan(60);
  expect(ink.opaqueRatio).toBeGreaterThan(0.02);
  expect(ink.inkRatio).toBeGreaterThan(0.01);
  expect((page as any).__errors).toEqual([]);
});

test('运行指标：水量平衡 / 污泥平衡 / 能耗都落在工程常规区间', async ({ page }) => {
  const kpi = await page.evaluate(() => {
    const water = (window as any).__water.kpi;
    return {
      inflow: water.inflow,
      mlss: water.sludge.mlss,
      srt: water.sludge.srt,
      fm: water.sludge.fm,
      hrt: water.sludge.totalHrt,
      waste: water.sludge.wasteSludgeFlow,
      energy: water.energyPerCubicMeter,
      oxygen: water.oxygenDemand,
      passed: water.compliance.passed,
      tightest: water.compliance.tightest.label,
    };
  });
  expect(kpi.inflow).toBe(100000);
  expect(kpi.mlss).toBeGreaterThan(3500);
  expect(kpi.mlss).toBeLessThan(4500);
  expect(kpi.srt).toBeGreaterThan(12);
  expect(kpi.srt).toBeLessThan(25);
  expect(kpi.fm).toBeGreaterThan(0.05);
  expect(kpi.fm).toBeLessThan(0.15);
  expect(kpi.hrt).toBeGreaterThan(6);
  expect(kpi.waste).toBeGreaterThan(500);
  expect(kpi.energy).toBeGreaterThan(0.2);
  expect(kpi.energy).toBeLessThan(0.35);
  expect(kpi.oxygen).toBeGreaterThan(20000);
  expect(kpi.passed).toBe(6);
  // 一级 A 里最难的是总氮 —— 模型也算出来了
  expect(kpi.tightest).toBe('总氮');
  expect((page as any).__errors).toEqual([]);
});

test('按需加载：图表库不进首屏 —— 默认页不建图，切到图表页才建', async ({ page }) => {
  // ① 首屏是「工艺流程图」，一个图表都不用：图表实例**没有被创建**（图表库是动态 import 的）
  expect(await page.evaluate(() => (window as any).__water.charts.boardReady())).toBe(false);

  // ② 控制台 chunk 的体积预算（**按原始字节**，与是否 gzip 无关）：图表库（281KB）拆成了独立 chunk。
  //    拆开前 ≈612KB、拆开后 ≈352KB —— 预算 450KB 能在"图表库又被塞回控制台 chunk"时报红，
  //    同时给正常增长留余量。GitHub Pages 会 gzip（线上实测 104KB），只会更小。
  const chunks = await page.evaluate(() =>
    (performance.getEntriesByType('resource') as PerformanceResourceTiming[])
      .filter((r) => /\.js$/.test(r.name))
      .map((r) => ({ name: r.name.split('/').pop() as string, kb: Math.round(((r.encodedBodySize || 0) / 1024) * 10) / 10 }))
  );
  const consoleChunk = chunks.filter((c) => /^console\./.test(c.name))[0];
  expect(consoleChunk, '应该能观测到控制台 chunk').toBeTruthy();
  expect(consoleChunk.kb, `控制台 chunk 不该含图表库（当前 ${consoleChunk.kb}KB）`).toBeLessThan(450);
  // 图表库必须是**独立 chunk**：登录后空闲预取会把它取回来（等它出现，最多 10s）
  await page.waitForFunction(() => performance.getEntriesByType('resource').some((r) => /chart\.[a-f0-9]+\.js$/.test(r.name)), null, {
    timeout: 10000,
  });

  // ③ 切到图表页 → 图表这时才被创建，并且真的画出来了
  await openPage(page, 'data');
  await page.waitForFunction(() => (window as any).__water.charts.boardReady(), null, { timeout: 15000 });
  const ink = await canvasStats(page, '#canvas-board');
  expect(ink.inkRatio).toBeGreaterThan(0.02);
  expect((page as any).__errors).toEqual([]);
});

test('侧栏菜单（画布控件）：点「运行数据」切页，看板岛出现并画出 24 点曲线', async ({ page }) => {
  await openPage(page, 'data');
  // 图表库是**按需加载**的（281KB，首屏「工艺流程图」用不到）：切到图表页之后要等它就绪，
  // 不能假设 `board.chart` 同步存在 —— 慢网下建图要等一次动态 import。
  await page.waitForFunction(() => !!(window as any).__water?.charts?.boardReady(), null, { timeout: 15000 });
  const state = await page.evaluate(() => {
    const water = (window as any).__water;
    const chart = water.board.chart;
    return {
      page: water.shell.current(),
      boardVisible: (document.querySelector('#island-board') as HTMLElement).style.display !== 'none',
      processHidden: (document.querySelector('#island-process') as HTMLElement).style.display === 'none',
      points: chart.norm.series.map((series: any) => (series.points || []).length),
      seriesCount: chart.seriesComponents.length,
      plotWidth: Math.round(chart.layout.plot.width),
      loadRows: water.hydraulics.filter((unit: any) => unit.flow > 0 || unit.power > 0).length,
    };
  });
  expect(state.page).toBe('data');
  expect(state.boardVisible).toBe(true);
  expect(state.processHidden).toBe(true);
  expect(state.seriesCount).toBe(4);
  expect(state.points).toEqual([24, 24, 24, 24]);
  expect(state.plotWidth).toBeGreaterThan(800);
  expect(state.loadRows).toBeGreaterThan(15);

  const chartInk = await canvasStats(page, '#canvas-board');
  expect(chartInk.width).toBeGreaterThan(800);
  expect(chartInk.inkRatio).toBeGreaterThan(0.02);
  expect((page as any).__errors).toEqual([]);
});

test('侧栏二级菜单：点「运行工况 → 雨季超越」切工况，指标与审计跟着变', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__water.modeId);
  expect(before).toBe('normal');

  await clickSubmenu(page, "window.__water.shell.find('menu')", 'mode', 'mode:rain');
  const state = await page.evaluate(() => {
    const water = (window as any).__water;
    return {
      mode: water.modeId,
      inflow: water.kpi.inflow,
      utilization: water.kpi.utilization,
      codes: water.issues.map((issue: any) => issue.code),
      bypass: water.designer.nodes.filter((node: any) => node.state.id === 'bypassValve')[0].state.valveState,
      passed: water.kpi.compliance.passed,
    };
  });
  expect(state.mode).toBe('rain');
  expect(state.inflow).toBe(135000);
  expect(state.utilization).toBe(135);
  expect(state.bypass).toBe('open');
  // 雨季水量上升 35%：表面负荷顶出设计区间，负荷率也超过规模
  expect(state.codes).toContain('surface-load-out-of-range');
  expect(state.codes).toContain('over-capacity');
  expect(state.passed).toBe(6);
  expect((page as any).__errors).toEqual([]);
});

test('顶栏按钮（画布控件）：点「导出 SVG」真的导出了含位号的矢量图', async ({ page }) => {
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('action-svg')");
  const svg = await page.evaluate(() => (window as any).__exportedSvg || '');
  expect(svg.length).toBeGreaterThan(2000);
  expect(svg).toContain('AE-101');
  expect(svg).toContain('DN600');
  expect((page as any).__errors).toEqual([]);
});

test('卡片里的操作按钮：选中出水阀 → 点「阀门开 / 闭」→ 断流 + 审计报错（可逆）', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__water.trace.connected);
  expect(before).toBe(true);

  // 注意：必须用**块体**回调。`designer.select()` 是链式 API，返回 designer 自身，
  // 而它的对象图（场景树 + 引擎 + 各种管理器）太深，Playwright 把它序列化回 Node 时会报
  // "Cannot serialize result: object reference chain is too long"。
  // 这里只要副作用，所以让回调不返回值。
  await page.evaluate(() => {
    (window as any).__water.designer.select('outletValve');
  });
  await page.waitForTimeout(150);
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('card-action-valve')");

  const after = await page.evaluate(() => {
    const water = (window as any).__water;
    return {
      connected: water.trace.connected,
      blockedAt: water.trace.blockedAt,
      codes: water.issues.map((issue: any) => issue.code),
      passed: water.kpi.compliance.passed,
      valve: water.designer.nodes.filter((node: any) => node.state.id === 'outletValve')[0].state.valveState,
    };
  });
  expect(after.valve).toBe('closed');
  expect(after.connected).toBe(false);
  expect(after.blockedAt).toBe('outletValve');
  expect(after.codes).toContain('flow-disconnected');
  expect(after.codes).toContain('effluent-exceed');
  expect(after.passed).toBeLessThan(6);

  // 再点一次：阀门回开位，流程恢复
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('card-action-valve')");
  const restored = await page.evaluate(() => (window as any).__water.trace.connected);
  expect(restored).toBe(true);
  expect((page as any).__errors).toEqual([]);
});

test('工艺图岛的视口交互：滚轮缩放、中键拖拽平移、顶栏「复位视图」回单位视口', async ({ page }) => {
  await expectViewportInteractions(page, '#canvas-process', {
    viewportExpr: 'window.__water.graphIce',
    resetExpr: "window.__water.shell.find('action-reset')",
  });
  expect((page as any).__errors).toEqual([]);
});

test('外壳与岛都真的画出来了（像素判定）', async ({ page }) => {
  const shellStats = await canvasStats(page, '#canvas-shell');
  expect(shellStats.colors).toBeGreaterThan(30);
  expect(shellStats.opaqueRatio).toBeGreaterThan(0.5); // 外壳底色铺满
  expect(shellStats.inkRatio).toBeGreaterThan(0.01);

  const processStats = await canvasStats(page, '#canvas-process');
  expect(processStats.colors).toBeGreaterThan(60);
  expect(processStats.opaqueRatio).toBeLessThan(0.6); // 图不该糊满整块

  // 页面不该被挤出滚动条（画布尺寸扣掉了 body 的 24px 内边距）
  const overflow = await page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
  expect(overflow.x).toBeLessThanOrEqual(0);
  expect(overflow.y).toBeLessThanOrEqual(0);
  expect((page as any).__errors).toEqual([]);
});

test('适应视图：整张工艺图落在岛的可视区内并居中', async ({ page }) => {
  const box = await page.evaluate(() => {
    const water = (window as any).__water;
    const canvas = document.querySelector('#canvas-process') as HTMLCanvasElement;
    const nodes = water.designer.nodes.map((node: any) => ({
      left: node.state.left,
      top: node.state.top,
      width: node.state.width,
      height: node.state.height,
    }));
    const world = {
      left: Math.min(...nodes.map((node: any) => node.left)),
      right: Math.max(...nodes.map((node: any) => node.left + node.width)),
      top: Math.min(...nodes.map((node: any) => node.top)),
      bottom: Math.max(...nodes.map((node: any) => node.top + node.height)),
    };
    const viewport = { ...water.graphIce.viewport };
    return {
      canvas: { width: canvas.width, height: canvas.height },
      screen: {
        left: world.left * viewport.scale + viewport.tx,
        right: world.right * viewport.scale + viewport.tx,
        top: world.top * viewport.scale + viewport.ty,
        bottom: world.bottom * viewport.scale + viewport.ty,
      },
    };
  });
  expect(box.screen.left).toBeGreaterThanOrEqual(0);
  expect(box.screen.top).toBeGreaterThanOrEqual(0);
  expect(box.screen.right).toBeLessThanOrEqual(box.canvas.width);
  expect(box.screen.bottom).toBeLessThanOrEqual(box.canvas.height);
  expect(Math.abs(box.screen.left - (box.canvas.width - box.screen.right))).toBeLessThan(6);
  expect((page as any).__errors).toEqual([]);
});

test('快照往返：导出 JSON 再导入，指标与图纸校验一致', async ({ page }) => {
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('action-json')");
  await page.waitForTimeout(200);
  const check = await page.evaluate(() => {
    const water = (window as any).__water;
    const json = (window as any).__exportedJson || '';
    const before = { nodes: water.designer.nodes.length, mlss: water.kpi.sludge.mlss };
    const report = water.designer.load(json);
    return { before, loaded: report.nodes, json };
  });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => {
    const water = (window as any).__water;
    return { mlss: water.kpi.sludge.mlss, validated: water.designer.validateWater().length };
  });
  expect((check as any).json.length).toBeGreaterThan(500);
  expect((check as any).loaded).toBe((check as any).before.nodes);
  expect(after.mlss).toBeCloseTo((check as any).before.mlss, 1);
  expect(after.validated).toBe(0);
  expect((page as any).__errors).toEqual([]);
});
