/**
 * 页 —— 工况预案演练（预案 → 预演 → 对比）。
 *
 * 上面选预案、中间看「预演步骤 + 达标度对比图」、下面逐条看偏差（达标/不达标）。
 * 预演**复用现有模型**（`sizing.evaluateScenario`），不另造一套 —— 所以页面上任何数字
 * 都能在"工艺试算"页用同一套参数复现。
 */
import { ICEStatCard, ICESegmented, ICETable, ICETag, ICEWidget } from 'ice-web-components';
import { drillKpi, drillRows, type DrillRun } from '../../domain';
import {
  CARD_INSET,
  CARD_TITLE_BAND,
  PAGE_GAP,
  PAGE_PADDING,
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

export type DrillPageDeps = {
  /** 当前预案 id（入口持有） */
  planId: () => string;
  /** 换预案 */
  onSelectPlan: (id: string) => void;
  /** 预演结果（入口按当前预案算好） */
  run: () => DrillRun;
  /** 可选预案清单（给分段控件） */
  plans: Array<{ id: string; name: string }>;
};

const STAT_HEIGHT = 96;
const ROW2_RATIO = 0.5;

/** 说明文案**必须短**：单元格文字节点按文字宽度排版，写长了会溢出列（expectTableFits 会抓） */
const NOTE_BY_ID: Record<string, string> = {
  removal: '上界由回流比决定',
  srt: '硝化菌养得住的前提',
  fm: '过高二沉池易跑泥',
  energy: '运行成本的直接口径',
  passed: '一级 A 六项达标数',
};

/** 工况预案页：四个统计 + 预演步骤 + 达标度对比（岛）+ 偏差明细表。 */
export class DrillPage extends WaterPage {
  private static compareCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const row2Top = y0 + STAT_HEIGHT + PAGE_GAP;
    const rest = layout.inner.height - STAT_HEIGHT - PAGE_GAP * 2;
    const width = Math.round(layout.inner.width * 0.58);
    return { left: x0 + (layout.inner.width - width), top: row2Top, width, height: Math.round(rest * ROW2_RATIO) };
  }

  public static drillCompareIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(DrillPage.compareCardRect(layout));
  }

  private static stepsCardRect(layout: ShellLayout): Rect {
    const compare = DrillPage.compareCardRect(layout);
    return {
      left: layout.content.left + PAGE_PADDING,
      top: compare.top,
      width: compare.left - (layout.content.left + PAGE_PADDING) - PAGE_GAP,
      height: compare.height,
    };
  }

  private static tableCardRect(layout: ShellLayout): Rect {
    const compare = DrillPage.compareCardRect(layout);
    return {
      left: layout.content.left + PAGE_PADDING,
      top: compare.top + compare.height + PAGE_GAP,
      width: layout.inner.width,
      height: layout.inner.height - STAT_HEIGHT - compare.height - PAGE_GAP * 2,
    };
  }

  private readonly deps: DrillPageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly stepsBody: ICEWidget;
  private readonly table: ICETable;

  constructor(ctx: PageContext, deps: DrillPageDeps) {
    super(ctx);
    this.deps = deps;
    const { layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

    /* ---------------- 第一行：四个统计 ---------------- */
    // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: STAT_HEIGHT, count: 4, gap: PAGE_GAP });
    this.addChild(statRow, false);
    const statConfigs = [
      { title: '预案达标', icon: '✔', trend: '按验收口径', type: 'success' as const },
      { title: '达标率', icon: '◔', trend: '达标条数 / 总条数', type: 'primary' as const },
      { title: '吨水电耗变化', icon: '⚡', trend: '相对当前参数', type: 'warning' as const },
      { title: '切换耗时', icon: '⏱', trend: '调度属性（非模型输出）', type: 'info' as const },
    ];
    this.statCards = statConfigs.map((config) => {
      const card = new ICEStatCard({
        height: STAT_HEIGHT,
        icon: config.icon,
        title: config.title,
        value: '0',
        trend: config.trend,
        trendType: config.type,
      });
      statRow.addChild(card, false);
      return card;
    });

    /* ---------------- 第二行左：预演步骤 ---------------- */
    const stepsRect = DrillPage.stepsCardRect(layout);
    // 正文容器必须落在**卡片的正文区**（标题带 44px 之下、左右各留 CARD_INSET），
    // 放在 (0,0) 会让第一行文字压在卡片标题上（版面体检抓到过）
    this.stepsBody = new ICEWidget({
      left: CARD_INSET,
      top: CARD_TITLE_BAND,
      width: stepsRect.width - CARD_INSET * 2,
      height: stepsRect.height - CARD_TITLE_BAND - CARD_INSET,
      fill: false,
      stroke: false,
      interactive: false,
    });
    const stepsCard = createCard({
      id: 'drill-steps-card',
      rect: stepsRect,
      title: '预演步骤与说明',
      extra: () =>
        new ICESegmented({
          id: 'drill-plan-select',
          left: 0,
          top: 0,
          width: 320,
          value: this.deps.planId(),
          options: this.deps.plans.map((plan) => ({ value: plan.id, label: plan.name })),
          onChange: (value: string) => {
            this.deps.onSelectPlan(value);
            this.onUpdate();
          },
        }),
    });
    stepsCard.addChild(this.stepsBody, false);
    this.addChild(stepsCard, false);

    /* ---------------- 第二行右：达标度对比（岛） ---------------- */
    const compareCard = createCard({
      id: 'drill-compare-card',
      rect: DrillPage.compareCardRect(layout),
      title: '达标度对比：当前参数 vs 预案参数',
    });
    this.addChild(compareCard, false);

    /* ---------------- 第三行：偏差明细 ---------------- */
    const tableRect = DrillPage.tableCardRect(layout);
    const rowFor = (rowId: string) => this.deps.run().deviations.filter((item) => item.id === rowId)[0];

    this.table = new ICETable({
      id: 'drill-table',
      left: CARD_INSET,
      top: 46,
      width: tableRect.width - CARD_INSET * 2,
      rowHeight: 34,
      rowKey: 'id',
      columns: [
        { key: 'label', title: '指标', width: 190 },
        { key: 'value', title: '预案取值', width: 190 },
        { key: 'target', title: '验收口径', width: 190 },
        { key: 'score', title: '达标度', width: 130, sorter: true },
        {
          key: 'status',
          title: '结论',
          width: 150,
          renderCell: (value: string, row: any) => {
            const item = rowFor(String(row.id));
            return new ICETag({
              left: 0,
              top: 6,
              width: 84,
              height: 22,
              text: String(value),
              status: item && item.ok ? 'success' : 'error',
              variant: 'soft',
            });
          },
        },
        { key: 'note', title: '说明', width: 300 },
      ],
      data: [],
      summary: (rows: any[]) => ({
        label: `共 ${rows.length} 条`,
        value: '',
        target: '',
        status: `${rows.filter((row) => row.status === '达标').length} 条达标`,
        note: '',
      }),
    });

    const tableCard = createCard({
      id: 'drill-table-card',
      rect: tableRect,
      title: '偏差明细（每条的取值、口径与达标度）',
    });
    tableCard.addChild(this.table, false);
    this.addChild(tableCard, false);
  }

  public islandSpecs(): IslandSpec[] {
    return [{ id: 'drill-compare', rect: DrillPage.drillCompareIslandRect(this.pageCtx.layout) }];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'drill-apply',
        // 顶栏按钮默认宽 96px，只装得下 6 个汉字；标题写长了会被截断，所以文案短 + 显式给宽
        label: '送到工艺试算',
        width: 132,
        onClick: () => {
          const run = this.deps.run();
          this.pageCtx.toast(`已选中「${run.plan.name}」：参数 ${JSON.stringify(run.plan.params)}`);
        },
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    const run = this.deps.run();
    const kpi = drillKpi(run);
    return [
      { text: `预案「${run.plan.name}」`, status: 'info', width: 168 },
      {
        text: kpi.passed === kpi.total ? '全部达标' : `${kpi.total - kpi.passed} 条未达标`,
        status: kpi.passed === kpi.total ? 'success' : 'error',
        width: 132,
      },
    ];
  }

  /** e2e 用 */
  public metrics(): ReturnType<typeof drillKpi> {
    return drillKpi(this.deps.run());
  }

  /** 唯一改值入口。 */
  public onUpdate(): void {
    const { theme } = this.pageCtx;
    const run = this.deps.run();
    const kpi = drillKpi(run);
    this.statCards[0].setValue(`${kpi.passed} / ${kpi.total}`);
    this.statCards[0].setTrend(kpi.passed === kpi.total ? '全部达标' : `${kpi.total - kpi.passed} 条未达标`);
    this.statCards[1].setValue(`${Math.round(kpi.passRate * 100)}%`);
    this.statCards[1].setTrend('按验收口径逐条判定');
    this.statCards[2].setValue(`${kpi.energyDelta >= 0 ? '+' : ''}${Math.round(kpi.energyDelta * 100)}%`);
    this.statCards[2].setTrend(`脱氮率${kpi.removalDelta >= 0 ? '+' : ''}${(kpi.removalDelta * 100).toFixed(1)} pt`);
    this.statCards[3].setValue(`${kpi.switchMinutes}`);
    this.statCards[3].setTrend('分钟（调度属性，不是模型算的）');

    // 预演步骤 + 说明：条数随预案变，整段重建（先清空）
    this.stepsBody.removeChildren([...this.stepsBody.childNodes]);
    this.stepsBody.addChild(sectionHeading(this.pageCtx, 0, 0, `${run.plan.name} · ${run.plan.description}`), false);
    let top = 28;
    run.plan.steps.forEach((step, index) => {
      const node = paragraph(this.pageCtx, {
        left: 0,
        top,
        width: this.stepsBody.state.width - 8,
        text: `${index + 1}. ${step}`,
        fontSize: 12,
        color: theme.colors.textSecondary,
      });
      this.stepsBody.addChild(node, false);
      top += Number(node.state.height) + 6;
    });
    const warn = run.warnings.length ? `工程提醒：${run.warnings.join('；')}` : '';
    if (warn) {
      this.stepsBody.addChild(
        paragraph(this.pageCtx, {
          left: 0,
          top: top + 4,
          width: this.stepsBody.state.width - 8,
          text: warn,
          fontSize: 12,
          color: theme.colors.error,
        }),
        false
      );
    }

    this.table.setData(drillRows(run).map((row) => ({ ...row, note: NOTE_BY_ID[row.id] || '' })));
    this.pageCtx.ice.dirty = true;
  }
}
