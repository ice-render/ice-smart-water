/**
 * 主入口 1 —— 工艺流程图编辑器（`water-editor.html`）。
 *
 * 由 entity-designer 的 `water-editor` 示例页迁移而来，但分工变了：
 * 原来所有逻辑都写在一个 HTML 的 `<script>` 里，现在——
 * - **业务**在 `src/domain`（厂站数据、水量水质模型、工况、审计），纯函数、可单测；
 * - **能力**全部来自 ICE 家族四件套：
 *   - `ice-render`：画布引擎（命中、变换、脏矩形、视口）；
 *   - `ice-entity-designer`：水工艺域设计器（符号库 / 管线 / 走线 / 快照 / 矢量导出）；
 *   - `ice-web-components`：运行控制台（画布原生控件：指标卡、分段控件、标签）；
 *   - `ice-chart`：运行看板（24 小时进出水趋势，双 y 轴）；
 * - **本文件只做装配**：把上面四层接起来，一件业务规则都不在这里写。
 *
 * 数据流向是单向的：**图上改 → 业务重算 → 界面刷新**。所以"图纸即数据源"：
 * 关掉一台阀、删掉一段管线，运行指标、出水达标、看板曲线会立刻跟着变。
 */
import { ICE } from 'ice-render';
import {
  WATER_MEDIUM_STYLES,
  WATER_SYMBOL_PRESETS,
  WaterProcessDesigner,
  type WaterSymbolKind,
} from 'ice-entity-designer';
import {
  DEFAULT_MODE_ID,
  NORMALLY_CLOSED_VALVES,
  SEWAGE_PLANT,
  auditPlant,
  chainHydraulics,
  computeHydraulics,
  computeKpi,
  designMap,
  evaluateQualityChain,
  isIdleInMode,
  modeById,
  nextTag,
  scaledBy,
  simulateDay,
  targetValveState,
  traceProcessFlow,
  type DayPoint,
  type FlowTrace,
  type OperatingModeId,
} from '../domain';
import {
  PropertyPanel,
  kpiMetrics,
  renderComplianceTable,
  renderIssueList,
  renderLoadTable,
  renderMetrics,
  setStatus,
} from '../view/panels';
import { installViewport } from '../view/canvas-viewport';
import { dailyTrendOption, mountChart } from '../view/board';
import { mountControlConsole } from '../view/control-console';
import { graphOfDesigner, tagsOfDesigner } from '../view/adapter';

function $(id: string): any {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少 DOM 节点 #${id}`);
  return node;
}

const dom = {
  canvasProcess: $('canvas-process') as HTMLCanvasElement,
  canvasConsole: $('canvas-console') as HTMLCanvasElement,
  canvasBoard: $('canvas-board') as HTMLCanvasElement,
  kind: $('in-kind') as HTMLSelectElement,
  medium: $('in-medium') as HTMLSelectElement,
  property: $('property-panel') as HTMLElement,
  metrics: $('metric-list') as HTMLElement,
  compliance: $('compliance-table') as HTMLElement,
  validate: $('validate-output') as HTMLElement,
  audit: $('audit-output') as HTMLElement,
  load: $('load-table') as HTMLElement,
  status: $('statusbar') as HTMLElement,
  boardCaption: $('board-caption') as HTMLElement,
};

const { meta } = SEWAGE_PLANT;
const designs = designMap(SEWAGE_PLANT);

/* ---------------- 引擎与设计器 ---------------- */

const ice = new ICE().init(dom.canvasProcess, { renderMode: 'dirty-rect' });
const designer = new WaterProcessDesigner(ice);
const viewport = installViewport({ ice, canvas: dom.canvasProcess, designer, padding: 60 });

/* ---------------- 下拉框：直接由域包词典生成，永不脱节 ---------------- */

Object.keys(WATER_SYMBOL_PRESETS).forEach((kind) => {
  const option = document.createElement('option');
  option.value = kind;
  option.textContent = (WATER_SYMBOL_PRESETS as any)[kind].label;
  dom.kind.appendChild(option);
});
dom.kind.value = 'pump';

Object.keys(WATER_MEDIUM_STYLES).forEach((medium) => {
  const option = document.createElement('option');
  option.value = medium;
  option.textContent = (WATER_MEDIUM_STYLES as any)[medium].label;
  dom.medium.appendChild(option);
});
dom.medium.value = 'sewage';

/* ---------------- 运行状态 ---------------- */

let modeId: OperatingModeId = DEFAULT_MODE_ID;
let dayPoints: DayPoint[] = [];
let lastTrace: FlowTrace | null = null;

/* ---------------- 控制台与看板（两块独立画布） ---------------- */

const consoleUi = mountControlConsole({
  canvas: dom.canvasConsole,
  modeId,
  onModeChange: (next: OperatingModeId) => {
    setMode(next);
  },
});

const board = mountChart(dom.canvasBoard, () =>
  dailyTrendOption(dayPoints, { modeLabel: modeById(modeId).label, standard: meta.standard })
);

const propertyPanel = new PropertyPanel({
  host: dom.property,
  designer,
  onChange: () => scheduleRecompute(),
});

/* ---------------- 案例装载 ---------------- */

function buildCase(): void {
  designer.clear();
  SEWAGE_PLANT.units.forEach((unit) => {
    designer.createSymbol(unit.kind, {
      id: unit.id,
      name: unit.name,
      tag: unit.tag,
      left: unit.left,
      top: unit.top,
    });
  });
  SEWAGE_PLANT.pipes.forEach((pipe) => {
    designer.createPipe({
      id: pipe.id,
      sourceId: pipe.sourceId,
      targetId: pipe.targetId,
      medium: pipe.medium,
      dn: pipe.dn,
      // 与实体设计器的示例页保持同一套端口约定：默认右出左进
      sourcePort: pipe.sourcePort || 'R',
      targetPort: pipe.targetPort || 'L',
    });
  });
  designer.select(null);
  designer.resetHistory();
}

/* ---------------- 工况 ---------------- */

/**
 * 把工况铺到**设计器**上（而不是另存一份图）：
 * 画布就是唯一真相，业务重算从画布读 —— 这样用户手动改过的阀位与工况不会互相覆盖。
 */
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
  ice.dirty = true;
  recompute();
}

/* ---------------- 重算与刷新 ---------------- */

let recomputePending = false;
function scheduleRecompute(): void {
  if (recomputePending) return;
  recomputePending = true;
  requestAnimationFrame(() => {
    recomputePending = false;
    recompute();
  });
}

function recompute(): void {
  const graph = graphOfDesigner(designer);
  const mode = modeById(modeId);
  const inflow = meta.capacity * mode.inflowFactor;
  const influent = scaledBy(meta.influent, mode.qualityFactor);

  const kpi = computeKpi(graph, designs, meta, { inflow, influent });
  const chain = evaluateQualityChain(graph, meta, influent);
  const hydraulics = computeHydraulics(graph, designs, meta, kpi.inflow, kpi.sludge.wasteSludgeFlow);
  const issues = auditPlant({ graph, designs, meta, mode, kpi, chain, hydraulics });
  dayPoints = simulateDay(graph, designs, meta, mode);
  lastTrace = traceProcessFlow(graph, { deprioritizedNodes: NORMALLY_CLOSED_VALVES });
  const idleCount = graph.nodes.filter((node) => node.idle).length;

  propertyPanel.render();
  renderMetrics(dom.metrics, kpiMetrics(kpi, idleCount));
  renderComplianceTable(dom.compliance, kpi);
  renderIssueList(dom.audit, issues, '运行审计通过：全厂指标在设计与标准区间内');
  renderLoadTable(dom.load, chainHydraulics(graph, hydraulics), kpi);
  renderIssueList(dom.validate, designer.validateWater(), '图纸校验通过');
  consoleUi.update({
    modeId,
    inflowWan: kpi.inflow / 10000,
    effluentCod: kpi.effluent.COD,
    energyPerCubicMeter: kpi.energyPerCubicMeter,
    compliance: kpi.compliance,
    idleCount,
  });
  board.refresh();

  const errors = issues.filter((issue) => issue.level === 'error').length;
  dom.boardCaption.textContent = `${mode.label} · ${dayPoints.length} 点 · 双击图例可只看某条曲线`;
  setStatus(
    dom.status,
    [
      `${mode.label}｜进水 ${(kpi.inflow / 10000).toFixed(2)} 万 m³/d`,
      `出水 ${kpi.compliance.passed}/${kpi.compliance.total} 项达标`,
      `吨水电耗 ${kpi.energyPerCubicMeter.toFixed(3)} kWh/m³`,
      lastTrace && lastTrace.connected ? `流径通畅（${lastTrace.path.length} 个单元）` : `断流：${lastTrace?.blockedAt || '未接通'}`,
    ].join('　·　'),
    errors ? 'error' : issues.length ? 'warning' : 'ok'
  );

  // 端到端测试的观察点（不参与业务，只是把当前状态摆出来给人/脚本看）
  (window as any).__water = {
    ice,
    designer,
    kpi,
    issues,
    dayPoints,
    mode,
    modeId,
    trace: lastTrace,
    graph,
    // 两个画布层的句柄：e2e 要验证"控件真的能点、画板真的在画"
    consoleUi,
    board,
  };
  ice.dirty = true;
}

designer.subscribe(() => scheduleRecompute());

/* ---------------- 工具栏 ---------------- */

$('btn-add').addEventListener('click', () => {
  const kind = dom.kind.value as WaterSymbolKind;
  const preset = (WATER_SYMBOL_PRESETS as any)[kind];
  const node = designer.createSymbol(kind, {
    name: preset.label,
    // 位号按同代号顺延，从源头避免撞号（图纸校验也会拦重复位号）
    tag: nextTag(kind, tagsOfDesigner(designer)),
  });
  designer.select(node.state.id);
  recompute();
});

$('btn-delete').addEventListener('click', () => {
  if (!designer.selectedId) {
    setStatus(dom.status, '先选中一个符号或管线，再删除', 'warning');
    return;
  }
  designer.remove(designer.selectedId);
  recompute();
});

$('btn-undo').addEventListener('click', () => {
  designer.undo();
  recompute();
});

$('btn-redo').addEventListener('click', () => {
  designer.redo();
  recompute();
});

let pipeSource: string | null = null;
$('btn-pipe').addEventListener('click', () => {
  const selected = designer.selectedId;
  if (!selected) {
    setStatus(dom.status, '先选中起点符号，再点「画管线」', 'warning');
    return;
  }
  if (!pipeSource) {
    pipeSource = selected;
    setStatus(dom.status, '已选起点：再选中终点符号并点「画管线」完成连线', 'info');
    return;
  }
  if (pipeSource !== selected) {
    designer.createPipe({ sourceId: pipeSource, targetId: selected, medium: dom.medium.value, dn: 'DN100' });
  }
  pipeSource = null;
  recompute();
});

$('btn-valve').addEventListener('click', () => {
  const node = designer.nodes.filter((item: any) => item.state.id === designer.selectedId)[0];
  if (!node || node.state.kind !== 'valve') {
    setStatus(dom.status, '先选中一台阀门，再点「阀门开 / 闭」', 'warning');
    return;
  }
  designer.setValveState(node.state.id, node.state.valveState === 'closed' ? 'open' : 'closed');
  recompute();
});

$('btn-trace').addEventListener('click', () => {
  recompute();
  if (!lastTrace) return;
  setStatus(
    dom.status,
    lastTrace.connected
      ? `✅ 进水可以走到出水，途经 ${lastTrace.path.length} 个单元、${lastTrace.pipePath.length} 段管线`
      : `❌ 断流：${lastTrace.blockedAt ? `卡在关断的阀门「${lastTrace.blockedAt}」` : '主流程未接通'}`,
    lastTrace.connected ? 'ok' : 'error'
  );
});

$('btn-validate').addEventListener('click', () => {
  const issues = designer.validateWater();
  renderIssueList(dom.validate, issues, '图纸校验通过');
  setStatus(dom.status, issues.length ? `图纸校验发现 ${issues.length} 个问题` : '图纸校验通过', issues.length ? 'warning' : 'ok');
});

$('btn-reload').addEventListener('click', () => {
  buildCase();
  setMode(DEFAULT_MODE_ID);
  viewport.fitViewport();
  recompute();
  setStatus(dom.status, '已重载示范案例', 'ok');
});

$('btn-fit').addEventListener('click', () => {
  viewport.sizeCanvas();
  viewport.fitViewport();
});

$('btn-reset').addEventListener('click', () => viewport.reset());

$('btn-export-svg').addEventListener('click', () => {
  const svg = designer.toSvg({ padding: 16, background: '#ffffff' });
  (window as any).__exportedSvg = svg;
  download('wastewater-aao-process.svg', svg, 'image/svg+xml');
});

$('btn-export-json').addEventListener('click', () => {
  const json = designer.serialize();
  (window as any).__exportedJson = json;
  download('wastewater-aao-process.json', json, 'application/json');
});

$('btn-import-json').addEventListener('click', () => {
  const json = (window as any).__exportedJson;
  if (!json) {
    setStatus(dom.status, '先「导出 JSON」一次，再导入（演示快照往返）', 'warning');
    return;
  }
  const report = designer.load(json);
  viewport.fitViewport();
  recompute();
  setStatus(dom.status, `已导入 ${report.nodes} 个符号 / ${report.edges} 段管线`, 'ok');
});

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/* ---------------- 启动 ---------------- */

buildCase();
setMode(DEFAULT_MODE_ID);
requestAnimationFrame(() => {
  viewport.sizeCanvas();
  viewport.fitViewport();
  board.resize();
  recompute();
});
