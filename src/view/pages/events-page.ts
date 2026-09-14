/**
 * 页 —— 事件中心（报警与工单闭环）。
 *
 * 业务闭环：报警进清单 → 按级别 / 状态 / 单元筛 → 点行展开看**处置轨迹与建议** →
 * 派单（确认）→ 处置完闭环。数据来自 `domain/alarm-log`（审计条目 + 24h 曲线越限小时 +
 * 工况相关事件三处汇总，确定性生成）。
 *
 * 控件是有意挑着用的：`ICETable` 的**多选 + 行展开 + 汇总行 + 分页 + 排序 + 列筛选**一起上，
 * 行展开区里就是这条报警的处置轨迹（`ICETimeline`）；行内按钮走 `attachPopconfirm` 二次确认，
 * 处置结果用 `ICENotification` 通知。
 */
import {
  ICEAutoComplete,
  ICEButton,
  ICENotification,
  ICESegmented,
  ICEStatCard,
  ICETable,
  ICETag,
  ICETimeline,
  ICEWidget,
  attachPopconfirm,
} from 'ice-web-components';
import {
  ALARM_LEVEL_LABELS,
  ALARM_STATUS_LABELS,
  alarmRows,
  filterAlarms,
  summarizeAlarms,
  type AlarmEvent,
  type AlarmLevel,
  type AlarmStatus,
} from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  createCard,
  paragraph,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type EventsPageDeps = {
  /** 取当前报警清单（由入口持有状态） */
  events: () => AlarmEvent[];
  /** 处置动作：入口负责改状态 */
  onAck: (id: string) => void;
  onClose: (id: string) => void;
  /** 处置人（写进处置轨迹） */
  operator: () => string;
  /** 跳到工艺图并选中该报警关联单元（跨视图联动） */
  onLocate?: (unitId: string) => void;
  /** 该报警是否能在工艺图上定位（单元在不在图上） */
  canLocate?: (unitId: string) => boolean;
};

export type EventsPageHandle = PageHandle & {
  /** 清单变了（新报警 / 处置后）刷新表格与统计 */
  reload: () => void;
  /** 当前筛选（e2e 用） */
  filter: () => { status: AlarmStatus | 'all'; keyword: string };
};

const STAT_HEIGHT = 96;

/** 「报警清单」卡片：占满内容区剩下的高度 */
export function eventsTableCardRect(layout: ShellLayout): Rect {
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  return {
    left: x0,
    top: y0 + STAT_HEIGHT + PAGE_GAP,
    width: layout.inner.width,
    height: layout.inner.height - STAT_HEIGHT - PAGE_GAP,
  };
}

const LEVEL_STATUS: Record<AlarmLevel, string> = { critical: 'error', major: 'warning', minor: 'info' };
const STATE_STATUS: Record<AlarmStatus, string> = { open: 'error', acked: 'warning', closed: 'success' };

export function buildEventsPage(ctx: PageContext, deps: EventsPageDeps): EventsPageHandle {
  const { theme, layout } = ctx;
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;

  let filterState: { status: AlarmStatus | 'all'; keyword: string } = { status: 'all', keyword: '' };

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
  const statWidth = Math.floor((layout.inner.width - PAGE_GAP * 3) / 4);
  const statConfigs = [
    { title: '未处理', icon: '⚑', trend: '待派单 / 处置', type: 'error' as const },
    { title: '已确认', icon: '◐', trend: '处理中', type: 'warning' as const },
    { title: '已闭环', icon: '✔', trend: '处置完成', type: 'success' as const },
    { title: '严重级别', icon: '❗', trend: '需要立即处置', type: 'error' as const },
  ];
  const statCards = statConfigs.map((config, index) => {
    const card = new ICEStatCard({
      left: x0 + index * (statWidth + PAGE_GAP),
      top: y0,
      width: statWidth,
      height: STAT_HEIGHT,
      icon: config.icon,
      title: config.title,
      value: '0',
      trend: config.trend,
      trendType: config.type,
    });
    page.addChild(card, false);
    return card;
  });

  /* ---------------- 第二行：报警清单 ---------------- */
  const tableRect = eventsTableCardRect(layout);
  const rowFor = (rowId: string) => deps.events().filter((item) => item.id === rowId)[0];

  const table = new ICETable({
    id: 'alarm-table',
    left: CARD_INSET,
    top: 46,
    width: tableRect.width - CARD_INSET * 2,
    rowHeight: 36,
    rowKey: 'id',
    rowSelection: 'multiple',
    pagination: { pageSize: 6, showTotal: true },
    columns: [
      // 时刻列给足宽度：「昨 08:12」这类标签实测要 54px，列宽 76 会溢出到下一列（实测抓出来的）
      { key: 'time', title: '时刻', width: 108, sorter: true },
      {
        key: 'level',
        title: '级别',
        width: 84,
        sorter: true,
        filters: [
          { text: '严重', value: ALARM_LEVEL_LABELS.critical },
          { text: '重要', value: ALARM_LEVEL_LABELS.major },
          { text: '提示', value: ALARM_LEVEL_LABELS.minor },
        ],
        renderCell: (value: string, row: any) => {
          const event = rowFor(String(row.id));
          return new ICETag({
            left: 0,
            top: 6,
            width: 64,
            height: 22,
            text: String(value),
            status: event ? LEVEL_STATUS[event.level] : 'info',
            variant: 'soft',
          });
        },
      },
      { key: 'unit', title: '单元 / 位号', width: 168 },
      { key: 'title', title: '报警内容', width: 368 },
      {
        key: 'status',
        title: '状态',
        width: 88,
        filters: [
          { text: '未处理', value: ALARM_STATUS_LABELS.open },
          { text: '已确认', value: ALARM_STATUS_LABELS.acked },
          { text: '已闭环', value: ALARM_STATUS_LABELS.closed },
        ],
        renderCell: (value: string, row: any) => {
          const event = rowFor(String(row.id));
          return new ICETag({
            left: 0,
            top: 6,
            width: 64,
            height: 22,
            text: String(value),
            status: event ? STATE_STATUS[event.status] : 'info',
            variant: 'soft',
          });
        },
      },
      { key: 'owner', title: '归口', width: 132 },
      {
        key: 'action',
        title: '处置',
        width: 180,
        renderCell: (value: string, row: any) => {
          const event = rowFor(String(row.id));
          const cell = new ICEWidget({ left: 0, top: 0, width: 172, height: 30, fill: false, stroke: false, interactive: false });
          const closed = event ? event.status === 'closed' : false;
          const button = new ICEButton({
            id: `alarm-action-${row.id}`,
            left: 0,
            top: 4,
            width: 84,
            height: 28,
            text: closed ? '已闭环' : event && event.status === 'open' ? '派单' : '闭环',
            size: 'small',
            variant: closed ? 'default' : 'primary',
          });
          if (!closed) {
            attachPopconfirm(ctx.ice, button, {
              title: event && event.status === 'open' ? '派这一单？' : '确认闭环？',
              description: event && event.status === 'open' ? '派单后会记入处置轨迹。' : '闭环表示问题已处置并复核。',
              onConfirm: () => {
                if (!event) return;
                if (event.status === 'open') deps.onAck(event.id);
                else deps.onClose(event.id);
                reload();
                ICENotification.open(ctx.ice, {
                  title: event.status === 'open' ? '已派单' : '已闭环',
                  description: `${event.unitTag} · ${event.title}`,
                  type: 'success',
                });
              },
            });
          }
          cell.addChild(button, false);
          // 跨视图联动：定位到工艺图上关联的单元（同一套选择总线驱动右侧单元检视）
          if (event && deps.canLocate && deps.canLocate(String(event.unitId))) {
            const locate = new ICEButton({
              id: `alarm-locate-${row.id}`,
              left: 90,
              top: 4,
              width: 78,
              height: 28,
              text: '定位',
              size: 'small',
              variant: 'text',
            });
            locate.on('click', () => {
              if (deps.onLocate) deps.onLocate(String(event.unitId));
            });
            cell.addChild(locate, false);
          }
          return cell;
        },
      },
    ],
    data: [],
    summary: (rows: any[]) => ({
      time: `本页 ${rows.length} 条`,
      title: '合计',
      level: rows.filter((row) => row.level === ALARM_LEVEL_LABELS.critical).length
        ? `${rows.filter((row) => row.level === ALARM_LEVEL_LABELS.critical).length} 条严重`
        : '无严重',
      action: '',
    }),
    expandable: {
      expandedRowHeight: 130,
      render: (row: any, cellCtx: { width: number }) => {
        const event = rowFor(String(row.id));
        const wrap = new ICEWidget({
          left: 0,
          top: 0,
          width: Math.max(200, cellCtx.width - 24),
          height: 122,
          fill: false,
          stroke: false,
          interactive: false,
        });
        if (!event) return wrap;
        wrap.addChild(
          paragraph(ctx, {
            left: 0,
            top: 0,
            width: wrap.state.width,
            text: `建议处置：${event.advice}`,
            fontSize: 12,
            color: theme.colors.text,
          }),
          false
        );
        wrap.addChild(
          new ICETimeline({
            left: 0,
            top: 36,
            width: wrap.state.width,
            items: event.actions.map((action) => ({
              title: action.text,
              time: `${action.at} · ${action.by}`,
              color: action.by === '系统' ? theme.colors.textTertiary : theme.colors.primary,
            })),
          }),
          false
        );
        return wrap;
      },
    },
  });

  const tableCard = createCard({
    id: 'events-card',
    rect: tableRect,
    title: '报警清单（点行展开处置轨迹；勾选可批量派单）',
    extra: () => {
      const bar = new ICEWidget({ left: 0, top: 0, width: 700, height: 32, fill: false, stroke: false, interactive: false });
      bar.addChild(
        new ICESegmented({
          id: 'events-status-filter',
          left: 0,
          top: 0,
          width: 328,
          value: 'all',
          options: [
            { value: 'all', label: '全部' },
            { value: 'open', label: '未处理' },
            { value: 'acked', label: '已确认' },
            { value: 'closed', label: '已闭环' },
          ],
          onChange: (value: string) => {
            filterState = { ...filterState, status: value as AlarmStatus | 'all' };
            reload();
          },
        }),
        false
      );
      bar.addChild(
        new ICEAutoComplete({
          id: 'events-search',
          left: 344,
          top: 0,
          width: 236,
          placeholder: '按位号筛…',
          options: Array.from(new Set(deps.events().map((event) => event.unitTag))),
          onSelect: (value: string) => {
            filterState = { ...filterState, keyword: value };
            reload();
          },
        }),
        false
      );
      const batch = new ICEButton({
        id: 'events-batch-ack',
        left: 594,
        top: 0,
        width: 104,
        height: 32,
        text: '批量派单',
        size: 'small',
        variant: 'primary',
      });
      batch.on('click', () => {
        const selected = table.getSelectedRows() as any[];
        const pending = selected.filter((row) => rowFor(String(row.id)) && rowFor(String(row.id)).status === 'open');
        if (!pending.length) {
          ctx.toast('先勾选「未处理」的报警再批量派单', 'warning');
          return;
        }
        pending.forEach((row) => deps.onAck(String(row.id)));
        reload();
        ICENotification.open(ctx.ice, {
          title: '批量派单完成',
          description: `${pending.length} 条报警已派给 ${deps.operator()}`,
          type: 'success',
        });
      });
      bar.addChild(batch, false);
      return bar;
    },
  });
  tableCard.addChild(table, false);
  page.addChild(tableCard, false);

  /* ---------------- 刷新 ---------------- */
  function reload(): void {
    const all = deps.events();
    const summary = summarizeAlarms(all);
    statCards[0].setValue(String(summary.open));
    statCards[1].setValue(String(summary.acked));
    statCards[2].setValue(String(summary.closed));
    statCards[2].setTrend(`共 ${summary.total} 条`);
    statCards[3].setValue(String(summary.critical));
    statCards[3].setTrend(summary.critical ? '需要立即处置' : '无严重报警');

    table.setData(
      alarmRows(filterAlarms(all, filterState)).map((row) => ({
        ...row,
        action: row.status === ALARM_STATUS_LABELS.closed ? '已闭环' : '派单 / 闭环',
      }))
    );
    ctx.ice.dirty = true;
  }

  reload();

  return {
    node: page,
    actions: [
      {
        key: 'events-refresh',
        label: '刷新清单',
        onClick: () => {
          reload();
          ctx.toast('已按当前工况重新汇总报警');
        },
      },
    ],
    statusTags: () => {
      const summary = summarizeAlarms(deps.events());
      return [
        { text: summary.text, status: summary.critical ? 'error' : summary.open ? 'warning' : 'success', width: 148 },
        { text: `共 ${summary.total} 条`, status: 'info', width: 96 },
      ];
    },
    reload,
    filter: () => ({ ...filterState }),
    refresh(): void {
      reload();
    },
  };
}
