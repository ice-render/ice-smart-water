/**
 * 主入口 2 —— 符号库（`water-symbols.html`）。
 *
 * 由 entity-designer 的 `water-symbols` 示例页迁移而来，但不止"把符号排一遍"：
 * 把**图形**（域包给的记法）与**业务语义**（本仓的符号目录：作用、设计关注、巡检要点）
 * 拼在一起看，再让分类筛选、构成统计直接用上控件库与图表库。
 *
 * 四件套在这一页的分工：
 * - `ice-render`：画布；
 * - `ice-entity-designer`：符号本体（`WATER_SYMBOL_PRESETS` 的尺寸与画法）+ 矢量导出；
 * - `ice-web-components`：分类筛选的分段控件与统计卡；
 * - `ice-chart`：符号库构成柱状图。
 */
import { ICE } from 'ice-render';
import { WATER_SYMBOL_PRESETS, WaterProcessDesigner } from 'ice-entity-designer';
import {
  SYMBOL_CATALOG,
  categoryStats,
  symbolsOfCategory,
  type LegendFilter,
  type SymbolEntry,
} from '../domain';
import { installViewport } from '../view/canvas-viewport';
import { mountChart, symbolMixOption } from '../view/board';
import { mountSymbolConsole } from '../view/symbol-console';
import { SymbolLegend, cellAt } from '../view/symbol-legend';
import { clear, el, setStatus, type StatusLevel } from '../view/panels';

function $(id: string): any {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少 DOM 节点 #${id}`);
  return node;
}

const dom = {
  canvasLegend: $('canvas-legend') as HTMLCanvasElement,
  canvasConsole: $('canvas-symbol-console') as HTMLCanvasElement,
  canvasMix: $('canvas-symbol-mix') as HTMLCanvasElement,
  detail: $('symbol-detail') as HTMLElement,
  status: $('statusbar') as HTMLElement,
};

const ice = new ICE().init(dom.canvasLegend, { renderMode: 'dirty-rect' });
const designer = new WaterProcessDesigner(ice);
const viewport = installViewport({ ice, canvas: dom.canvasLegend, designer, padding: 40 });
const legend = new SymbolLegend({ ice, designer });

let filter: LegendFilter = 'all';
let selected: SymbolEntry | null = null;

const consoleUi = mountSymbolConsole({
  canvas: dom.canvasConsole,
  filter,
  onFilterChange: (next: LegendFilter) => {
    filter = next;
    renderLegend();
  },
});

const mixChart = mountChart(dom.canvasMix, () => symbolMixOption(categoryStats()));

/** 重画图例（换筛选、导出之后都要重来一遍） */
function renderLegend(): void {
  const layout = legend.render(filter);
  viewport.sizeCanvas();
  viewport.fitViewport();
  selected = null;
  renderDetail(null);
  consoleUi.update({ filter, matched: layout.cells.length, selected });
  status(`已渲染 ${layout.cells.length} 个符号（${filter === 'all' ? '全部分类' : filter}）`, 'ok');
}

/** 选中一个符号：点亮 + 详情 + 控件面板 */
function selectSymbol(entry: SymbolEntry): void {
  selected = entry;
  legend.highlight(entry.kind);
  renderDetail(entry);
  consoleUi.update({ filter, matched: legend.getLayout().cells.length, selected });
  status(`${entry.label}（${entry.kind}）· 位号代号 ${entry.tag} · 介质 ${entry.mediums.join(' / ')}`, 'ok');
}

/** 详情面板：长文本留在 DOM（排版、复制、屏幕阅读器都是现成的） */
function renderDetail(entry: SymbolEntry | null): void {
  clear(dom.detail);
  if (!entry) {
    dom.detail.className = 'hint';
    dom.detail.textContent = '点击左侧图例里的任意符号查看详情';
    return;
  }
  dom.detail.className = '';

  const head = el('div', 'detail__head');
  head.appendChild(el('span', 'detail__name', entry.label));
  head.appendChild(el('span', 'detail__kind', `${entry.kind} · 分类 ${entry.category}`));
  dom.detail.appendChild(head);

  const rows = el('div', 'detail__row');
  rows.appendChild(el('span', 'detail__label', '位号代号'));
  rows.appendChild(el('span', undefined, entry.tag));
  rows.appendChild(el('span', 'detail__label', '常见介质'));
  rows.appendChild(el('span', undefined, entry.mediums.join(' / ')));
  dom.detail.appendChild(rows);

  dom.detail.appendChild(el('div', 'detail__role', entry.role));

  dom.detail.appendChild(el('div', 'detail__section', '设计关注'));
  const focus = el('ul', 'detail__list');
  entry.designFocus.forEach((item) => focus.appendChild(el('li', undefined, item)));
  dom.detail.appendChild(focus);

  dom.detail.appendChild(el('div', 'detail__section', '运行巡检要点'));
  const checks = el('ul', 'detail__list');
  entry.checks.forEach((item) => checks.appendChild(el('li', undefined, item)));
  dom.detail.appendChild(checks);
}

function status(text: string, level: StatusLevel = 'info'): void {
  setStatus(dom.status, text, level);
}

/* ---------------- 交互 ---------------- */

dom.canvasLegend.addEventListener('click', (event: MouseEvent) => {
  const cell = cellAt(legend.getLayout(), event.offsetX, event.offsetY);
  if (!cell) return;
  selectSymbol(cell.entry);
});

$('btn-export').addEventListener('click', () => {
  // 导出前摘掉排版辅助件（单元格底、标题、高亮框），只留符号；导出后立刻恢复画面
  legend.stripChrome();
  const svg = designer.toSvg({ padding: 16, background: '#ffffff' });
  (window as any).__exportedSvg = svg;
  renderLegend();
  if (selected) {
    const keep = SYMBOL_CATALOG[selected.kind];
    legend.highlight(keep.kind);
    renderDetail(keep);
    consoleUi.update({ filter, matched: legend.getLayout().cells.length, selected: keep });
  }
  status(`已导出 SVG（${svg.length} 字节），画面已恢复`, 'ok');
});

$('btn-fit').addEventListener('click', () => {
  viewport.sizeCanvas();
  viewport.fitViewport();
});

$('btn-reset').addEventListener('click', () => viewport.reset());

/* ---------------- 启动 ---------------- */

renderLegend();
requestAnimationFrame(() => {
  viewport.sizeCanvas();
  viewport.fitViewport();
  mixChart.resize();
});

// 端到端测试与人工排查的观察点
(window as any).__symbols = {
  ice,
  designer,
  legend,
  consoleUi,
  mixChart,
  stats: categoryStats(),
  total: Object.keys(SYMBOL_CATALOG).length,
  symbolsOf: (category: LegendFilter) => symbolsOfCategory(category as any).length,
};
// 域包的符号预设：给 e2e 做"业务目录 ↔ 域包预设"的奇偶校验用（单测不依赖兄弟仓库产物）
(window as any).__waterPresets = WATER_SYMBOL_PRESETS;
