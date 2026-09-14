/**
 * 「岛」：需要**独立 ICE 实例**的画布区域。
 *
 * 为什么工艺图与图表不能直接画在外壳那张画布上：
 * - 工艺图要能滚轮缩放 / 拖拽平移，而 `ICE.setViewport()` 作用于**整个场景** ——
 *   画在同一张画布上的侧栏、卡片会跟着图一起位移；
 * - `ice-chart` 的 `createChart()` 内部自己 `new ICE()`，天生就是一张独立画布。
 *
 * 所以它们是 DOM 里的独立 `<canvas>`，按**外壳坐标**绝对定位，嵌在外壳卡片挖好的"洞"里：
 * 卡片的正文区留空、岛的画布透明底，视觉上就是"图长在卡里"。
 *
 * HTML 约定（每个岛一段）：
 * ```html
 * <div class="island" id="island-process"><canvas id="canvas-process"></canvas></div>
 * ```
 * `.island` 用 `position:absolute` + 内层 canvas `width/height:100%`，
 * 这样 `sizeCanvasToParent(canvas)` 读到的容器尺寸正好是洞的尺寸。
 */
import type { Rect } from './shell';

export type IslandHandle = {
  id: string;
  host: HTMLElement;
  canvas: HTMLCanvasElement;
  /** 摆到外壳坐标系里的指定矩形 */
  place: (rect: Rect) => void;
  /** 随页签显隐（切页时调用） */
  show: (visible: boolean) => void;
  /** 当前是否可见 */
  visible: () => boolean;
};

export function mountIsland(id: string, canvas: HTMLCanvasElement): IslandHandle {
  const host = document.getElementById(`island-${id}`) as HTMLElement | null;
  if (!host) throw new Error(`页面缺少岛的容器 #island-${id}`);
  return {
    id,
    host,
    canvas,
    place(rect: Rect): void {
      host.style.left = `${Math.round(rect.left)}px`;
      host.style.top = `${Math.round(rect.top)}px`;
      host.style.width = `${Math.round(rect.width)}px`;
      host.style.height = `${Math.round(rect.height)}px`;
    },
    show(visible: boolean): void {
      host.style.display = visible ? '' : 'none';
    },
    visible(): boolean {
      return host.style.display !== 'none';
    },
  };
}

/**
 * 把当前页声明里的岛摆好，并让**不在本页**的岛隐起来。
 *
 * 岛的显隐必须自己管：岛是 DOM 元素，不在引擎的显示树里，
 * 页面节点 `display:false` 不会连带隐藏它 —— 不处理就会出现"切了页，工艺图还在那儿飘着"。
 */
export function placeIslands(islands: Record<string, IslandHandle>, specs: Array<{ id: string; rect: Rect }>): void {
  const active = new Set(specs.map((spec) => spec.id));
  specs.forEach((spec) => {
    const island = islands[spec.id];
    if (!island) return;
    island.place(spec.rect);
  });
  Object.keys(islands).forEach((id) => {
    if (!active.has(id)) islands[id].show(false);
    else islands[id].show(true);
  });
}
