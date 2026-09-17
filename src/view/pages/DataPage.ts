/**
 * 页 2 —— 运行数据：24 小时看板（`ice-chart`）+ 沿程水量与负荷表 + 出水达标对照 + 运行审计。
 *
 * 看板是**岛**（`ice-chart` 自己 new 一个引擎、自己一张画布），挖在「24 小时运行看板」卡片的正文区。
 * 三张表都是 `ICETable`，表头/分页/空态都由控件库提供。
 *
 * 本页是**页面 OO 化的样板页**（2026-09-17）：一个类 + `onUpdate()` 唯一改值入口 + 声明式只读
 * 访问器，取代原来的 `buildXxxPage()` 工厂 + 闭包句柄（`{ node, islands, statusTags, refresh }`）。
 * 约定见 `view/page.ts`，容器契约见 ice-web-components `docs/guides/layout.md` 第六节。
 */
import { ICETable, ICEWidget } from 'ice-web-components';
import type { AuditIssue, DayPoint, PlantKpi, UnitHydraulics } from '../../domain';
import { QUALITY_LABELS } from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  paragraph,
  sectionHeading,
  type IslandSpec,
  type PageContext,
  type Rect,
  type ShellLayout,
  type StatusTagSpec,
} from '../shell';
import { WaterPage } from '../WaterPage';
import { token } from 'ice-render';

export type DataSnapshot = {
  kpi: PlantKpi;
  issues: AuditIssue[];
  points: DayPoint[];
  hydraulics: UnitHydraulics[];
  modeLabel: string;
};

export type DataPageDeps = {
  snapshot: () => DataSnapshot;
};


/**
 * 运行数据页：一张看板岛 + 三张卡（沿程负荷表 / 达标对照 / 运行审计）。
 *
 * **树只建一次**：卡片、表格、审计容器都在构造期建好；`onUpdate()` 只改数据、不动结构。
 * 唯一例外是审计列表 —— 它是**数量不定**的内容（0~N 条），整段重建比维护增量简单，
 * 但必须先 `removeChildren` 清空（库里记着的坑：不清空会新旧文字叠在一起）。
 */
export class DataPage extends WaterPage {
  private static readonly TREND_HEIGHT = 372;

  private static readonly LOAD_TABLE_WIDTH = 596;

  private static readonly COMPLIANCE_WIDTH = 372;

  /**
   * 「24 小时运行看板」卡片的矩形。
   *
   * 为什么是**静态**方法：入口要在建引擎之前先把岛摆到位，那时页面实例还不存在 ——
   * 版面几何是"这个页面类型"的静态知识，不是某个实例的状态。
   */
  private static boardCardRect(layout: ShellLayout): Rect {
    return {
      left: layout.content.left + PAGE_PADDING,
      top: layout.content.top + PAGE_PADDING,
      width: layout.inner.width,
      height: DataPage.TREND_HEIGHT,
    };
  }

  /** 看板岛的矩形 = 卡片正文区 */
  public static boardIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(DataPage.boardCardRect(layout));
  }

  /**
   * 把控件放进卡片的正文区。
   *
   * 坐标基准是**卡片内相对坐标** —— 卡片自己已经在 rect 上了，这里再加一次 `rect.left`
   * 会让控件整体跑出卡片（症状是"控件在画布外、点不到"）。
   */
  private static placeInCard(card: any, child: any): void {
    child.setState({ left: CARD_INSET, top: 46 });
    card.addChild(child, false);
  }

  private readonly deps: DataPageDeps;
  private readonly loadTable: ICETable;
  private readonly complianceTable: ICETable;
  private readonly auditBody: ICEWidget;
  private readonly auditRect: Rect;

  constructor(ctx: PageContext, deps: DataPageDeps) {
    super(ctx);
    this.deps = deps;
    const { layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const auditWidth = layout.inner.width - DataPage.LOAD_TABLE_WIDTH - DataPage.COMPLIANCE_WIDTH - PAGE_GAP * 2;

    /* ---------------- 24 小时运行看板（岛） ---------------- */
    const trendRect: Rect = DataPage.boardCardRect(layout);
    const trendCard = createCard({
      id: 'trend-card',
      rect: trendRect,
      title: '24 小时进出水趋势 · 滚轮缩放 / 拖拽平移 / 双击图例可只看一条曲线',
    });
    this.addChild(trendCard, false);

    /* ---------------- 底部三块 ---------------- */
    const bottomTop = y0 + DataPage.TREND_HEIGHT + PAGE_GAP;
    const bottomHeight = layout.inner.height - DataPage.TREND_HEIGHT - PAGE_GAP;

    const loadRect: Rect = { left: x0, top: bottomTop, width: DataPage.LOAD_TABLE_WIDTH, height: bottomHeight };
    const loadCard = createCard({ id: 'load-card', rect: loadRect, title: '沿程水量与负荷' });
    this.loadTable = new ICETable({
      id: 'load-table',
      left: 0,
      top: 0,
      width: DataPage.LOAD_TABLE_WIDTH - CARD_INSET * 2,
      rowHeight: 28,
      columns: [
        { key: 'unit', title: '单元' },
        { key: 'flow', title: 'Q m³/d', align: 'right' as const },
        { key: 'hrt', title: 'HRT h', align: 'right' as const },
        { key: 'load', title: '负荷', align: 'right' as const },
        { key: 'power', title: 'kW', align: 'right' as const },
      ],
      data: [],
      pagination: { pageSize: 6, showTotal: true },
    });
    DataPage.placeInCard(loadCard, this.loadTable);

    const complianceRect: Rect = {
      left: x0 + DataPage.LOAD_TABLE_WIDTH + PAGE_GAP,
      top: bottomTop,
      width: DataPage.COMPLIANCE_WIDTH,
      height: bottomHeight,
    };
    const complianceCard = createCard({ id: 'compliance-card', rect: complianceRect, title: '出水达标对照' });
    this.complianceTable = new ICETable({
      id: 'compliance-table',
      left: 0,
      top: 0,
      width: DataPage.COMPLIANCE_WIDTH - CARD_INSET * 2,
      rowHeight: 28,
      columns: [
        { key: 'item', title: '指标' },
        { key: 'value', title: '出水', align: 'right' as const },
        { key: 'limit', title: '限值', align: 'right' as const },
        { key: 'margin', title: '裕度', align: 'right' as const },
      ],
      data: [],
    });
    DataPage.placeInCard(complianceCard, this.complianceTable);

    this.auditRect = {
      left: x0 + DataPage.LOAD_TABLE_WIDTH + DataPage.COMPLIANCE_WIDTH + PAGE_GAP * 2,
      top: bottomTop,
      width: auditWidth,
      height: bottomHeight,
    };
    const auditCard = createCard({ id: 'audit-card', rect: this.auditRect, title: '运行审计' });
    this.auditBody = new ICEWidget({
      left: this.auditRect.left + CARD_INSET,
      top: this.auditRect.top + 44,
      width: this.auditRect.width - CARD_INSET * 2,
      height: this.auditRect.height - 60,
      fill: false,
      stroke: false,
      interactive: false,
    });

    this.addChild(auditCard, false);
    this.addChild(this.auditBody, false);
    this.addChild(loadCard, false);
    this.addChild(complianceCard, false);
  }

  /** 本页的岛：24 小时看板挖在 `trend-card` 的正文区。 */
  public islandSpecs(): IslandSpec[] {
    return [{ id: 'board', rect: DataPage.boardIslandRect(this.pageCtx.layout) }];
  }

  /** 本页关心的状态：当前工况 + 审计结论。 */
  public statusTags(): StatusTagSpec[] {
    const snapshot = this.deps.snapshot();
    const errors = snapshot.issues.filter((issue) => issue.level === 'error').length;
    return [
      { text: snapshot.modeLabel, status: snapshot.modeLabel === '检修停运' ? 'warning' : 'primary', width: 92 },
      {
        text: errors ? `${errors} 项超标` : snapshot.issues.length ? `${snapshot.issues.length} 项关注` : '全部达标',
        status: errors ? 'error' : snapshot.issues.length ? 'warning' : 'success',
        width: 96,
      },
    ];
  }

  /** 唯一改值入口：换上最新快照，结构一概不动。 */
  public onUpdate(): void {
    const snapshot = this.deps.snapshot();
    this.__renderLoadTable(snapshot);
    this.__renderCompliance(snapshot);
    this.__renderAudit(snapshot);
  }

  private __renderLoadTable(snapshot: DataSnapshot): void {
    const rows = snapshot.hydraulics
      .filter((unit) => unit.flow > 0 || unit.power > 0)
      .map((unit) => ({
        unit: `${unit.tag} ${unit.name}${unit.idle ? '（停运）' : ''}`,
        flow: unit.flow > 0 ? unit.flow.toLocaleString() : '—',
        hrt: unit.hrt > 0 ? unit.hrt.toFixed(2) : '—',
        load: unit.surfaceLoad > 0 ? unit.surfaceLoad.toFixed(2) : '—',
        power: unit.power > 0 ? String(unit.power) : '—',
      }));
    this.loadTable.setData(rows);
  }

  private __renderCompliance(snapshot: DataSnapshot): void {
    this.complianceTable.setData(
      snapshot.kpi.compliance.items.map((item) => ({
        item: QUALITY_LABELS[item.index],
        value: item.value.toFixed(2),
        limit: String(item.limit),
        margin: `${Math.round(item.margin * 100)}%`,
      }))
    );
  }

  private __renderAudit(snapshot: DataSnapshot): void {
    const { theme } = this.pageCtx;
    const width = this.auditRect.width - CARD_INSET * 2;
    // 数量不定的列表：整段重建，但先清空 —— 不清会新旧文字叠在一起（库里的坑）。
    this.auditBody.removeChildren([...this.auditBody.childNodes]);
    let y = 0;
    this.auditBody.addChild(
      sectionHeading(
        this.pageCtx,
        0,
        y,
        `${snapshot.modeLabel} · ${snapshot.issues.length ? `${snapshot.issues.length} 条待关注` : '全部正常'}`
      ),
      false
    );
    y += 22;
    if (!snapshot.issues.length) {
      this.auditBody.addChild(
        paragraph(this.pageCtx, {
          left: 0,
          top: y,
          width,
          text: '✅ 未发现问题：六项指标达标，负荷与停留时间都在设计区间内',
          color: token('ui.colors.success'),
        }),
        false
      );
      return;
    }
    snapshot.issues.slice(0, 6).forEach((issue) => {
      const node = paragraph(this.pageCtx, {
        left: 0,
        top: y,
        width,
        text: `${issue.level === 'error' ? '❌' : '⚠️'} ${issue.message}`,
        fontSize: 11,
        color: issue.level === 'error' ? theme.colors.error : theme.colors.warning,
      });
      this.auditBody.addChild(node, false);
      const lines = Math.max(1, Math.ceil((issue.message.length + 3) / (width / 11)));
      y += lines * 18 + 4;
    });
    if (snapshot.issues.length > 6) {
      this.auditBody.addChild(
        paragraph(this.pageCtx, { left: 0, top: y, width, text: `…还有 ${snapshot.issues.length - 6} 条`, fontSize: 11 }),
        false
      );
    }
  }
}
