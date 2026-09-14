import { expect, test } from '@playwright/test';
import { clickSubmenu, clickWidget, layoutAudit, login, pageOverflow } from './helpers';

/**
 * 版面体检 + 菜单反馈回归。
 *
 * 这两件事都是**截图看不出来**的问题：
 * - 版面交叠（卡片压卡片、正文压标题、标签溢出到隔壁列）人眼容易当成设计；
 * - 点菜单"没反应"（父项只展开、切工况不换页）在状态里其实变了，界面上却看不出。
 * 所以都用可断言的量来钉：矩形两两比 + 页签/工况真的变了。
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
  await login(page, { name: '体检员' });
});

const PAGES = ['process', 'data', 'live', 'calc', 'events', 'legend'];

test('版面体检：六个页签都没有图元相交、没有图元冲出内容区', async ({ page }) => {
  for (const key of PAGES) {
    await page.evaluate((k) => (window as any).__water.shell.show(k), key);
    await page.waitForTimeout(key === 'live' ? 1200 : 700);
    const audit = await layoutAudit(page);
    expect(audit.page).toBe(key);
    // 体检真的走到了内容（不是"没找到页节点"式的空过）
    expect(audit.nodeCount, `${key} 页体检节点太少，检查脚本本身`).toBeGreaterThan(5);
    expect(audit.hits, `${key} 页有图元相交：\n${audit.hits.join('\n')}`).toEqual([]);
    expect(audit.outside, `${key} 页有图元冲出内容区：\n${audit.outside.join('\n')}`).toEqual([]);
  }
  expect(await pageOverflow(page)).toEqual({ x: 0, y: 0 });
  expect((page as any).__errors).toEqual([]);
});

test('版面体检的自检：故意把一张卡压到另一张上，体检必须抓得住', async ({ page }) => {
  const before = await layoutAudit(page);
  expect(before.hits).toEqual([]);

  // 把「运行控制台」卡挪到「工艺流程」卡上面（模拟一处真实的排版错误）
  await page.evaluate(() => {
    const card = (window as any).__water.shell.find('console-card');
    const graph = (window as any).__water.shell.find('graph-card');
    card.setState({ left: graph.state.left + 40, top: graph.state.top + 40 });
    (window as any).__water.shell.ice.dirty = true;
  });
  await page.waitForTimeout(300);
  const after = await layoutAudit(page);
  expect(after.hits.length).toBeGreaterThan(0);
  expect(after.hits.join('|')).toContain('console-card');
  expect((page as any).__errors).toEqual([]);
});

test('菜单：父项也会跳到对应页 + 提示，二级项切工况后跳到工艺流程图', async ({ page }) => {
  // 点「符号分类」父项：跳到符号库页（原来只是展开，什么都不会变）
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('cats')");
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).__water.shell.current())).toBe('legend');

  // 点「运行工况」父项：跳到工艺流程图
  await clickSubmenu(page, "window.__water.shell.find('menu')", 'mode', 'mode:normal');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__water.shell.current())).toBe('process');

  // 在别的页切工况：切完落到工艺流程图（阀位/指标在那里最直观）
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('events')");
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).__water.shell.current())).toBe('events');

  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('mode:rain')");
  await page.waitForTimeout(700);
  const state = await page.evaluate(() => ({
    page: (window as any).__water.shell.current(),
    mode: (window as any).__water.modeId,
    bypass: (window as any).__water.designer.nodes.filter((node: any) => node.state.id === 'bypassValve')[0].state.valveState,
  }));
  expect(state.page).toBe('process');
  expect(state.mode).toBe('rain');
  expect(state.bypass).toBe('open');

  // 关键回归：雨季超越会产生审计条目（多条、带长数字），这些条目以前因为高度估少而互相压字
  const audit = await layoutAudit(page);
  expect(audit.hits, `切到雨季超越后，工艺流程图页有图元相交：\n${audit.hits.join('\n')}`).toEqual([]);
  expect(audit.outside, `切到雨季超越后，工艺流程图页有图元冲出内容区：\n${audit.outside.join('\n')}`).toEqual([]);
  expect((page as any).__errors).toEqual([]);
});

test('菜单：二级项不再"点了没反应"——每个二级项都有可观测的落点', async ({ page }) => {
  // 符号分类的三个二级项：都要落到符号库页且筛选生效
  for (const [child, expectedFilter] of [
    ['filter:water', 'water'],
    ['filter:equipment', 'equipment'],
    ['filter:all', 'all'],
  ] as Array<[string, string]>) {
    await clickSubmenu(page, "window.__water.shell.find('menu')", 'cats', child);
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => ({
      page: (window as any).__water.shell.current(),
      filter: (window as any).__water.currentFilter(),
      cells: (window as any).__water.legend.getLayout().cells.length,
    }));
    expect(state.page).toBe('legend');
    expect(state.filter).toBe(expectedFilter);
    expect(state.cells).toBeGreaterThan(0);
  }

  // 运行工况的三个二级项：都要切到对应工况（用 clickSubmenu：它会按需展开父项）
  for (const [child, expectedMode] of [
    ['mode:maintenance', 'maintenance'],
    ['mode:normal', 'normal'],
  ] as Array<[string, string]>) {
    await clickSubmenu(page, "window.__water.shell.find('menu')", 'mode', child);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).__water.modeId)).toBe(expectedMode);
  }
  expect((page as any).__errors).toEqual([]);
});

test('版面体检：折叠/展开菜单（行数变化）之后版式依然不交叠', async ({ page }) => {
  // 展开两个父项（菜单变长），再逐页体检一遍
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('mode')");
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('cats')");
  await page.waitForTimeout(500);
  const menu = await page.evaluate(() => ({
    rows: (window as any).__water.shell.find('menu').getVisibleItems().length,
    height: (window as any).__water.shell.find('menu').state.height,
  }));
  expect(menu.rows).toBeGreaterThan(11);

  for (const key of ['process', 'live', 'events']) {
    await page.evaluate((k) => (window as any).__water.shell.show(k), key);
    await page.waitForTimeout(key === 'live' ? 1200 : 700);
    const audit = await layoutAudit(page);
    expect(audit.hits, `${key} 页有图元相交`).toEqual([]);
  }
  // 菜单不能顶到侧栏底部署名上
  const menuBottom = await page.evaluate(() => {
    const menuNode = (window as any).__water.shell.find('menu');
    const footer = (window as any).__water.shell.find('footer-name');
    const world = (n: any) => {
      let l = 0;
      let t = 0;
      let c = n;
      while (c && c.state) {
        l += Number(c.state.left) || 0;
        t += Number(c.state.top) || 0;
        c = c.parentNode;
      }
      return { t, h: Number(n.state.height) || 0 };
    };
    return { menu: world(menuNode), footer: world(footer) };
  });
  expect(menuBottom.menu.t + menuBottom.menu.h).toBeLessThan(menuBottom.footer.t);
  expect((page as any).__errors).toEqual([]);
});


