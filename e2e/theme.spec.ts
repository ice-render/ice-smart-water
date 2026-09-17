import { expect, test, type Page } from '@playwright/test';
import { clickWidget, expectViewportInteractions, login, openPage } from './helpers';

/**
 * 外观主题：**在真实业务系统里到底能不能用**（这是本组用例的要害，不是"有没有开关"）。
 *
 * 背景：组件库的主题是**构造期读一次**（`ice-web-components/docs/guides/theming.md`），
 * 所以本工程的切换 = 记住选择 + 重新加载（见 `src/view/theme.ts`）。要验的是三件事：
 *
 * 1. **整套界面真的换了**，不是只换了几个控件 —— 判据是外壳画布的**平均亮度**与
 *    **纯白像素占比**：暗色下如果还有大片 `#ffffff`，说明某个面板/岛屿漏了（"半新半旧"）。
 * 2. **关键三层各自都跟上了**：DOM 那半（body/画布底色）、画布控件那半（外壳）、
 *    引擎那半（每个 ICE 实例的 theme —— 设计器外壳与图表 `theme:'auto'` 都靠它）。
 * 3. **切换入口与切换之后**：真点侧栏菜单能换、偏好落盘、刷新回来还是暗的、交互照旧。
 *
 * 阈值都来自 2026-09-17 的实测（浅色外壳 luma 249 / 纯白 77%；暗色外壳 luma 48 / 纯白 0%；
 * 暗色登录门 luma 39 / 纯白 0%），留了余量而不是贴着数字写。
 */

interface Ink {
  luma: number;
  whitePct: number;
}

/** 画布上非透明像素的平均亮度，以及"纯白像素"（每个通道 > 250）的百分比。 */
async function canvasInk(page: Page, selector: string): Promise<Ink> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement | null;
    if (!canvas) throw new Error(`找不到画布 ${sel}`);
    const { data } = (canvas.getContext('2d') as CanvasRenderingContext2D).getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );
    let luma = 0;
    let n = 0;
    let white = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue;
      luma += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      n += 1;
      if (data[i] > 250 && data[i + 1] > 250 && data[i + 2] > 250) white += 1;
    }
    return { luma: n ? luma / n : -1, whitePct: n ? (white / n) * 100 : -1 };
  }, selector);
}

/** DOM 那半与引擎那半的读数（两层都要看，缺一层就是"半新半旧"）。 */
async function themeFacts(page: Page) {
  return page.evaluate(() => {
    const water = (window as any).__water;
    const semanticBg = (ice: any) =>
      ice && ice.getTheme ? (ice.getTheme().semantic || {}).background : null;
    return {
      dataTheme: document.documentElement.dataset.theme,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      shellCssBg: getComputedStyle(document.querySelector('#canvas-shell') as Element).backgroundColor,
      loginCssBg: getComputedStyle(document.querySelector('#canvas-login') as Element).backgroundColor,
      graphIceBg: semanticBg(water && water.graphIce),
      shellIceBg: semanticBg(water && water.shell && water.shell.ice),
      loginVisible: !!(window as any).__login && (window as any).__login.visible(),
    };
  });
}

/** 过登录门 + 等外壳画完（每个用例都是新上下文，所以必然先见登录门）。 */
async function enterApp(page: Page): Promise<void> {
  await page.waitForFunction(() => !!(window as any).__water);
  await page.waitForTimeout(300);
  // ⚠️ 幂等：同一个 page 上可能已经登录过（比如切换主题触发了刷新、或同一用例第二次进来）——
  // 那种情况下登录门已经不存在，再调 `login()` 会去点一个看不见的画布（踩过：
  // "点上去应当是 #canvas-login，实际是 canvas-shell"）。
  const gateVisible = await page.evaluate(
    () => !!(window as any).__login && (window as any).__login.visible()
  );
  if (gateVisible) await login(page, { name: '主题用例' });
  await page.waitForTimeout(300);
}

/**
 * 展开侧栏的「界面主题」父项。
 *
 * **必须真点**（走画布坐标，与用户一致）：`ICEMenu` 的 `toggleExpand` 是点击处理，
 * 直接 `node.on('click')` 只是注册监听，不会展开（踩过）。
 */
async function expandThemeMenu(page: Page, menu: string): Promise<void> {
  const expanded = await page.evaluate((expr) => {
    const found = new Function(`return ${expr}`)();
    return !!found.getItemNode('theme:light');
  }, menu);
  if (!expanded) {
    await clickWidget(page, '#canvas-shell', `${menu}.getItemNode('theme')`);
    await page.waitForTimeout(320);
  }
}

/** 读某个子项**画出来的**文案（菜单只建一次，✓ 表示当前主题）。 */
async function themeChildLabel(page: Page, key: string): Promise<string> {
  return page.evaluate((childKey) => {
    const menu = (window as any).__water.shell.find('menu');
    const root = menu.getItemNode(childKey);
    if (!root) return '';
    // `getItemNode` 给的是**行容器**（ICEGroup），文案在子节点上（ICEMenu 内部用 ICELabel 画）。
    // 所以这里把子树里的 `state.text` 收集起来 —— 断言的是"画出来的文案"，不是某个内部字段。
    const texts: string[] = [];
    const walk = (node: any): void => {
      if (!node) return;
      const text = node.state && node.state.text;
      if (typeof text === 'string' && text) texts.push(text);
      (node.childNodes || []).forEach(walk);
    };
    walk(root);
    return texts.join(' ');
  }, key);
}

test.describe('外观主题：真实业务系统里的可用性', () => {
  test('浅色（默认）：外壳亮、白底大片 —— 作为对照基线', async ({ page }) => {
    await page.goto('/');
    await enterApp(page);

    const facts = await themeFacts(page);
    const shell = await canvasInk(page, '#canvas-shell');
    expect(facts.dataTheme).toBe('light');
    expect(facts.bodyBg).toBe('rgb(238, 241, 244)');
    expect(facts.shellCssBg).toBe('rgb(255, 255, 255)');
    expect(shell.luma).toBeGreaterThan(200);
    expect(shell.whitePct).toBeGreaterThan(40);
    // 引擎侧也拿的是浅色 token（applyThemeToEngine 把 surface 映射成 background）
    expect(facts.graphIceBg).toBe('#ffffff');
  });

  test('?theme=dark：DOM 半 + 画布半 + 引擎半都换，且没有"半新半旧"的漏水', async ({ page }) => {
    await page.goto('/?theme=dark');
    await enterApp(page);

    const facts = await themeFacts(page);
    const shell = await canvasInk(page, '#canvas-shell');

    // ① DOM 那半
    expect(facts.dataTheme).toBe('dark');
    expect(facts.bodyBg).toBe('rgb(33, 37, 41)');
    expect(facts.shellCssBg).toBe('rgb(43, 48, 53)');
    // ② 画布控件那半
    expect(shell.luma, '暗色外壳应当明显变暗').toBeLessThan(100);
    // ③ 漏水探测器：暗色下不该还有成片纯白（某个面板/岛屿漏了主题就会飙起来）
    expect(shell.whitePct, '暗色下不应有大片纯白面板').toBeLessThan(2);
    // ④ 引擎那半（设计器外壳 / 图表 auto 都读它）
    expect(facts.graphIceBg).toBe('#2b3035');
    expect(facts.shellIceBg).toBe('#2b3035');
  });

  test('登录门在暗色下也是暗的（主题安装必须早于任何组件构造）', async ({ page }) => {
    await page.goto('/?theme=dark');
    await page.waitForFunction(() => !!(window as any).__login);
    await page.waitForTimeout(700);

    const facts = await themeFacts(page);
    expect(facts.loginVisible).toBe(true);
    expect(facts.loginCssBg).toBe('rgb(43, 48, 53)');
    const gate = await canvasInk(page, '#canvas-login');
    // 登录门的底原来是写死的 #f8fafc（暗色下会是一块白光板）—— 现在取主题 token
    expect(gate.luma).toBeLessThan(100);
    expect(gate.whitePct).toBeLessThan(2);
  });

  test('图表跟着主题走（theme:auto + 引擎实例主题，不是白底黑字）', async ({ page }) => {
    const chartTextColor = async (url: string): Promise<string> => {
      await page.goto(url);
      await enterApp(page);
      await openPage(page, 'data');
      await page.waitForFunction(() => {
        const board = (window as any).__water.board;
        return !!(board && board.ready && board.chart);
      }, undefined, { timeout: 30000 });
      await page.waitForTimeout(600);
      return page.evaluate(() => {
        const chart = (window as any).__water.board.chart;
        return (chart.norm && chart.norm.theme && chart.norm.theme.textColor) || '';
      });
    };

    const light = await chartTextColor('/');
    const dark = await chartTextColor('/?theme=dark');
    expect(light, '浅色图表的文字应当是深色').toMatch(/#(1|2|3)/);
    expect(dark, '暗色图表的文字应当是浅色').toMatch(/#(E|D|C|F)/);
    expect(light).not.toBe(dark);
  });

  test('侧栏「界面主题」能切：**真热换、不刷新** → 落偏好 + 地址栏同步 + ✓ 挪位', async ({ page }) => {
    await page.goto('/');
    await enterApp(page);
    const menu = "window.__water.shell.find('menu')";

    // 浅色时：展开「界面主题」，✓ 应当在「浅色」上
    await expandThemeMenu(page, menu);
    expect(await themeChildLabel(page, 'theme:light')).toContain('✓');
    expect(await themeChildLabel(page, 'theme:dark')).not.toContain('✓');

    /**
     * **不刷新**的判据：先在页面上留一个"页面级"标记 —— 一旦发生导航 / 重载，它会消失。
     * （这条是本轮改造的核心：库 1.15.x 支持热切换之后，"切主题 = 重新加载"的拐杖撤掉了。）
     */
    await page.evaluate(() => {
      (window as any).__noReloadMark = 'keep-me';
    });

    // 真点「深色」→ 就地换主题（画布 + 图表 + DOM 变量）
    await clickWidget(page, '#canvas-shell', `${menu}.getItemNode('theme:dark')`);
    await page.waitForFunction(() => location.search.includes('theme=dark'), undefined, { timeout: 10000 });
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => (window as any).__noReloadMark), '不该发生页面重载').toBe('keep-me');
    expect(await page.evaluate(() => localStorage.getItem('ice-smart-water:theme'))).toBe('dark');
    expect((await canvasInk(page, '#canvas-shell')).luma).toBeLessThan(100);

    // ✓ 挪到「深色」上（菜单不重建，靠 setItemLabel 改文案）
    await expandThemeMenu(page, menu);
    expect(await themeChildLabel(page, 'theme:dark')).toContain('✓');
    expect(await themeChildLabel(page, 'theme:light')).not.toContain('✓');

    // 再切回浅色：同样不刷新，颜色与 ✓ 都回来
    await clickWidget(page, '#canvas-shell', `${menu}.getItemNode('theme:light')`);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).__noReloadMark)).toBe('keep-me');
    expect((await canvasInk(page, '#canvas-shell')).luma).toBeGreaterThan(200);
    await expandThemeMenu(page, menu);
    expect(await themeChildLabel(page, 'theme:light')).toContain('✓');
  });

  test('暗色下交互照旧：切页 + 工艺岛缩放平移 + 全程零报错', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => msg.type() === 'error' && errors.push(msg.text()));
    page.on('pageerror', (err) => errors.push(String(err)));

    await page.goto('/?theme=dark');
    await enterApp(page);

    await openPage(page, 'data');
    await page.waitForTimeout(800);
    await openPage(page, 'process');
    await page.waitForTimeout(800);
    await expectViewportInteractions(page, '#canvas-process', {
      viewportExpr: 'window.__water.graphIce',
      resetExpr: "window.__water.shell.find('action-reset')",
    });

    // 切完页、缩放平移之后仍然暗（整屏没有回到白底），且没有报错
    expect((await canvasInk(page, '#canvas-shell')).luma).toBeLessThan(110);
    expect(errors).toEqual([]);
  });
});
