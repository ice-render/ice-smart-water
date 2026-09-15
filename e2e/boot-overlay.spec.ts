import { expect, test } from '@playwright/test';

/**
 * 启动遮罩（2026-09-15）。
 *
 * 背景：首屏要下载 + 解析 + 执行约 1.4MB 的包，冷启动要好几秒；在此之前画布上**一个像素都画不出来**。
 * 没有遮罩时用户先看到的是 `canvas` 的默认尺寸 300×150 —— 左上角那个突兀的白色圆角矩形
 * （实测 1.6Mbps + 4× CPU 降速：7.5 秒才出登录门）。
 *
 * 这里钉住两条：① 加载期间看到的是遮罩、**看不到裸 canvas**；② 应用就绪后遮罩自己撤下。
 */

test('加载期间：显示遮罩，且看不到裸 canvas（那个 300×150 的矩形）', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));

  // 把 bundle 换成空实现：页面停在"加载中"，但**不是**网络错误（避免"零报错"口径被这条测试污染）
  await page.route('**/app.*.js', (route) =>
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
