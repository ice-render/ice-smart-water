/**
 * 页 —— 巡检管理（点位 → 路线 → 班次任务 → 到位 / 隐患闭环）。
 *
 * 巡检点位**由符号目录的「巡检要点」派生**（图例页看到的要点，就是这里派的活），
 * 所以业务目录只有一份真相。左侧柱状图按三条路线给出「计划 / 到位 / 超时」，
 * 右侧任务表可以就地登记结论（正常 / 发现隐患），统计卡的到位率与隐患数跟着变。
 */
import {
  ICEButton,
  ICENotification,
  ICEStatCard,
  ICETable,
  ICETag,
  ICEWidget,
  attachPopconfirm,
} from 'ice-web-components';
import {
  INSPECTION_STATUS_LABELS,
  inspectionKpi,
  taskRows,
  type InspectionResult,
  type InspectionStatus,
  type InspectionTask,
} from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  createStatRow,
  paragraph,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type InspectionPageDeps = {
  /** 今日巡检任务（入口持有状态） */
  tasks: () => InspectionTask[];
  /** 登记一条结论 */
  onResult: (id: string, result: InspectionResult, note: string) => void;
  /** 巡检人 */
  operator: () => string;
};

export type InspectionPageHandle = PageHandle & {
  reload: () => void;
  /** 当前统计（e2e 用） */
  stats: () => ReturnType<typeof inspectionKpi>;
};

const STAT_HEIGHT = 96;
const ROUTE_WIDTH_RATIO = 0.38;

export function inspectionRouteCardRect(layout: ShellLayout): Rect {
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  return {
    left: x0,
    top: y0 + STAT_HEIGHT + PAGE_GAP,
    width: Math.round(layout.inner.width * ROUTE_WIDTH_RATIO),
    height: layout.inner.height - STAT_HEIGHT - PAGE_GAP,
  };
}

/** 路线到位率柱状图所在的岛 */
export function inspectionRouteIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(inspectionRouteCardRect(layout));
}

export function inspectionTaskCardRect(layout: ShellLayout): Rect {
  const route = inspectionRouteCardRect(layout);
  return {
    left: route.left + route.width + PAGE_GAP,
    top: route.top,
    width: layout.inner.width - route.width - PAGE_GAP,
    height: route.height,
  };
}

const STATUS_STYLE: Record<InspectionStatus, string> = { pending: 'warning', done: 'success', missed: 'error' };

export function buildInspectionPage(ctx: PageContext, deps: InspectionPageDeps): InspectionPageHandle {
  const { theme, layout } = ctx;
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;

  const page = new ICEWidget({
    left: 0,
    top: 0,
    width: layout.content.width,
    height: layout.content.height,
    fill: false,
    stroke: false,
    interactive: false,
  });

  /* ---------------- 第一行：四个统计 ---------------- */
  // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
  const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: STAT_HEIGHT, count: 4, gap: PAGE_GAP });
  page.addChild(statRow, false);
  const statConfigs = [
    { title: '今日计划', icon: '☑', trend: '三条路线', type: 'primary' as const },
    { title: '已巡检', icon: '✔', trend: '到位率', type: 'success' as const },
    { title: '发现隐患', icon: '⚠', trend: '需转工单跟踪', type: 'warning' as const },
    { title: '超时未巡', icon: '⏰', trend: '需补巡', type: 'error' as const },
  ];
  const statCards = statConfigs.map((config, index) => {
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

  /* ---------------- 第二行左：路线到位率（岛） ---------------- */
  const routeCard = createCard({
    id: 'inspection-route-card',
    rect: inspectionRouteCardRect(layout),
    title: '路线到位情况：计划 / 已巡 / 超时',
  });
  page.addChild(routeCard, false);

  /* ---------------- 第二行右：任务表 ---------------- */
  const taskRect = inspectionTaskCardRect(layout);
  const rowFor = (rowId: string) => deps.tasks().filter((item) => item.id === rowId)[0];

  const table = new ICETable({
    id: 'inspection-table',
    left: CARD_INSET,
    top: 46,
    width: taskRect.width - CARD_INSET * 2,
    rowHeight: 36,
    rowKey: 'id',
    pagination: { pageSize: 8, showTotal: true },
    columns: [
      { key: 'planAt', title: '计划', width: 58, sorter: true },
      { key: 'unit', title: '单元 / 位号', width: 190 },
      { key: 'item', title: '巡检项', width: 240 },
      {
        key: 'status',
        title: '状态',
        width: 72,
        renderCell: (value: string, row: any) => {
          const task = rowFor(String(row.id));
          return new ICETag({
            left: 0,
            top: 6,
            width: 72,
            height: 22,
            text: String(value),
            status: task ? STATUS_STYLE[task.status] : 'info',
            variant: 'soft',
          });
        },
      },
      {
        key: 'action',
        title: '登记',
        width: 152,
        renderCell: (value: string, row: any) => {
          const cell = new ICEWidget({ left: 0, top: 0, width: 148, height: 30, fill: false, stroke: false, interactive: false });
          const task = rowFor(String(row.id));
          if (!task || task.status !== 'pending') {
            const label = task && task.result === 'hazard' ? '已转工单' : '已完成';
            const done = new ICEButton({
              id: `inspection-done-${row.id}`,
              left: 0,
              top: 4,
              width: 84,
              height: 28,
              text: label,
              size: 'small',
              variant: 'default',
            });
            cell.addChild(done, false);
            return cell;
          }
          const ok = new ICEButton({
            id: `inspection-ok-${row.id}`,
            left: 0,
            top: 4,
            width: 68,
            height: 28,
            text: '正常',
            size: 'small',
            variant: 'primary',
          });
          ok.on('click', () => {
            deps.onResult(String(row.id), 'normal', '');
            reload();
          });
          const hazard = new ICEButton({
            id: `inspection-hazard-${row.id}`,
            left: 74,
            top: 4,
            width: 74,
            height: 28,
            text: '发现隐患',
            size: 'small',
            variant: 'text',
          });
          attachPopconfirm(ctx.ice, hazard, {
            title: '登记为隐患？',
            description: '会记入隐患清单并算进「发现隐患」统计。',
            onConfirm: () => {
              deps.onResult(String(row.id), 'hazard', '');
              reload();
              ICENotification.open(ctx.ice, {
                title: '隐患已登记',
                description: `${task.unitTag} · ${task.item}`,
                type: 'warning',
              });
            },
          });
          cell.addChild(ok, false);
          cell.addChild(hazard, false);
          return cell;
        },
      },
    ],
    data: [],
    summary: (rows: any[]) => ({
      planAt: `本页 ${rows.length} 条`,
      item: '合计',
      status: `${rows.filter((row) => row.status === INSPECTION_STATUS_LABELS.missed).length} 条超时`,
      action: '',
    }),
    expandable: {
      expandedRowHeight: 96,
      render: (row: any, cellCtx: { width: number }) => {
        const task = rowFor(String(row.id));
        const wrap = new ICEWidget({
          left: 0,
          top: 0,
          width: Math.max(200, cellCtx.width - 24),
          height: 88,
          fill: false,
          stroke: false,
          interactive: false,
        });
        if (!task) return wrap;
        wrap.addChild(
          paragraph(ctx, {
            left: 0,
            top: 0,
            width: wrap.state.width,
            text: `路线 ${task.routeName} · 班组 ${task.crew} · 计划 ${task.planAt}${task.by ? ` · 巡检人 ${task.by}` : ''}`,
            fontSize: 12,
            color: theme.colors.text,
          }),
          false
        );
        wrap.addChild(
          paragraph(ctx, {
            left: 0,
            top: 34,
            width: wrap.state.width,
            text: task.note ? `结论：${task.note}` : '尚未登记结论。',
            fontSize: 12,
            color: task.result === 'hazard' ? theme.colors.error : theme.colors.textSecondary,
          }),
          false
        );
        return wrap;
      },
    },
  });

  const taskCard = createCard({
    id: 'inspection-table-card',
    rect: taskRect,
    title: '今日巡检任务（点行展开；待巡检的可就地登记）',
  });
  taskCard.addChild(table, false);
  page.addChild(taskCard, false);

  /* ---------------- 刷新 ---------------- */
  function reload(): void {
    const tasks = deps.tasks();
    const kpi = inspectionKpi(tasks);
    statCards[0].setValue(String(kpi.total));
    statCards[0].setTrend(`三条路线 · 共 ${kpi.total} 项`);
    statCards[1].setValue(String(kpi.done));
    statCards[1].setTrend(`到位率 ${Math.round(kpi.arrivalRate * 100)}%`);
    statCards[2].setValue(String(kpi.hazard));
    statCards[2].setTrend(kpi.hazard ? '需转工单跟踪' : '无隐患');
    statCards[3].setValue(String(kpi.missed));
    statCards[3].setTrend(kpi.missed ? `超时率 ${Math.round(kpi.missRate * 100)}%` : '无超时');

    table.setData(taskRows(tasks));
    ctx.ice.dirty = true;
  }

  reload();

  return {
    node: page,
    islands: [{ id: 'inspection-route', rect: inspectionRouteIslandRect(layout) }],
    actions: [
      {
        key: 'inspection-hazards',
        label: '看隐患清单',
        onClick: () => {
          const hazards = deps.tasks().filter((task) => task.result === 'hazard');
          ctx.toast(
            hazards.length ? `${hazards.length} 条隐患：${hazards.slice(0, 2).map((task) => task.unitTag).join(' / ')}…` : '暂无隐患',
            hazards.length ? 'warning' : 'success'
          );
        },
      },
    ],
    statusTags: () => {
      const kpi = inspectionKpi(deps.tasks());
      return [
        { text: `到位率 ${Math.round(kpi.arrivalRate * 100)}%`, status: kpi.missed ? 'warning' : 'success', width: 132 },
        { text: `隐患 ${kpi.hazard}`, status: kpi.hazard ? 'error' : 'info', width: 92 },
      ];
    },
    reload,
    stats: () => inspectionKpi(deps.tasks()),
    refresh(): void {
      reload();
    },
  };
}
