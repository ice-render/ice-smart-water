/**
 * 启动遮罩的收尾（遮罩本体在 `public/index.html`：纯 HTML/CSS，先于任何 JS 显示）。
 *
 * 为什么遮罩必须是 HTML/CSS 而不是画在画布上：首屏要下载 + 解析 + 执行约 1.4MB 的包
 * （四个家族包内联），**在包跑起来之前，画布上一个像素也画不出来**。所以"加载中"这件事
 * 只能由浏览器原生渲染的那一层来表达。
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

/** 遮罩是否还在（供 e2e 与调试使用）。 */
export function isBootOverlayVisible(): boolean {
  if (typeof document === 'undefined') {
    return false;
  }
  return document.body.classList.contains('is-booting');
}
