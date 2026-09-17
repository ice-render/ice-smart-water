/**
 * 外观主题：**开页装一次；切换是就地热换，不刷新页面**（2026-09-17 起）。
 *
 * ## 热切换为什么现在能成立
 *
 * 以前组件是**构造期**把颜色抄成字面量的（`setTheme()` 只影响之后新建的控件），所以本工程退到过
 * "存偏好 + `location.reload()`" —— 重新构造整棵树，代价是一次刷新。库 **1.15.0** 起两条腿都通了：
 *
 * 1. 组件样式里的颜色是**主题引用**（`token('ui.colors.x')`），引擎在 **paint 时**解析；
 * 2. `iceUIManager.setTheme()` 会**广播到所有登记过的引擎实例**（`applyThemeToIce()` 时登记）。
 *
 * 于是换主题 = 改表 + 标脏 + 下一帧重画。**本仓自己的取色也必须是引用式**
 * （5 处已迁：外壳品牌标题、登录门两处标题、图例强调、两个页面的时间线操作人）——
 * 写死字面量的地方会停在旧主题上，那正是"半新半旧"的来源。
 *
 * ⚠️ 派生色（混色 / 压暗 / alpha）写不成一条引用，将来加进来要挂在
 * `iceUIManager.onThemeChange()` 上重算（库的 `ICEWidget.onThemeChange()` 就是这件事）。
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
import {
  applyThemeToCss,
  applyThemeToEngine,
  iceUIManager,
  type ICEThemeTokens,
} from 'ice-web-components';

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

  applyTheme(name);
  if (new URLSearchParams(search).get('theme') !== null) {
    safeWriteStorage(name);
  }
  return name;
}

/**
 * 把一套主题装上（画布 + DOM 两半一起），**不重新加载**。
 *
 * - 画布那半：`iceUIManager.setTheme()` —— 库 **1.15.0 起会广播到所有登记过的引擎实例**，
 *   而组件样式里的颜色是**主题引用**（`token('ui.colors.x')`，paint 时解析），所以下一帧就是新色，
 *   **不必重建组件树**；
 * - DOM 那半：`applyThemeToCss()` 把同一张 token 表写成 CSS 变量，并保留 `data-theme` 供
 *   开页兜底（刷新时 head 的内联脚本据此先上底色，不闪白）。
 */
function applyTheme(name: ThemeName): void {
  iceUIManager.setTheme(name);
  installed = name;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = name;
    applyThemeToCss(document.documentElement);
  }
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
 * 切换主题：**就地换，不刷新**（2026-09-17 起，库 1.15.x 支持热切换之后）。
 *
 * 做三件事：装主题（画布 + DOM）→ 记住偏好 → 把 `?theme=` 同步进地址栏（`replaceState`，
 * 不产生历史记录、也不触发导航，这样链接分享出去仍然是当前这套主题）。
 *
 * ⚠️ 前提是"界面里没有停在旧主题上的颜色"：
 * - 组件库内部已迁移到引用式取色；
 * - **本仓自己的取色也必须是引用式**（`token('ui.colors.x')`）—— 5 处已迁；
 * - 派生色（混色 / 压暗 / 加透明度）如果将来加进来，要在 `iceUIManager.onThemeChange()` 里重算。
 */
export function switchTheme(next: ThemeName): void {
  safeWriteStorage(next);
  const url = new URL(globalThis.location.href);
  url.searchParams.set('theme', next);
  globalThis.history.replaceState(null, '', url.toString());
  applyTheme(next);
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
