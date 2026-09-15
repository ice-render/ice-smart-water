/**
 * 启动入口（webpack entry）。
 *
 * 首屏只做一件事：把**登录门**挂起来（`./login-boot`）。控制台那一大堆东西
 * ——画布外壳 + 12 个页签 + 实体设计器（194KB）+ 图表库（281KB）+ 各页面模块——
 * 交给异步 chunk 去建（`./app`）。
 *
 * 为什么要拆：那些模块在用户还没登录之前**一个都用不上**，却要占住首屏的下载、解析与执行时间。
 * 拆分前是 1.37MB 单文件（gzip 391KB）、全部压在最前面；拆分后首屏只剩引擎 + 组件库 + 登录门，
 * 控制台 chunk 在登录门画出来之后才开始加载（用户此时正在看/输入登录表单）。
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
