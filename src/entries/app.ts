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
import {
  AERATION_ZONES,
  DEFAULT_SCENARIO,
  LIVE_SIGNALS,
  buildAlarmEvents,
  createSignalRandom,
  createZoneMatrix,
  denitrificationCeiling,
  evaluateScenario,
  initialSignalValues,
  rollZoneMatrix,
  sampleSignals,
  summarizeReadings,
  summarizeAlarms,
  zoneMatrixData,
  ackAlarm,
  closeAlarm,
  type AlarmEvent,
  type ScenarioParams,
  type ScenarioResult,
  type SignalReading,
} from '../domain';
import { SymbolLegend, cellAt } from '../view/symbol-legend';
import { buildProcessPage, processIslandRect } from '../view/pages/process-page';
import { boardIslandRect, buildDataPage } from '../view/pages/data-page';
import { buildLegendPage, legendIslandRect, type LegendPageHandle } from '../view/pages/legend-page';
import {
  buildLivePage,
  gaugeIslandRect,
  heatIslandRect,
  liveTrendIslandRect,
  type LivePageHandle,
} from '../view/pages/live-page';
import { buildCalcPage, curveIslandRect, type CalcPageHandle } from '../view/pages/calc-page';
import { buildEventsPage, type EventsPageHandle } from '../view/pages/events-page';
import { graphOfDesigner } from '../view/adapter';
import { getSelectedUnit, inspectorProbe, onUnitSelect, selectUnit, setInspectorSource } from '../view/selection';

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
  'live-trend': mountIsland('live-trend', need<HTMLCanvasElement>('canvas-live-trend')),
  'live-gauge': mountIsland('live-gauge', need<HTMLCanvasElement>('canvas-live-gauge')),
  'live-heat': mountIsland('live-heat', need<HTMLCanvasElement>('canvas-live-heat')),
  'calc-curve': mountIsland('calc-curve', need<HTMLCanvasElement>('canvas-calc-curve')),
};
// 先把所有岛摆到位再建引擎：引擎初始化要读画布尺寸，摆之前是 0×0
islands.process.place(processIslandRect(layout));
islands.board.place(boardIslandRect(layout));
islands.legend.place(legendIslandRect(layout));
islands['live-trend'].place(liveTrendIslandRect(layout));
islands['live-gauge'].place(gaugeIslandRect(layout));
islands['live-heat'].place(heatIslandRect(layout));
islands['calc-curve'].place(curveIslandRect(layout));

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

/* ================= 岛 4~7：实时监视的三张图 + 试算曲线 ================= */

const LIVE_WINDOW = 120; // 趋势滑动窗口点数
const HEAT_COLUMNS = 24; // 热力图时间片数

/** 实时趋势：三条曲线（流量 / 溶解氧 / 出水氨氮），双 y 轴 */
const liveTrend = mountChart(islands['live-trend'].canvas, () => ({
  title: { text: '实时趋势', subtext: '滑动窗口 · 新点从右侧进入' },
  theme: 'light',
  legend: { show: true, position: 'top' },
  tooltip: { trigger: 'axis' },
  crosshair: { show: true, axis: 'x', showAxisLabel: true },
  xAxis: { type: 'value', name: '采样点' },
  yAxis: [
    { name: '流量 m³/h', min: 2000, max: 6500 },
    { name: '浓度 mg/L', position: 'right', min: 0, max: 8 },
  ],
  animation: { enter: { duration: 300, easing: 'easeOutCubic' } },
  series: [
    { id: 'inflow', type: 'area', name: '进水流量', data: [], color: '#0d6efd', areaOpacity: 0.16, lineWidth: 1.6, smooth: 0.25 },
    { id: 'do', type: 'line', name: '溶解氧', yAxisIndex: 1, data: [], color: '#198754', lineWidth: 2, smooth: 0.25 },
    { id: 'nh3n', type: 'line', name: '出水氨氮', yAxisIndex: 1, data: [], color: '#dc3545', lineWidth: 2, smooth: 0.25 },
  ],
}) as any);

/** 关键仪表：指针弹簧跟随 */
const liveGauge = mountChart(islands['live-gauge'].canvas, () => ({
  title: { text: '好氧池溶解氧', subtext: '目标 2.0 mg/L' },
  theme: 'light',
  tooltip: { trigger: 'item' },
  gauge: {
    min: 0,
    max: 5,
    splitNumber: 5,
    lineWidth: 14,
    axisLineColor: [
      [0.2, '#dc3545'],
      [0.3, '#ffc107'],
      [0.75, '#198754'],
      [1, '#0d6efd'],
    ],
    pointer: { show: true, width: 6, length: 0.72 },
    detail: { formatter: (value: number) => `${value.toFixed(2)}`, fontSize: 26 },
    title: { show: false },
  },
  series: [{ id: 'g', type: 'gauge', name: '溶解氧', data: [{ name: '溶解氧', value: 2.0 }] }],
}) as any);

/** 分区溶解氧热力图：每两拍左移一列 */
let heatMatrix = createZoneMatrix(HEAT_COLUMNS, AERATION_ZONES.length, 20260914);
const liveHeat = mountChart(islands['live-heat'].canvas, () => ({
  title: { text: '生化池分区溶解氧', subtext: `最近 ${HEAT_COLUMNS} 个时间片` },
  theme: 'light',
  legend: { show: false },
  tooltip: { trigger: 'item' },
  xAxis: { type: 'category', data: Array.from({ length: HEAT_COLUMNS }, (_, index) => `T${index + 1}`) },
  yAxis: { type: 'category', data: AERATION_ZONES },
  grid: { x: false, y: false },
  animation: { enter: { duration: 300 }, update: { duration: 180, easing: 'linear' } },
  series: [{ id: 'heat', type: 'heatmap', name: '溶解氧', data: zoneMatrixData(heatMatrix, AERATION_ZONES) }],
}) as any);

/** 试算曲线：理论上界 + 修正后能力（都是 function 系列）+ 当前工作点 */
let curveOptionOf = () => ({ series: [] as any[] });
const calcCurve = mountChart(islands['calc-curve'].canvas, () => curveOptionOf() as any);

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

/* ================= 实时监视：采样循环 ================= */

let signalRandom = createSignalRandom(20260914);
let signalValues = initialSignalValues(LIVE_SIGNALS);
let liveReadings: SignalReading[] = [];
let liveRunning = true;
let liveSpeed = 1;
let liveSamples = 0;
let liveTimer: any = null;
let livePage: LivePageHandle | null = null;

/** 跑一拍：采样 → 推曲线 → 更新仪表与热力图 → 刷新读数卡 */
function liveTick(): void {
  const sampled = sampleSignals(LIVE_SIGNALS, signalValues, signalRandom);
  signalValues = sampled.values;
  liveReadings = sampled.readings;
  liveSamples += 1;

  const byId = (id: string) => sampled.readings.filter((reading) => reading.id === id)[0];
  const inflow = byId('inflow');
  const oxygen = byId('do');
  const ammonia = byId('nh3n');
  if (inflow && oxygen && ammonia) {
    liveTrend.chart.appendData('inflow', [[liveSamples, Number(inflow.value.toFixed(1))]], { maxPoints: LIVE_WINDOW });
    liveTrend.chart.appendData('do', [[liveSamples, Number(oxygen.value.toFixed(2))]], { maxPoints: LIVE_WINDOW });
    liveTrend.chart.appendData('nh3n', [[liveSamples, Number(ammonia.value.toFixed(2))]], { maxPoints: LIVE_WINDOW });
    liveGauge.chart.setData('g', [{ name: '溶解氧', value: Number(oxygen.value.toFixed(2)) }]);
  }
  // 热力图每两拍左移一列（与图表的 180ms 更新动画配合，不闪）
  if (liveSamples % 2 === 0) {
    heatMatrix = rollZoneMatrix(heatMatrix, signalRandom, AERATION_ZONES.length);
    liveHeat.chart.setData('heat', zoneMatrixData(heatMatrix, AERATION_ZONES));
  }
  const summary = summarizeReadings(liveReadings);
  if (livePage) livePage.update(liveReadings, summary);
  shell.ice.dirty = true;
}

function liveStart(): void {
  if (liveTimer) return;
  liveRunning = true;
  liveTimer = setInterval(liveTick, Math.max(120, 500 / liveSpeed));
  if (livePage) livePage.setRunning(true);
}

function livePause(): void {
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = null;
  liveRunning = false;
  if (livePage) livePage.setRunning(false);
  shell.refresh();
}

function liveToggle(): void {
  if (liveRunning) livePause();
  else liveStart();
  shell.refresh();
}

function liveSetSpeed(speed: number): void {
  liveSpeed = speed;
  if (liveTimer) {
    clearInterval(liveTimer);
    liveTimer = null;
    liveStart();
  }
}

/* ================= 工艺试算：参数与结果 ================= */

let scenarioParams: ScenarioParams = { ...DEFAULT_SCENARIO };
let scenarioResult: ScenarioResult = evaluateScenario(scenarioParams);
let calcPage: CalcPageHandle | null = null;

/** 试算曲线：两条函数曲线（理论上界 / 修正后能力）+ 当前工作点 */
function curveOption(): any {
  const { returnRatio, internalRatio } = scenarioParams;
  const k = scenarioResult.temperatureFactor * scenarioResult.srtFactor;
  return {
    title: { text: '脱氮能力 vs 污泥回流比 R', subtext: `内回流比 r = ${internalRatio} · 修正系数 k = ${k.toFixed(2)}` },
    theme: 'light',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    crosshair: { show: true, axis: 'x', showAxisLabel: true },
    xAxis: { type: 'value', name: 'R', min: 0.3, max: 2.5 },
    yAxis: { name: '脱氮率 %', min: 0, max: 100 },
    animation: { enter: { duration: 400 }, update: { duration: 260, easing: 'easeOutCubic' } },
    series: [
      {
        id: 'ceiling',
        type: 'function',
        name: '理论上界 (R+r)/(1+R+r)',
        expression: '(x + r) / (1 + x + r) * 100',
        domain: [0.3, 2.5],
        params: { r: internalRatio },
        color: '#0d6efd',
        lineWidth: 2.4,
      },
      {
        id: 'capability',
        type: 'function',
        name: '修正后能力（温度 / 泥龄）',
        expression: '(x + r) / (1 + x + r) * 100 * k',
        domain: [0.3, 2.5],
        params: { r: internalRatio, k },
        color: '#fd7e14',
        lineWidth: 2,
        lineDash: [6, 4],
      },
      {
        id: 'demo',
        type: 'function',
        name: '参数扫动演示（r 在 1~3 之间来回）',
        expression: '(x + rr) / (1 + x + rr) * 100',
        domain: [0.3, 2.5],
        params: { rr: 2 },
        sweep: { name: 'rr', from: 1, to: 3, duration: 4200, mode: 'pingpong' },
        color: '#94a3b8',
        lineWidth: 1.4,
      },
      {
        id: 'point',
        type: 'scatter',
        name: '当前工作点',
        data: [[returnRatio, Number((scenarioResult.removalRate * 100).toFixed(1))]],
        color: '#dc3545',
        symbolSize: 9,
      },
    ],
  };
}

function applyScenario(next: ScenarioParams): void {
  scenarioParams = next;
  scenarioResult = evaluateScenario(next);
  if (calcPage) calcPage.apply(scenarioResult);
  calcCurve.chart.setOption(curveOption(), { animate: true, preserveView: true });
  shell.refresh();
}

/* ================= 事件中心：报警状态 ================= */

let alarms: AlarmEvent[] = [];
let eventsPage: EventsPageHandle | null = null;
let operatorName = '值班员';

function refreshAlarms(): void {
  alarms = buildAlarmEvents({ issues, points: dayPoints, mode: modeById(modeId), meta });
  if (eventsPage) eventsPage.reload();
}

/** 报警关联单元在不在工艺图上（事件中心「定位」按钮的可用性判断） */
function canLocateUnit(unitId: string): boolean {
  return graphOfDesigner(designer).nodes.some((node: any) => node.id === unitId);
}

/** 跨视图联动：从事件中心跳到工艺图，并选中该报警关联的单元（同一选择总线驱动右侧检视） */
function locateUnit(unitId: string): void {
  if (!canLocateUnit(unitId)) {
    shell.toast('该报警单元不在工艺图上', 'warning');
    return;
  }
  shell.show('process');
  selectUnit(unitId, { source: 'events' });
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
  refreshAlarms();
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
  // 跨视图联动：在符号库里选中一个符号 → 工艺图上同类型的真实单元一并被选中
  // （走统一选择总线，右侧检视面板随之切换；与事件中心「定位」共用同一份选中状态）
  const unit = graphOfDesigner(designer).nodes.find((node: any) => node.kind === entry.kind);
  if (unit) selectUnit(unit.id, { source: 'legend' });
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
  // 顶部消息画到覆盖画布上（在所有「岛」之上），否则堆进工艺图区域会被岛画布盖住
  messageOverlay: need<HTMLCanvasElement>('canvas-overlay'),
  brand: 'ice-smart-water',
  brandSub: '示范厂 10 万 m³/d · AAO + 混凝沉淀 + 滤布滤池 + 消毒 · 执行 GB 18918-2002 一级 A',
  footer: { avatar: 'SW', name: '示范厂 WWTP-100K', role: '智慧水务运行控制台' },
  menu: [
    { key: 'process', label: '工艺流程图', iconPath: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
    { key: 'data', label: '运行数据', iconPath: 'M3 3v18h18M7 15l4-5 3 3 5-7' },
    { key: 'live', label: '实时监视', iconPath: 'M22 12h-4l-3 9L9 3l-3 9H2' },
    { key: 'calc', label: '工艺试算', iconPath: 'M9 3H5a2 2 0 0 0-2 2v4m0 6v4a2 2 0 0 0 2 2h4m6 0h4a2 2 0 0 0 2-2v-4m0-6V5a2 2 0 0 0-2-2h-4M7 12h10' },
    { key: 'events', label: '事件中心', iconPath: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0' },
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
  /**
   * 父项只展开、不触发 onMenuSelect（上游设计）：这里补上"跳转 + 提示"。
   *
   * 不补的话，点「运行工况」「符号分类」在界面上**没有任何变化** —— 用户会以为菜单坏了。
   * 现在点父项就跳到该组最相关的那一页，并提示"展开后选一个"。
   */
  onMenuExpand: (key: string, expanded: boolean) => {
    if (!expanded) return;
    if (key === 'mode') {
      shell.show('process');
      recompute();
      shell.toast('运行工况已展开：选「正常运行 / 雨季超越 / 检修停运」，图上阀位与运行要点会跟着变');
      return;
    }
    if (key === 'cats') {
      shell.show('legend');
      shell.toast('符号分类已展开：选一个分类看对应图例');
    }
  },
  onMenuSelect: (key: string) => {
    if (key.indexOf('mode:') === 0) {
      const next = key.replace('mode:', '') as OperatingModeId;
      setMode(next);
      // 切工况的"结果"在工艺流程图页最直观（阀位、指标、审计），顺手跳过去，别让用户以为没反应
      shell.show('process');
      shell.toast(`已切到「${modeById(next).label}」：图上阀位、5 张指标卡与运行要点已更新`);
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
    if (key === 'calc') applyScenario({ ...scenarioParams });
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
      key: 'live',
      label: '实时监视',
      build: (ctx: PageContext) => {
        livePage = buildLivePage(ctx, {
          onToggleRunning: liveToggle,
          onSpeedChange: liveSetSpeed,
          isRunning: () => liveRunning,
        });
        return livePage;
      },
    },
    {
      key: 'calc',
      label: '工艺试算',
      build: (ctx: PageContext) => {
        calcPage = buildCalcPage(ctx, {
          initial: scenarioParams,
          onChange: applyScenario,
          onReset: () => applyScenario({ ...DEFAULT_SCENARIO }),
          result: () => scenarioResult,
        });
        calcPage.apply(scenarioResult);
        calcPage.syncControls(scenarioParams);
        return calcPage;
      },
    },
    {
      key: 'events',
      label: '事件中心',
      build: (ctx: PageContext) => {
        eventsPage = buildEventsPage(ctx, {
          events: () => alarms,
          onAck: (id) => {
            alarms = ackAlarm(alarms, id, operatorName);
          },
          onClose: (id) => {
            alarms = closeAlarm(alarms, id, operatorName);
          },
          operator: () => operatorName,
          // 跨视图联动：事件中心「定位」→ 跳工艺图并走统一选择总线选中关联单元
          onLocate: locateUnit,
          canLocate: canLocateUnit,
        });
        return eventsPage;
      },
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
    // 实时三图与试算曲线：懒显示，第一次露出来补一次尺寸对齐 + 首帧数据
    if (specs.some((spec) => spec.id === 'live-trend')) {
      requestAnimationFrame(() => {
        liveTrend.resize();
        liveTrend.refresh();
        liveGauge.resize();
        liveGauge.refresh();
        liveHeat.resize();
        liveHeat.refresh();
        if (!liveSamples) liveTick();
      });
    }
    if (specs.some((spec) => spec.id === 'calc-curve')) {
      requestAnimationFrame(() => {
        calcCurve.resize();
        calcCurve.refresh();
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

let suppressRecompute = false;

// 设计器里的任何变更（拖拽 / 改阀 / 载入 / undo / redo）→ 重算（除非是"选择联动"主动压制的那一次）
designer.subscribe(() => {
  if (suppressRecompute) {
    suppressRecompute = false;
    return;
  }
  scheduleRecompute();
});
// 设计器选中变化 → 同步到【统一选择总线】（不触发重算）
designer.subscribe((_snapshot, d) => {
  selectUnit(d.selectedId);
});

// 【统一选择总线】选中变化 → 反向高亮设计器上的节点（若不同才动，避免回环）
onUnitSelect((id) => {
  if (designer.selectedId !== id) {
    suppressRecompute = true;
    designer.select(id);
  }
});

// 注入检视数据源：业务状态都在这几个模块级变量里，运行时提供给检视探针（不反向依赖引擎）
setInspectorSource(() => ({
  graph: graphOfDesigner(designer),
  designs,
  meta,
  kpi,
  hydraulics,
  issues,
  alarms,
}));

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
  liveStart();
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
    calcCurve.resize();
    calcCurve.refresh();
  });
  refreshAlarms();
  operatorName = name;
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
curveOptionOf = curveOption;
shell.show('process');
requestAnimationFrame(() => {
  viewport.sizeCanvas();
  viewport.fitViewport();
  recompute();
});

// 实时采样：进应用后才开始（登录门后面不必空跑）
const remembered = readLoginUser();
if (remembered) liveStart();
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
  // 实时监视
  live: {
    isRunning: () => liveRunning,
    samples: () => liveSamples,
    readings: () => liveReadings,
    tick: () => liveTick(),
    toggle: () => liveToggle(),
    setSpeed: (speed: number) => liveSetSpeed(speed),
    trendPoints: () => liveTrend.chart.norm.series.map((series: any) => (series.points || []).length),
    heatData: () => (liveHeat.chart.norm.series[0]?.points || []).length,
  },
  // 工艺试算
  calc: {
    params: () => scenarioParams,
    apply: (next: Partial<ScenarioParams>) => applyScenario({ ...scenarioParams, ...next }),
    result: () => scenarioResult,
    curveSeries: () => calcCurve.chart.norm.series.map((series: any) => series.id),
  },
  // 事件中心
  alarms: {
    list: () => alarms,
    summary: () => summarizeAlarms(alarms),
    filter: () => (eventsPage ? eventsPage.filter() : { status: 'all', keyword: '' }),
    ack: (id: string) => {
      alarms = ackAlarm(alarms, id, operatorName);
      if (eventsPage) eventsPage.reload();
    },
    close: (id: string) => {
      alarms = closeAlarm(alarms, id, operatorName);
      if (eventsPage) eventsPage.reload();
    },
  },
  // 统一选择总线（端到端测试 / 调试入口）
  selection: {
    get current() {
      return getSelectedUnit();
    },
    select: (id: string | null) => selectUnit(id),
    probe: (id?: string | null) => inspectorProbe(id ?? undefined),
  },
};
