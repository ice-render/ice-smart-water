import { expect, test } from '@playwright/test';
import { canvasStats, clickWidget, expectLoginCovers, login } from './helpers';

/**
 * 登录门（`water-editor.html` / `water-symbols.html` 共用同一套）。
 *
 * 登录页是**画布覆盖层**：盖在外壳与岛之上，输入走的是 `ICETextField` / `ICEPasswordField`
 * （聚焦时挂原生 input 替身）。所以这里验三件事：盖得住、点得动 / 打得进去、进得去也退得出来。
 */

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  (page as any).__errors = errors;
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
});

test('首屏停在登录页：盖住应用，应用控件点不到', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__login);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__login.visible())).toBe(true);
  await expectLoginCovers(page);
  // 侧栏（264 宽）与顶栏位置也被盖住
  await expectLoginCovers(page, 120, 300);
  await expectLoginCovers(page, 800, 40);

  // 登录页自己真的画出来了
  const ink = await canvasStats(page, '#canvas-login');
  expect(ink.colors).toBeGreaterThan(30);
  expect(ink.opaqueRatio).toBeGreaterThan(0.9); // 不透明底色，底下透不出来

  // 登录卡里的控件都在（按 id 找得到）
  const found = await page.evaluate(() =>
    ['login-card', 'login-username', 'login-password', 'login-submit', 'login-alert'].map(
      (id) => !!(window as any).__login.find(id)
    )
  );
  expect(found).toEqual([true, true, true, true, true]);
  expect((page as any).__errors).toEqual([]);
});

test('用户名空着点登录：停在登录页并给出提示；一开始输入提示就撤掉', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__login);
  await page.waitForTimeout(500);

  await clickWidget(page, '#canvas-login', "window.__login.find('login-submit')");
  const after = await page.evaluate(() => ({ visible: (window as any).__login.visible(), ...(window as any).__login.state() }));
  expect(after.visible).toBe(true);
  expect(after.error).toContain('请先输入用户名');

  await clickWidget(page, '#canvas-login', "window.__login.find('login-username')");
  await page.keyboard.type('张');
  const typing = await page.evaluate(() => (window as any).__login.state());
  expect(typing.name).toBe('张');
  expect(typing.error).toBe('');
  expect((page as any).__errors).toEqual([]);
});

test('输入任意内容 → 进入应用，用户名带到侧栏署名；退出登录能回到登录页', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__login);
  await page.waitForTimeout(500);

  await login(page, { name: 'Felix 水务', password: 'whatever' });

  const entered = await page.evaluate(() => {
    const find = (node: any, id: string): any => {
      if (!node) return null;
      if (node.state && node.state.id === id) return node;
      for (const child of node.childNodes || []) {
        const hit = find(child, id);
        if (hit) return hit;
      }
      return null;
    };
    const water = (window as any).__water;
    return {
      loginVisible: (window as any).__login.visible(),
      footerName: find(water.shell.ice, 'footer-name').getText(),
      avatar: find(water.shell.ice, 'footer-avatar').getText(),
      stored: JSON.parse(window.sessionStorage.getItem('ice-smart-water.user') || '{}'),
      under: document.elementFromPoint(700, 300).id,
    };
  });
  expect(entered.loginVisible).toBe(false);
  expect(entered.footerName).toBe('Felix 水务');
  expect(entered.avatar).toBe('F');
  expect(entered.stored.name).toBe('Felix 水务');
  // 登录层隐藏后，应用接管这块区域
  expect(entered.under).toBe('canvas-process');

  // 退出登录：回登录页 + 清掉登录态
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('logout')");
  const afterLogout = await page.evaluate(() => ({
    loginVisible: (window as any).__login.visible(),
    stored: window.sessionStorage.getItem('ice-smart-water.user'),
    state: (window as any).__login.state(),
  }));
  expect(afterLogout.loginVisible).toBe(true);
  expect(afterLogout.stored).toBeNull();
  expect(afterLogout.state.name).toBe(''); // 表单已清空
  await expectLoginCovers(page);
  expect((page as any).__errors).toEqual([]);
});

test('登录态存 sessionStorage：同一标签页刷新不用重登', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__login);
  await page.waitForTimeout(400);
  await login(page, { name: '刷新人' });

  await page.reload();
  await page.waitForFunction(() => !!(window as any).__water && !!(window as any).__login);
  await page.waitForTimeout(600);
  const state = await page.evaluate(() => {
    const find = (node: any, id: string): any => {
      if (!node) return null;
      if (node.state && node.state.id === id) return node;
      for (const child of node.childNodes || []) {
        const hit = find(child, id);
        if (hit) return hit;
      }
      return null;
    };
    const water = (window as any).__water;
    return {
      loginVisible: (window as any).__login.visible(),
      footerName: find(water.shell.ice, 'footer-name').getText(),
    };
  });
  expect(state.loginVisible).toBe(false);
  expect(state.footerName).toBe('刷新人');
  expect((page as any).__errors).toEqual([]);
});

test('整个系统只有一个 HTML：登录门之后是同一个壳，符号库是壳里的页签', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__login);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__login.visible())).toBe(true);
  await expectLoginCovers(page);

  await login(page, { name: '符号员' });
  const entered = await page.evaluate(() => ({
    loginVisible: (window as any).__login.visible(),
    total: (window as any).__water.symbolTotal,
    page: (window as any).__water.shell.current(),
    under: document.elementFromPoint(700, 300).id,
    canvases: Array.from(document.querySelectorAll('canvas')).map((c) => c.id),
  }));
  expect(entered.loginVisible).toBe(false);
  expect(entered.total).toBe(31);
  expect(entered.page).toBe('process');
  expect(entered.under).toBe('canvas-process');
  // 一张外壳画布 + 一张登录层 + 七个岛画布，全部在同一个 HTML 里
  expect(entered.canvases.sort()).toEqual(
    [
      'canvas-shell',
      'canvas-login',
      'canvas-process',
      'canvas-board',
      'canvas-legend',
      'canvas-live-trend',
      'canvas-live-gauge',
      'canvas-live-heat',
      'canvas-calc-curve',
    ].sort()
  );

  // 切到符号库页签，图例岛接管那块区域
  await clickWidget(page, '#canvas-shell', "window.__water.shell.find('menu').getItemNode('legend')");
  await page.waitForTimeout(400);
  const legend = await page.evaluate(() => ({
    page: (window as any).__water.shell.current(),
    under: document.elementFromPoint(700, 300).id,
    cells: (window as any).__water.legend.getLayout().cells.length,
  }));
  expect(legend.page).toBe('legend');
  expect(legend.under).toBe('canvas-legend');
  expect(legend.cells).toBe(31);
  expect((page as any).__errors).toEqual([]);
});
