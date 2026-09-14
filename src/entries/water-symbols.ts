/**
 * 主入口 2 —— 给排水符号库（`water-symbols.html`）。
 *
 * 与主入口同一套**整页画布化**的 admin console 版面：侧栏 + 顶栏 + 卡片栅格都由
 * ice-web-components 画在同一张画布上；只有**符号图例**是岛（域包的 `WaterProcessDesigner`
 * 需要自己的引擎实例与画布）。
 *
 * 图例把「图形」（域包给的记法）与「业务语义」（本仓符号目录：作用 / 设计关注 / 巡检要点）
 * 摆在一起看 —— 画得出符号，不等于新人知道该怎么用。
 */
import { ICE } from 'ice-render';
import { WaterProcessDesigner } from 'ice-entity-designer';
import { SYMBOL_CATALOG, categoryStats, symbolsOfCategory, type LegendFilter, type SymbolEntry } from '../domain';
import { WATER_SYMBOL_PRESETS } from 'ice-entity-designer';
import { computeLayout, measureCanvas, mountShell, type IslandSpec, type PageContext, type ShellLayout } from '../view/shell';
import { mountIsland, placeIslands, type IslandHandle } from '../view/islands';
import { installViewport } from '../view/canvas-viewport';
import { SymbolLegend, cellAt } from '../view/symbol-legend';
import { buildLegendPage, legendIslandRect, type LegendPageHandle } from '../view/pages/legend-page';

function need<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少 DOM 节点 #${id}`);
  return node as T;
}

const measured = measureCanvas();
const layout: ShellLayout = computeLayout(measured.width, measured.height);

const islands: Record<string, IslandHandle> = {
  legend: mountIsland('legend', need<HTMLCanvasElement>('canvas-legend')),
};
// 先摆岛再建引擎：引擎初始化要读画布尺寸
islands.legend.place(legendIslandRect(layout));

const ice = new ICE().init(islands.legend.canvas, { renderMode: 'dirty-rect' });
const designer = new WaterProcessDesigner(ice);
const viewport = installViewport({ ice, canvas: islands.legend.canvas, designer, padding: 40 });
const legend = new SymbolLegend({ ice, designer });

let filter: LegendFilter = 'all';
let selected: SymbolEntry | null = null;
let legendPage: LegendPageHandle | null = null;

function matchedCount(): number {
  return legend.getLayout().cells.length;
}

/** 重画图例（换筛选、导出之后都要重来一遍） */
function renderLegend(): void {
  legend.render(filter);
  viewport.sizeCanvas();
  viewport.fitViewport();
  selected = null;
  if (legendPage) legendPage.setSelection(null, matchedCount());
}

function selectSymbol(entry: SymbolEntry): void {
  selected = entry;
  legend.highlight(entry.kind);
  if (legendPage) legendPage.setSelection(entry, matchedCount());
}

function handleAction(key: 'fit' | 'reset' | 'export-svg'): void {
  if (key === 'fit') {
    viewport.sizeCanvas();
    viewport.fitViewport();
    return;
  }
  if (key === 'reset') {
    viewport.reset();
    return;
  }
  // 导出前摘掉排版辅助件（单元格底、标题、分类小标题），只留符号本身；导完立刻恢复画面
  legend.stripChrome();
  const svg = designer.toSvg({ padding: 16, background: '#ffffff' });
  (window as any).__exportedSvg = svg;
  const keep = selected;
  renderLegend();
  if (keep) selectSymbol(SYMBOL_CATALOG[keep.kind]);
  shell.toast(`已导出 SVG（${svg.length} 字节），画面已恢复`);
}

const shell = mountShell({
  canvas: need<HTMLCanvasElement>('canvas-shell'),
  brand: 'ice-smart-water',
  brandSub: '给排水工艺符号库 · 记法依据 GB/T 50106 图例 + 工艺专业通行画法',
  footer: { avatar: 'SW', name: '示范厂 WWTP-100K', role: '符号库 · 21 种给排水符号' },
  menu: [
    { key: 'legend', label: '符号图例', iconPath: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z' },
    {
      key: 'editor',
      label: '工艺流程图',
      iconPath: 'M3 3v18h18M7 15l4-5 3 3 5-7',
    },
    {
      key: 'cats',
      label: '符号分类',
      iconPath: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
      children: [
        { key: 'filter:all', label: '全部符号' },
        { key: 'filter:water', label: '水线处理单元' },
        { key: 'filter:sludge', label: '污泥线单元' },
        { key: 'filter:equipment', label: '设备与仪表' },
        { key: 'filter:boundary', label: '边界符号' },
      ],
    },
  ],
  selectedKey: 'legend',
  onMenuSelect: (key: string) => {
    if (key === 'editor') {
      window.location.href = './water-editor.html';
      return;
    }
    if (key.indexOf('filter:') === 0) {
      filter = key.replace('filter:', '') as LegendFilter;
      renderLegend();
      shell.toast(`已筛选：${filter === 'all' ? '全部符号' : filter}`);
    }
  },
  pages: [
    {
      key: 'legend',
      label: '符号图例',
      build: (ctx: PageContext) => {
        legendPage = buildLegendPage(ctx, {
          initialFilter: filter,
          onFilterChange: (next: LegendFilter) => {
            filter = next;
            renderLegend();
          },
          onAction: handleAction,
        });
        return legendPage;
      },
    },
  ],
  onIslands: (specs: IslandSpec[]) => placeIslands(islands, specs),
  fabItems: [
    { key: 'fit', icon: '⌖' },
    { key: 'export-svg', icon: '↧' },
  ],
  onFabItem: (key: string) => handleAction(key as any),
});

/* ---------------- 交互：点图例看详情 ---------------- */

islands.legend.canvas.addEventListener('click', (event) => {
  const cell = cellAt(legend.getLayout(), event.offsetX, event.offsetY);
  if (!cell) return;
  selectSymbol(cell.entry);
});

/* ---------------- 启动 ---------------- */

shell.show('legend');
requestAnimationFrame(() => {
  renderLegend();
  const stats = categoryStats();
  shell.setStatusTags([
    { text: `共 ${stats.reduce((total, item) => total + item.count, 0)} 种符号`, status: 'primary', width: 108 },
    { text: `${symbolsOfCategory('water').length + symbolsOfCategory('sludge').length} 种工艺单元`, status: 'info', width: 116 },
  ]);
});

(window as any).__symbols = {
  shell,
  ice,
  designer,
  legend,
  islands,
  layout,
  // 域包给的符号预设：给 e2e 做「业务目录 ↔ 域包预设」的奇偶校验
  presets: WATER_SYMBOL_PRESETS,
  stats: categoryStats(),
  total: Object.keys(SYMBOL_CATALOG).length,
  currentFilter: () => filter,
  selected: () => selected,
  matched: () => matchedCount(),
};
