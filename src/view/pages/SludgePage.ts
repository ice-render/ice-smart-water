/**
 * 页 —— 污泥产运联单（产泥 → 脱水 → 外运 → 归档）。
 *
 * 业务闭环：联单清单 → 点行展开看**处置轨迹**（签发/过磅/签收/归档）→ 行内「推进」把状态往前推一步
 * → 统计卡（闭合率）与右侧流程图（各环节湿泥量）跟着变。数据来自 `domain/sludge-manifest`。
 *
 * 左侧的「污泥流程」是**岛**（独立画布 + ice-chart）：湿泥量随含水率逐段收缩、干泥量恒定，
 * 一根柱 + 一条线正好把这个守恒关系画出来。
 */
import {
  ICEButton,
  ICENotification,
  ICEStatCard,
  ICETable,
  ICETag,
  ICETimeline,
  ICEWidget,
  attachPopconfirm,
} from 'ice-web-components';
import {
  MANIFEST_STATUS_LABELS,
  manifestRows,
  sludgeKpi,
  summarizeManifests,
  type ManifestStatus,
  type PlantKpi,
  type SludgeManifest,
} from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  createStatRow,
  paragraph,
  type HeaderActionSpec,
  type IslandSpec,
  type PageContext,
  type Rect,
  type ShellLayout,
  type StatusTagSpec,
} from '../shell';
import { WaterPage } from '../WaterPage';
import { token } from 'ice-render';

export type SludgePageDeps = {
  /** 当前 KPI（入口持有，随工况/图纸变化） */
  kpi: () => PlantKpi;
  /** 联单清单（入口持有状态，推进后由入口写回） */
  manifests: () => SludgeManifest[];
  /** 推进一张联单的状态 */
  onAdvance: (id: string) => void;
  /** 操作人（写进轨迹） */
  operator: () => string;
};



/** 污泥产运页：五个统计 + 污泥流程（岛）+ 外运联单表。 */
export class SludgePage extends WaterPage {
  private static readonly STAT_HEIGHT = 96;

  private static readonly FLOW_WIDTH_RATIO = 0.38;

  private static readonly STATUS_STYLE: Record<ManifestStatus, string> = {
    issued: 'info',
    weighed: 'warning',
    signed: 'primary',
    closed: 'success',
  };

  /** 「污泥流程」卡片 */
  private static flowCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    return {
      left: x0,
      top: y0 + SludgePage.STAT_HEIGHT + PAGE_GAP,
      width: Math.round(layout.inner.width * SludgePage.FLOW_WIDTH_RATIO),
      height: layout.inner.height - SludgePage.STAT_HEIGHT - PAGE_GAP,
    };
  }

  /** 「污泥流程」岛（画在卡片正文里） */
  public static sludgeFlowIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(SludgePage.flowCardRect(layout));
  }

  /** 「外运联单」表格卡片 */
  private static manifestCardRect(layout: ShellLayout): Rect {
    const flow = SludgePage.flowCardRect(layout);
    return {
      left: flow.left + flow.width + PAGE_GAP,
      top: flow.top,
      width: layout.inner.width - flow.width - PAGE_GAP,
      height: flow.height,
    };
  }

  private readonly deps: SludgePageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly table: ICETable;

  constructor(ctx: PageContext, deps: SludgePageDeps) {
    super(ctx);
    this.deps = deps;
    const { theme, layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

    /* ---------------- 第一行：五个统计 ---------------- */
    // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: SludgePage.STAT_HEIGHT, count: 5, gap: PAGE_GAP });
    this.addChild(statRow, false);
    const statConfigs = [
      { title: '干泥产量', icon: '◍', trend: 'tDS/d', type: 'primary' as const },
      { title: '泥饼量（湿）', icon: '▤', trend: 'm³/d', type: 'info' as const },
      { title: '泥饼含水率', icon: '💧', trend: '≤ 80%', type: 'success' as const },
      { title: 'PAM 单耗', icon: '⚗', trend: 'kg/tDS', type: 'warning' as const },
      { title: '外运车次', icon: '🚚', trend: '按 12 t/车', type: 'primary' as const },
    ];
    this.statCards = statConfigs.map((config) => {
      const card = new ICEStatCard({
        height: SludgePage.STAT_HEIGHT,
        icon: config.icon,
        title: config.title,
        value: '0',
        trend: config.trend,
        trendType: config.type,
      });
      statRow.addChild(card, false);
      return card;
    });

    /* ---------------- 第二行左：污泥流程（岛） ---------------- */
    const flowCard = createCard({
      id: 'sludge-flow-card',
      rect: SludgePage.flowCardRect(layout),
      title: '污泥流程：湿泥量随含水率收缩，干泥量守恒',
    });
    this.addChild(flowCard, false);

    /* ---------------- 第二行右：外运联单 ---------------- */
    const manifestRect = SludgePage.manifestCardRect(layout);
    const rowFor = (rowId: string) => this.deps.manifests().filter((item) => item.id === rowId)[0];

    this.table = new ICETable({
      id: 'manifest-table',
      left: CARD_INSET,
      top: 46,
      width: manifestRect.width - CARD_INSET * 2,
      rowHeight: 36,
      rowKey: 'id',
      pagination: { pageSize: 6, showTotal: true },
      columns: [
        { key: 'issuedAt', title: '时刻', width: 60 },
        { key: 'id', title: '联单号', width: 120 },
        { key: 'receiver', title: '接收单位', width: 190 },
        { key: 'wetTon', title: '净重 t', width: 66 },
        {
          key: 'status',
          title: '状态',
          width: 76,
          renderCell: (value: string, row: any) => {
            const item = rowFor(String(row.id));
            return new ICETag({
              left: 0,
              top: 6,
              width: 68,
              height: 22,
              text: String(value),
              status: item ? SludgePage.STATUS_STYLE[item.status] : 'info',
              variant: 'soft',
            });
          },
        },
        {
          key: 'action',
          title: '处置',
          width: 96,
          renderCell: (value: string, row: any) => {
            const cell = new ICEWidget({ left: 0, top: 0, width: 92, height: 30, fill: false, stroke: false, interactive: false });
            const item = rowFor(String(row.id));
            const closed = item ? item.status === 'closed' : true;
            const button = new ICEButton({
              id: `manifest-action-${row.id}`,
              left: 0,
              top: 4,
              width: 84,
              height: 28,
              text: closed ? '已归档' : '推进',
              size: 'small',
              variant: closed ? 'default' : 'primary',
            });
            if (!closed) {
              attachPopconfirm(ctx.ice, button, {
                title: '推进这张联单？',
                description: '按 签发 → 过磅 → 签收 → 归档 顺序往前一步，并记入处置轨迹。',
                onConfirm: () => {
                  if (!item) return;
                  this.deps.onAdvance(item.id);
                  this.onUpdate();
                  ICENotification.open(ctx.ice, {
                    title: '联单已推进',
                    description: `${item.id} · ${MANIFEST_STATUS_LABELS[item.status]}`,
                    type: 'success',
                  });
                },
              });
            }
            cell.addChild(button, false);
            return cell;
          },
        },
      ],
      data: [],
      summary: (rows: any[]) => ({
        issuedAt: `本页 ${rows.length} 张`,
        id: '合计',
        wetTon: `${rows.reduce((sum, row) => sum + Number(row.wetTon || 0), 0).toFixed(1)} t`,
        action: '',
      }),
      expandable: {
        expandedRowHeight: 132,
        render: (row: any, cellCtx: { width: number }) => {
          const item = rowFor(String(row.id));
          const wrap = new ICEWidget({
            left: 0,
            top: 0,
            width: Math.max(200, cellCtx.width - 24),
            height: 124,
            fill: false,
            stroke: false,
            interactive: false,
          });
          if (!item) return wrap;
          wrap.addChild(
            paragraph(ctx, {
              left: 0,
              top: 0,
              width: wrap.state.width,
              text: `车号 ${item.truck} · 含水率 ${Math.round(item.waterRate * 1000) / 10}% · 折算干泥 ${item.dryTon.toFixed(2)} tDS · PAM ${item.pamKg.toFixed(1)} kg`,
              fontSize: 12,
              color: token('ui.colors.text'),
            }),
            false
          );
          wrap.addChild(
            new ICETimeline({
              left: 0,
              top: 34,
              width: wrap.state.width,
              items: item.actions.map((action) => ({
                title: action.text,
                time: `${action.at} · ${action.by}`,
                color: action.by === '系统' ? token('ui.colors.textTertiary') : token('ui.colors.link'),
              })),
            }),
            false
          );
          return wrap;
        },
      },
    });

    const manifestCard = createCard({
      id: 'manifest-card',
      rect: manifestRect,
      title: '外运联单（点行展开处置轨迹，行内可推进状态）',
    });
    manifestCard.addChild(this.table, false);
    this.addChild(manifestCard, false);

    this.onUpdate();
  }

  public islandSpecs(): IslandSpec[] {
    return [{ id: 'sludge-flow', rect: SludgePage.sludgeFlowIslandRect(this.pageCtx.layout) }];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'sludge-plan',
        label: '核对今日出车计划',
        onClick: () => {
          const kpi = sludgeKpi(this.deps.kpi().sludge, this.deps.manifests());
          this.pageCtx.toast(`今日应出 ${kpi.trucks} 车，泥饼 ${kpi.cakeVolume.toFixed(1)} m³`);
        },
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    const kpi = sludgeKpi(this.deps.kpi().sludge, this.deps.manifests());
    return [
      {
        text: kpi.closureRate >= 1 ? '联单全归档' : `联单闭合 ${kpi.closed}/${kpi.total}`,
        status: kpi.closureRate >= 1 ? 'success' : 'warning',
        width: 148,
      },
      { text: `${kpi.trucks} 车 / 日`, status: 'info', width: 96 },
    ];
  }

  /** 当前联单状态分布（e2e 用） */
  public statusCounts(): Record<ManifestStatus, number> {
    return summarizeManifests(this.deps.manifests());
  }

  /** 唯一改值入口。 */
  public onUpdate(): void {
    const manifests = this.deps.manifests();
    const kpi = sludgeKpi(this.deps.kpi().sludge, manifests);
    this.statCards[0].setValue(kpi.drySludge.toFixed(2));
    this.statCards[0].setTrend(`${kpi.drySludge.toFixed(2)} tDS/d`);
    this.statCards[1].setValue(kpi.cakeVolume.toFixed(1));
    this.statCards[1].setTrend(`${kpi.cakeVolume.toFixed(1)} m³/d`);
    this.statCards[2].setValue(`${Math.round(kpi.waterRate * 1000) / 10}%`);
    this.statCards[2].setTrend('≤ 80% 达标');
    this.statCards[3].setValue(kpi.pamUnit.toFixed(1));
    this.statCards[3].setTrend(`日耗 ${kpi.pamDaily.toFixed(1)} kg`);
    this.statCards[4].setValue(String(kpi.trucks));
    this.statCards[4].setTrend(`闭合率 ${Math.round(kpi.closureRate * 100)}%`);

    this.table.setData(manifestRows(manifests));
    this.pageCtx.ice.dirty = true;
  }
}
