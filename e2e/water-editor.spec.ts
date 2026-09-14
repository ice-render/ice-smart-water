import { expect, test } from '@playwright/test';
import { canvasStats, clickCanvasChild, expectViewportInteractions } from './helpers';

/**
 * `water-editor.html` 的端到端回归。
 *
 * 覆盖的是这一页的**真价值**：图纸不只是画得出来，而是**画完能算**——
 * 沿程水量与水质、出水达标、能耗、运行审计都跟着图走；工况一换，结论就变。
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  (page as any).__errors = errors;
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/water-editor.html');
  await page.waitForFunction(() => !!(window as any).__water);
  await page.waitForTimeout(300);
});

test('装载：22 个单位 / 24 段管线，图纸校验与运行审计都干净', async ({ page }) => {
  const state = await page.evaluate(() => {
    const water = (window as any).__water;
    return {
      nodes: water.designer.nodes.length,
      edges: water.designer.edges.length,
      kinds: water.designer.nodes.map((node: any) => node.state.kind),
      validate: water.designer.validateWater(),
      issues: water.issues.map((issue: any) => issue.code),
      traceConnected: water.trace.connected,
      tracePath: water.trace.path.length,
    };
  });
  expect(state.nodes).toBe(22);
  expect(state.edges).toBe(24);
  expect(state.kinds).toContain('aerobicTank');
  expect(state.validate).toEqual([]);
  expect(state.issues).toEqual([]);
  expect(state.traceConnected).toBe(true);
  expect(state.tracePath).toBe(16);
  expect((page as any).__errors).toEqual([]);
});

test('运行指标：水量平衡 / 污泥平衡 / 能耗都落在工程常规区间', async ({ page }) => {
  const kpi = await page.evaluate(() => {
    const water = (window as any).__water.kpi;
    return {
      inflow: water.inflow,
      inflowWan: water.inflow / 10000,
      mlss: water.sludge.mlss,
      srt: water.sludge.srt,
      fm: water.sludge.fm,
      hrt: water.sludge.totalHrt,
      waste: water.sludge.wasteSludgeFlow,
      energy: water.energyPerCubicMeter,
      oxygen: water.oxygenDemand,
      effluent: water.effluent,
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

test('图纸即数据源：走界面关掉出水阀 → 断流 + 审计报错 + 看板曲线跟着变', async ({ page }) => {
  const before = await page.evaluate(() => {
    const water = (window as any).__water;
    return {
      connected: water.trace.connected,
      cod: water.dayPoints[12].cod,
      passed: water.kpi.compliance.passed,
      mode: water.modeId,
    };
  });
  expect(before.connected).toBe(true);
  expect(before.passed).toBe(6);

  // 真用户路径：在图上选中出水阀 → 点「阀门开 / 闭」
  await page.evaluate(() => (window as any).__water.designer.select('outletValve'));
  await page.waitForTimeout(150);
  // 属性面板用静态文本显示符号 ID（名称 / 位号是 input 的 value，不是 textContent）
  await expect(page.locator('#property-panel')).toContainText('outletValve');
  await page.click('#btn-valve');
  await page.waitForTimeout(250);

  const after = await page.evaluate(() => {
    const water = (window as any).__water;
    return {
      connected: water.trace.connected,
      blockedAt: water.trace.blockedAt,
      codes: water.issues.map((issue: any) => issue.code),
      passed: water.kpi.compliance.passed,
      valve: water.designer.nodes.filter((node: any) => node.state.id === 'outletValve')[0].state.valveState,
      statusbar: document.getElementById('statusbar')?.textContent || '',
    };
  });
  expect(after.valve).toBe('closed');
  expect(after.connected).toBe(false);
  expect(after.blockedAt).toBe('outletValve');
  expect(after.codes).toContain('flow-disconnected');
  expect(after.codes).toContain('effluent-exceed');
  expect(after.passed).toBeLessThan(6);
  expect(after.statusbar).toContain('断流');

  // 再点一次：阀门回开位，流程恢复（可逆）
  await page.click('#btn-valve');
  await page.waitForTimeout(250);
  const restored = await page.evaluate(() => (window as any).__water.trace.connected);
  expect(restored).toBe(true);
  expect((page as any).__errors).toEqual([]);
});

test('运行控制台（ice-web-components）：点画布上的分段控件切到雨季工况', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__water.modeId);
  expect(before).toBe('normal');

  // 控制台画布上的第 2 个子项 = 单选组的「雨季超越」档（点档位中心，不是组中心）
  // 注意：表达式是**在浏览器里**求值的，必须写纯 JS（不能带 TS 的类型断言）
  await clickCanvasChild(page, '#canvas-console', 'window.__water.consoleUi.ice.childNodes[1]', 1);

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
  // 雨季水量上升 35%：表面负荷与停留时间会顶出设计区间，负荷率也超过规模
  expect(state.codes).toContain('surface-load-out-of-range');
  expect(state.codes).toContain('over-capacity');
  expect(state.passed).toBe(6);
  expect((page as any).__errors).toEqual([]);
});

test('运行看板（ice-chart）与工艺图都真的画出来了', async ({ page }) => {
  // 工艺图：符号 21 种、管线 24 段。采样统计的颜色数门槛按采样率打折 ——
  // 空白画布只有 1~2 种，60 以上就足以说明"真的画了内容"
  const stage = await canvasStats(page, '#canvas-process');
  expect(stage.colors).toBeGreaterThan(60);
  expect(stage.opaqueRatio).toBeGreaterThan(0.02);
  expect(stage.opaqueRatio).toBeLessThan(0.6);
  expect(stage.inkRatio).toBeGreaterThan(0.01);

  // 运行看板：24 点 × 4 条曲线 + 坐标轴/图例
  const board = await canvasStats(page, '#canvas-board');
  expect(board.width).toBeGreaterThan(600);
  expect(board.colors).toBeGreaterThan(20);
  expect(board.inkRatio).toBeGreaterThan(0.02);

  // 运行控制台：4 个控件（单选组 + 两张卡 + 标签）
  const consoleStats = await canvasStats(page, '#canvas-console');
  expect(consoleStats.width).toBe(390);
  expect(consoleStats.colors).toBeGreaterThan(20);
  expect(consoleStats.opaqueRatio).toBeGreaterThan(0.2);
  expect((page as any).__errors).toEqual([]);
});

test('适应视图：整张工艺图落在画布可视区内并留出边距', async ({ page }) => {
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
    const viewport = { ...water.ice.viewport };
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
  // 左右留白大致对称（居中），并且真的缩放过（图比画布宽）
  expect(Math.abs(box.screen.left - (box.canvas.width - box.screen.right))).toBeLessThan(6);
  expect((page as any).__errors).toEqual([]);
});

test('沿程水量表与出水达标表有数据，看板 24 点齐全', async ({ page }) => {
  const rows = await page.locator('#load-table tbody tr').count();
  expect(rows).toBeGreaterThan(15);
  const complianceRows = await page.locator('#compliance-table tbody tr').count();
  expect(complianceRows).toBe(6);
  const points = await page.evaluate(() => (window as any).__water.dayPoints.length);
  expect(points).toBe(24);
  await expect(page.locator('#metric-list')).toContainText('吨水电耗');
  await expect(page.locator('#audit-output')).toContainText('运行审计通过');
  expect((page as any).__errors).toEqual([]);
});

test('画布交互：滚轮缩放、中键拖拽平移、复位回单位视口', async ({ page }) => {
  await expectViewportInteractions(page, '#canvas-process', '#btn-reset');
  expect((page as any).__errors).toEqual([]);
});

test('矢量导出与快照往返：SVG 含位号与管径，JSON 载入后指标一致', async ({ page }) => {
  await page.click('#btn-export-svg');
  await page.click('#btn-export-json');
  const check = await page.evaluate(() => {
    const svg = (window as any).__exportedSvg || '';
    const json = (window as any).__exportedJson || '';
    const before = {
      nodes: (window as any).__water.designer.nodes.length,
      mlss: (window as any).__water.kpi.sludge.mlss,
    };
    const report = (window as any).__water.designer.load(json);
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          resolve({
            svgHasTag: svg.indexOf('AE-101') >= 0,
            svgHasDn: svg.indexOf('DN600') >= 0,
            before,
            loaded: report.nodes,
            after: (window as any).__water.kpi.sludge.mlss,
            validated: (window as any).__water.designer.validateWater().length,
          })
        )
      );
    });
  });
  const data = check as any;
  expect(data.svgHasTag).toBe(true);
  expect(data.svgHasDn).toBe(true);
  expect(data.loaded).toBe(data.before.nodes);
  expect(data.after).toBeCloseTo(data.before.mlss, 1);
  expect(data.validated).toBe(0);
  expect((page as any).__errors).toEqual([]);
});

test('新增符号：位号按同代号顺延，不撞号', async ({ page }) => {
  const before = await page.evaluate(() => (window as any).__water.designer.nodes.length);
  await page.selectOption('#in-kind', 'barScreen');
  await page.click('#btn-add');
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => {
    const water = (window as any).__water;
    const tags = water.designer.nodes.map((node: any) => node.state.tag);
    return {
      nodes: water.designer.nodes.length,
      newTag: water.designer.nodes[water.designer.nodes.length - 1].state.tag,
      duplicate: tags.length !== new Set(tags).size,
      validated: water.designer.validateWater().length,
    };
  });
  expect(after.nodes).toBe(before + 1);
  expect(after.newTag).toBe('GR-102');
  expect(after.duplicate).toBe(false);
  expect((page as any).__errors).toEqual([]);
});
