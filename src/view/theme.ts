/**
 * 外观主题：**开页读一次、装一次；切换 = 记住选择 + 重新加载**。
 *
 * ## 为什么不做"热切换"
 *
 * 组件库的主题是**构造期读一次**（见 `ice-web-components/docs/guides/theming.md`）：
 * `iceUIManager.setTheme()` 只影响**之后**新建的控件。而本工程界面几乎全是构造期取色的控件
 * —— 外壳（`shell.ts`）、12 个页面、卡片、表格、分段控件、菜单…… 热切换的结果是
 * **半新半旧**：换过的控件变深，没换的还是白的。那比"不支持切换"更糟（用户会以为界面坏了）。
 *
 * 所以这里的做法是：**切换 = 写偏好 + `location.reload()`** —— 重新构造整棵树，
 * 每一层都拿到新主题。代价是一次刷新（本工程首屏本来就有一层遮罩，观感可接受）。
 *
 * ⚠️ 引擎那一层其实**能**热换：`applyThemeToEngine(ice)` 会 `setTheme` + 置脏重绘，
 * 而 `ice-chart` 的 `theme: 'auto'` 还会订阅引擎主题变化自己重画。控件层不行 ——
 * 界面必须是整体一致的，所以两者不能各切各的。
 *
 * ## 两级优先（与 `ice-agent-console` 同一口径）
 *
 * `?theme=dark`（显式，且会写回 localStorage，方便分享链接）→ localStorage → 默认 `light`。
 * 非法值**落回默认而不是报错**：主题是观感选项，手抖打错一个参数不该让页面白屏。
 *
 * ## DOM 那半
 *
 * 启动遮罩是纯 HTML/CSS（先于任何 JS 出现），它的底色不能等 JS ——
 * `public/index.html` 的 head 里有一段**同样优先级**的内联脚本，先给
 * `<html data-theme>` 打上标记，CSS 据此换底色。两处必须同一个 key、同一套解析，
 * 所以 `tests/view/theme.test.ts` 会读 index.html 把它们钉在一起（漂了会红）。
 */
import { applyThemeToEngine, iceUIManager, type ICEThemeTokens } from 'ice-web-components';

export type ThemeName = 'light' | 'dark';

/** localStorage 的键。**必须与 `public/index.html` 的 head 内联脚本一致**（单测钉住）。 */
export const THEME_STORAGE_KEY = 'ice-smart-water:theme';

/** 默认主题。 */
export const DEFAULT_THEME: ThemeName = 'light';

const isThemeName = (value: unknown): value is ThemeName => value === 'light' || value === 'dark';

/** 当前生效的主题（安装之后才是准的）。 */
let installed: ThemeName = DEFAULT_THEME;

/**
 * 这次开页该用哪套主题。**纯函数**（search / stored 都从外面传），所以优先级能被穷举测掉。
 */
export function resolveThemeName(search: string, stored: string | null): ThemeName {
  const wanted = new URLSearchParams(search).get('theme');
  if (isThemeName(wanted)) return wanted;
  if (isThemeName(stored)) return stored;
  return DEFAULT_THEME;
}

/** 当前主题名。 */
export function themeName(): ThemeName {
  return installed;
}

/** 当前主题的 token（画布里的控件与 DOM 共用同一份）。 */
export function themeTokens(): ICEThemeTokens {
  return iceUIManager.getTheme();
}

/**
 * 安装主题：**必须在任何组件构造之前调用**（`src/entries/login-boot.ts` 的第一行）。
 *
 * 光调 `setTheme` 不够，还得：
 * - 把 `<html data-theme>` 写上 —— DOM 那半（启动遮罩）靠它换底色；
 * - 把显式传进来的 `?theme=` 写回 localStorage —— 否则分享出去的 `?theme=dark` 链接
 *   只在这一次生效，下次裸链又回到浅色，用户会以为"选了不记住"。
 */
export function installTheme(): ThemeName {
  const search = globalThis.location?.search ?? '';
  const stored = safeReadStorage();
  const name = resolveThemeName(search, stored);

  iceUIManager.setTheme(name);
  installed = name;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = name;
  }
  if (new URLSearchParams(search).get('theme') !== null) {
    safeWriteStorage(name);
  }
  return name;
}

/**
 * 把当前主题打到某个引擎实例上：语义色 + 交互外壳（选中框 / 手柄 / 插槽 / 对齐引导线 /
 * 阴影 / **画布底色**）。
 *
 * 每个 `new ICE()` 都要自己调一次 —— 本工程有 6+ 个实例（外壳、登录门、两个设计器岛、
 * 覆盖画布、每张图表）。漏掉哪个，那个画布就会留在默认主题上。
 */
export function applyThemeToIce(ice: any): void {
  if (!ice) return;
  applyThemeToEngine(ice, themeTokens());
}

/**
 * 切换主题：写偏好 + 重新加载（见文件头"为什么不做热切换"）。
 *
 * 用 `reload()` 而不是自己拆树重建：本工程的装配是模块级脚本（`entries/app.ts`），
 * 没有 teardown 路径；为了切主题去加一套"拆干净再重建"的机制，风险和收益不成比例。
 */
export function switchTheme(next: ThemeName): void {
  safeWriteStorage(next);
  const url = new URL(globalThis.location.href);
  url.searchParams.set('theme', next);
  globalThis.location.replace(url.toString());
}

/** localStorage 在隐私模式 / 沙箱里可能直接抛异常，读写成"尽力而为"。 */
function safeReadStorage(): string | null {
  try {
    return globalThis.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

function safeWriteStorage(name: ThemeName): void {
  try {
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, name);
  } catch {
    /* 存不了就算了：这次切换仍然生效 */
  }
}
