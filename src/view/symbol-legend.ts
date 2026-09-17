/**
 * 符号库图例：把 21 种给排水符号按业务分类铺成一张"图纸"，供人对照识别。
 *
 * 版式口径沿用设计器域包的排版铁律：**位号在上、名称在下、图形居中**。
 * 网格线与分类标题是**排版辅助**，不是符号本身 —— 导出 SVG 前会摘掉（`stripChrome()`）。
 *
 * 版面计算（`legendLayout`）是纯函数：不依赖引擎，能单独验证；渲染才是引擎的事。
 */
import { ICERect, ICEText, token } from 'ice-render';
import { WATER_SYMBOL_PRESETS, type WaterSymbolKind, type WaterMedium } from 'ice-entity-designer';
import {
  SYMBOL_CATEGORIES,
  categoryMetaOf,
  symbolsOfCategory,
  type LegendFilter,
  type SymbolCategory,
  type SymbolEntry,
} from '../domain/symbol-catalog';

export const LEGEND_COLUMNS = 5;
export const LEGEND_CELL_WIDTH = 280;
export const LEGEND_CELL_HEIGHT = 200;
export const LEGEND_GAP = 18;
export const LEGEND_PAD = 24;
export const SECTION_HEIGHT = 46;

export type LegendCell = {
  kind: WaterSymbolKind;
  entry: SymbolEntry;
  /** 全局序号（从 1 开始），图例上标在角上 */
  index: number;
  category: SymbolCategory;
  left: number;
  top: number;
  width: number;
  height: number;
};

export type LegendLayout = {
  cells: LegendCell[];
  width: number;
  height: number;
};

/** 可见分类：`all` 时按分类表顺序全出 */
export function categoriesOf(filter: LegendFilter): SymbolCategory[] {
  return filter === 'all' ? SYMBOL_CATEGORIES.map((item) => item.id) : [filter];
}

/**
 * 纯计算版面：按分类分段，每段一个小标题 + 若干行网格。
 *
 * 返回每个格子与整张图的外框 —— 画布尺寸、点选命中的坐标判断都用它。
 */
export function legendLayout(filter: LegendFilter = 'all'): LegendLayout {
  const cells: LegendCell[] = [];
  let top = LEGEND_PAD + SECTION_HEIGHT; // 顶部留出「图例总标题」的位置
  let index = 0;

  categoriesOf(filter).forEach((category) => {
    const entries = symbolsOfCategory(category);
    top += SECTION_HEIGHT; // 分类小标题
    entries.forEach((entry, position) => {
      const column = position % LEGEND_COLUMNS;
      const row = Math.floor(position / LEGEND_COLUMNS);
      index += 1;
      cells.push({
        kind: entry.kind,
        entry,
        index,
        category,
        left: LEGEND_PAD + column * (LEGEND_CELL_WIDTH + LEGEND_GAP),
        top: top + row * (LEGEND_CELL_HEIGHT + LEGEND_GAP),
        width: LEGEND_CELL_WIDTH,
        height: LEGEND_CELL_HEIGHT,
      });
    });
    const rows = Math.ceil(entries.length / LEGEND_COLUMNS);
    top += rows * (LEGEND_CELL_HEIGHT + LEGEND_GAP) + LEGEND_GAP;
  });

  const columns = Math.max(1, Math.min(LEGEND_COLUMNS, Math.max(...categoriesOf(filter).map((c) => symbolsOfCategory(c).length))));
  return {
    cells,
    width: LEGEND_PAD * 2 + columns * (LEGEND_CELL_WIDTH + LEGEND_GAP) - LEGEND_GAP,
    height: top + LEGEND_PAD,
  };
}

/** 命中哪个格子（点选用；只看格子区域，分类标题不算） */
export function cellAt(layout: LegendLayout, x: number, y: number): LegendCell | null {
  return (
    layout.cells.filter(
      (cell) => x >= cell.left && x <= cell.left + cell.width && y >= cell.top && y <= cell.top + cell.height
    )[0] || null
  );
}

/**
 * 符号库画布：负责"画出来"与"点亮选中的那个"。
 *
 * 图例是**只读**的：格子里的符号 `interactive: false`，避免在对照识别的场景里
 * 手一抖把符号拖走（这一页不是编辑器）。
 */
export class SymbolLegend {
  private ice: any;
  private designer: any;
  private highlightBox: any = null;
  private selectedKind: WaterSymbolKind | null = null;
  private layout: LegendLayout = { cells: [], width: 0, height: 0 };
  /** 界面底色 / 文字 / 边框都取自**主题引用**（`token('ui.colors.*')`，paint 时解析 → 热切换跟着走）。 */

  constructor(options: { ice: any; designer: any }) {
    this.ice = options.ice;
    this.designer = options.designer;
    /**
     * ⚠️ **不要再把主题对象存下来**（`this.theme = iceUIManager.getTheme()`）。
     *
     * 存下来的字面量冻在构造那一刻：切换主题时这块整体不变 —— 实测过（线上切深色，
     * 图例里有色的 253 个节点**一个颜色都没变**，卡片还是白的、标题还是深字）。
     * 现在样式槽里放的是**主题引用**（`token('ui.colors.*')`，paint 时由引擎解析），
     * 所以图例跟着页面主题走，也不需要重建。
     *
     * 符号本身的颜色（`WATER_SYMBOL_PRESETS` 里的域配色）**不动**：那是工艺语义（介质/管径），
     * 不是外观 —— 暗色下也应当保持同一套工艺配色。
     */
  }

  public render(filter: LegendFilter = 'all'): LegendLayout {
    const layout = legendLayout(filter);
    this.layout = layout;
    this.selectedKind = null;
    this.highlightBox = null;
    this.designer.clear();

    const title = new ICEText({
      left: LEGEND_PAD,
      top: LEGEND_PAD - 6,
      width: layout.width - LEGEND_PAD * 2,
      height: 30,
      text: '给排水工艺流程图 · 符号图例',
      stroke: false,
      interactive: false,
      linkable: false,
      style: { fontSize: 20, fillStyle: token('ui.colors.text'), textAlign: 'left', textBaseline: 'middle' },
    });
    this.ice.addChild(title);

    let lastCategory: SymbolCategory | null = null;
    layout.cells.forEach((cell) => {
      if (cell.category !== lastCategory) {
        this.__sectionTitle(cell.category, cell.left, cell.top - SECTION_HEIGHT + 6, layout.width - LEGEND_PAD * 2);
        lastCategory = cell.category;
      }
      this.__cell(cell);
    });

    this.designer.select(null);
    this.designer.resetHistory();
    return layout;
  }

  public getLayout(): LegendLayout {
    return this.layout;
  }

  /** 点亮某个符号（点选或用键盘选择时调用） */
  public highlight(kind: WaterSymbolKind | null): LegendCell | null {
    this.selectedKind = kind;
    const cell = kind ? this.layout.cells.filter((item) => item.kind === kind)[0] : null;
    if (!cell) {
      if (this.highlightBox) this.highlightBox.setState({ display: false });
      this.ice.requestRepaint();
      return null;
    }
    if (!this.highlightBox) {
      this.highlightBox = new ICERect({
        left: 0,
        top: 0,
        width: 10,
        height: 10,
        radius: 10,
        interactive: false,
        linkable: false,
        zIndex: 999,
        style: { fillStyle: token('ui.colors.primaryBg'), strokeStyle: token('ui.colors.primary'), lineWidth: 2 },
      });
      this.ice.addChild(this.highlightBox);
    }
    this.highlightBox.setState({
      display: true,
      left: cell.left,
      top: cell.top,
      width: cell.width,
      height: cell.height,
      radius: 10,
    });
    this.ice.requestRepaint();
    return cell;
  }

  public getSelected(): LegendCell | null {
    return this.selectedKind ? this.layout.cells.filter((item) => item.kind === this.selectedKind)[0] || null : null;
  }

  /**
   * 摘掉排版辅助件，只留符号本身 —— 导出 SVG 前调用。
   * 判定依据是类型：`WaterSymbol` 留着，其余（单元格底、标题、高亮框）全摘。
   */
  public stripChrome(): void {
    const symbolType = 'ice-entity-designer:WaterSymbol';
    this.ice.childNodes
      .slice()
      .filter((child: any) => !child.constructor || child.constructor.typeId !== symbolType)
      .forEach((child: any) => this.ice.removeChild(child));
  }

  /** 按类别画一个小标题 + 一条分隔线 */
  private __sectionTitle(category: SymbolCategory, left: number, top: number, width: number): void {
    const meta = categoryMetaOf(category);
    this.ice.addChild(
      new ICEText({
        left,
        top,
        width,
        height: 24,
        text: `${meta.label}　${meta.description}`,
        stroke: false,
        interactive: false,
        linkable: false,
        style: { fontSize: 14, fillStyle: token('ui.colors.link'), textAlign: 'left', textBaseline: 'middle' },
      })
    );
    this.ice.addChild(
      new ICERect({
        left,
        top: top + 28,
        width,
        height: 2,
        radius: 1,
        interactive: false,
        linkable: false,
        style: { fillStyle: token('ui.colors.border'), strokeStyle: token('ui.colors.border'), lineWidth: 0 },
      })
    );
  }

  /** 一个格子：参考框 + 序号 + 位号 + 符号 + 介质标注 */
  private __cell(cell: LegendCell): void {
    this.ice.addChild(
      new ICERect({
        left: cell.left,
        top: cell.top,
        width: cell.width,
        height: cell.height,
        radius: 10,
        interactive: false,
        linkable: false,
        style: { fillStyle: token('ui.colors.surface'), strokeStyle: token('ui.colors.border'), lineWidth: 1 },
      })
    );
    this.ice.addChild(
      new ICEText({
        left: cell.left + 10,
        top: cell.top + 8,
        width: cell.width - 20,
        height: 18,
        text: `${cell.index}. ${cell.kind}`,
        stroke: false,
        interactive: false,
        linkable: false,
        style: { fontSize: 11, fillStyle: token('ui.colors.textTertiary'), textAlign: 'left', textBaseline: 'middle' },
      })
    );

    const preset = (WATER_SYMBOL_PRESETS as any)[cell.kind];
    const symbolLeft = cell.left + (cell.width - preset.width) / 2;
    const symbolTop = cell.top + 92;
    this.designer.createSymbol(cell.kind, {
      name: cell.entry.label,
      tag: preset.tag + '-101',
      left: symbolLeft,
      top: symbolTop,
      interactive: false,
      draggable: false,
    });

    this.ice.addChild(
      new ICEText({
        left: cell.left + 10,
        top: cell.top + cell.height - 30,
        width: cell.width - 20,
        height: 18,
        text: this.__mediumText(cell.entry.mediums),
        stroke: false,
        interactive: false,
        linkable: false,
        style: { fontSize: 11, fillStyle: token('ui.colors.textSecondary'), textAlign: 'center', textBaseline: 'middle' },
      })
    );
  }

  private __mediumText(mediums: WaterMedium[]): string {
    return `介质：${mediums.join(' / ')}`;
  }
}
