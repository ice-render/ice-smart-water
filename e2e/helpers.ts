import { expect, type Page } from '@playwright/test';

/**
 * 画布应用的公共断言工具（整页画布化之后，界面里几乎没有可选择的 DOM，
 * 一切都要"按画布坐标点、按像素判"）。
 *
 * 三条口径：
 * 1. **画布元素存在 ≠ 画出来了** —— 一律用像素判定；
 *    ⚠️ 画布背景是**透明**的（底色由页面 CSS 给），统计时必须排除 alpha≈0 的像素，
 *    否则"非白像素占比"恒等于 1，断言看着通过其实什么都没验证。
 * 2. 点画布控件要点**子项中心**：控件的可点区域是它的每一档/每个选项，
 *    点在父容器的缝隙上会命中容器本身（没有 click 处理）→ 表现成"点了没反应"。
 * 3. 累加世界坐标的循环条件必须用 `state` 而不是 `parentNode`：
 *    直接挂在 `ICE` 实例上的组件 `parentNode` 是空的，用 parentNode 判终止会漏掉那一层偏移。
 */

/**
 * 全部页签 key —— **单一数据源**。
 *
 * 版面体检 / 全量审计 / 截图脚本都从这里取，别再各自写一份字面量数组
 * （以前散在 `layout.spec.ts` 与 `audit-all.spec.ts`，新增页签必漏一处）。
 */
export const PAGES = [
  'process',
  'data',
  'live',
  'calc',
  'events',
  'legend',
  'sludge',
  'asset',
  'inspection',
];

export type CanvasStats = {
  width: number;
  height: number;
  /** 采样到的不同颜色数（只统计真正画上去的像素） */
  colors: number;
  /** 画上去的像素占比（alpha > 8）——"有没有画"用这个 */
  opaqueRatio: number;
  /** 落墨占比：画上去且不是近白色的像素 ——"是不是一片白"用这个 */
  inkRatio: number;
};

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
      if (data[index + 3] < 8) continue;
      opaque += 1;
      colors.add(`${data[index]},${data[index + 1]},${data[index + 2]}`);
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

/** canvas 内部坐标 → 页面坐标，校验该点确实落在目标画布上，并把鼠标移过去 */
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
  // 这里允许 INPUT/TEXTAREA：画布文本控件聚焦时会挂一个**原生输入替身**盖在自己身上
  // （键盘输入走的是它），此时命中它的位置返回的是 INPUT 而不是画布本身。
  const expected = selector.replace('#', '');
  const acceptable = under === expected || under === 'INPUT' || under === 'TEXTAREA';
  expect(acceptable, `${JSON.stringify(point)} 上应当是 ${selector}（或它的原生输入替身），实际是 ${under}`).toBe(true);
  // 必须真的把指针移过去：`page.mouse.wheel` 在**当前指针位置**派发，不先 move 就"缩放失灵"
  await page.mouse.move(point.x, point.y);
  return point;
}

/** 在画布上点一下（canvas 内部坐标） */
export async function clickCanvas(page: Page, selector: string, x: number, y: number): Promise<void> {
  const point = await canvasPoint(page, selector, x, y);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(200);
}

/**
 * 算一个画布组件的**世界中心**（相对画布左上角），再换算成页面坐标。
 *
 * `expression` 是**在浏览器里**求值的表达式（纯 JS，不能带 TS 类型断言），
 * 例如 `window.__water.shell.find('page-tabs').getSegmentNode('data')`（页签那一档的按钮节点）。
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
      while (cursor && cursor.state) {
        left += Number(cursor.state.left) || 0;
        top += Number(cursor.state.top) || 0;
        cursor = cursor.parentNode;
      }
      return { x: left + (Number(node.state.width) || 0) / 2, y: top + (Number(node.state.height) || 0) / 2 };
    },
    { expression }
  );
  expect(center, `没能算出组件中心：${expression}`).not.toBeNull();
  return canvasPoint(page, selector, (center as any).x, (center as any).y);
}

/** 点一个画布组件（真鼠标事件，走引擎的命中测试路径） */
export async function clickWidget(page: Page, selector: string, expression: string): Promise<void> {
  const center = await componentCenter(page, selector, expression);
  await page.mouse.click(center.x, center.y);
  await page.waitForTimeout(280);
}

/**
 * 切到一个页签 —— **两级导航：先点侧栏的「域」，再点顶栏该域的页签**。
 *
 * 页签在顶栏的 `ICESegmented`（id `page-tabs`）里，每一档是一个按钮子节点，
 * 用组件自己的 `getSegmentNode(value)` 拿到它再按画布坐标点（真鼠标事件）。
 * 目标页已在当前域时跳过第一步。
 */
export async function openPage(page: Page, key: string): Promise<void> {
  const target = await page.evaluate((k) => {
    const shell = (window as any).__water.shell;
    const domain = shell.domains().filter((d: any) => d.pages.some((p: any) => p.key === k))[0];
    return domain ? { domain: domain.key } : null;
  }, key);
  expect(target, `没有域包含页「${key}」（检查 ShellOptions.domains）`).not.toBeNull();
  const currentDomain = await page.evaluate(() => (window as any).__water.shell.currentDomain());
  if (currentDomain !== (target as any).domain) {
    await clickWidget(page, '#canvas-shell', `window.__water.shell.find('menu').getItemNode('${(target as any).domain}')`);
    await page.waitForTimeout(320);
  }
  await clickWidget(page, '#canvas-shell', `window.__water.shell.find('page-tabs').getSegmentNode('${key}')`);
  await page.waitForTimeout(900);
}

/** 一个画布组件在**画布坐标系**里的矩形（累加父链的 left/top） */
export async function widgetWorldRect(
  page: Page,
  expression: string
): Promise<{ left: number; top: number; width: number; height: number }> {
  const rect = await page.evaluate((expr) => {
    // eslint-disable-next-line no-new-func
    const node = new Function(`return ${expr}`)();
    if (!node) return null;
    let left = 0;
    let top = 0;
    let cursor = node;
    while (cursor && cursor.state) {
      left += Number(cursor.state.left) || 0;
      top += Number(cursor.state.top) || 0;
      cursor = cursor.parentNode;
    }
    return { left, top, width: Number(node.state.width) || 0, height: Number(node.state.height) || 0 };
  }, expression);
  expect(rect, `没能算出组件矩形：${expression}`).not.toBeNull();
  return rect as { left: number; top: number; width: number; height: number };
}

/** 岛（DOM 画布）在**外壳坐标系**里的矩形 */
export async function islandRect(
  page: Page,
  islandId: string
): Promise<{ left: number; top: number; width: number; height: number }> {
  return page.evaluate((id) => {
    const shell = (document.querySelector('#canvas-shell') as HTMLElement).getBoundingClientRect();
    const host = document.getElementById(`island-${id}`) as HTMLElement;
    const rect = host.getBoundingClientRect();
    return {
      left: rect.left - shell.left,
      top: rect.top - shell.top,
      width: rect.width,
      height: rect.height,
    };
  }, islandId);
}

/**
 * 点侧栏里的**二级菜单项**：先点父项把它展开，再点子项。
 *
 * 子项节点在父项展开之前**不存在**（`getItemNode` 返回 null）——
 * 这不是缺陷，而是"内联展开"的实现方式；测试要按真实交互顺序来。
 */
export async function clickSubmenu(
  page: Page,
  menuExpr: string,
  parentKey: string,
  childKey: string
): Promise<void> {
  // 已经展开就别再点父项了：`toggleExpand` 是**开关**，再点一次会把子项收起（踩过）
  const expanded = await page.evaluate((payload) => {
    // eslint-disable-next-line no-new-func
    const menu = new Function(`return ${payload.menuExpr}`)();
    return !!menu.getItemNode(payload.childKey);
  }, { menuExpr, childKey });
  if (!expanded) {
    await clickWidget(page, '#canvas-shell', `${menuExpr}.getItemNode('${parentKey}')`);
    await page.waitForTimeout(320);
  }
  await clickWidget(page, '#canvas-shell', `${menuExpr}.getItemNode('${childKey}')`);
}

/**
 * 过登录门：**走真实交互路径**（点输入框 → 键盘打字 → 点「登 录」）。
 *
 * 输入是画布控件 `ICETextField`，它聚焦时会挂一个原生 `<input>` 替身接键盘输入，
 * 所以这里必须"先点再打字"：直接 `setValue()` 会跳过整条输入链路，等于没验证登录框。
 */
export async function login(
  page: Page,
  options: { name?: string; password?: string; selector?: string } = {}
): Promise<void> {
  const selector = options.selector || '#canvas-login';
  const name = options.name || '演示用户';
  await page.waitForFunction(() => !!(window as any).__login);
  await clickWidget(page, selector, "window.__login.find('login-username')");
  await page.keyboard.type(name);
  if (options.password) {
    await clickWidget(page, selector, "window.__login.find('login-password')");
    await page.keyboard.type(options.password);
  }
  await clickWidget(page, selector, "window.__login.find('login-submit')");
  await page.waitForFunction(() => !(window as any).__login.visible());
  await page.waitForTimeout(300);
}

/** 断言登录层真的盖住了应用（点上去应该落在登录画布上） */
export async function expectLoginCovers(page: Page, x = 700, y = 300): Promise<void> {
  const under = await page.evaluate((point) => {
    const el = document.elementFromPoint(point.x, point.y);
    return el ? el.id || el.tagName : null;
  }, { x, y });
  expect(under, '登录层应当盖在应用之上').toBe('canvas-login');
}

/** 三段式视口回归：滚轮缩放 → 中键拖拽平移 → 复位 */
export async function expectViewportInteractions(
  page: Page,
  selector: string,
  options: { viewportExpr: string; resetExpr: string }
): Promise<void> {
  const box = await page.evaluate((sel) => {
    const canvas = document.querySelector(sel) as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  }, selector);

  const viewportOf = () =>
    page.evaluate((expr) => {
      // eslint-disable-next-line no-new-func
      return { ...new Function(`return ${expr}`)().viewport };
    }, options.viewportExpr);

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

  await clickWidget(page, '#canvas-shell', options.resetExpr);
  await page.waitForTimeout(200);
  expect(await viewportOf()).toMatchObject({ scale: 1, tx: 0, ty: 0 });
}

/**
 * 版面体检：把可见页子树里「我排的容器」的矩形取出来，找任意两个相交。
 *
 * 为什么需要它：页面里大量位置是我算的（卡片、行、栈），一处算错就是"压字"——
 * 而这类问题**截图看不出来**（人眼会以为是设计），只有把矩形两两比一遍才抓得到。
 *
 * 两条口径：
 * - **祖先判定按对象身份**，不能按 `state.id || 类名`：匿名节点的类名会被当成 id，
 *   与父链里的同名条目撞上，真交叠会被误判成父子而跳过（踩过）；
 * - **控件内部不再往下审**：滑块的轨道与滑块头、表格单元格本来就有意叠在一起。
 *   也不能拿 `getFormValue` 判"是控件"——基类上就有它，会把所有节点都判成控件（踩过）。
 */
export type LayoutAudit = {
  page: string;
  hits: string[];
  outside: string[];
  nodeCount: number;
};

export async function layoutAudit(page: Page): Promise<LayoutAudit> {
  return page.evaluate(() => {
    const w = (window as any).__water;
    const shell = w.shell;
    const chrome = ['shell-bg', 'sidebar', 'header', 'fab'];
    const pageNode = (shell.ice.childNodes || []).filter(
      (n: any) =>
        n.state &&
        n.state.display !== false &&
        chrome.indexOf(String(n.state.id)) < 0 &&
        (Number(n.state.width) || 0) >= shell.layout.content.width
    )[0];
    if (!pageNode) return { page: shell.current(), hits: ['没有找到可见页节点'], outside: [], nodeCount: 0 };

    const world = (node: any) => {
      let l = 0;
      let t = 0;
      let c = node;
      while (c && c.state) {
        l += Number(c.state.left) || 0;
        t += Number(c.state.top) || 0;
        c = c.parentNode;
      }
      return { l, t, w: Number(node.state.width) || 0, h: Number(node.state.height) || 0 };
    };
    const isLibraryControl = (n: any) =>
      typeof n.getSelectedRows === 'function' ||
      typeof n.getThumbs === 'function' ||
      typeof n.getItemNode === 'function' ||
      typeof n.getTextNodes === 'function' ||
      typeof n.getLabelTexts === 'function' ||
      typeof n.getToggleButton === 'function';

    const nodes: any[] = [];
    const collect = (node: any, ancestors: any[]) => {
      if (!node || !node.state || node.state.display === false) return;
      const box = world(node);
      const label = String(node.state.id || node.constructor.name);
      if (box.w > 0 && box.h > 0) nodes.push({ node, label, box, ancestors });
      if (isLibraryControl(node)) return;
      const next = ancestors.concat([node]);
      (node.childNodes || []).forEach((kid: any) => collect(kid, next));
    };
    collect(pageNode, []);

    const hits: string[] = [];
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i];
        const b = nodes[j];
        if (a.ancestors.indexOf(b.node) >= 0 || b.ancestors.indexOf(a.node) >= 0) continue;
        const ox = Math.min(a.box.l + a.box.w, b.box.l + b.box.w) - Math.max(a.box.l, b.box.l);
        const oy = Math.min(a.box.t + a.box.h, b.box.t + b.box.h) - Math.max(a.box.t, b.box.t);
        const aInB = a.box.l >= b.box.l && a.box.t >= b.box.t && a.box.l + a.box.w <= b.box.l + b.box.w && a.box.t + a.box.h <= b.box.t + b.box.h;
        const bInA = b.box.l >= a.box.l && b.box.t >= a.box.t && b.box.l + b.box.w <= a.box.l + a.box.w && b.box.t + b.box.h <= a.box.t + a.box.h;
        if (ox > 2 && oy > 2 && !aInB && !bInA) {
          hits.push(
            a.label + '[' + Math.round(a.box.l) + ',' + Math.round(a.box.t) + ' ' + Math.round(a.box.w) + 'x' + Math.round(a.box.h) + ']' +
              ' x ' +
              b.label + '[' + Math.round(b.box.l) + ',' + Math.round(b.box.t) + ' ' + Math.round(b.box.w) + 'x' + Math.round(b.box.h) + ']'
          );
        }
      }
    }

    const content = shell.layout.content;
    const outside = nodes
      .filter(
        (n) =>
          n.node !== pageNode &&
          (n.box.l < content.left - 2 ||
            n.box.t < content.top - 2 ||
            n.box.l + n.box.w > content.left + content.width + 2 ||
            n.box.t + n.box.h > content.top + content.height + 2)
      )
      .map((n) => n.label + '@' + Math.round(n.box.l) + ',' + Math.round(n.box.t) + ' ' + Math.round(n.box.w) + 'x' + Math.round(n.box.h));

    return { page: shell.current(), hits: hits.slice(0, 10), outside: outside.slice(0, 10), nodeCount: nodes.length };
  });
}

/** 当前页所有卡片在内容区内的可见性（滚动条检查用） */
export async function pageOverflow(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => ({
    x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
  }));
}

/**
 * 运行要点/审计摘要卡回归：其正文子节点必须落在卡片正文区内（挖掉标题带 44 与内边距 16）。
 *
 * 这是上一轮"交叠"残留的精准回归点 —— 雨季 7 条审计曾把文字甩到卡片底外。
 * `layoutAudit` 抓不到它（溢出的兄弟节点彼此不相交、且仍在内容区内），所以单独守这一处。
 */
export async function auditNotesCard(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = (window as any).__water;
    const shell = w.shell;
    const world = (node: any) => {
      let l = 0;
      let t = 0;
      let c = node;
      while (c && c.state) {
        l += Number(c.state.left) || 0;
        t += Number(c.state.top) || 0;
        c = c.parentNode;
      }
      return { l, t, w: Number(node.state.width) || 0, h: Number(node.state.height) || 0 };
    };
    const card = shell.find('notes-card');
    if (!card) return ['找不到 notes-card'];
    const cardBox = world(card);
    // 卡片正文区：挖掉标题带(44)与内边距(16)
    const body = { l: cardBox.l + 16, t: cardBox.t + 44, w: cardBox.w - 32, h: cardBox.h - 44 - 16 };
    const tol = 2;
    const problems: string[] = [];
    const notesBody = (card.childNodes || []).find(
      (n: any) => n && n.state && n.constructor && n.constructor.name === 'ICEWidget'
    );
    const kids = notesBody ? notesBody.childNodes || [] : [];
    for (const kid of kids) {
      if (!kid || !kid.state) continue;
      const b = world(kid);
      if (
        b.l < body.l - tol ||
        b.t < body.t - tol ||
        b.l + b.w > body.l + body.w + tol ||
        b.t + b.h > body.t + body.h + tol
      ) {
        problems.push(
          `notes 子节点[${Math.round(b.l)},${Math.round(b.t)} ${Math.round(b.w)}x${Math.round(b.h)}] 溢出卡片正文区[${Math.round(body.l)},${Math.round(body.t)} ${Math.round(body.w)}x${Math.round(body.h)}]`
        );
      }
    }
    return problems;
  });
}
