import { expect, test } from '@playwright/test';
import { auditNotesCard, clickCanvas, clickWidget, login } from './helpers';

/**
 * 统一单元选择总线（Plant Selection Bus）的端到端回归。
 *
 * 一件事「选中一个处理单元」同时牵动：工艺图高亮、右侧单元检视面板、事件中心「定位」、
 * 符号库同类型单元联动。本文件守的就是这条联动链：一处选中，处处同步。
 *
 * 选中的锚点走 `__water.selection`（应用层注入的调试入口），断言读 `designer.selectedId`
 * 与 `selection.current` 双路一致 —— 二者不一致就说明总线在某个方向上漏了同步。
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
  await login(page, { name: '联动验证员' });
});

// 画布是整页化的，文字不在 DOM 里、且生产构建会混淆类名，所以从「状态 / 数据」侧断言最稳：
// `__water.selection` 暴露了选中态与检视探针，探针读的是和右侧面板**完全同一份**数据。
function inspectorOf(page: import('@playwright/test').Page, id?: string): Promise<any> {
  return page.evaluate((arg) => {
    const w = (window as any).__water;
    return arg ? w.selection.probe(arg) : w.selection.probe();
  }, id);
}

test('总线选中 → 工艺图高亮 + 右侧单元检视同步', async ({ page }) => {
  // 默认停在工艺流程图页；通过总线选中二沉池（SC-101，该类型有表面负荷 / 停留时间两项设计区间）
  await page.evaluate(() => (window as any).__water.selection.select('sec'));
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => ({
    current: (window as any).__water.selection.current,
    selected: (window as any).__water.designer.selectedId,
  }));
  expect(state.current).toBe('sec');
  expect(state.selected).toBe('sec');

  // 右侧上下文卡切到了单元检视：探针（与面板同源）带出二沉池的位号、名称与运行指标
  const info = await inspectorOf(page);
  expect(info).not.toBeNull();
  expect(info.id).toBe('sec');
  expect(info.tag).toBe('SC-101');
  expect(info.name).toBe('二沉池');
  expect(info.metrics.length).toBeGreaterThan(0);

  // 版面体检：检视内容不溢出卡片正文区（覆盖「右侧面板真的画了东西」的布局回归）
  const problems = await auditNotesCard(page);
  expect(problems).toEqual([]);
  expect((page as any).__errors).toEqual([]);
});

test('事件中心「定位」→ 跳工艺图并选中关联单元（跨视图）', async ({ page }) => {
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('events')");
  await page.waitForTimeout(400);

  // 找一个「单元在图上、且「定位」按钮已渲染」的报警（取第一页第一条即可）
  const target = await page.evaluate(() => {
    const w = (window as any).__water;
    const nodeIds = new Set(w.designer.nodes.map((n: any) => n.state && n.state.id));
    const ev = w.alarms.list().find(
      (a: any) => nodeIds.has(a.unitId) && w.shell.find('alarm-locate-' + a.id)
    );
    return ev ? { id: ev.id, unitId: ev.unitId, unitTag: ev.unitTag } : null;
  });
  expect(target, '应当存在可在工艺图上定位的报警').not.toBeNull();

  await clickWidget(page, '#canvas-shell', `window.__water.shell.find('alarm-locate-${target!.id}')`);
  await page.waitForTimeout(500);

  const after = await page.evaluate(() => ({
    page: (window as any).__water.shell.current(),
    current: (window as any).__water.selection.current,
    selected: (window as any).__water.designer.selectedId,
  }));
  expect(after.page).toBe('process');
  expect(after.current).toBe(target!.unitId);
  expect(after.selected).toBe(target!.unitId);

  // 跨视图联动后，右侧单元检视面板同步显示了被定位的单元
  const info = await inspectorOf(page);
  expect(info).not.toBeNull();
  expect(info.id).toBe(target!.unitId);
  expect(info.tag).toBe(target!.unitTag);
  expect((page as any).__errors).toEqual([]);
});

test('符号库选中符号 → 工艺图上同类型真实单元一并被选中', async ({ page }) => {
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('legend')");
  await page.waitForTimeout(400);

  // 点一个在工艺图上确有实体的符号（曝气沉砂池 → 图上节点 grit）
  const cell = await page.evaluate(() => {
    const cells = (window as any).__water.legend.getLayout().cells;
    const target = cells.filter((c: any) => c.kind === 'gritChamber')[0];
    return { x: target.left + target.width / 2, y: target.top + target.height / 2 };
  });
  await clickCanvas(page, '#canvas-legend', cell.x, cell.y);
  await page.waitForTimeout(400);

  const sel = await page.evaluate(() => ({
    current: (window as any).__water.selection.current,
    selected: (window as any).__water.designer.selectedId,
  }));
  expect(sel.current).toBe('grit');
  expect(sel.selected).toBe('grit');
  expect((page as any).__errors).toEqual([]);
});
