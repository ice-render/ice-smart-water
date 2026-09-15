/**
 * 首屏那一层：登录门（+ 启动遮罩的收尾）。
 *
 * 它是**入口 chunk** 的一部分，所以这里只能依赖"首屏真的需要"的东西：
 * 引擎、组件库、登录门自己。设计师 / 图表 / 各页面模块都在异步的 `./app` 里。
 *
 * 与控制台的接缝只有一个：用户按下"登录"之后要进哪个应用 —— 控制台就绪之前按下的，
 * 先排队（`queued`），`setEnterApp()` 一注册就立刻补进应用，用户不必再点一次。
 */
import { mountLogin, readLoginUser, type LoginHandle } from '../view/login';
import { measureCanvas } from '../view/shell';
import { hideBootOverlayWhenPainted } from '../view/boot-overlay';

const canvas = document.getElementById('canvas-login') as HTMLCanvasElement | null;
if (!canvas) {
  throw new Error('缺少 #canvas-login：登录门挂不上（检查 public/index.html）');
}

let enterAppHandler: ((name: string) => void) | null = null;
const queued: string[] = [];

/** 提交登录（按钮 / Enter / e2e 都走这里）：控制台没就绪就先排队。 */
function dispatchLogin(name: string): void {
  if (enterAppHandler) {
    enterAppHandler(name);
  } else {
    // 控制台还没就绪：先排队，`setEnterApp()` 一注册就立刻补进应用（用户不必再点一次）
    queued.push(name);
  }
}

export const login: LoginHandle = mountLogin({
  canvas,
  size: measureCanvas(),
  onLogin: (user) => dispatchLogin(user.name),
});

/** 控制台就绪时接管登录提交；排队中的提交立刻生效（不用用户再点一次）。 */
export function setEnterApp(handler: (name: string) => void): void {
  enterAppHandler = handler;
  while (queued.length) {
    handler(queued.shift() as string);
  }
}

(window as any).__login = login;

// 没有记住登录态 → 立刻亮登录门，并等它画完一帧再撤启动遮罩。
// （记住登录态的分支不进登录门，遮罩由控制台在外壳画出来之后撤 —— 那种情况本来就要等控制台。）
if (!readLoginUser()) {
  login.show();
  hideBootOverlayWhenPainted(login.ice);
}
