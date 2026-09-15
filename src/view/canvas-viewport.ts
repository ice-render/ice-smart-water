/**
 * 画布视口交互：铺满容器 + 滚轮锚点缩放 + 拖拽平移。
 *
 * 三件事全部复用引擎原语，应用层不自己造轮子：
 * 1. `sizeCanvasToParent()`：把 canvas 的像素尺寸对齐它的容器。**必须先做这一步** ——
 *    引擎的 `fitViewport()` / `hitTest()` 都是按 `canvas.width/height` 算的，
 *    尺寸不跟容器走，图会跑到屏幕外（老示例页就踩过这个坑）。
 * 2. `ice.zoomAt(x, y, factor, min, max)`：以光标为锚点缩放（引擎内部反解平移并钳制 scale）。
 * 3. `ice.setViewport(scale, tx, ty)`：拖拽平移。空白处左键 / 任意位置中键才是平移，
 *    图元上的左键留给引擎做选择与拖拽 —— 否则用户拖不动任何东西。
 */
export type ViewportOptions = {
  /** 引擎实例（`ICE`） */
  ice: any;
  canvas: HTMLCanvasElement;
  /** 有 `fitViewport` 的对象（设计器）；给了就自动接上"适应视图" */
  designer?: { fitViewport?: (padding?: number) => void } | null;
  /** 容器，默认取 canvas 的父元素 */
  wrapper?: HTMLElement | null;
  minScale?: number;
  maxScale?: number;
  /** 适应视图时四周留白 */
  padding?: number;
  /** 自定义"适应视图"（例如 ICEChart 用自己的 resize 逻辑） */
  fit?: () => void;
};

export type ViewportHandle = {
  /** 重新把 canvas 对齐容器（容器尺寸变了要调一次） */
  sizeCanvas: () => void;
  fitViewport: () => void;
  reset: () => void;
  dispose: () => void;
};

/**
 * 把 canvas 的像素尺寸与 CSS 尺寸都对齐到容器，并同步回引擎。
 *
 * 尺寸契约**整体交给引擎**：`ICE.fitCanvasToDisplaySize()`（ice-render 2.12.0 起新增）
 * 负责 backing store × dpr、CSS 尺寸、`canvasWidth/Height`，以及命中矩形与内容盒的同步。
 *
 * 此前这里是手写的：直接给 `ice.canvasWidth/canvasHeight` 赋值、再手动刷一次矩形 ——
 * 等于从外面改引擎的内部状态，而命中测试正是按这两个值算的。同样的逻辑 ice-chart 那边
 * 也手写了一遍（而且用的是 border-box，画布带边框时会偏），两处都踩过坑。
 * 现在只有一份实现，这里只负责"尺寸从哪个容器量"这一件应用层的事。
 *
 * 注意：本函数在 dpr=1 且画布无边框时与旧实现**数值等价**，是消除手写内部状态的重构，
 * 不是行为修复。它的价值在于——以后谁把这个应用切到 HiDPI，不会再出现
 * "引擎以为自己在 2× 渲染、画布却被写回 1×" 的静默错位。
 *
 * 返回容器测得的 CSS 尺寸（尺寸为 0 时原样返回 0，交给引擎退回画布自身尺寸）。
 */
export function sizeCanvasToParent(canvas: HTMLCanvasElement, ice: any): { width: number; height: number } {
  const wrapper = canvas.parentElement;
  if (!wrapper) return { width: canvas.width, height: canvas.height };
  // 不再 `Math.max(1, …)`：容器尺寸为 0（页签隐藏 / 布局未就绪）时，引擎会退回画布自身的
  // 显示尺寸并报告"未变化"，不会像旧实现那样先把画布写成 1×1、显示出来再重排一次。
  const width = Math.round(wrapper.clientWidth);
  const height = Math.round(wrapper.clientHeight);
  ice.fitCanvasToDisplaySize(width, height);
  return { width, height };
}

export function installViewport(options: ViewportOptions): ViewportHandle {
  const ice = options.ice;
  const canvas = options.canvas;
  const designer = options.designer || null;
  const fit = options.fit;
  const minScale = options.minScale === undefined ? 0.2 : options.minScale;
  const maxScale = options.maxScale === undefined ? 3 : options.maxScale;
  const padding = options.padding === undefined ? 48 : options.padding;

  function sizeCanvas(): void {
    sizeCanvasToParent(canvas, ice);
  }

  function fitViewport(): void {
    if (typeof fit === 'function') {
      fit();
      return;
    }
    if (designer && typeof designer.fitViewport === 'function') {
      designer.fitViewport(padding);
    }
  }

  function reset(): void {
    ice.setViewport(1, 0, 0);
  }

  function onWheel(event: WheelEvent): void {
    event.preventDefault();
    ice.zoomAt(event.offsetX, event.offsetY, event.deltaY > 0 ? 1 / 1.1 : 1.1, minScale, maxScale);
  }

  let panning = false;
  let lastX = 0;
  let lastY = 0;

  function onMouseDown(event: MouseEvent): void {
    const onBlank = event.button === 0 && !ice.hitTest(event.offsetX, event.offsetY);
    if (event.button !== 1 && !onBlank) return;
    event.preventDefault();
    event.stopPropagation();
    panning = true;
    lastX = event.offsetX;
    lastY = event.offsetY;
    canvas.style.cursor = 'grabbing';
  }

  function onMouseMove(event: MouseEvent): void {
    if (!panning) return;
    ice.setViewport(
      ice.viewport.scale,
      ice.viewport.tx + (event.offsetX - lastX),
      ice.viewport.ty + (event.offsetY - lastY)
    );
    lastX = event.offsetX;
    lastY = event.offsetY;
  }

  function stopPan(): void {
    if (!panning) return;
    panning = false;
    canvas.style.cursor = 'grab';
  }

  function onAuxClick(event: MouseEvent): void {
    if (event.button === 1) event.preventDefault();
  }

  let resizeTimer: any = null;
  function onResize(): void {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      sizeCanvas();
      fitViewport();
    }, 150);
  }

  sizeCanvas();
  canvas.style.cursor = 'grab';
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseMove);
  canvas.addEventListener('mouseup', stopPan);
  canvas.addEventListener('mouseleave', stopPan);
  canvas.addEventListener('auxclick', onAuxClick);
  window.addEventListener('resize', onResize);

  return {
    sizeCanvas,
    fitViewport,
    reset,
    dispose(): void {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('mousedown', onMouseDown);
      canvas.removeEventListener('mousemove', onMouseMove);
      canvas.removeEventListener('mouseup', stopPan);
      canvas.removeEventListener('mouseleave', stopPan);
      canvas.removeEventListener('auxclick', onAuxClick);
      window.removeEventListener('resize', onResize);
      if (resizeTimer) clearTimeout(resizeTimer);
    },
  };
}
