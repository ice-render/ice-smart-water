/**
 * `sizeCanvasToParent`：应用只负责"尺寸从哪个容器量"，应用交给引擎。
 *
 * 这个函数以前自己写 `canvas.width/height`、再手写 `ice.canvasWidth/canvasHeight`
 * 加手动刷矩形 —— 等于从外面改引擎的内部状态，而命中测试正是按那两个值算的。
 * 现在它只量容器，然后把尺寸转交给 `ICE.fitCanvasToDisplaySize()`（ice-render 2.12.0 起）。
 *
 * 用假对象测、不起 DOM：被测的就是"量容器 + 转交"这一段。
 */
import { sizeCanvasToParent } from '../../src/view/canvas-viewport';

function fakeIce() {
  const calls: Array<[number, number]> = [];
  return {
    calls,
    fitCanvasToDisplaySize(width: number, height: number): boolean {
      calls.push([width, height]);
      return true;
    },
  };
}

function fakeCanvas(clientWidth: number | null, clientHeight: number | null) {
  return {
    width: 300,
    height: 150,
    style: {} as Record<string, string>,
    parentElement: clientWidth === null ? null : { clientWidth, clientHeight },
  } as any;
}

describe('sizeCanvasToParent', () => {
  it('把容器尺寸转交给引擎，不再自己碰画布尺寸与引擎内部状态', () => {
    const ice = fakeIce();
    const canvas = fakeCanvas(800, 600);

    const size = sizeCanvasToParent(canvas, ice);

    expect(size).toEqual({ width: 800, height: 600 });
    expect(ice.calls).toEqual([[800, 600]]);
    // 关键：画布自身的尺寸与样式都不再被这里改写
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    expect(canvas.style.width).toBeUndefined();
  });

  it('小数尺寸四舍五入后再转交', () => {
    const ice = fakeIce();
    sizeCanvasToParent(fakeCanvas(800.6, 599.4), ice);

    expect(ice.calls).toEqual([[801, 599]]);
  });

  it('容器尺寸为 0 时原样转交 —— 不写成 1×1（旧实现的抖动源）', () => {
    // 页签隐藏 / 布局未就绪时父容器是 0。旧实现 max(1, 0) 会把画布写成 1×1，
    // 显示出来再重排一次；现在引擎会退回画布自身的显示尺寸并报告"未变化"。
    const ice = fakeIce();

    const size = sizeCanvasToParent(fakeCanvas(0, 0), ice);

    expect(ice.calls).toEqual([[0, 0]]);
    expect(size).toEqual({ width: 0, height: 0 });
  });

  it('没有父容器时不动引擎，返回画布当前尺寸', () => {
    const ice = fakeIce();
    const canvas = fakeCanvas(null, null);

    expect(sizeCanvasToParent(canvas, ice)).toEqual({ width: 300, height: 150 });
    expect(ice.calls).toEqual([]);
  });
});
