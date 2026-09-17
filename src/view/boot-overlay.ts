/**
 * 启动遮罩的收尾（遮罩本体在 `public/index.html`：纯 HTML/CSS，先于任何 JS 显示）。
 *
 * 为什么遮罩必须是 HTML/CSS 而不是画在画布上：登录门这一层就要下载 + 解析 + 执行
 * 约 780KB 的包（引擎 + 组件库，gzip ≈212KB），控制台 chunk 还会并行跟上，
 * **在包跑起来之前，画布上一个像素也画不出来**。所以"加载中"这件事只能由浏览器原生渲染的
 * 那一层来表达（2026-09-17 起图表库已拆成按需 chunk，不在首屏）。
 *
 * 撤下的时机：应用的首帧之后（见 `src/entries/app.ts` 的启动段）。撤下之前
 * `body.is-booting` 会让 `.app` 整个 `visibility: hidden` —— 否则用户会先看到
 * `canvas` 的默认尺寸 300×150（左上角那个白色圆角矩形）。
 */
export function hideBootOverlay(): void {
  const body = typeof document === 'undefined' ? null : document.body;
  if (!body || !body.classList.contains('is-booting')) {
    return; // 幂等：重复调用 / 没有遮罩（例如测试环境）都安全
  }
  body.classList.remove('is-booting');
  const overlay = document.getElementById('boot-overlay');
  if (!overlay) {
    return;
  }
  // 淡出结束后把节点摘掉（用定时器而不是 transitionend：标签页不可见时后者不触发，
  // 节点会一直留在 DOM 里，e2e 里"遮罩已消失"的断言就会假红）
  window.setTimeout(() => overlay.remove(), 400);
}

/**
 * 等**首个可见的引擎实例真正画完一帧**再撤遮罩。
 *
 * 为什么不用"第 N 帧之后"这种固定时机：启动段里 `recompute()`（建 12 个页签的内容）会占住
 * 主线程几百毫秒，而**登录门 / 外壳各自有独立画布**，它们的首帧并不需要等 `recompute` 跑完。
 * 固定时机要么早撤（露出还没画的白页），要么晚撤（本地实测白等 0.7s）。
 * 判据用 `ice.dirty === false` —— 渲染器每跑完一轮都会把它清掉，是可靠的"已上屏一次"信号。
 *
 * 兜底：最多等 60 帧（约 1s）。引擎没起来 / 画布一直不脏时，遮罩不能无限期挂着。
 */
export function hideBootOverlayWhenPainted(ice: any): void {
  let frames = 0;
  const tick = (): void => {
    const painted = !!ice && ice.dirty === false;
    if (painted || frames >= 60) {
      hideBootOverlay();
      return;
    }
    frames += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** 遮罩是否还在（供 e2e 与调试使用）。 */
export function isBootOverlayVisible(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.body.classList.contains('is-booting');
}
