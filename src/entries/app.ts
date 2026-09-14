/**
 * 唯一入口 —— `index.html`（整个系统只有一个 HTML，所有功能都在这张画布外壳里）。
 *
 * 三层结构：
 * 1. **画布外壳**（`view/shell.ts`）：侧栏 `ICEMenu` + 顶栏（标题 / 面包屑 / 状态标签 / 操作按钮）
 *    + 内容卡片栅格 —— 全部由 ice-web-components 画在同一张画布上；
 * 2. **三个页签**：工艺流程图 / 运行数据 / 符号库。切页是 `display` 切换，不重新加载页面，
 *    连"符号库"也在这个壳里（以前是两个 HTML，现在是一个）；
 * 3. **三个岛**（独立画布 + 独立 `ICE` 实例）：工艺图（设计器）、24 小时看板（`ice-chart`）、
 *    符号图例（设计器）。它们各自需要自己的引擎实例，所以按外壳坐标绝对定位、嵌在卡片挖的洞里。
 *
 * 再外面盖一层**登录门**（`view/login.ts`）：不透明的覆盖画布，登录成功后整层隐藏。
 * 应用是**先建好再被盖住**的 —— 顺序上省掉了一整类"登录后才初始化"的时序坑。
 *
 * 业务依旧只在 `src/domain`：本文件把图交给 domain 算，再把结果喂回画布控件。
 */
import { ICE } from 'ice-render';
import { WATER_SYMBOL_PRESETS, WaterProcessDesigner } from 'ice-entity-designer';
import {
  DEFAULT_MODE_ID,
  NORMALLY_CLOSED_VALVES,
  SEWAGE_PLANT,
  SYMBOL_CATALOG,
  auditPlant,
  categoryStats,
  computeHydraulics,
  computeKpi,
  designMap,
  evaluateQualityChain,
  isIdleInMode,
  modeById,
  scaledBy,
  simulateDay,
  targetValveState,
  traceProcessFlow,
  type AuditIssue,
  type DayPoint,
  type FlowTrace,
  type LegendFilter,
  type OperatingModeId,
  type PlantKpi,
  type SymbolEntry,
  type UnitHydraulics,
} from '../domain';
import {
  avatarTextOf,
  computeLayout,
  measureCanvas,
  mountShell,
  type IslandSpec,
  type PageContext,
  type ShellLayout,
} from '../view/shell';
import { mountIsland, placeIslands, type IslandHandle } from '../view/islands';
import { installViewport } from '../view/canvas-viewport';
import { clearLoginUser, mountLogin, readLoginUser, saveLoginUser } from '../view/login';
import { dailyTrendOption, mountChart } from '../view/board';
import { SymbolLegend, cellAt } from '../view/symbol-legend';
import { buildProcessPage, processIslandRect } from '../view/pages/process-page';
import { boardIslandRect, buildDataPage } from '../view/pages/data-page';
import { buildLegendPage, legendIslandRect, type LegendPageHandle } from '../view/pages/legend-page';
import { graphOfDesigner } from '../view/adapter';

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少 DOM 节点 #${id}`);
  return node as T;
}

/* ================= 版面与三个岛 ================= */

const measured = measureCanvas();
const layout: ShellLayout = computeLayout(measured.width, measured.height);

const islands: Record<string, IslandHandle> = {
  process: mountIsland('process', need<HTMLCanvasElement>('canvas-process')),
  board: mountIsland('board', need<HTMLCanvasElement>('canvas-board')),
  legend: mountIsland('legend', need<HTMLCanvasElement>('canvas-legend')),
};
// 先把三个岛摆到位再建引擎：引擎初始化要读画布尺寸，摆之前是 0×0
islands.process.place(processIslandRect(layout));
islands.board.place(boardIslandRect(layout));
islands.legend.place(legendIslandRect(layout));

/* ================= 岛 1：工艺图（设计器） ================= */

const graphIce = new ICE().init(islands.process.canvas, { renderMode: 'dirty-rect' });
const designer = new WaterProcessDesigner(graphIce);
const viewport = installViewport({ ice: graphIce, canvas: islands.process.canvas, designer, padding: 56 });

/* ================= 岛 3：符号图例（同一个域设计器，另一张画布） ================= */

const legendIce = new ICE().init(islands.legend.canvas, { renderMode: 'dirty-rect' });
const legendDesigner = new WaterProcessDesigner(legendIce);
const legendViewport = installViewport({ ice: legendIce, canvas: islands.legend.canvas, designer: legendDesigner, padding: 40 });
const legend = new SymbolLegend({ ice: legendIce, designer: legendDesigner });
let legendFilter: LegendFilter = 'all';
let legendPage: LegendPageHandle | null = null;

/* ================= 业务状态 ================= */

const meta = SEWAGE_PLANT.meta;
const designs = designMap(SEWAGE_PLANT);

let modeId: OperatingModeId = DEFAULT_MODE_ID;
let kpi: PlantKpi = computeKpi(graphOfDesigner(designer), designs, meta);
let issues: AuditIssue[] = [];
let trace: FlowTrace = { connected: false, path: [], pipePath: [] };
let dayPoints: DayPoint[] = [];
let hydraulics: UnitHydraulics[] = [];

/* ================= 岛 2：24 小时看板（ice-chart） ================= */

const board = mountChart(islands.board.canvas, () =>
  dailyTrendOption(dayPoints, { modeLabel: modeById(modeId).label, standard: meta.standard })
);

function snapshot() {
  return {
    kpi,
    issues,
    trace,
    points: dayPoints,
    hydraulics,
    mode: modeById(modeId),
    modeLabel: modeById(modeId).label,
    idleCount: graphOfDesigner(designer).nodes.filter((node) => node.idle).length,
  };
}

/* ================= 案例装载与工况 ================= */

function buildCase(): void {
  designer.clear();
  SEWAGE_PLANT.units.forEach((unit) => {
    designer.createSymbol(unit.kind, { id: unit.id, name: unit.name, tag: unit.tag, left: unit.left, top: unit.top });
  });
  SEWAGE_PLANT.pipes.forEach((pipe) => {
    designer.createPipe({
      id: pipe.id,
      sourceId: pipe.sourceId,
      targetId: pipe.targetId,
      medium: pipe.medium,
      dn: pipe.dn,
      sourcePort: pipe.sourcePort || 'R',
      targetPort: pipe.targetPort || 'L',
    });
  });
  designer.select(null);
  designer.resetHistory();
}

/** 把工况铺到设计器上（画布是唯一真相，业务重算从画布读） */
function setMode(next: OperatingModeId): void {
  modeId = next;
  const mode = modeById(next);
  designer.nodes.forEach((node: any) => {
    if (node.state.kind === 'valve') {
      const target = targetValveState(mode, node.state.id);
      if (node.state.valveState !== target) designer.setValveState(node.state.id, target);
    }
    const idle = isIdleInMode(mode, node.state.id);
    if (!!node.state.idle !== idle) node.applyPatch({ idle });
  });
  graphIce.dirty = true;
  recompute();
}

/* ================= 重算 ================= */

let pending = false;
function scheduleRecompute(): void {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    recompute();
  });
}

function recompute(): void {
  const graph = graphOfDesigner(designer);
  const mode = modeById(modeId);
  const inflow = meta.capacity * mode.inflowFactor;
  const influent = scaledBy(meta.influent, mode.qualityFactor);

  kpi = computeKpi(graph, designs, meta, { inflow, influent });
  const chain = evaluateQualityChain(graph, meta, influent);
  hydraulics = computeHydraulics(graph, designs, meta, kpi.inflow, kpi.sludge.wasteSludgeFlow);
  issues = auditPlant({ graph, designs, meta, mode, kpi, chain, hydraulics });
  dayPoints = simulateDay(graph, designs, meta, mode);
  trace = traceProcessFlow(graph, { deprioritizedNodes: NORMALLY_CLOSED_VALVES });

  if (islands.board.visible()) board.refresh();
  shell.refresh();
  graphIce.dirty = true;
}

/* ================= 符号图例 ================= */

/** 当前选中的符号（null 表示没选） */
let selectedSymbol: SymbolEntry | null = null;

function matchedSymbols(): number {
  return legend.getLayout().cells.length;
}

/** 重画图例（换筛选、导出之后都要重来一遍） */
function renderLegend(): void {
  legend.render(legendFilter);
  legendViewport.sizeCanvas();
  legendViewport.fitViewport();
  selectedSymbol = null;
  if (legendPage) legendPage.setSelection(null, matchedSymbols());
}

function selectSymbol(entry: SymbolEntry): void {
  selectedSymbol = entry;
  legend.highlight(entry.kind);
  if (legendPage) legendPage.setSelection(entry, matchedSymbols());
  shell.toast(`${entry.label}（${entry.kind}）· 位号代号 ${entry.tag}`, 'info');
}

/**
 * 换筛选：一条状态、两个入口（侧栏「符号分类」菜单 / 页面里的分段控件）都要同步。
 * `openPage` 为真时顺带切到符号库页（菜单入口）。
 */
function applyLegendFilter(next: LegendFilter, openPage = false): void {
  legendFilter = next;
  renderLegend();
  if (legendPage) legendPage.setFilter(next, matchedSymbols());
  if (openPage) shell.show('legend');
  shell.refresh();
}

/* ================= 页级 / 全局动作 ================= */

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function handleAction(key: string): void {
  switch (key) {
    case 'valve': {
      const node = designer.nodes.filter((item: any) => item.state.id === designer.selectedId)[0];
      if (!node || node.state.kind !== 'valve') {
        shell.toast('先在图上选中一台阀门', 'warning');
        return;
      }
      const next = node.state.valveState === 'closed' ? 'open' : 'closed';
      designer.setValveState(node.state.id, next);
      recompute();
      shell.toast(`${node.state.tag} 已${next === 'closed' ? '关闭' : '开启'}`, 'info');
      return;
    }
    case 'trace': {
      recompute();
      if (trace.connected) shell.toast(`进水可到出水：途经 ${trace.path.length} 个单元、${trace.pipePath.length} 段管线`);
      else shell.toast(trace.blockedAt ? `断流：卡在关断的阀门 ${trace.blockedAt}` : '断流：主流程未接通', 'error');
      return;
    }
    case 'validate': {
      const found = designer.validateWater();
      if (!found.length) {
        shell.toast('图纸校验通过：位号唯一、管线标注齐全、流径通畅');
        return;
      }
      shell.notify(
        `图纸校验发现 ${found.length} 个问题`,
        found
          .slice(0, 3)
          .map((issue: any) => issue.message)
          .join('；'),
        'warning'
      );
      return;
    }
    case 'fit':
      viewport.sizeCanvas();
      viewport.fitViewport();
      return;
    case 'reset':
      viewport.reset();
      return;
    case 'export-svg': {
      const svg = designer.toSvg({ padding: 16, background: '#ffffff' });
      (window as any).__exportedSvg = svg;
      download('wastewater-aao-process.svg', svg, 'image/svg+xml');
      shell.toast('已导出 SVG');
      return;
    }
    case 'export-json': {
      const json = designer.serialize();
      (window as any).__exportedJson = json;
      download('wastewater-aao-process.json', json, 'application/json');
      shell.toast('已导出 JSON 快照');
      return;
    }
    case 'import-json': {
      const json = (window as any).__exportedJson;
      if (!json) {
        shell.toast('先「导出 JSON」一次再导入（演示快照往返）', 'warning');
        return;
      }
      const report = designer.load(json);
      viewport.fitViewport();
      recompute();
      shell.toast(`已导入 ${report.nodes} 个符号 / ${report.edges} 段管线`);
      return;
    }
    case 'reload': {
      buildCase();
      setMode(DEFAULT_MODE_ID);
      viewport.fitViewport();
      shell.show('process');
      recompute();
      shell.toast('已重载示范案例');
      return;
    }
    default:
      return;
  }
}

/* ================= 符号库页的动作（导出只留符号本身） ================= */

function handleLegendAction(key: string): void {
  if (key === 'fit') {
    legendViewport.sizeCanvas();
    legendViewport.fitViewport();
    return;
  }
  if (key === 'reset') {
    legendViewport.reset();
    return;
  }
  // 导出前摘掉排版辅助件（单元格底、标题、分类小标题），只留符号本身；导完立刻恢复画面
  legend.stripChrome();
  const svg = legendDesigner.toSvg({ padding: 16, background: '#ffffff' });
  (window as any).__exportedSvg = svg;
  const keep = selectedSymbol;
  renderLegend();
  if (keep) selectSymbol(SYMBOL_CATALOG[keep.kind]);
  shell.toast(`已导出 SVG（${svg.length} 字节），画面已恢复`);
}

/* ================= 外壳（单页三页签） ================= */

const shell = mountShell({
  canvas: need<HTMLCanvasElement>('canvas-shell'),
  brand: 'ice-smart-water',
  brandSub: '示范厂 10 万 m³/d · AAO + 混凝沉淀 + 滤布滤池 + 消毒 · 执行 GB 18918-2002 一级 A',
  footer: { avatar: 'SW', name: '示范厂 WWTP-100K', role: '智慧水务运行控制台' },
  menu: [
    { key: 'process', label: '工艺流程图', iconPath: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
    { key: 'data', label: '运行数据', iconPath: 'M3 3v18h18M7 15l4-5 3 3 5-7' },
    {
      key: 'legend',
      label: '符号库',
      iconPath: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
    },
    {
      key: 'mode',
      label: '运行工况',
      iconPath: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
      children: [
        { key: 'mode:normal', label: '正常运行' },
        { key: 'mode:rain', label: '雨季超越' },
        { key: 'mode:maintenance', label: '检修停运' },
      ],
    },
    {
      key: 'cats',
      label: '符号分类',
      iconPath: 'M4 6h16M4 12h16M4 18h10',
      children: [
        { key: 'filter:all', label: '全部符号' },
        { key: 'filter:water', label: '水线处理单元' },
        { key: 'filter:sludge', label: '污泥线单元' },
        { key: 'filter:equipment', label: '设备与仪表' },
        { key: 'filter:boundary', label: '边界符号' },
      ],
    },
    {
      key: 'reload',
      label: '重载示范案例',
      iconPath: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15',
    },
    { key: 'logout', label: '退出登录', iconPath: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9' },
  ],
  selectedKey: 'process',
  onMenuSelect: (key: string) => {
    if (key.indexOf('mode:') === 0) {
      const next = key.replace('mode:', '') as OperatingModeId;
      setMode(next);
      shell.toast(`已切到「${modeById(next).label}」`);
      return;
    }
    if (key.indexOf('filter:') === 0) {
      const next = key.replace('filter:', '') as LegendFilter;
      applyLegendFilter(next, true);
      shell.toast(`符号筛选：${next === 'all' ? '全部符号' : next}`);
      return;
    }
    if (key === 'reload') {
      handleAction('reload');
      return;
    }
    if (key === 'logout') {
      logout();
      return;
    }
    shell.show(key);
    recompute();
    if (key === 'legend') legendViewport.fitViewport();
  },
  pages: [
    {
      key: 'process',
      label: '工艺流程图',
      build: (ctx: PageContext) => buildProcessPage(ctx, { snapshot, onModeChange: setMode, onAction: handleAction }),
    },
    {
      key: 'data',
      label: '运行数据',
      build: (ctx: PageContext) => buildDataPage(ctx, { snapshot }),
    },
    {
      key: 'legend',
      label: '符号库',
      build: (ctx: PageContext) => {
        legendPage = buildLegendPage(ctx, {
          initialFilter: legendFilter,
          onFilterChange: (next: LegendFilter) => applyLegendFilter(next),
          onAction: handleLegendAction,
        });
        return legendPage;
      },
    },
  ],
  onIslands: (specs: IslandSpec[]) => {
    placeIslands(islands, specs);
    // 看板是懒刷新的：它在别的页签里一直隐藏着，第一次显示出来要补 resize + refresh
    if (specs.some((spec) => spec.id === 'board')) {
      requestAnimationFrame(() => {
        board.resize();
        board.refresh();
      });
    }
    // 图例岛同理：第一次显示出来时画布尺寸才对得上
    if (specs.some((spec) => spec.id === 'legend')) {
      requestAnimationFrame(() => {
        legendViewport.sizeCanvas();
        legendViewport.fitViewport();
      });
    }
  },
  fabItems: [
    { key: 'fit', icon: '⌖' },
    { key: 'export-svg', icon: '↧' },
    { key: 'export-json', icon: '▤' },
    { key: 'import-json', icon: '↥' },
  ],
  onFabItem: handleAction,
});

designer.subscribe(() => scheduleRecompute());

/* ================= 图例上的点选 ================= */

islands.legend.canvas.addEventListener('click', (event) => {
  const cell = cellAt(legend.getLayout(), event.offsetX, event.offsetY);
  if (!cell) return;
  selectSymbol(cell.entry);
});

/* ================= 登录门 ================= */

const login = mountLogin({
  canvas: need<HTMLCanvasElement>('canvas-login'),
  size: layout.canvas,
  onLogin: (user) => enterApp(user.name),
});

/** 进入应用：记住登录态、把用户带到侧栏署名上、揭开登录层 */
function enterApp(name: string): void {
  saveLoginUser({ name });
  shell.setUser({ name, role: '示范厂 WWTP-100K · 已登录' });
  login.hide();
  // 岛在登录层下面，被盖着的时候已经建好了；这里只需按当前页把两个引擎对齐一次
  requestAnimationFrame(() => {
    viewport.sizeCanvas();
    viewport.fitViewport();
    legendViewport.sizeCanvas();
    legendViewport.fitViewport();
    if (islands.board.visible()) {
      board.resize();
      board.refresh();
    }
  });
  recompute();
  shell.toast(`欢迎，${name}`);
}

/** 退出登录：清状态、揭开登录层、回到首页签 */
function logout(): void {
  clearLoginUser();
  login.show();
  shell.show('process');
}

/* ================= 启动 ================= */

buildCase();
renderLegend();
shell.show('process');
requestAnimationFrame(() => {
  viewport.sizeCanvas();
  viewport.fitViewport();
  recompute();
});

// 有登录态（同一标签页刷新）就直接进；否则停在登录页
const remembered = readLoginUser();
if (remembered) enterApp(remembered.name);
else login.show();

// 端到端测试与人工排查的观察点。
//
// 业务状态用 **getter** 暴露：`__water` 只建一次，`recompute()` 改了模块级变量之后
// 读到的就是最新值 —— 在 recompute 里反复重建这个对象则会互相覆盖（踩过）。
(window as any).__login = login;
(window as any).__water = {
  shell,
  designer,
  graphIce,
  islands,
  layout,
  board,
  legend,
  legendDesigner,
  legendIce,
  presets: WATER_SYMBOL_PRESETS,
  symbolStats: categoryStats(),
  symbolTotal: Object.keys(SYMBOL_CATALOG).length,
  currentFilter: () => legendFilter,
  selectedSymbol: () => selectedSymbol,
  matchedSymbols,
  applyLegendFilter,
  get kpi() {
    return kpi;
  },
  get issues() {
    return issues;
  },
  get trace() {
    return trace;
  },
  get dayPoints() {
    return dayPoints;
  },
  get hydraulics() {
    return hydraulics;
  },
  get modeId() {
    return modeId;
  },
};
