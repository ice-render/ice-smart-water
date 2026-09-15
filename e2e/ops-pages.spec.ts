/**
 * 运营类三个页签（污泥产运 / 设备资产 / 巡检管理）的端到端回归。
 *
 * 三个页面都是「表格 + 一张图（岛）」，所以每页三类断言各来一遍：
 * ① 页签切得过去、岛真的露出来、图画出了墨；② 页面数字与 domain 数据一致；
 * ③ 动作真的改了状态（且整页零 console / pageerror）。
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
  await login(page, { name: '运营员 王五' });
});

test('污泥产运：湿泥量沿流程收缩、联单与统计一致，推进一张后不丢单', async ({ page }) => {
  await openPage(page, 'sludge');
  const before = await page.evaluate(() => {
    const w = (window as any).__water;
    return {
      page: w.shell.current(),
      total: w.sludge.manifests.length,
      counts: w.sludge.statusCounts,
      drySludge: w.sludge.metrics.drySludge,
      stages: w.sludge.stages.map((stage: any) => stage.wetFlow),
      islandVisible: (document.getElementById('island-sludge-flow') as HTMLElement).style.display !== 'none',
    };
  });
  expect(before.page).toBe('sludge');
  expect(before.total).toBeGreaterThan(0);
  expect(before.islandVisible).toBe(true);
  expect(before.drySludge).toBeGreaterThan(0);
  // 干泥守恒 → 湿泥量沿流程单调收缩
  expect(before.stages[0]).toBeGreaterThan(before.stages[1]);
  expect(before.stages[1]).toBeGreaterThan(before.stages[2]);

  const target = await page.evaluate(() => {
    const w = (window as any).__water;
    const item = w.sludge.manifests.filter((m: any) => m.status !== 'closed')[0];
    return item ? item.id : null;
  });
  if (target) {
    await page.evaluate((id: string) => (window as any).__water.sludge.advance(id), target);
    const after = await page.evaluate(() => (window as any).__water.sludge.statusCounts);
    const sum = after.closed + after.signed + after.weighed + after.issued;
    expect(sum).toBe(before.total); // 一张都没丢
    expect(after.closed).toBeGreaterThanOrEqual(before.counts.closed);
  }

  await expectTableFits(page, 'manifest-table');
  const stats = await canvasStats(page, '#canvas-sludge-flow');
  expect(stats.opaqueRatio).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});

test('设备资产：台账与图上单元对应、健康度图有输出，登记维保后到期数下降', async ({ page }) => {
  await openPage(page, 'asset');
  const state = await page.evaluate(() => {
    const w = (window as any).__water;
    return {
      page: w.shell.current(),
      total: w.assets.list.length,
      availability: w.assets.metrics.availability,
      due: w.assets.dueCount,
      islandVisible: (document.getElementById('island-asset-health') as HTMLElement).style.display !== 'none',
    };
  });
  expect(state.page).toBe('asset');
  expect(state.total).toBeGreaterThan(20);
  expect(state.availability).toBeGreaterThan(0);
  expect(state.islandVisible).toBe(true);

  if (state.due > 0) {
    const target = await page.evaluate(() => {
      const w = (window as any).__water;
      const item = w.assets.list.filter((a: any) => a.maintenance.due && !a.maintenance.done)[0];
      return item ? item.id : null;
    });
    if (target) {
      await page.evaluate((id: string) => (window as any).__water.assets.maintain(id), target);
      const dueAfter = await page.evaluate(() => (window as any).__water.assets.dueCount);
      expect(dueAfter).toBe(state.due - 1);
    }
  }

  await expectTableFits(page, 'asset-table');
  const stats = await canvasStats(page, '#canvas-asset-health');
  expect(stats.opaqueRatio).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});

test('巡检管理：三条路线、任务与 KPI 一致，登记隐患后隐患数 +1', async ({ page }) => {
  await openPage(page, 'inspection');
  const before = await page.evaluate(() => {
    const w = (window as any).__water;
    return {
      page: w.shell.current(),
      total: w.inspection.tasks.length,
      hazard: w.inspection.metrics.hazard,
      done: w.inspection.metrics.done,
      routes: w.inspection.routes.routes.length,
      islandVisible: (document.getElementById('island-inspection-route') as HTMLElement).style.display !== 'none',
    };
  });
  expect(before.page).toBe('inspection');
  expect(before.total).toBeGreaterThan(0);
  expect(before.routes).toBe(3);
  expect(before.islandVisible).toBe(true);
  // 三种状态相加等于总数（页面统计与任务列表同源）
  const sums = await page.evaluate(() => {
    const m = (window as any).__water.inspection.metrics;
    return m.done + m.pending + m.missed;
  });
  expect(sums).toBe(before.total);

  const pending = await page.evaluate(() => {
    const w = (window as any).__water;
    const task = w.inspection.tasks.filter((t: any) => t.status === 'pending')[0];
    return task ? task.id : null;
  });
  if (pending) {
    await page.evaluate((id: string) => (window as any).__water.inspection.result(id, 'hazard'), pending);
    const after = await page.evaluate(() => (window as any).__water.inspection.metrics);
    expect(after.hazard).toBe(before.hazard + 1);
    expect(after.done).toBe(before.done + 1);
  }

  await expectTableFits(page, 'inspection-table');
  const stats = await canvasStats(page, '#canvas-inspection-route');
  expect(stats.opaqueRatio).toBeGreaterThan(0);
  expect((page as any).__errors).toEqual([]);
});
