/**
 * 页 —— 符号库：21 种给排水符号的图例（岛）+ 分类筛选（`ICESegmented`）+ 符号详情。
 *
 * 图例是**岛**（`WaterProcessDesigner` 自己一张画布），挖在「符号图例」卡片的正文区；
 * 详情把**图形**（域包给的记法）与**业务语义**（本仓符号目录：作用 / 设计关注 / 巡检要点）摆在一起。
 */
import { ICEDescriptions, ICELabel, ICESegmented, ICEStatCard, ICEWidget } from 'ice-web-components';
import { WATER_SYMBOL_PRESETS } from 'ice-entity-designer';
import {
  SYMBOL_CATEGORIES,
  categoryStats,
  categoryMetaOf,
  symbolsOfCategory,
  type LegendFilter,
  type SymbolEntry,
} from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  bullet,
  cardBodyRect,
  createCard,
  createStatRow,
  paragraph,
  sectionHeading,
  type HeaderActionSpec,
  type IslandSpec,
  type PageContext,
  type Rect,
  type ShellLayout,
  type StatusTagSpec,
} from '../shell';
import { WaterPage } from '../WaterPage';

export type LegendPageDeps = {
  onFilterChange: (filter: LegendFilter) => void;
  initialFilter: LegendFilter;
  onAction: (key: 'fit' | 'reset' | 'export-svg') => void;
};


/** 符号库页：五个分类统计 + 图例（岛）+ 筛选 + 符号详情。 */
export class LegendPage extends WaterPage {
  private static readonly STAT_HEIGHT = 120;

  private static readonly FILTER_HEIGHT = 96;

  /** 「符号图例」卡片的矩形（入口要在建引擎前摆岛，见 process-page 的注释） */
  private static legendCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    return {
      left: x0,
      top: y0 + LegendPage.STAT_HEIGHT + PAGE_GAP,
      width: layout.inner.width - PAGE_GAP - layout.rightWidth,
      height: layout.inner.height - LegendPage.STAT_HEIGHT - PAGE_GAP,
    };
  }

  /** 图例岛的矩形 = 卡片正文区 */
  public static legendIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(LegendPage.legendCardRect(layout));
  }

  /** 介质代号 → 中文（词典来自设计器的水工艺域包） */
  private static mediumLabelOf(medium: string): string {
    const labels: Record<string, string> = {
      sewage: '污水',
      effluent: '出水',
      recycle: '混合液回流',
      returnSludge: '回流污泥',
      sludge: '剩余污泥',
      air: '空气',
      chemical: '药剂',
    };
    return labels[medium] || medium;
  }

  private readonly deps: LegendPageDeps;
  private readonly detailBody: ICEWidget;
  private readonly detailWidth: number;
  private readonly segmented: ICESegmented;
  private currentFilter: LegendFilter;

  constructor(ctx: PageContext, deps: LegendPageDeps) {
    super(ctx);
    this.deps = deps;
    this.currentFilter = deps.initialFilter;
    const { layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const rightWidth = layout.rightWidth;
    const leftWidth = layout.inner.width - PAGE_GAP - rightWidth;
    const mainTop = y0 + LegendPage.STAT_HEIGHT + PAGE_GAP;
    const mainHeight = layout.inner.height - LegendPage.STAT_HEIGHT - PAGE_GAP;

    /* ---------------- 分类统计 ---------------- */
    const stats = categoryStats();
    // 5 张卡（符号总数 + 4 个分类）：列宽必须按 5 列算 —— 按 4 列算会让第 5 张冲出画布右边
    // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: LegendPage.STAT_HEIGHT, count: 5, gap: PAGE_GAP });
    this.addChild(statRow, false);
    const statCards = [
      { icon: '⊞', title: '符号总数', value: String(stats.reduce((total, item) => total + item.count, 0)), trend: `${SYMBOL_CATEGORIES.length} 个分类` },
      ...stats.map((item) => ({ icon: '◫', title: item.label, value: String(item.count), trend: item.description })),
    ].map(
      (cfg) =>
        new ICEStatCard({
          height: LegendPage.STAT_HEIGHT,
          trendType: 'info',
          ...cfg,
        })
    );
    statCards.forEach((card) => statRow.addChild(card, false));

    /* ---------------- 左：符号图例（岛） ---------------- */
    const legendRect: Rect = LegendPage.legendCardRect(layout);
    const legendCard = createCard({ id: 'legend-card', rect: legendRect, title: '符号图例 · 位号在上、名称在下、图形居中（点击任意符号看详情）' });
    this.addChild(legendCard, false);

    /* ---------------- 右：筛选 + 详情 ---------------- */
    const filterRect: Rect = { left: x0 + leftWidth + PAGE_GAP, top: mainTop, width: rightWidth, height: LegendPage.FILTER_HEIGHT };
    const filterCard = createCard({ id: 'filter-card', rect: filterRect, title: '分类筛选' });
    this.segmented = new ICESegmented({
      id: 'symbol-filter',
      // 注意坐标基准：加进卡片之后是**卡片内相对坐标**（卡片自己已经在 filterRect 上了），
      // 写成 filterRect.left + CARD_INSET 会整体再偏移一次卡片的位置
      left: CARD_INSET,
      top: 50,
      width: rightWidth - CARD_INSET * 2,
      value: deps.initialFilter,
      options: [{ value: 'all', label: '全部' }].concat(SYMBOL_CATEGORIES.map((item) => ({ value: item.id, label: item.short }))),
      // ICESegmented 走**构造参数** onChange（它不抛 change 事件）
      onChange: (value: string) => this.deps.onFilterChange(value as LegendFilter),
    });
    filterCard.addChild(this.segmented, false);

    const detailRect: Rect = {
      left: x0 + leftWidth + PAGE_GAP,
      top: mainTop + LegendPage.FILTER_HEIGHT + PAGE_GAP,
      width: rightWidth,
      height: mainHeight - LegendPage.FILTER_HEIGHT - PAGE_GAP,
    };
    const detailCard = createCard({ id: 'detail-card', rect: detailRect, title: '符号详情' });
    this.detailWidth = detailRect.width - CARD_INSET * 2;
    this.detailBody = new ICEWidget({
      left: detailRect.left + CARD_INSET,
      top: detailRect.top + 44,
      width: this.detailWidth,
      height: detailRect.height - 60,
      fill: false,
      stroke: false,
      interactive: false,
    });
    this.addChild(filterCard, false);
    this.addChild(detailCard, false);
    this.addChild(this.detailBody, false);

    this.__renderDetail(null, symbolsOfCategory('water').length);
  }

  public islandSpecs(): IslandSpec[] {
    return [{ id: 'legend', rect: LegendPage.legendIslandRect(this.pageCtx.layout) }];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      { key: 'fit', label: '适应视图', onClick: () => this.deps.onAction('fit') },
      { key: 'reset', label: '复位视图', onClick: () => this.deps.onAction('reset') },
      { key: 'svg', label: '导出 SVG', variant: 'primary', onClick: () => this.deps.onAction('export-svg') },
    ];
  }

  /** 本页关心的状态：符号总数 + 当前筛选 */
  public statusTags(): StatusTagSpec[] {
    const total = categoryStats().reduce((sum, item) => sum + item.count, 0);
    const current = this.currentFilter === 'all' ? '全部分类' : categoryMetaOf(this.currentFilter).label;
    return [
      { text: `共 ${total} 种符号`, status: 'primary', width: 108 },
      { text: current, status: 'info', width: 108 },
    ];
  }

  /** 唯一改值入口：清空详情（切页 / 刷新时回到"未选中"）。 */
  public onUpdate(): void {
    this.__renderDetail(null, 0);
  }

  /** 选中一个符号（或 null 清空） */
  public setSelection(entry: SymbolEntry | null, matched: number): void {
    this.__renderDetail(entry, matched);
    this.pageCtx.ice.dirty = true;
  }

  /** 当前筛选值 */
  public filter(): LegendFilter {
    return this.currentFilter;
  }

  /** 从外部（侧栏菜单）改筛选：同步分段控件并重画详情 */
  public setFilter(next: LegendFilter, matched: number): void {
    this.currentFilter = next;
    if (this.segmented.getValue() !== next) this.segmented.setValue(next);
    this.__renderDetail(null, matched);
    this.pageCtx.ice.dirty = true;
  }

  private __renderDetail(entry: SymbolEntry | null, matched: number): void {
    const { theme } = this.pageCtx;
    const width = this.detailWidth;
    this.detailBody.removeChildren([...this.detailBody.childNodes]);
    if (!entry) {
      this.detailBody.addChild(
        paragraph(this.pageCtx, {
          left: 0,
          top: 0,
          width,
          text: `当前筛选：${this.currentFilter === 'all' ? '全部分类' : categoryMetaOf(this.currentFilter).label}，共 ${matched} 种符号。\n点击左侧图例里的任意符号查看它的作用、设计关注与巡检要点。`,
        }),
        false
      );
      return;
    }
    const preset = (WATER_SYMBOL_PRESETS as any)[entry.kind];
    const category = categoryMetaOf(entry.category);
    let y = 0;

    this.detailBody.addChild(
      new ICELabel({
        left: 0,
        top: y,
        width,
        text: entry.label,
        style: { fontSize: 17, fontWeight: '700', fillStyle: theme.colors.text },
      }),
      false
    );
    y += 26;
    this.detailBody.addChild(
      new ICELabel({
        left: 0,
        top: y,
        width,
        text: `${entry.kind} · ${category.label} · 位号代号 ${entry.tag}`,
        style: { fontSize: 11, fillStyle: theme.colors.textTertiary },
      }),
      false
    );
    y += 22;

    this.detailBody.addChild(
      paragraph(this.pageCtx, { left: 0, top: y, width, text: entry.role, color: theme.colors.text }),
      false
    );
    y += Math.max(20, Math.ceil(entry.role.length / (width / 12)) * 19) + 10;

    this.detailBody.addChild(
      new ICEDescriptions({
        left: 0,
        top: y,
        width,
        column: 1,
        items: [
          { label: '常见介质', value: entry.mediums.map(LegendPage.mediumLabelOf).join(' / ') },
          { label: '图形尺寸', value: `${preset.width} × ${preset.height}` },
          { label: '是否串联在管线上', value: preset.inline ? '是（阀门 / 流量计）' : '否' },
        ],
      }),
      false
    );
    y += 108;

    this.detailBody.addChild(sectionHeading(this.pageCtx, 0, y, '设计关注'), false);
    y += 20;
    entry.designFocus.forEach((text) => {
      this.detailBody.addChild(bullet(this.pageCtx, { left: 0, top: y, width, text }), false);
      y += Math.max(20, Math.ceil((text.length + 2) / (width / 12)) * 19) + 2;
    });

    y += 8;
    this.detailBody.addChild(sectionHeading(this.pageCtx, 0, y, '运行巡检要点'), false);
    y += 20;
    entry.checks.forEach((text) => {
      this.detailBody.addChild(bullet(this.pageCtx, { left: 0, top: y, width, text }), false);
      y += Math.max(20, Math.ceil((text.length + 2) / (width / 12)) * 19) + 2;
    });
  }
}
