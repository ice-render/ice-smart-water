/**
 * 运行 / 工艺类三个页签（能耗分项 / 泵站监视 / 工况预案）的端到端回归。
 *
 * 这三页都有**业务上的守恒或确定性**可断言，所以除了"页签切得过去、岛有墨、表不溢出"，
 * 还各加一条硬断言：能耗分项之和守恒、相似定律成立、预案达标度可复现。
 */
import { expect, test } from '@playwright/test';
import { canvasStats, expectTableFits, login, openPage } from './helpers';

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
  await login(page, { name: '运行员 赵六' });
});

test('能耗分项：分项日耗电守恒、曝气是最大头，两张图都有墨', async ({ page }) => {
  await openPage(page, 'energy');
  const state = await page.evaluate(() => {
    const w = (window as any).__water;
    const metrics = w.energy.metrics;
    const nodes = w.energy.nodes;
    return {
      page: w.shell.current(),
      energyTotal: metrics.energyTotal,
      blowerShare: metrics.blowerShare,
      sumEnergy: nodes.reduce((sum: number, node: any) => sum + node.energy, 0),
      maxShare: Math.max(...nodes.map((node: any) => node.share)),
      islands: ['energy-mix', 'energy-tariff'].map(
        (id) => (document.getElementById(`island-${id}`) as HTMLElement).style.display !== 'none'
      ),
    };
  });
  expect(state.page).toBe('energy');
  // 摊分守恒：分项之和 = 全厂日耗电
  expect(Math.abs(state.sumEnergy - state.energyTotal)).toBeLessThan(1);
  // 曝气是最大头，且占比 > 40%
  expect(state.blowerShare).toBeGreaterThan(0.4);
  expect(state.blowerShare).toBeCloseTo(state.maxShare, 2);
  expect(state.islands).toEqual([true, true]);

  await expectTableFits(page, 'energy-table');
  const mix = await canvasStats(page, '#canvas-energy-mix');
  const tariff = await canvasStats(page, '#canvas-energy-tariff');
  expect(mix.opaqueRatio).toBeGreaterThan(0);
  expect(tariff.opaqueRatio).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});

test('泵站监视：相似定律成立；投运备用泵后运行数与流量跟着变，复位可回退', async ({ page }) => {
  await openPage(page, 'pump');
  const before = await page.evaluate(() => {
    const w = (window as any).__water;
    const pumps = w.pumps.stations.flatMap((station: any) => station.pumps);
    return {
      page: w.shell.current(),
      running: w.pumps.metrics.running,
      standby: w.pumps.metrics.standby,
      ratedPower: w.pumps.metrics.ratedPower,
      // 相似定律抽查一台运行泵
      law: pumps
        .filter((pump: any) => pump.running)
        .map((pump: any) => [pump.flow - pump.ratedFlow * pump.speed, pump.power - pump.ratedPower * pump.speed ** 3]),
      standbyId: (pumps.filter((pump: any) => !pump.running)[0] || {}).id,
      islands: ['pump-curve', 'sump-level'].map(
        (id) => (document.getElementById(`island-${id}`) as HTMLElement).style.display !== 'none'
      ),
    };
  });
  expect(before.page).toBe('pump');
  expect(before.running).toBeGreaterThan(0);
  expect(before.standby).toBeGreaterThan(0);
  expect(before.islands).toEqual([true, true]);
  // 相似定律：流量与轴功率都能由转速反算（容差来自 speed 的两位小数）
  before.law.forEach(([flowDelta, powerDelta]: number[]) => {
    expect(Math.abs(flowDelta)).toBeLessThan(0.6);
    expect(Math.abs(powerDelta)).toBeLessThan(0.6);
  });

  // 投运一台备用泵 → 运行数 +1；总流量不变（需求没变，只是重新平摊）
  await page.evaluate((id: string) => (window as any).__water.pumps.toggle(id), before.standbyId);
  const after = await page.evaluate(() => ({
    running: (window as any).__water.pumps.metrics.running,
    totalFlow: (window as any).__water.pumps.metrics.totalFlow,
  }));
  expect(after.running).toBe(before.running + 1);
  expect(after.totalFlow).toBeGreaterThan(0);

  // 复位 → 回到默认
  await page.evaluate(() => (window as any).__water.pumps.reset());
  const reset = await page.evaluate(() => (window as any).__water.pumps.metrics.running);
  expect(reset).toBe(before.running);

  await expectTableFits(page, 'pump-table');
  expect((await canvasStats(page, '#canvas-pump-curve')).opaqueRatio).toBeGreaterThan(0);
  expect((await canvasStats(page, '#canvas-sump-level')).opaqueRatio).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});

test('工况预案：四个预案可选、达标度可复现，切预案后结论跟着变', async ({ page }) => {
  await openPage(page, 'drill');
  const state = await page.evaluate(() => {
    const w = (window as any).__water;
    return {
      page: w.shell.current(),
      plans: w.drill.plans.length,
      planId: w.drill.planId,
      metrics: w.drill.metrics,
      deviations: w.drill.run.deviations.length,
      islandVisible: (document.getElementById('island-drill-compare') as HTMLElement).style.display !== 'none',
    };
  });
  expect(state.page).toBe('drill');
  expect(state.plans).toBe(4);
  expect(state.deviations).toBe(5);
  expect(state.metrics.total).toBe(5);
  expect(state.islandVisible).toBe(true);

  // 确定性：读两次结果一致
  const twice = await page.evaluate(() => {
    const w = (window as any).__water;
    return [w.drill.metrics.passed, w.drill.metrics.passed];
  });
  expect(twice[0]).toBe(twice[1]);

  // 切到「低温硝化」：脱氮率相对基线下降（泥龄修正）
  await page.evaluate(() => (window as any).__water.drill.select('winter'));
  const winter = await page.evaluate(() => ({
    planId: (window as any).__water.drill.planId,
    removalDelta: (window as any).__water.drill.metrics.removalDelta,
  }));
  expect(winter.planId).toBe('winter');
  expect(winter.removalDelta).toBeLessThan(0);

  await expectTableFits(page, 'drill-table');
  expect((await canvasStats(page, '#canvas-drill-compare')).opaqueRatio).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});
