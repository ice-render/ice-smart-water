/**
 * 页 —— 能耗分项与吨水电耗。
 *
 * 回答三个问题：「电花在哪儿（分项）」「什么时段花的（峰谷）」「还能不能省（单位去除电耗）」。
 * 两张图各占一半：分项柱状图 + 峰谷分摊（柱=电量、线=电价）；下面一张分项明细表把口径摊开
 * （装机 / 负载系数 / 占比各是多少）。
 */
import { ICEStatCard, ICETable, ICETag, ICEWidget } from 'ice-web-components';
import type { EnergyKpi, MeterNode } from '../../domain';
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

export type EnergyPageDeps = {
  energy: () => EnergyKpi;
  nodes: () => MeterNode[];
};


/** 能耗分项页：五个统计 + 两张图（岛）+ 分项明细表。 */
export class EnergyPage extends WaterPage {
  private static readonly STAT_HEIGHT = 96;

  private static readonly ISLAND_ROW_RATIO = 0.52;

  private static energyMixCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const row2Top = y0 + EnergyPage.STAT_HEIGHT + PAGE_GAP;
    const rest = layout.inner.height - EnergyPage.STAT_HEIGHT - PAGE_GAP * 2;
    const width = Math.round((layout.inner.width - PAGE_GAP) / 2);
    return { left: x0, top: row2Top, width, height: Math.round(rest * EnergyPage.ISLAND_ROW_RATIO) };
  }

  public static energyMixIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(EnergyPage.energyMixCardRect(layout));
  }

  private static tariffCardRect(layout: ShellLayout): Rect {
    const mix = EnergyPage.energyMixCardRect(layout);
    return { left: mix.left + mix.width + PAGE_GAP, top: mix.top, width: mix.width, height: mix.height };
  }

  public static tariffIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(EnergyPage.tariffCardRect(layout));
  }

  private static energyTableCardRect(layout: ShellLayout): Rect {
    const mix = EnergyPage.energyMixCardRect(layout);
    return {
      left: mix.left,
      top: mix.top + mix.height + PAGE_GAP,
      width: layout.inner.width,
      height: layout.inner.height - EnergyPage.STAT_HEIGHT - mix.height - PAGE_GAP * 2,
    };
  }

  private readonly deps: EnergyPageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly table: ICETable;

  constructor(ctx: PageContext, deps: EnergyPageDeps) {
    super(ctx);
    this.deps = deps;
    const { theme, layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

    /* ---------------- 第一行：五个统计 ---------------- */
    // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: EnergyPage.STAT_HEIGHT, count: 5, gap: PAGE_GAP });
    this.addChild(statRow, false);
    const statConfigs = [
      { title: '日耗电', icon: '⚡', trend: '全厂 kWh/d', type: 'primary' as const },
      { title: '吨水电耗', icon: '◔', trend: 'kWh/m³', type: 'info' as const },
      { title: '曝气占比', icon: '🜁', trend: '鼓风 + 曝气', type: 'warning' as const },
      { title: '单位去除电耗', icon: '◍', trend: 'kWh/kgCOD', type: 'success' as const },
      { title: '日电费', icon: '💰', trend: '分时电价', type: 'primary' as const },
    ];
    this.statCards = statConfigs.map((config) => {
      const card = new ICEStatCard({
        height: EnergyPage.STAT_HEIGHT,
        icon: config.icon,
        title: config.title,
        value: '0',
        trend: config.trend,
        trendType: config.type,
      });
      statRow.addChild(card, false);
      return card;
    });

    /* ---------------- 第二行：两张图（岛） ---------------- */
    const mixCard = createCard({
      id: 'energy-mix-card',
      rect: EnergyPage.energyMixCardRect(layout),
      title: '能耗分项：日耗电按分项摊分',
    });
    this.addChild(mixCard, false);

    const tariffCard = createCard({
      id: 'energy-tariff-card',
      rect: EnergyPage.tariffCardRect(layout),
      title: '峰谷分摊：电量（柱）与电价（线）',
    });
    this.addChild(tariffCard, false);

    /* ---------------- 第三行：分项明细 ---------------- */
    const tableRect = EnergyPage.energyTableCardRect(layout);
    const nodeFor = (rowId: string) => this.deps.nodes().filter((node) => node.id === rowId)[0];

    this.table = new ICETable({
      id: 'energy-table',
      left: CARD_INSET,
      top: 46,
      width: tableRect.width - CARD_INSET * 2,
      rowHeight: 34,
      rowKey: 'id',
      columns: [
        { key: 'name', title: '分项', width: 150 },
        { key: 'power', title: '装机 kW', width: 120, sorter: true },
        { key: 'energy', title: '日耗电 kWh', width: 130, sorter: true },
        {
          key: 'share',
          title: '占比',
          width: 100,
          sorter: true,
          renderCell: (value: string, row: any) => {
            const node = nodeFor(String(row.id));
            return new ICETag({
              left: 0,
              top: 6,
              width: 86,
              height: 22,
              text: String(value),
              status: node && node.share >= 0.4 ? 'warning' : 'info',
              variant: 'soft',
            });
          },
        },
        { key: 'duty', title: '负载系数', width: 110 },
        { key: 'note', title: '口径说明', width: 560 },
      ],
      data: [],
      summary: (rows: any[]) => ({
        name: `共 ${rows.length} 个分项`,
        power: `${rows.reduce((sum, row) => sum + Number(String(row.power).replace(/[^\d.]/g, '') || 0), 0).toFixed(0)} kW`,
        energy: '合计',
        note: '',
      }),
      expandable: {
        expandedRowHeight: 76,
        render: (row: any, cellCtx: { width: number }) => {
          const node = nodeFor(String(row.id));
          const wrap = new ICEWidget({
            left: 0,
            top: 0,
            width: Math.max(200, cellCtx.width - 24),
            height: 68,
            fill: false,
            stroke: false,
            interactive: false,
          });
          if (!node) return wrap;
          wrap.addChild(
            paragraph(ctx, {
              left: 0,
              top: 0,
              width: wrap.state.width,
              text: `归入该分项的设备：${node.tags.join('、') || '—'}`,
              fontSize: 12,
              color: theme.colors.text,
            }),
            false
          );
          return wrap;
        },
      },
    });

    const tableCard = createCard({
      id: 'energy-table-card',
      rect: tableRect,
      title: '分项明细（点行展开看归入的设备位号）',
    });
    tableCard.addChild(this.table, false);
    this.addChild(tableCard, false);
  }

  public islandSpecs(): IslandSpec[] {
    return [
      { id: 'energy-mix', rect: EnergyPage.energyMixIslandRect(this.pageCtx.layout) },
      { id: 'energy-tariff', rect: EnergyPage.tariffIslandRect(this.pageCtx.layout) },
    ];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'energy-peak',
        label: '看峰段电量',
        onClick: () => {
          const split = this.deps.energy().tariff;
          this.pageCtx.toast(
            `峰段 ${split.peak.toFixed(0)} kWh（占 ${Math.round(split.peakShare * 100)}%）、日电费 ${split.cost} 元`,
            split.peakShare > 0.4 ? 'warning' : 'success'
          );
        },
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    const kpi = this.deps.energy();
    return [
      {
        text: `吨水电耗 ${kpi.energyPerCubicMeter.toFixed(2)}`,
        status: kpi.energyPerCubicMeter <= 0.45 ? 'success' : 'warning',
        width: 148,
      },
      { text: `日电费 ${kpi.tariff.cost} 元`, status: 'info', width: 132 },
    ];
  }

  /** e2e 用 */
  public metrics(): EnergyKpi {
    return this.deps.energy();
  }

  /** 唯一改值入口。 */
  public onUpdate(): void {
    const kpi = this.deps.energy();
    this.statCards[0].setValue(kpi.energyTotal.toFixed(0));
    this.statCards[0].setTrend(`${kpi.energyTotal.toFixed(0)} kWh/d · 装机 ${kpi.installedPower.toFixed(0)} kW`);
    this.statCards[1].setValue(kpi.energyPerCubicMeter.toFixed(2));
    this.statCards[1].setTrend('kWh/m³（AAO 常见 0.2~0.45）');
    this.statCards[2].setValue(`${Math.round(kpi.blowerShare * 100)}%`);
    this.statCards[2].setTrend('曝气与鼓风占全厂日耗电');
    this.statCards[3].setValue(kpi.removalEnergy.toFixed(2));
    this.statCards[3].setTrend('kWh/kgCOD（按去除量）');
    this.statCards[4].setValue(String(kpi.tariff.cost));
    this.statCards[4].setTrend(`均价 ${kpi.tariff.avgPrice.toFixed(3)} 元/kWh`);

    this.table.setData(
      this.deps.nodes().map((node) => ({
        id: node.id,
        name: node.name,
        power: node.power.toFixed(0),
        energy: node.energy.toFixed(0),
        share: `${Math.round(node.share * 100)}%`,
        duty: `${Math.round(node.duty * 100)}%`,
        note: node.note,
      }))
    );
    this.pageCtx.ice.dirty = true;
  }
}
