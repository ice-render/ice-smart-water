/**
 * 画布化外壳 —— 对齐 `ice-web-components/examples/admin.html` 的设计语言：
 * 侧栏（**域**导航 `ICEMenu`）+ 顶栏（标题 / **当前域 + 该域页签** / 状态标签 / 操作按钮）+ 内容区（`ICECard` 栅格），
 * **全部由 ice-web-components 画在同一张画布上**。页面靠 `display` 切换，不销毁重建。
 *
 * 与 admin.html 的两点差异（都是有意的）：
 * 1. **自适应窗口**：画布取 `max(设计尺寸, 窗口尺寸)`，外壳铺满整张画布，不再是固定在 1600×1000 里；
 * 2. **"岛"（island）**：工艺图与图表各自需要一个独立的 `ICE` 实例（设计器的视口变换会带着
 *    整个场景一起位移，图表库自己 new 一个引擎），所以它们是**独立画布**，按外壳坐标绝对定位、
 *    嵌在卡片的"洞"里。见 `islands.ts`。
 */
import { ICE, ICEGridLayout } from 'ice-render';
import {
  ICEAvatar,
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
  ICESegmented,
  ICESeparator,
  ICETag,
  ICEWidget,
  attachTooltip,
  getICEFocusManager,
  iceUIManager,
  mountICEAccessibilityMirror,
} from 'ice-web-components';
import type { PageContent } from './WaterPage';

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

/**
 * 导航的「域」：**侧栏列域，顶栏的页签分段控件列该域下的页**。
 *
 * 为什么分两级：页签多了以后侧栏一屏放不下（`ICEMenu` 没有滚动）。域只是**导航分组** ——
 * `pages` 仍是一张扁平表，`shell.show(pageKey)` 会自动定位到它所属的域、切过去并高亮页签。
 */
export type ShellDomain = {
  key: string;
  label: string;
  iconPath?: string;
  pages: Array<{ key: string; label: string }>;
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
  /** 造一页：**页面自己就是容器**（`PageContent` = 容器 + 几个只读声明），见 `view/WaterPage.ts`。 */
  build: (ctx: PageContext) => PageContent;
};

/**
 * 外壳内部的页面视图：把页面上的**可选**声明补成可调用的形状。
 *
 * 为什么不各自 if 一遍：切页路径上有 5 处要问页面（岛 / 状态标签 / 按钮 / 重算 / 节点）。
 */
type MountedPage = {
  node: any;
  islands: () => IslandSpec[];
  statusTags: () => StatusTagSpec[];
  actions: () => HeaderActionSpec[];
  update: () => void;
};

function toMountedPage(page: PageContent): MountedPage {
  return {
    node: page,
    islands: () => (page.islandSpecs ? page.islandSpecs() : []),
    statusTags: () => (page.statusTags ? page.statusTags() : []),
    actions: () => (page.headerActions ? page.headerActions() : []),
    update: () => {
      if (page.onUpdate) page.onUpdate();
    },
  };
}

export type PageContext = {
  ice: any;
  theme: any;
  layout: ShellLayout;
  toast: (text: string, type?: string) => void;
  notify: (title: string, description: string, type?: string) => void;
};

export type ShellHandle = {
  ice: any;
  /** 顶部消息所在的引擎实例（有覆盖画布时是独立实例，否则与 `ice` 相同） */
  messageIce: any;
  theme: any;
  layout: ShellLayout;
  /** 当前页 key */
  current: () => string;
  /** 当前域 key */
  currentDomain: () => string;
  /**
   * 切页：先定位到它所属的**域**（侧栏高亮跟着走），再切页签、标题、顶栏按钮与岛的显隐。
   */
  show: (key: string) => void;
  /** 切域：跳到该域**上次停留的页**（没有则第一页） */
  showDomain: (key: string) => void;
  /** 导航域定义（只读；测试 / 调试据此按页 key 反查所属域） */
  domains: () => ShellDomain[];
  /** 重排当前页（动态文案改完用它；岛的位置会一并跟着走） */
  refresh: () => void;
  /**
   * 手动设置顶栏状态标签。
   *
   * **一般不用调**：页面在 `statusTags()` 里声明自己的标签，切页与 `refresh()` 时
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
  /**
   * 顶部消息（`toast`）专用的「覆盖画布」。
   *
   * 外壳画布在 DOM 里位于各「岛」画布**之下**，画在外壳工具层上的消息只要堆进岛的区域
   * 就会被岛盖住（ICE 的 zIndex 管不了 DOM 层叠）。传一张在所有岛之上、`pointer-events:none`
   * 的覆盖画布，外壳就会为它单独起一个引擎实例专门画顶部消息。
   * 不传则退回画在外壳画布上（单画布场景的旧行为）。
   */
  messageOverlay?: HTMLCanvasElement;
  brand: string;
  brandSub: string;
  /**
   * 导航的「域」列表。外壳据此**自动生成侧栏的域项**（域项 + 下面的 `menu` 拼成完整侧栏菜单），
   * 以及顶栏那个「本域页签」分段控件。
   */
  domains: ShellDomain[];
  /** 侧栏里**域项之外**的菜单项（都是动作类：切工况 / 筛符号 / 重载案例 / 退出登录） */
  menu: ShellMenuItem[];
  /** 初始页 key（外壳据此决定侧栏高亮哪个域、页签选哪一格） */
  selectedKey: string;
  /**
   * 侧栏**父项**展开 / 收起时的回调。
   *
   * 父项（"运行工况"、"符号分类"）点一下只展开、不触发 `onMenuSelect` —— 这是上游的设计，
   * 但对用户来说就是"点了没反应"。用它补上跳转与提示。
   */
  onMenuExpand?: (key: string, expanded: boolean) => void;
  onMenuSelect: (key: string, item: any) => void;
  /**
   * 切页**之后**调用 —— **页签点击与 `shell.show()` 都会走这里**。
   *
   * 页签是外壳内部直接调 `show()` 的，不经过 `onMenuSelect`；所以"切页后要做的事"
   * （重算业务状态、某页的一次性动作如 `fitViewport`）必须挂在这里，否则从页签切页会漏掉。
   */
  onPageShow?: (key: string) => void;
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

/**
 * 统计卡**一行**（等宽 + 等间距）。
 *
 * 老写法在每个页面里手算：`statWidth = floor((inner.width - gap*(n-1))/n)`，
 * 再 `left = x0 + index * (statWidth + gap)` —— 同一段算术散落在 11 个页面里，
 * 改行宽/卡数就要逐页改公式。这里交给引擎的**等分网格**：行容器持有
 * `ICEGridLayout({ cols, cellSizing: 'equal' })`，卡片的宽度由布局算、加卡删卡自动重排；
 * 卡片内部（见 `ICEStatCard` 的自持策略）也会跟着自己的尺寸走。
 *
 * 行容器的盒子仍来自本页的设计矩形（`layout.inner`），精确构图的语义不变。
 */
export function createStatRow(options: {
  left: number;
  top: number;
  width: number;
  height: number;
  /** 卡片数量（等分列数） */
  count: number;
  /** 列间距 */
  gap: number;
}): ICEWidget {
  const row = new ICEWidget({
    left: options.left,
    top: options.top,
    width: options.width,
    height: options.height,
    fill: false,
    stroke: false,
    interactive: false,
  });
  row.setLayout(
    new ICEGridLayout({
      cols: Math.max(1, Math.floor(options.count) || 1),
      gapX: options.gap,
      gapY: 0,
      cellSizing: 'equal',
    })
  );
  return row;
}

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

  // 顶部消息画到「覆盖画布」（若有）：外壳画布在 DOM 里位于各「岛」之下，画在外壳工具层上的
  // 消息一旦堆进岛的区域就会被岛盖住。覆盖画布在所有岛之上、尺寸与外壳画布一致（坐标才能对齐）。
  let messageIce: any = ice;
  if (options.messageOverlay) {
    const overlay = options.messageOverlay;
    overlay.width = measured.width;
    overlay.height = measured.height;
    overlay.style.width = `${measured.width}px`;
    overlay.style.height = `${measured.height}px`;
    messageIce = new ICE().init(overlay, { renderMode: 'dirty-rect' });
  }

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

  /** 域定义 + 「页 key → 所属域」反查（`show(pageKey)` 靠它自动切域） */
  const domains: ShellDomain[] = options.domains || [];
  const domainOfPage = (pageKey: string): ShellDomain | null =>
    domains.filter((domain) => domain.pages.some((page) => page.key === pageKey))[0] || null;
  /** 侧栏菜单 = **域项**（导航）+ 调用方给的域外项（动作：切工况 / 筛符号 / 重载 / 退出） */
  const menuItems: ShellMenuItem[] = [
    ...domains.map((domain) => ({ key: domain.key, label: domain.label, iconPath: domain.iconPath })),
    ...(options.menu || []),
  ];
  const menu = new ICEMenu({
    id: 'menu',
    left: 16,
    top: 92,
    width: 232,
    items: menuItems,
    selectedKey: (domainOfPage(options.selectedKey) || domains[0] || { key: '' }).key,
    style: { fillStyle: theme.colors.surface },
    onSelect: (item: any) => options.onMenuSelect(item.key, item),
    onExpand: (key: string, expanded: boolean) => {
      if (options.onMenuExpand) options.onMenuExpand(key, expanded);
    },
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
  /**
   * 顶栏第二行 = 两级导航的落脚点：左边是当前**域**名，右边是该域的**页签**（`ICESegmented`）。
   *
   * 放在顶栏（而不是新加一条子栏）：顶栏 64px 的第二行本来就是空的（原面包屑位置），
   * 这样**不用改内容区高度** —— 否则所有页面的卡片 rect 与岛的洞都要跟着下移。
   */
  const domainLabel = new ICELabel({
    id: 'domain-label',
    left: 56,
    top: 36,
    width: 96,
    height: 22,
    verticalAlign: 'middle',
    text: '',
    style: { fontSize: 12, fontWeight: '600', fillStyle: theme.colors.textSecondary },
  });
  header.addChildren([hamburger, pageTitle, domainLabel]);
  ice.addChild(header);

  /**
   * 当前域的页签。**换域时重建**（`ICESegmented` 的 options 只在构造期读一次，没有 setOptions），
   * 同域内切页只 `setValue()` 改高亮。
   */
  const PAGE_TABS_LEFT = 168;
  const PAGE_TABS_TOP = 31;
  const PAGE_TABS_HEIGHT = 28;
  let pageTabs: any = null;
  function renderPageTabs(domain: ShellDomain, activePage: string): void {
    if (pageTabs && pageTabs.parentNode === header) header.removeChild(pageTabs);
    const count = Math.max(1, domain.pages.length);
    pageTabs = new ICESegmented({
      id: 'page-tabs',
      left: PAGE_TABS_LEFT,
      top: PAGE_TABS_TOP,
      width: Math.min(420, Math.max(96, count * 96)),
      height: PAGE_TABS_HEIGHT,
      options: domain.pages.map((page) => ({ value: page.key, label: page.label })),
      value: activePage,
      onChange: (value: string) => show(value),
    });
    header.addChild(pageTabs);
    ice.dirty = true;
  }

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
  const pageNodes: Record<string, MountedPage> = {};
  let currentKey = '';
  let currentPage: ShellPage | null = null;
  let currentHandle: MountedPage | null = null;
  /** 当前域 key（v2 两级导航） */
  let currentDomainKey = '';
  /** 每个域上次停留的页（切域回来时回到原处，而不是永远跳第一页） */
  const lastPageOfDomain: Record<string, string> = {};

  function collectIslands(): void {
    Object.keys(isles).forEach((key) => delete isles[key]);
    (currentHandle ? currentHandle.islands() : []).forEach((island) => {
      isles[island.id] = island.rect;
    });
  }

  function show(key: string): void {
    const page = options.pages.filter((item) => item.key === key)[0];
    if (!page) throw new Error(`没有注册页面：${key}`);
    const domain = domainOfPage(key);
    if (!domain) throw new Error(`页面「${key}」没有归入任何域（检查 ShellOptions.domains）`);
    // 页面节点懒构建：建好之后一直挂着，靠 display 切换（与 admin.html 同策略）
    if (!pageNodes[key]) {
      const mounted = toMountedPage(page.build({ ice, theme, layout, toast, notify }));
      // 先挂载（onMount）再显示（onShow）：顺序反了，页面就拿不到"这是首次显示"这个事件。
      ice.addChild(mounted.node);
      mounted.node.setState({ display: true });
      pageNodes[key] = mounted;
    }
    // 切换显示
    Object.keys(pageNodes).forEach((otherKey) => {
      pageNodes[otherKey].node.setState({ display: otherKey === key });
    });
    currentKey = key;
    currentPage = page;
    currentHandle = pageNodes[key];
    // 两级导航：**换域才重建页签**，同域内切页只改高亮 + 选中的域项
    if (currentDomainKey !== domain.key) {
      renderPageTabs(domain, key);
    } else if (pageTabs) {
      pageTabs.setValue(key);
    }
    currentDomainKey = domain.key;
    lastPageOfDomain[domain.key] = key;
    domainLabel.setText(domain.label);
    menu.setSelectedKey(domain.key);
    pageTitle.setText(page.label);
    setActions(currentHandle ? currentHandle.actions() : []);
    applyPageTags();
    collectIslands();
    if (options.onIslands) options.onIslands(Object.keys(isles).map((id) => ({ id, rect: isles[id] })));
    ice.dirty = true;
    if (options.onPageShow) options.onPageShow(key);
  }

  /** 切域：跳到该域**上次停留的页**（没有则第一页）；已经是当前域就什么都不做。 */
  function showDomain(key: string): void {
    const domain = domains.filter((item) => item.key === key)[0];
    if (!domain || !domain.pages.length) return;
    if (currentDomainKey === key) return;
    show(lastPageOfDomain[key] || domain.pages[0].key);
  }

  /** 取当前页声明的状态标签（页面没声明就清空） */
  function applyPageTags(): void {
    setStatusTags(currentHandle ? currentHandle.statusTags() : []);
  }

  function refresh(): void {
    // 先重排页面内容，再让岛对齐卡片（岛的洞是按卡片矩形算的，卡片动了洞就动）
    if (currentHandle) currentHandle.update();
    applyPageTags();
    ice.dirty = true;
  }

  function toast(text: string, type = 'success'): void {
    // 走「覆盖画布」的实例：顶部消息必须在所有岛之上，否则堆进工艺图区域会被盖住（见 messageOverlay）
    ICEMessage.show(messageIce, text, { type: type as any });
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
    messageIce,
    theme,
    layout,
    current: () => currentKey,
    currentDomain: () => currentDomainKey,
    show,
    showDomain,
    domains: () => domains.slice(),
    refresh,
    setStatusTags,
    setUser,
    toast,
    notify,
    islandRect: (id: string) => isles[id] || null,
    find: (id: string) => findWidget(ice, id),
    destroy(): void {
      if (messageIce !== ice && typeof messageIce.destroy === 'function') messageIce.destroy();
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
 *
 * 口径：
 * - CJK / 全角符号 / 上标数字：一字约 1em；
 * - ASCII（英文、数字、标点、空格、emoji）：按 0.7em 估（实测 0.55 会偏乐观，
 *   因为 `ICELabel` 对 ASCII 词组会按词边界换行，不能把长数字串压在一行）；
 * - `perLine` 再 ×0.9 留安全余量，避免"估 1 行实际 2 行"导致压字。
 */
export function estimateTextHeight(text: string, width: number, fontSize: number, lineHeight: number): number {
  const perLine = Math.max(1, Math.floor((width / fontSize) * 0.9));
  let lines = 0;
  String(text || '')
    .split('\n')
    .forEach((paragraph) => {
      let units = 0;
      for (const char of paragraph) {
        const code = char.charCodeAt(0);
        // CJK 统一表意符号 / 全角符号 / 上标/下标/货币等块（常见中文、日文、韩文、全角标点）
        const cjk =
          (code >= 0x2e80 && code <= 0x9fff) ||
          (code >= 0xac00 && code <= 0xd7ff) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe30 && code <= 0xfe4f) ||
          (code >= 0xff00 && code <= 0xffef);
        units += cjk ? 1 : 0.7;
      }
      lines += Math.max(1, Math.ceil(units / perLine));
    });
  return Math.max(lineHeight, lines * lineHeight);
}

/** 正文段落（自动换行，宽给定、高按内容估） */
export function paragraph(ctx: PageContext, rect: Omit<Rect, 'height'> & { text: string; fontSize?: number; color?: string }): any {
  const fontSize = rect.fontSize || 12;
  const lineHeight = Math.round(fontSize * 1.6);
  const height = estimateTextHeight(rect.text, rect.width, fontSize, lineHeight);
  return new ICELabel({
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height,
    text: rect.text,
    style: { fontSize, wrap: true, lineHeight, fillStyle: rect.color || ctx.theme.colors.textSecondary },
  });
}

/** 小节标题（卡片内部用） */
export function sectionHeading(ctx: PageContext, left: number, top: number, text: string): any {
  const fontSize = 12;
  return new ICELabel({
    left,
    top,
    text,
    height: Math.round(fontSize * 1.6),
    style: { fontSize, fontWeight: '600', fillStyle: ctx.theme.colors.textSecondary },
  });
}

/** 一条要点：`• 文字`，自动换行（可传 fontSize 收紧行高，卡片窄时多塞几条） */
export function bullet(
  ctx: PageContext,
  rect: { left: number; top: number; width: number; text: string; fontSize?: number }
): any {
  return paragraph(ctx, { ...rect, fontSize: rect.fontSize, text: `• ${rect.text}` });
}

/**
 * 给没有设置高度的 ICELabel 补一个合适高度（单行）。
 *
 * `sectionHeading()` 这种只传文本的标题，构造后没有 `height`，`stackColumn` 会把它当成 0 高。
 * 构造完补一下即可。
 */
export function fixLabelHeight(node: any, fontSize: number = 12): void {
  if (node && node.state && !node.state.height) {
    node.setState({ height: Math.round(fontSize * 1.6) });
  }
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

/**
 * 纵向流式布局：按每个节点的**实际高度**依次下排，返回内容总高（最后一项的底边）。
 *
 * 为什么必须有它：卡片正文里的"标题 + 若干段落 + 若干要点"如果靠手算 y 递增，
 * 只要有一处估高偏小就会**压字**（实测踩过：标题 16px 高但按 20px 递增、段落估少一行）。
 * 交给它按 `state.height` 排就不会错；文案变了再调一次即可（幂等）。
 *
 * `gapAfter` 可以对某一项单独加大间距（例如标题下面多留一点）。
 */
export function stackColumn(
  children: any[],
  options: { left?: number; top?: number; width: number; gap?: number; gapAfter?: (index: number) => number }
): number {
  const left = options.left === undefined ? 0 : options.left;
  const gap = options.gap === undefined ? 6 : options.gap;
  let y = options.top === undefined ? 0 : options.top;
  children.forEach((child, index) => {
    child.setState({ left, top: y, width: options.width });
    y += (Number(child.state.height) || 0) + gap + (options.gapAfter ? options.gapAfter(index) : 0);
  });
  return y - gap;
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
