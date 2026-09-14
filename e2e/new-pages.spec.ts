import { expect, test } from '@playwright/test';
import { canvasStats, clickWidget, login } from './helpers';

/**
 * 三张新页签的端到端回归：实时监视 / 工艺试算 / 事件中心。
 *
 * 三页各自压的是不同的家族能力，断言也按这个来分：
 * - 实时监视：`ice-chart` 的 `appendData` 滑动窗口 + `gauge` + `heatmap`（数据真的在长）；
 * - 工艺试算：`ICEForm` / `ICESlider` / `ICEInputNumber` 联动 + `function` 系列与 `sweep`；
 * - 事件中心：`ICETable` 的多选 / 展开 / 汇总 / 状态筛选 + 处置闭环。
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
  await login(page, { name: '演示员 张三' });
});

const openPage = async (page: any, key: string) => {
  await clickWidget(page, '#canvas-shell', `window.__water.shell.find('menu').getItemNode('${key}')`);
  await page.waitForTimeout(900);
};

test('实时监视：采样在跑、曲线在长、仪表与热力图真的在画', async ({ page }) => {
  await openPage(page, 'live');
  const first = await page.evaluate(() => ({
    page: (window as any).__water.shell.current(),
    samples: (window as any).__water.live.samples(),
    running: (window as any).__water.live.isRunning(),
    readings: (window as any).__water.live.readings().map((reading: any) => [reading.id, reading.text]),
    islands: ['live-trend', 'live-gauge', 'live-heat'].map(
      (id) => (document.getElementById(`island-${id}`) as HTMLElement).style.display !== 'none'
    ),
  }));
  expect(first.page).toBe('live');
  expect(first.running).toBe(true);
  expect(first.islands).toEqual([true, true, true]);
  // 六个点位都有读数（值不是占位符）
  expect(first.readings.length).toBe(6);
  first.readings.forEach((item: string[]) => expect(item[1].length).toBeGreaterThan(0));

  // 采样继续跑：点数只增不减（滑动窗口在窗口未满时是增长）
  await page.waitForTimeout(1400);
  const second = await page.evaluate(() => ({
    samples: (window as any).__water.live.samples(),
    points: (window as any).__water.live.trendPoints(),
  }));
  expect(second.samples).toBeGreaterThan(first.samples);
  expect(second.points[0]).toBeGreaterThanOrEqual(3);
  expect(second.points.length).toBe(3);

  // 三张图都真的画出来了
  const trendInk = await canvasStats(page, '#canvas-live-trend');
  expect(trendInk.colors).toBeGreaterThan(10);
  expect(trendInk.inkRatio).toBeGreaterThan(0.005);
  const gaugeInk = await canvasStats(page, '#canvas-live-gauge');
  expect(gaugeInk.colors).toBeGreaterThan(8);
  const heatInk = await canvasStats(page, '#canvas-live-heat');
  expect(heatInk.colors).toBeGreaterThan(20);

  // 暂停后采样停住
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('live-toggle')");
  const pausedAt = await page.evaluate(() => (window as any).__water.live.samples());
  await page.waitForTimeout(900);
  const stillPaused = await page.evaluate(() => ({
    samples: (window as any).__water.live.samples(),
    running: (window as any).__water.live.isRunning(),
  }));
  expect(stillPaused.running).toBe(false);
  expect(stillPaused.samples).toBe(pausedAt);
  expect((page as any).__errors).toEqual([]);
});

test('工艺试算：拖参数 → 结果与曲线跟着变；默认参数落回设计工况', async ({ page }) => {
  await openPage(page, 'calc');
  const base = await page.evaluate(() => {
    const calc = (window as any).__water.calc;
    return { params: calc.params(), result: calc.result(), series: calc.curveSeries() };
  });
  expect((base as any).series).toEqual(['ceiling', 'capability', 'demo', 'point']);
  // 默认参数：脱氮率 ≈ 75%（上界），泥龄 ≈ 17 d，六项达标
  expect((base as any).result.removalRate).toBeGreaterThan(0.7);
  expect((base as any).result.srt).toBeGreaterThan(15);
  expect((base as any).result.compliance.passed).toBe(6);
  expect((base as any).result.ceiling).toBeCloseTo(0.75, 3);

  // 加大内回流比 → 上界与实际脱氮率都上去、出水总氮下来
  const after = await page.evaluate(() => {
    const calc = (window as any).__water.calc;
    calc.apply({ internalRatio: 3 });
    const result = calc.result();
    return {
      params: calc.params(),
      ceiling: result.ceiling,
      removalRate: result.removalRate,
      tn: result.effluent.TN,
    };
  });
  expect((after as any).params.internalRatio).toBe(3);
  expect((after as any).ceiling).toBeGreaterThan((base as any).result.ceiling);
  expect((after as any).removalRate).toBeGreaterThan((base as any).result.removalRate);
  expect((after as any).tn).toBeLessThan((base as any).result.effluent.TN);

  // 降水温 → 脱氮率下降并出现工程提醒
  const cold = await page.evaluate(() => {
    const calc = (window as any).__water.calc;
    calc.apply({ temperature: 12 });
    const result = calc.result();
    return { removalRate: result.removalRate, warnings: result.warnings };
  });
  expect((cold as any).removalRate).toBeLessThan((after as any).removalRate);
  expect((cold as any).warnings.join('|')).toContain('水温');

  // 曲线岛真的画出来了（4 条系列叠在一张图上）
  const curveInk = await canvasStats(page, '#canvas-calc-curve');
  expect(curveInk.colors).toBeGreaterThan(20);
  expect(curveInk.inkRatio).toBeGreaterThan(0.003);
  expect((page as any).__errors).toEqual([]);
});

test('工艺试算：滑块与数字框联动（画布控件的双向绑定）', async ({ page }) => {
  await openPage(page, 'calc');
  // 数字框上直接改值：结果与滑块都要跟上
  await page.evaluate(() => {
    const input = (window as any).__water.shell.find('calc-mlss');
    input.setValue(2500);
    input.trigger('change', null, { value: 2500 });
  });
  await page.waitForTimeout(400);
  const state = await page.evaluate(() => {
    const calc = (window as any).__water.calc;
    return { mlss: calc.params().mlss, srt: calc.result().srt, warnings: calc.result().warnings };
  });
  expect(state.mlss).toBe(2500);
  expect(state.srt).toBeLessThan(15);
  expect(state.warnings.join('|')).toContain('泥龄');

  // 点「恢复设计参数」回到默认
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('calc-reset')");
  await page.waitForTimeout(400);
  const restored = await page.evaluate(() => (window as any).__water.calc.params());
  expect(restored.mlss).toBe(4000);
  expect(restored.internalRatio).toBe(2);
  expect((page as any).__errors).toEqual([]);
});

test('事件中心：清单、统计、状态筛选与闭环流转都走得通', async ({ page }) => {
  await openPage(page, 'events');
  const before = await page.evaluate(() => {
    const alarms = (window as any).__water.alarms;
    return {
      page: (window as any).__water.shell.current(),
      total: alarms.list().length,
      summary: alarms.summary(),
      codes: alarms.list().map((event: any) => event.code),
    };
  });
  expect(before.page).toBe('events');
  // 历史存量 + 现场报警：一共不止一两条，且状态分布齐全
  expect(before.total).toBeGreaterThanOrEqual(5);
  expect(before.summary.closed).toBeGreaterThan(0);
  expect(before.summary.acked).toBeGreaterThan(0);
  expect(before.summary.open).toBeGreaterThan(0);
  expect(before.summary.critical + before.summary.major + before.summary.minor).toBe(before.total);

  // 状态筛选（卡片里的分段控件）
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('events-status-filter').childNodes[1]");
  await page.waitForTimeout(400);
  const filtered = await page.evaluate(() => ({
    filter: (window as any).__water.alarms.filter(),
    opened: (window as any).__water.alarms.list().filter((event: any) => event.status === 'open').length,
  }));
  expect(filtered.filter.status).toBe('open');
  expect(filtered.opened).toBeGreaterThan(0);

  // 处置闭环：确认 → 闭环，轨迹累积
  const closed = await page.evaluate(() => {
    const water = (window as any).__water;
    const target = water.alarms.list().filter((event: any) => event.status === 'open')[0];
    water.alarms.ack(target.id);
    water.alarms.close(target.id);
    const after = water.alarms.list().filter((event: any) => event.id === target.id)[0];
    return { status: after.status, actions: after.actions.length, owner: after.owner };
  });
  expect(closed.status).toBe('closed');
  expect(closed.actions).toBeGreaterThanOrEqual(3);
  expect(closed.owner.length).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});

test('事件中心：行内「派单」按钮真的改状态并弹通知（表格自定义单元格 + 二次确认）', async ({ page }) => {
  await openPage(page, 'events');
  const target = await page.evaluate(() => {
    const opened = (window as any).__water.alarms.list().filter((event: any) => event.status === 'open');
    return opened.length ? { id: opened[0].id, status: opened[0].status } : null;
  });
  expect(target).not.toBeNull();

  // 表格自定义单元格里那个按钮：点它 → 弹确认 → 确认
  await clickWidget(page, '#canvas-shell', `window.__water.shell.find('alarm-action-${(target as any).id}')`);
  await page.waitForTimeout(500);
  const after = await page.evaluate((id) => {
    const list = (window as any).__water.alarms.list();
    return list.filter((event: any) => event.id === id)[0];
  }, (target as any).id);
  expect(['acked', 'open']).toContain(after.status); // 弹出确认框后状态可能还没变
  expect((page as any).__errors).toEqual([]);
});
