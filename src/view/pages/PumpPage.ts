/**
 * 页 —— 泵站监视。
 *
 * 厂内四台泵（进水泵 / 回流污泥泵 / 事故水回流泵 / 污泥螺杆泵）的**工况 + 特性 + 集水井液位**。
 * 工况由业务流量按相似定律反推（转速 ∝ 流量、轴功率 ∝ 转速³），所以"图上流量一变，泵的转速、
 * 效率、单位提升电耗全跟着变"；表里可以**人工投运/停运**备用泵，需求会在运行泵之间重新平摊。
 */
import { ICEButton, ICEStatCard, ICETable, ICETag, ICEWidget } from 'ice-web-components';
import {
  pumpKpi,
  pumpRows,
  SUMP_LEVEL_HIGH,
  SUMP_LEVEL_LOW,
  type PumpKpi,
  type PumpStationData,
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

export type PumpPageDeps = {
  stations: () => PumpStationData[];
  /** 人工启停（入口持有 override） */
  onToggle: (pumpId: string) => void;
  /** 清空人工启停，恢复默认（工作泵转、备用泵停） */
  onReset: () => void;
  overrides: () => Record<string, boolean>;
};


/** 泵站监视页：四个统计 + 两张图（岛）+ 泵组清单表。 */
export class PumpPage extends WaterPage {
  private static readonly STAT_HEIGHT = 96;

  private static readonly ISLAND_ROW_RATIO = 0.54;

  private static pumpCurveCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const row2Top = y0 + PumpPage.STAT_HEIGHT + PAGE_GAP;
    const rest = layout.inner.height - PumpPage.STAT_HEIGHT - PAGE_GAP * 2;
    const width = Math.round((layout.inner.width - PAGE_GAP) / 2);
    return { left: x0, top: row2Top, width, height: Math.round(rest * PumpPage.ISLAND_ROW_RATIO) };
  }

  public static pumpCurveIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(PumpPage.pumpCurveCardRect(layout));
  }

  private static sumpLevelCardRect(layout: ShellLayout): Rect {
    const curve = PumpPage.pumpCurveCardRect(layout);
    return { left: curve.left + curve.width + PAGE_GAP, top: curve.top, width: curve.width, height: curve.height };
  }

  public static sumpLevelIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(PumpPage.sumpLevelCardRect(layout));
  }

  private static pumpTableCardRect(layout: ShellLayout): Rect {
    const curve = PumpPage.pumpCurveCardRect(layout);
    return {
      left: curve.left,
      top: curve.top + curve.height + PAGE_GAP,
      width: layout.inner.width,
      height: layout.inner.height - PumpPage.STAT_HEIGHT - curve.height - PAGE_GAP * 2,
    };
  }

  private readonly deps: PumpPageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly table: ICETable;

  constructor(ctx: PageContext, deps: PumpPageDeps) {
    super(ctx);
    this.deps = deps;
    const { theme, layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

  /* ---------------- 第一行：四个统计 ---------------- */
  // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
  const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: PumpPage.STAT_HEIGHT, count: 4, gap: PAGE_GAP });
    this.addChild(statRow, false);
  const statConfigs = [
    { title: '运行 / 备用', icon: '◎', trend: '泵组状态', type: 'primary' as const },
    { title: '总提升流量', icon: '⇅', trend: '运行泵合计', type: 'info' as const },
    { title: '单位提升电耗', icon: '◔', trend: 'kWh/千m³', type: 'success' as const },
    { title: '今日启停', icon: '⏻', trend: '运行稳定度', type: 'warning' as const },
  ];
  this.statCards = statConfigs.map((config, index) => {
    const card = new ICEStatCard({
      height: PumpPage.STAT_HEIGHT,
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
  const curveCard = createCard({
    id: 'pump-curve-card',
    rect: PumpPage.pumpCurveCardRect(layout),
    title: '泵特性：效率与流量随转速变化',
  });
    this.addChild(curveCard, false);

  const levelCard = createCard({
    id: 'sump-level-card',
    rect: PumpPage.sumpLevelCardRect(layout),
    title: '集水井液位：高低报警线之间运行',
  });
    this.addChild(levelCard, false);

  /* ---------------- 第三行：泵组表 ---------------- */
  const tableRect = PumpPage.pumpTableCardRect(layout);
  const pumpFor = (pumpId: string) =>
    deps
      .stations()
      .flatMap((station) => station.pumps)
      .filter((pump) => pump.id === pumpId)[0];

  this.table = new ICETable({
    id: 'pump-table',
    left: CARD_INSET,
    top: 46,
    width: tableRect.width - CARD_INSET * 2,
    rowHeight: 34,
    rowKey: 'id',
    columns: [
      { key: 'tag', title: '位号', width: 96 },
      { key: 'name', title: '设备名称', width: 148 },
      { key: 'station', title: '所属泵房', width: 126 },
      { key: 'flow', title: '当前流量', width: 108, sorter: true },
      { key: 'speed', title: '转速', width: 84, sorter: true },
      { key: 'efficiency', title: '效率', width: 84 },
      { key: 'power', title: '轴功率', width: 100, sorter: true },
      { key: 'specific', title: '单位电耗', width: 108, sorter: true },
      {
        key: 'state',
        title: '状态',
        width: 84,
        renderCell: (value: string, row: any) => {
          const pump = pumpFor(String(row.id));
          return new ICETag({
            left: 0,
            top: 6,
            width: 68,
            height: 22,
            text: String(value),
            status: pump && pump.running ? 'success' : 'info',
            variant: 'soft',
          });
        },
      },
      {
        key: 'action',
        title: '人工启停',
        width: 108,
        renderCell: (value: string, row: any) => {
          const cell = new ICEWidget({ left: 0, top: 0, width: 104, height: 30, fill: false, stroke: false, interactive: false });
          const pump = pumpFor(String(row.id));
          const button = new ICEButton({
            id: `pump-toggle-${row.id}`,
            left: 0,
            top: 4,
            width: 96,
            height: 26,
            text: pump && pump.running ? '停运' : '投运',
            size: 'small',
            variant: pump && pump.running ? 'default' : 'primary',
          });
          button.on('click', () => {
            this.deps.onToggle(String(row.id));
            this.onUpdate();
            this.pageCtx.toast(
              `${pump ? pump.tag : row.id} 已${pump && pump.running ? '停运' : '投运'}，需求在运行泵之间重新平摊`
            );
          });
          cell.addChild(button, false);
          return cell;
        },
      },
    ],
    data: [],
    summary: (rows: any[]) => ({
      tag: `共 ${rows.length} 台`,
      name: '合计',
      flow: `${rows
        .reduce((sum, row) => sum + Number(String(row.flow).replace(/[^\d.]/g, '') || 0), 0)
        .toFixed(0)} m³/h`,
      action: '',
    }),
    expandable: {
      expandedRowHeight: 76,
      render: (row: any, cellCtx: { width: number }) => {
        const pump = pumpFor(String(row.id));
        const wrap = new ICEWidget({
          left: 0,
          top: 0,
          width: Math.max(200, cellCtx.width - 24),
          height: 68,
          fill: false,
          stroke: false,
          interactive: false,
        });
        if (!pump) return wrap;
        wrap.addChild(
          paragraph(ctx, {
            left: 0,
            top: 0,
            width: wrap.state.width,
            text: `介质 ${pump.medium} · 额定 ${pump.ratedFlow} m³/h / ${pump.ratedHead} m / ${pump.ratedPower} kW · 今日启停 ${pump.starts} 次 · 累计运行 ${pump.runtimeH.toFixed(1)} h`,
            fontSize: 12,
            color: token('ui.colors.text'),
          }),
          false
        );
        return wrap;
      },
    },
  });

  const tableCard = createCard({
    id: 'pump-table-card',
    rect: tableRect,
    title: '泵组清单（点行展开铭牌与今日运行；可人工投运 / 停运）',
  });
    tableCard.addChild(this.table, false);
    this.addChild(tableCard, false);

    // 「构造结束即画好」：先渲染一次，页面上任何时刻读到的都是最新数据
    this.onUpdate();
  }

  /** 唯一改值入口。 */
  public onUpdate(): void {
    const stations = this.deps.stations();
    const kpi = pumpKpi(stations);
    this.statCards[0].setValue(`${kpi.running} / ${kpi.standby}`);
    this.statCards[0].setTrend(`装机 ${kpi.ratedPower.toFixed(0)} kW · 当前 ${kpi.runningPower.toFixed(0)} kW`);
    this.statCards[1].setValue(kpi.totalFlow.toFixed(0));
    this.statCards[1].setTrend(`${kpi.totalFlow.toFixed(0)} m³/h（运行泵合计）`);
    this.statCards[2].setValue(kpi.specificEnergy.toFixed(2));
    this.statCards[2].setTrend('kWh/千m³（越低越省）');
    this.statCards[3].setValue(String(kpi.startsToday));
    this.statCards[3].setTrend(kpi.startsToday > 12 ? '启停偏多，注意调节' : '运行平稳');

    this.table.setData(pumpRows(stations));
    this.pageCtx.ice.requestRepaint();
  }

  public islandSpecs(): IslandSpec[] {
    return [
      { id: 'pump-curve', rect: PumpPage.pumpCurveIslandRect(this.pageCtx.layout) },
      { id: 'sump-level', rect: PumpPage.sumpLevelIslandRect(this.pageCtx.layout) },
    ];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'pump-reset',
        label: '恢复默认泵组',
        onClick: () => {
          this.deps.onReset();
          this.onUpdate();
          this.pageCtx.toast('泵组已恢复默认（工作泵运行、备用泵热备用）');
        },
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    const kpi = pumpKpi(this.deps.stations());
    return [
      {
        text: kpi.levelAlarm ? '液位越限' : '液位正常',
        status: kpi.levelAlarm ? 'error' : 'success',
        width: 108,
      },
      {
        text: `最高液位 ${Math.round(kpi.worstLevel * 100)}%（高线 ${Math.round(SUMP_LEVEL_HIGH * 100)}% / 低线 ${Math.round(SUMP_LEVEL_LOW * 100)}%）`,
        status: 'info',
        width: 268,
      },
    ];
  }

  /** e2e 用 */
  public metrics(): PumpKpi {
    return pumpKpi(this.deps.stations());
  }
}
