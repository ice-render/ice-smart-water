/**
 * 启动入口（webpack entry）。
 *
 * 首屏只做一件事：把**登录门**挂起来（`./login-boot`）。控制台那一大堆东西
 * ——画布外壳 + 12 个页签 + 实体设计器（194KB）+ 图表库（281KB）+ 各页面模块——
 * 交给异步 chunk 去建（`./app`）。
 *
 * 为什么要拆：那些模块在用户还没登录之前**一个都用不上**，却要占住首屏的下载、解析与执行时间。
 * 拆分前是 1.37MB 单文件（gzip 391KB）、全部压在最前面；拆分后首屏只剩引擎 + 组件库 + 登录门。
 *
 * **并行下载**（2026-09-17 补）：动态 import 只能等本 chunk 执行完才发请求 —— 慢网（Slow 4G +
 * 4x CPU、冷缓存）实测 boot.js 下载 341→1532ms，控制台 chunk 1664ms 才发出、外壳首帧被推到 3792ms，
 * 两段下载完全**串行**。现在由 HtmlWebpackPlugin 在**构建期**把带哈希的
 * `<link rel="preload" as="script" href="console.<hash>.js">` 写进 HTML（见 `public/index.html` 顶部），
 * 浏览器解析 HTML 时就开始并行下载，两段重叠 → 复访路径的外壳首帧提前约 1s。
 * 用 preload 而不是 prefetch：这条 import 在启动时无条件执行、一定会用到；
 * 而运行期 `webpackPrefetch` 注释同样是"等 boot.js 执行时才注入 link"，解决不了串行。
 *
 * 注意：登录门**不依赖**控制台 —— `mountLogin` 只需要画布尺寸（`measureCanvas()`），
 * 原先那行 `size: layout.canvas` 里的 `layout` 就是外壳的同一份测量结果。
 */
import './login-boot';

void import(/* webpackChunkName: "console" */ './app').catch((err) => {
  // 控制台 chunk 加载失败（弱网 / 部署缺文件）：别让遮罩永远转下去
  console.error('[ice-smart-water] 控制台模块加载失败：', err);
  const status = document.getElementById('boot-status');
  if (status) {
    status.textContent = '应用加载失败，请刷新重试。';
  }
});
