import { expect, test } from '@playwright/test';
import { clickWidget } from './helpers';

/**
 * 启动遮罩（2026-09-15）。
 *
 * 背景：首屏要下载 + 解析 + 执行约 1.4MB 的包，冷启动要好几秒；在此之前画布上**一个像素都画不出来**。
 * 没有遮罩时用户先看到的是 `canvas` 的默认尺寸 300×150 —— 左上角那个突兀的白色圆角矩形
 * （实测 1.6Mbps + 4× CPU 降速：7.5 秒才出登录门）。
 *
 * 这里钉住两条：① 加载期间看到的是遮罩、**看不到裸 canvas**；② 应用就绪后遮罩自己撤下。
 */

test('加载期间（入口 chunk 还没跑）：显示遮罩，且看不到裸 canvas（那个 300×150 的矩形）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  // 把**入口 chunk** 换成空实现：页面停在"什么都没跑"的状态，但**不是**网络错误
  // （避免"零报错"口径被这条测试污染）
  await page.route('**/boot.*.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await page.goto('/');
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => {
    const overlay = document.getElementById('boot-overlay');
    const shell = document.getElementById('canvas-shell') as HTMLCanvasElement;
    const spinner = document.querySelector('.boot-spinner') as HTMLElement;
    const overlayStyle = overlay ? getComputedStyle(overlay) : null;
    return {
      booting: document.body.classList.contains('is-booting'),
      overlayVisible: !!overlayStyle && overlayStyle.visibility === 'visible' && Number(overlayStyle.opacity) > 0.9,
      hasTitle: !!overlay && overlay.textContent!.includes('智慧水务运行控制台'),
      hasStatus: !!document.getElementById('boot-status'),
      spinnerAnimated: !!spinner && getComputedStyle(spinner).animationName !== 'none',
      shellVisibility: getComputedStyle(shell).visibility,
      shellBox: { w: Math.round(shell.getBoundingClientRect().width), h: Math.round(shell.getBoundingClientRect().height) },
      // 遮罩不拦点击：加载期间没有可点的东西，拦了反而会挡住 e2e 的画布坐标点击
      overlayPointerEvents: overlayStyle ? overlayStyle.pointerEvents : null,
    };
  });

  expect(state.booting).toBe(true);
  expect(state.overlayVisible).toBe(true);
  expect(state.hasTitle).toBe(true);
  expect(state.hasStatus).toBe(true);
  expect(state.spinnerAnimated).toBe(true);
  expect(state.overlayPointerEvents).toBe('none');
  // 关键：应用（含裸 canvas）在启动期间不可见 —— 用户不会看到那个矩形
  expect(state.shellVisibility).toBe('hidden');
  expect(state.shellBox.w).toBe(300); // canvas 的默认尺寸，正是不藏起来时那个矩形的来源
  expect(errors).toEqual([]);
});

test('代码分割：控制台 chunk 加载不出来时，登录门照样能起来（首屏不依赖它）', async ({ page }) => {
  // 控制台 = 外壳 + 12 个页签 + 设计器 + 图表；它**不该**挡在首屏关键路径上。
  // 把 console chunk 换成空实现：登录门必须仍然可用，而 __water（控制台句柄）不该出现。
  await page.route('**/console.*.js', (route) =>
    route.fulfill({ status: 200, contentType: 'application/javascript', body: '' })
  );
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__login, { timeout: 20000 });
  await page.waitForFunction(
    () => {
      const c = document.getElementById('canvas-login') as HTMLCanvasElement;
      if (!c || !c.width) return false;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let nonWhite = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) nonWhite++;
        if (nonWhite > 2000) return true;
      }
      return false;
    },
    { timeout: 20000 }
  );
  expect(await page.evaluate(() => (window as any).__login.visible())).toBe(true);
  expect(await page.evaluate(() => !!(window as any).__water)).toBe(false);
});

test('应用就绪后：遮罩自己撤下（并已经从 DOM 摘掉）', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__water);
  await expect(page.locator('#boot-overlay')).toBeHidden();
  await expect(page.locator('#boot-overlay')).toHaveCount(0, { timeout: 5000 });
  expect(await page.evaluate(() => document.body.classList.contains('is-booting'))).toBe(false);
  // 就绪之后外壳画布是真的可见的（撤遮罩不能把应用一起藏掉）
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('canvas-shell')!).visibility)).toBe(
    'visible'
  );
});

test('弱网：控制台还没到位就点了"登录"，到货后自动进入应用（不用再点一次）', async ({ page }) => {
  // 把 console chunk 延迟 1.5s 到货，模拟"用户比控制台快"的真实路径
  await page.route('**/console.*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  // 用 commit：默认的 load 会等动态 chunk 下载完，那就不成"控制台还没到位"了
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForFunction(() => !!(window as any).__login);
  // 此刻控制台还没到（__water 不存在），照样把用户名敲进去、点登录
  expect(await page.evaluate(() => !!(window as any).__water)).toBe(false);
  // 用真鼠标 + 真键盘（与 login.spec 同一口径）：点输入框、敲用户名、点登录
  await clickWidget(page, '#canvas-login', "window.__login.find('login-username')");
  await page.keyboard.type('队列用户');
  await clickWidget(page, '#canvas-login', "window.__login.find('login-submit')");

  // 控制台到货后：自动进入应用（登录层收起、__water 出现）
  await page.waitForFunction(() => !(window as any).__login.visible(), { timeout: 20000 });
  expect(await page.evaluate(() => !!(window as any).__water)).toBe(true);
  expect(await page.evaluate(() => (window as any).__water.shell.current())).toBe('process');
});
