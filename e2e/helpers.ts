import { expect, type Page } from '@playwright/test';

/**
 * 画布相关的公共断言工具。
 *
 * 两条口径与家族其它仓库一致：
 * 1. **画布元素存在 ≠ 画出来了** —— 一律用像素判定（颜色种数、非白像素数）；
 * 2. 事件坐标用「canvas 内部坐标 + 元素左上角偏移」，先断言这个坐标上是 canvas，
 *    坐标算错时立刻报错，而不是让后面的断言莫名其妙失败。
 */

export type CanvasStats = {
  width: number;
  height: number;
  /** 采样到的不同颜色数（只统计**真正画上去的**像素，透明像素不算） */
  colors: number;
  /** 画上去的像素占比（alpha > 8）——"有没有画"用这个 */
  opaqueRatio: number;
  /** 落墨占比：画上去、且不是近白色的像素 ——"画的是不是一片白"用这个 */
  inkRatio: number;
};

/**
 * 用像素判定"画布真的画出来了"。
 *
 * 两个坑：
 * 1. **画布背景是透明的**（底色由页面 CSS 给），不排除透明像素的话，
 *    "非白像素占比"会恒等于 1 —— 断言看似通过，其实什么都没验证；
 * 2. 采样要跳步（`4 * 53`）：1180×583 的画布逐像素扫会拖慢每个用例。
 */
export async function canvasStats(page: Page, selector: string): Promise<CanvasStats> {
  return page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement;
    if (!canvas) throw new Error(`找不到画布 ${sel}`);
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set<string>();
    let opaque = 0;
    let ink = 0;
    let samples = 0;
    for (let index = 0; index < data.length; index += 4 * 53) {
      samples += 1;
      if (data[index + 3] < 8) continue; // 透明：没画东西
      opaque += 1;
      const key = `${data[index]},${data[index + 1]},${data[index + 2]}`;
      colors.add(key);
      if (data[index] < 245 || data[index + 1] < 245 || data[index + 2] < 245) ink += 1;
    }
    return {
      width: canvas.width,
      height: canvas.height,
      colors: colors.size,
      opaqueRatio: samples ? opaque / samples : 0,
      inkRatio: samples ? ink / samples : 0,
    };
  }, selector);
}

/** 把 canvas 内部坐标换成页面坐标，校验该点确实落在画布上，并把鼠标移过去 */
export async function canvasPoint(
  page: Page,
  selector: string,
  x: number,
  y: number
): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    (payload) => {
      const canvas = document.querySelector(payload.selector) as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      return { x: Math.round(rect.left + payload.x), y: Math.round(rect.top + payload.y) };
    },
    { selector, x, y }
  );
  const under = await page.evaluate((payload) => {
    const el = document.elementFromPoint(payload.x, payload.y);
    return el ? el.id || el.tagName : null;
  }, point);
  expect(under, `坐标 ${JSON.stringify(point)} 上应当是目标画布`).toBe(selector.replace('#', ''));
  // 必须真的把指针移过去：`page.mouse.wheel` 是在**当前指针位置**派发的，
  // 不先 move 的话滚轮事件落在 (0,0)，页面看起来"缩放失灵"。
  await page.mouse.move(point.x, point.y);
  return point;
}

/** 在画布上点一下（canvas 内部坐标） */
export async function clickCanvas(page: Page, selector: string, x: number, y: number): Promise<void> {
  const point = await canvasPoint(page, selector, x, y);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(150);
}

/**
 * 算一个画布组件的**世界中心**（相对画布左上角），再换算成页面坐标。
 *
 * 为什么要这么点，而不是背坐标：画布控件（ice-web-components）的可点区域是它的**子项**
 * （例如单选组的每一档），父容器只负责布局。点在父容器的空白处（档与档之间的缝隙）
 * 命中到的是容器本身，它没有 click 处理 —— 表现就是"点上去没反应"，很容易误判成功能坏了。
 * 所以从组件往上累加 left/top 得到世界坐标，再取子项中心来点。
 *
 * 返回的是**页面坐标**（可直接给 page.mouse.click），换算与断言都在 canvasPoint 里做。
 */
export async function componentCenter(
  page: Page,
  selector: string,
  expression: string
): Promise<{ x: number; y: number }> {
  const center = await page.evaluate(
    (payload) => {
      // eslint-disable-next-line no-new-func
      const node = new Function(`return ${payload.expression}`)();
      if (!node) return null;
      let left = 0;
      let top = 0;
      let cursor = node;
      // 循环条件是 `state` 而不是 `parentNode`：**引擎根节点的直接子节点 parentNode 是空的**
      // （挂到 ICE 实例上的组件没有回指父级），用 parentNode 判终止会漏掉挂在画布上的那一层偏移。
      while (cursor && cursor.state) {
        left += Number(cursor.state.left) || 0;
        top += Number(cursor.state.top) || 0;
        cursor = cursor.parentNode;
      }
      return {
        x: left + (node.state.width || 0) / 2,
        y: top + (node.state.height || 0) / 2,
      };
    },
    { expression }
  );
  expect(center, `没能算出组件中心：${expression}`).not.toBeNull();
  return canvasPoint(page, selector, (center as any).x, (center as any).y);
}

/** 点画布控件里的第 index 个子项（从 0 开始） */
export async function clickCanvasChild(
  page: Page,
  selector: string,
  ownerExpression: string,
  index: number
): Promise<void> {
  const center = await componentCenter(page, selector, `${ownerExpression}.childNodes[${index}]`);
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(250);
}

/** 三段式视口回归：滚轮缩放 → 拖拽平移 → 复位 */
export async function expectViewportInteractions(page: Page, selector: string, resetSelector: string): Promise<void> {
  const box = await page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  }, selector);

  const viewportOf = () =>
    page.evaluate(() => {
      const ice = (window as any).__water ? (window as any).__water.ice : (window as any).__symbols.ice;
      return { ...ice.viewport };
    });

  const before = await viewportOf();
  const centerX = Math.round(box.width / 2);
  const centerY = Math.round(box.height / 2);
  await canvasPoint(page, selector, centerX, centerY);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(250);
  const zoomed = await viewportOf();
  expect(zoomed.scale).toBeGreaterThan(before.scale);

  const from = await canvasPoint(page, selector, centerX, centerY);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(from.x + 70, from.y + 40, { steps: 6 });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(250);
  const panned = await viewportOf();
  expect([panned.tx, panned.ty]).not.toEqual([zoomed.tx, zoomed.ty]);

  await page.click(resetSelector);
  await page.waitForTimeout(150);
  expect(await viewportOf()).toMatchObject({ scale: 1, tx: 0, ty: 0 });
}
