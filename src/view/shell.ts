/**
 * 画布化外壳 —— 对齐 `ice-web-components/examples/admin.html` 的设计语言：
 * 侧栏（`ICEMenu`）+ 顶栏（标题 / 面包屑 / 状态标签 / 操作按钮）+ 内容区（`ICECard` 栅格），
 * **全部由 ice-web-components 画在同一张画布上**。页面靠 `display` 切换，不销毁重建。
 *
 * 与 admin.html 的两点差异（都是有意的）：
 * 1. **自适应窗口**：画布取 `max(设计尺寸, 窗口尺寸)`，外壳铺满整张画布，不再是固定在 1600×1000 里；
 * 2. **"岛"（island）**：工艺图与图表各自需要一个独立的 `ICE` 实例（设计器的视口变换会带着
 *    整个场景一起位移，图表库自己 new 一个引擎），所以它们是**独立画布**，按外壳坐标绝对定位、
 *    嵌在卡片的"洞"里。见 `islands.ts`。
 */
import { ICE } from 'ice-render';
import {
  ICEAvatar,
  ICEBreadcrumb,
  ICEButton,
  ICECard,
  ICEFloatButton,
  ICEHoverManager,
  ICEIcon,
  ICELabel,
  ICEMessage,
  ICEMenu,
  ICENotification,
  ICEPanel,
  ICESeparator,
  ICETag,
  ICEWidget,
  attachTooltip,
  getICEFocusManager,
  iceUIManager,
  mountICEAccessibilityMirror,
} from 'ice-web-components';

/** 设计尺寸下限：窗口比它小就整页滚动（与 admin.html 同策略，换来"外壳坐标恒定、岛不用跟着重排"） */
export const MIN_CANVAS_WIDTH = 1440;
export const MIN_CANVAS_HEIGHT = 900;
export const SIDEBAR_WIDTH = 264;
export const HEADER_HEIGHT = 64;
/** 内容区四周留白 */
export const PAGE_PADDING = 24;
/** 卡片之间的间距 */
export const PAGE_GAP = 18;
/** 卡片正文的左右内缩与标题带高度（与 `card()` 的排版一致，岛就挖在这块空里） */
export const CARD_INSET = 16;
export const CARD_TITLE_BAND = 44;

export type Rect = { left: number; top: number; width: number; height: number };

export type ShellMenuItem = {
  key: string;
  label: string;
  iconPath?: string;
  children?: Array<{ key: string; label: string }>;
};

export type HeaderActionSpec = {
  key: string;
  label: string;
  width?: number;
  variant?: 'primary' | 'default' | 'text' | 'link';
  danger?: boolean;
  onClick: () => void;
};

export type IslandSpec = {
  /** 对应页面里 `<div class="island" id="island-<id>">` 的 id 后缀 */
  id: string;
  /** 在外壳坐标系里的位置（= 画布坐标） */
  rect: Rect;
};

export type ShellLayout = {
  /** 画布尺寸 */
  canvas: { width: number; height: number };
  /** 内容区（含 24px 内边距） */
  content: Rect;
  /** 内容区的可用宽高（已扣掉内边距） */
  inner: { width: number; height: number };
  /** 右侧栏宽度 */
  rightWidth: number;
};

export type StatusTagSpec = { text: string; status: string; width?: number };

export type ShellPage = {
  key: string;
  label: string;
  build: (ctx: PageContext) => PageHandle;
};

export type PageHandle = {
  node: any;
  islands?: IslandSpec[];
  actions?: HeaderActionSpec[];
  /**
   * 顶栏状态标签**由页面自己声明**（每页关心的东西不一样：工艺图页关心工况与流径，
   * 符号库页关心符号数量）。切页与 `refresh()` 时外壳会重新取一次。
   */
  statusTags?: () => StatusTagSpec[];
  refresh?: () => void;
};

export type PageContext = {
  ice: any;
  theme: any;
  layout: ShellLayout;
  toast: (text: string, type?: string) => void;
  notify: (title: string, description: string, type?: string) => void;
};

export type ShellHandle = {
  ice: any;
  theme: any;
  layout: ShellLayout;
  /** 当前页 key */
  current: () => string;
  /** 切页（会同步侧栏选中、标题、面包屑、顶栏按钮与岛的显隐） */
  show: (key: string) => void;
  /** 重排当前页（动态文案改完用它；岛的位置会一并跟着走） */
  refresh: () => void;
  /**
   * 手动设置顶栏状态标签。
   *
   * **一般不用调**：页面在 `PageHandle.statusTags` 里声明自己的标签，切页与 `refresh()` 时
   * 外壳会自己取。这个入口留给"外壳外的状态"（比如全局连接状态）用。
   */
  setStatusTags: (tags: Array<{ text: string; status: string; width?: number }>) => void;
  /** 换侧栏底部的登录用户（登录 / 退出登录时用） */
  setUser: (user: { avatar?: string; name: string; role?: string }) => void;
  toast: (text: string, type?: string) => void;
  notify: (title: string, description: string, type?: string) => void;
  /** 岛的位置（岛画布由页面自己创建，这里只负责摆位置） */
  islandRect: (id: string) => Rect | null;
  /**
   * 按 `state.id` 在显示树里深度优先找一个控件。
   *
   * 侧栏里的菜单、卡片上的按钮都不是画布的直接子节点（挂在 sidebar / page 下），
   * 端到端测试与调试要拿到它们就得挖树 —— 与其在测试里写一串 childNodes 索引，
   * 不如由外壳提供这一个入口。
   */
  find: (id: string) => any;
  destroy: () => void;
};

export type ShellOptions = {
  canvas: HTMLCanvasElement;
  brand: string;
  brandSub: string;
  menu: ShellMenuItem[];
  selectedKey: string;
  onMenuSelect: (key: string, item: any) => void;
  pages: ShellPage[];
  /** 侧栏底部署名 */
  footer?: { avatar: string; name: string; role: string };
  /** 悬浮按钮（快捷操作），key 由调用方处理 */
  fabItems?: Array<{ key: string; icon: string; tip?: string }>;
  onFabItem?: (key: string) => void;
  /**
   * 切页时回调当前页声明的岛。
   *
   * 外壳不管岛怎么摆（岛是 DOM 元素、不在引擎显示树里），只把"这一页有哪几个岛"
   * 告诉调用方 —— 由调用方 `placeIslands()` 摆位并**隐藏不在本页的岛**
   * （不处理就会出现"切了页，工艺图还在那儿飘着"）。
   */
  onIslands?: (specs: IslandSpec[]) => void;
};

/** 内容区尺寸：铺满画布，去掉侧栏与顶栏 */
export function computeLayout(canvasWidth: number, canvasHeight: number, rightWidth = 360): ShellLayout {
  const width = Math.max(canvasWidth, MIN_CANVAS_WIDTH);
  const height = Math.max(canvasHeight, MIN_CANVAS_HEIGHT);
  const content: Rect = {
    left: SIDEBAR_WIDTH,
    top: HEADER_HEIGHT,
    width: width - SIDEBAR_WIDTH,
    height: height - HEADER_HEIGHT,
  };
  return {
    canvas: { width, height },
    content,
    inner: { width: content.width - PAGE_PADDING * 2, height: content.height - PAGE_PADDING * 2 },
    rightWidth,
  };
}

/** 画布外边距（与 HTML 里 `body { padding }` 一致） */
export const CANVAS_MARGIN = 24;

/**
 * 画面尺寸：取「窗口可用区域」与设计下限的较大者，外壳铺满整张画布。
 *
 * 必须扣掉 body 的 padding：`window.innerWidth` 不扣，加上 body 的 24px 内边距就会
 * 恒比视口宽 48px —— 一条永远消不掉的水平滚动条。
 */
export function measureCanvas(): { width: number; height: number } {
  const root = document.documentElement;
  const width = Math.max(MIN_CANVAS_WIDTH, Math.floor(root.clientWidth) - CANVAS_MARGIN * 2);
  const height = Math.max(MIN_CANVAS_HEIGHT, Math.floor(root.clientHeight) - CANVAS_MARGIN * 2);
  return { width, height };
}

export function mountShell(options: ShellOptions): ShellHandle {
  const canvas = options.canvas;
  const measured = measureCanvas();
  canvas.width = measured.width;
  canvas.height = measured.height;
  canvas.style.width = `${measured.width}px`;
  canvas.style.height = `${measured.height}px`;

  const ice = new ICE().init(canvas, { renderMode: 'dirty-rect' });
  const theme = iceUIManager.getTheme();
  const layout = computeLayout(measured.width, measured.height);
  const { content, inner } = layout;

  ice.addChild(
    new ICEPanel({
      id: 'shell-bg',
      left: 0,
      top: 0,
      width: layout.canvas.width,
      height: layout.canvas.height,
      radius: 0,
      interactive: false,
      fill: true,
      stroke: false,
      style: { fillStyle: '#f8f9fa' },
    })
  );

  /* ---------------- 侧栏 ---------------- */
  const sidebar = new ICEPanel({
    id: 'sidebar',
    left: 0,
    top: 0,
    width: SIDEBAR_WIDTH,
    height: layout.canvas.height,
    radius: 0,
    style: { fillStyle: theme.colors.surface, strokeStyle: theme.colors.border },
  });
  const brand = new ICELabel({
    left: 24,
    top: 22,
    text: options.brand,
    style: { fontSize: 20, fontWeight: '700', fillStyle: theme.colors.primary },
  });
  const brandSub = new ICELabel({
    left: 24,
    top: 48,
    width: 216,
    text: options.brandSub,
    style: { fontSize: 11, wrap: true, lineHeight: 16, fillStyle: theme.colors.textSecondary },
  });
  const footerTop = layout.canvas.height - 96;
  const sidebarFooter: any[] = [];
  let footerNodes: { avatar: any; name: any; role: any } | null = null;
  if (options.footer) {
    const avatar = new ICEAvatar({ id: 'footer-avatar', left: 16, top: footerTop + 20, text: options.footer.avatar, size: 40 });
    const name = new ICELabel({
      id: 'footer-name',
      left: 64,
      top: footerTop + 16,
      text: options.footer.name,
      style: { fontSize: 13, fontWeight: '600', fillStyle: theme.colors.text },
    });
    const role = new ICELabel({
      id: 'footer-role',
      left: 64,
      top: footerTop + 36,
      width: 184,
      text: options.footer.role,
      style: { fontSize: 11, wrap: true, lineHeight: 15, fillStyle: theme.colors.textSecondary },
    });
    footerNodes = { avatar, name, role };
    sidebarFooter.push(new ICESeparator({ left: 16, top: footerTop, width: 232, height: 1 }), avatar, name, role);
  }

  /**
   * 换登录用户：只改文字，不重建节点（重建会把配色/字号这些一起丢掉）。
   * 头像取名字的 1~2 个字符 —— 中文取前 1 个，英文取前 2 个首字母。
   */
  function setUser(user: { avatar?: string; name: string; role?: string }): void {
    if (!footerNodes) return;
    footerNodes.name.setText(user.name);
    if (user.role !== undefined) footerNodes.role.setText(user.role);
    footerNodes.avatar.setText(user.avatar || avatarTextOf(user.name));
    ice.dirty = true;
  }

  const menu = new ICEMenu({
    id: 'menu',
    left: 16,
    top: 92,
    width: 232,
    items: options.menu,
    selectedKey: options.selectedKey,
    style: { fillStyle: theme.colors.surface },
    onSelect: (item: any) => options.onMenuSelect(item.key, item),
  });
  sidebar.addChildren([brand, brandSub, menu, ...sidebarFooter] as any);
  ice.addChild(sidebar);

  /* ---------------- 顶栏 ---------------- */
  const header = new ICEPanel({
    id: 'header',
    left: SIDEBAR_WIDTH,
    top: 0,
    width: content.width,
    height: HEADER_HEIGHT,
    radius: 0,
    style: { fillStyle: theme.colors.surface, strokeStyle: theme.colors.border },
  });
  const hamburger = new ICEIcon({
    id: 'hamburger',
    left: 22,
    top: 20,
    size: 24,
    icon: '☰',
    color: theme.colors.textSecondary,
  });
  const pageTitle = new ICELabel({
    left: 56,
    top: 8,
    height: 26,
    verticalAlign: 'middle',
    text: '',
    style: { fontSize: 18, fontWeight: '600', fillStyle: theme.colors.text },
  });
  const breadcrumb = new ICEBreadcrumb({
    id: 'breadcrumb',
    left: 56,
    top: 36,
    width: 260,
    fontSize: 11,
    items: [{ label: '首页' }, { label: '工艺流程图' }],
  });
  header.addChildren([hamburger, pageTitle, breadcrumb]);
  ice.addChild(header);

  /** 顶栏右侧：状态标签 + 页级操作按钮（切页时重建） */
  let tagNodes: any[] = [];
  let actionNodes: any[] = [];
  /** 上一次画出来的标签签名：一样就不重建（每次 refresh 都重建会闪） */
  let tagSignature = '';

  function clearNodes(nodes: any[], host: any): void {
    nodes.forEach((node) => {
      if (node.parentNode === host) host.removeChild(node);
    });
  }

  function layoutHeaderRight(): void {
    const right = content.width - PAGE_PADDING;
    let cursor = right;
    // 操作按钮：右对齐，从右往左排
    const actions = actionNodes.slice().reverse();
    actions.forEach((node) => {
      const width = Number(node.state.width) || 96;
      cursor -= width;
      node.setState({ left: cursor, top: 16 });
      cursor -= 10;
    });
    if (actionNodes.length) cursor -= 8;
    // 状态标签：按钮左侧
    const tags = tagNodes.slice().reverse();
    tags.forEach((node) => {
      const width = Number(node.state.width) || 88;
      cursor -= width;
      node.setState({ left: cursor, top: 19 });
      cursor -= 8;
    });
  }

  /** 重建顶栏右侧的按钮组（每页的按钮不一样） */
  function setActions(actions: HeaderActionSpec[]): void {
    clearNodes(actionNodes, header);
    actionNodes = actions.map((action) => {
      const button = new ICEButton({
        id: `action-${action.key}`,
        left: 0,
        top: 16,
        width: action.width || 96,
        height: 32,
        text: action.label,
        size: 'small',
        variant: action.variant || 'default',
        danger: !!action.danger,
      });
      button.on('click', () => action.onClick());
      header.addChild(button);
      return button;
    });
    layoutHeaderRight();
    ice.dirty = true;
  }

  function setStatusTags(tags: StatusTagSpec[]): void {
    const signature = tags.map((tag) => `${tag.text}|${tag.status}|${tag.width || ''}`).join('~');
    if (signature === tagSignature) return;
    tagSignature = signature;
    clearNodes(tagNodes, header);
    // ICETag 的状态色在构造期定死，所以状态变了要重建（只 setText 不会变色）
    tagNodes = tags.map((tag, index) => {
      const node = new ICETag({
        id: `status-tag-${index}`,
        left: 0,
        top: 19,
        width: tag.width || 88,
        height: 24,
        text: tag.text,
        status: tag.status,
        variant: 'soft',
      });
      header.addChild(node);
      return node;
    });
    layoutHeaderRight();
    ice.dirty = true;
  }

  /* ---------------- 内容区 ----------------
   *
   * 页面节点**直接挂在画布根上**（不放进一个 content 容器里），这样全工程只有一套坐标系
   * = 画布绝对坐标：外壳、卡片、岛（DOM 画布）用同一套数。
   * 放进 content（它自己在 264,64）会让卡片的绝对坐标再叠一次容器偏移 ——
   * 症状是"卡片画在右边偏 264px，而岛还留在原地"，卡片和洞对不上。
   */
  const isles: Record<string, Rect> = {};
  const pageNodes: Record<string, any> = {};
  let currentKey = '';
  let currentPage: ShellPage | null = null;
  let currentHandle: PageHandle | null = null;

  function collectIslands(): void {
    Object.keys(isles).forEach((key) => delete isles[key]);
    (currentHandle && currentHandle.islands ? currentHandle.islands : []).forEach((island) => {
      isles[island.id] = island.rect;
    });
  }

  function show(key: string): void {
    const page = options.pages.filter((item) => item.key === key)[0];
    if (!page) throw new Error(`没有注册页面：${key}`);
    // 页面节点懒构建：建好之后一直挂着，靠 display 切换（与 admin.html 同策略）
    if (!pageNodes[key]) {
      const handle = page.build({ ice, theme, layout, toast, notify });
      handle.node.setState({ display: true });
      ice.addChild(handle.node);
      pageNodes[key] = { node: handle.node, handle };
    }
    // 切换显示
    Object.keys(pageNodes).forEach((otherKey) => {
      pageNodes[otherKey].node.setState({ display: otherKey === key });
    });
    currentKey = key;
    currentPage = page;
    currentHandle = pageNodes[key].handle;
    pageTitle.setText(page.label);
    breadcrumb.setItems([{ label: '首页' }, { label: page.label }]);
    menu.setSelectedKey(key);
    setActions((currentHandle && currentHandle.actions) || []);
    applyPageTags();
    collectIslands();
    if (options.onIslands) options.onIslands(Object.keys(isles).map((id) => ({ id, rect: isles[id] })));
    ice.dirty = true;
  }

  /** 取当前页声明的状态标签（页面没声明就清空） */
  function applyPageTags(): void {
    setStatusTags(currentHandle && currentHandle.statusTags ? currentHandle.statusTags() : []);
  }

  function refresh(): void {
    // 先重排页面内容，再让岛对齐卡片（岛的洞是按卡片矩形算的，卡片动了洞就动）
    if (currentHandle && typeof currentHandle.refresh === 'function') currentHandle.refresh();
    applyPageTags();
    ice.dirty = true;
  }

  function toast(text: string, type = 'success'): void {
    ICEMessage.show(ice, text, { type: type as any });
  }
  function notify(title: string, description: string, type = 'success'): void {
    ICENotification.open(ice, { title, description, type: type as any });
  }

  /* ---------------- 悬浮件 ---------------- */
  const fab = new ICEFloatButton({
    id: 'fab',
    left: layout.canvas.width - 24 - 44 - 12,
    top: layout.canvas.height - 24 - 44 - 12,
    size: 44,
    type: 'primary',
    items: (options.fabItems || []).map((item) => ({
      key: item.key,
      icon: item.icon,
      onClick: () => (options.onFabItem ? options.onFabItem(item.key) : undefined),
    })),
  });
  attachTooltip(ice, fab, { title: '快捷操作', placement: 'left' });
  raiseSubtree(fab, 9000);
  ice.addChild(fab);

  // 悬停 / 焦点 / 无障碍：画布控件的三件套
  new ICEHoverManager(ice).start();
  getICEFocusManager(ice).start();
  mountICEAccessibilityMirror(ice, { id: 'shell-a11y' });

  return {
    ice,
    theme,
    layout,
    current: () => currentKey,
    show,
    refresh,
    setStatusTags,
    setUser,
    toast,
    notify,
    islandRect: (id: string) => isles[id] || null,
    find: (id: string) => findWidget(ice, id),
    destroy(): void {
      if (typeof ice.destroy === 'function') ice.destroy();
    },
  };
}

/** 按 `state.id` 深度优先找控件（注意：`ICE` 实例本身没有 `state`，不能拿它当终止条件） */
export function findWidget(root: any, id: string): any {
  if (!root) return null;
  if (root.state && root.state.id === id) return root;
  const children = root.childNodes || [];
  for (let index = 0; index < children.length; index += 1) {
    const hit = findWidget(children[index], id);
    if (hit) return hit;
  }
  return null;
}

/** 头像文字：中文取第一个字，英文取前两个字母的大写 */
export function avatarTextOf(name: string): string {
  const text = String(name || '').trim();
  if (!text) return 'SW';
  if (/^[\x20-\x7e]+$/.test(text)) return text.slice(0, 2).toUpperCase();
  return text.slice(0, 1);
}

/** 把整棵子树抬到指定 zIndex（同值不破坏内部父子顺序） */
export function raiseSubtree(node: any, z: number): void {
  if (!node || !node.state) return;
  node.state.zIndex = z;
  (node.childNodes || []).forEach((child: any) => raiseSubtree(child, z));
}

/**
 * 一次性的绝对定位排版：把 `items` 按给定的矩形摆好。
 *
 * 之所以不用流式布局：这一页的栅格是**定死**的（统计卡一行五张、左图右栏），
 * 定死的东西用定死的坐标最不容易出错；只有"文字多长要多少行"这种才是动态的，
 * 那部分交给 `estimateTextHeight()` 估高。
 */
export function place(node: any, rect: Rect): any {
  node.setState({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  return node;
}

/**
 * 估一段 CJK 文本的渲染高度。
 *
 * 为什么不用实测：`ICEText` 构造期还没有 canvas 上下文，走 DOM 兜底测量，
 * 长中文串会被量得**偏大**（组件库自己的注释里记着实测 418 vs 真实 228）。
 * 用它来估"卡片要留多高"足够稳；真正的换行由引擎按 `style.wrap` 做。
 * 口径：CJK 一字约 1em，ASCII 约 0.55em。
 */
export function estimateTextHeight(text: string, width: number, fontSize: number, lineHeight: number): number {
  const perLine = Math.max(1, Math.floor(width / fontSize));
  let lines = 0;
  String(text || '')
    .split('\n')
    .forEach((paragraph) => {
      let units = 0;
      for (const char of paragraph) {
        units += char.charCodeAt(0) > 0x2e80 ? 1 : 0.55;
      }
      lines += Math.max(1, Math.ceil(units / perLine));
    });
  return Math.max(lineHeight, lines * lineHeight);
}

/** 正文段落（自动换行，宽给定、高按内容估） */
export function paragraph(ctx: PageContext, rect: Omit<Rect, 'height'> & { text: string; fontSize?: number; color?: string }): any {
  const fontSize = rect.fontSize || 12;
  const lineHeight = Math.round(fontSize * 1.6);
  return new ICELabel({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    text: rect.text,
    style: { fontSize, wrap: true, lineHeight, fillStyle: rect.color || ctx.theme.colors.textSecondary },
  });
}

/** 小节标题（卡片内部用） */
export function sectionHeading(ctx: PageContext, left: number, top: number, text: string): any {
  return new ICELabel({
    left,
    top,
    text,
    style: { fontSize: 12, fontWeight: '600', fillStyle: ctx.theme.colors.textSecondary },
  });
}

/** 一条要点：`• 文字`，自动换行 */
export function bullet(ctx: PageContext, rect: { left: number; top: number; width: number; text: string }): any {
  return paragraph(ctx, { ...rect, text: `• ${rect.text}` });
}

export type CardOptions = {
  rect: Rect;
  title: string;
  /** 给控件一个稳定 id：调试与端到端测试靠它拿句柄 */
  id?: string;
  /** 标题栏右上角的插槽（放操作按钮）；传工厂函数，由卡片在构造期创建（避免被卡面盖住） */
  extra?: () => any;
};

export function createCard(options: CardOptions): any {
  const { rect, title, id, extra } = options;
  return new ICECard({
    id,
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    title,
    extra,
  });
}

/** 卡片正文区（挖岛用的那块空白）的矩形 */
export function cardBodyRect(rect: Rect): Rect {
  return {
    left: rect.left + CARD_INSET,
    top: rect.top + CARD_TITLE_BAND,
    width: rect.width - CARD_INSET * 2,
    height: rect.height - CARD_TITLE_BAND - CARD_INSET,
  };
}

/** 空节点：只用来占位 / 承载子节点 */
export function emptyBox(rect: Rect): any {
  return new ICEWidget({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    fill: false,
    stroke: false,
    interactive: false,
  });
}
