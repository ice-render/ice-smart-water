/**
 * 页面基类与**槽契约**（应用层自己的，不进组件库）。
 *
 * 为什么需要它：页面在组件库里就是**一个容器**（`ICEContainer` 子类），宿主只认几个可选的
 * 只读声明。以前每页是一个 `buildXxxPage(ctx, deps)` 工厂，各自返回一份闭包句柄
 * `{ node, islands, actions, statusTags, refresh }` —— 12 页写 12 份，谁也说不清"一页到底
 * 该长什么样"。现在统一成一个类：
 *
 * - **建树**：构造结束即建好（库的约定），子类在构造末尾完成建树；树只建一次；
 * - **更新**：`onUpdate()` 是唯一改值入口，取代各页自带的 `refresh()` 闭包；
 * - **对外**：`statusTags()` / `islandSpecs()` / `headerActions()` 是声明式只读访问器，
 *   页面不拿宿主闭包、也不回调宿主。
 *
 * 容器本身的契约（能不能嵌套、坐标口径、布局优先）见 ice-web-components
 * `docs/guides/layout.md` 第六节；这里是它在应用层的落地形状。
 */
import { ICEContainer } from 'ice-web-components';
import type { HeaderActionSpec, IslandSpec, PageContext, StatusTagSpec } from './shell';

/**
 * 槽内容契约：页面**自己就是**那个容器。
 *
 * 四个成员全部可选，但要注意它们是**声明**不是回调 —— 宿主在切页 / 刷新时来取一次，
 * 页面不主动推。少一个成员就等于少一项能力，宿主不会因此报错。
 */
export type PageContent = ICEContainer & {
  /** 本页关心的顶栏状态标签 */
  statusTags?: () => StatusTagSpec[];
  /** 本页的岛（DOM 画布）及其位置 */
  islandSpecs?: () => IslandSpec[];
  /** 顶栏上的页级操作按钮 */
  headerActions?: () => HeaderActionSpec[];
  /** 唯一改值入口（应用层约定，不是引擎回调 —— 引擎只回调显隐/尺寸，见库的 `ICEWidget`） */
  onUpdate?: () => void;
};

/**
 * 页面基类：把每页都要重复的构造参数收到一处。
 *
 * `display: false` 是刻意的 —— 显示是**宿主**的决定：宿主切页时给
 * `setState({ display: true })`，页面据此在 `onShow()` 里更新数据。构造期就假设自己可见，
 * 会让"首次显示"变成一个无声事件（切页时页面还停在上一轮数据上）。
 */
export abstract class WaterPage extends ICEContainer {
  /**
   * 宿主上下文（ice / theme / layout / toast / notify）。
   *
   * 名字刻意不叫 `ctx` —— 基类上那个 `ctx` 是引擎的画布 2D 上下文（挂载后才有），
   * 两者同名会撞成编译错误，也容易让读代码的人看错。
   */
  protected readonly pageCtx: PageContext;

  constructor(ctx: PageContext) {
    super({
      left: 0,
      top: 0,
      width: ctx.layout.content.width,
      height: ctx.layout.content.height,
      fill: false,
      stroke: false,
      interactive: false,
      display: false,
    });
    this.pageCtx = ctx;
  }

  /** 唯一改值入口：只改名值 / 换数据，不重建稳定结构。默认空实现，页面按需覆盖。 */
  public onUpdate(): void {}
}
