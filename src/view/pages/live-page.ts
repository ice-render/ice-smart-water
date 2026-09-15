/**
 * 页 —— 实时监视（模拟 SCADA / PLC 推送）。
 *
 * 与「运行数据」页的分工：那边是**事后**的 24 小时报表（跑完一天再看），
 * 这边是**正在发生**的：点位读数实时刷新、曲线滚动、仪表指针弹簧跟随、
 * 生化池分区溶解氧热力图每 250ms 左移一列。用的是 `ice-chart` 的
 * `appendData(id, items, { maxPoints })` 滑动窗口 —— 新点从右边进、旧点从左边滑走。
 *
 * 数据由入口驱动（那边跑定时器），这一页只负责"怎么显示"与"按钮怎么点"。
 */
import { ICEButton, ICELabel, ICESegmented, ICEStatCard, ICEWidget } from 'ice-web-components';
import type { SignalReading } from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  createStatRow,
  paragraph,
  sectionHeading,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type LivePageHandle = PageHandle & {
  /** 每个采样周期调一次：刷新读数卡与状态文字 */
  update: (readings: SignalReading[], summary: { alarm: number; warning: number; text: string }) => void;
  /** 定时器跑没跑（按钮文案要用） */
  setRunning: (running: boolean) => void;
};

const STAT_HEIGHT = 100;
const GAUGE_HEIGHT = 288;
const STATUS_HEIGHT = 128;
const RIGHT_WIDTH = 360;

/** 「实时趋势」卡片（岛挖在正文区） */
export function liveTrendCardRect(layout: ShellLayout): Rect {
  return {
    left: layout.content.left + PAGE_PADDING,
    top: layout.content.top + PAGE_PADDING + STAT_HEIGHT + PAGE_GAP,
    width: layout.inner.width - PAGE_GAP - RIGHT_WIDTH,
    height: layout.inner.height - STAT_HEIGHT - PAGE_GAP,
  };
}

export function liveTrendIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(liveTrendCardRect(layout));
}

/** 右栏三张卡：仪表（岛）/ 采集状态（纯控件）/ 热力图（岛） */
export function gaugeCardRect(layout: ShellLayout): Rect {
  const trend = liveTrendCardRect(layout);
  return { left: trend.left + trend.width + PAGE_GAP, top: trend.top, width: RIGHT_WIDTH, height: GAUGE_HEIGHT };
}

export function gaugeIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(gaugeCardRect(layout));
}

export function liveStatusCardRect(layout: ShellLayout): Rect {
  const gauge = gaugeCardRect(layout);
  return {
    left: gauge.left,
    top: gauge.top + gauge.height + PAGE_GAP,
    width: RIGHT_WIDTH,
    height: STATUS_HEIGHT,
  };
}

export function heatCardRect(layout: ShellLayout): Rect {
  const status = liveStatusCardRect(layout);
  const trend = liveTrendCardRect(layout);
  return {
    left: status.left,
    top: status.top + status.height + PAGE_GAP,
    width: RIGHT_WIDTH,
    height: trend.top + trend.height - (status.top + status.height + PAGE_GAP),
  };
}

export function heatIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(heatCardRect(layout));
}

export function buildLivePage(
  ctx: PageContext,
  deps: {
    onToggleRunning: () => void;
    onSpeedChange: (speed: number) => void;
    isRunning: () => boolean;
  }
): LivePageHandle {
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

  /** 最近一次汇总结论（状态标签与采集状态卡读它） */
  let summaryState = { alarm: 0, warning: 0, text: '' };
  let toggleButton: ICEButton | null = null;

  /* ---------------- 第一行：实时读数卡 ---------------- */
  const titles = ['进水流量', '溶解氧', '污泥浓度', '出水氨氮', '出水 COD', '风机振动'];
  const icons = ['〜', '◉', '◎', '◈', '◈', '⌁'];
  // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
  const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: STAT_HEIGHT, count: 6, gap: PAGE_GAP });
  page.addChild(statRow, false);
  const statCards: ICEStatCard[] = titles.map((title, index) => {
    const card = new ICEStatCard({
      height: STAT_HEIGHT,
      icon: icons[index],
      title,
      value: '—',
      trend: '等待采样',
      trendType: 'info',
    });
    statRow.addChild(card, false);
    return card;
  });

  /* ---------------- 趋势卡（岛） ---------------- */
  const trendRect = liveTrendCardRect(layout);
  const trendCard = createCard({
    id: 'live-trend-card',
    rect: trendRect,
    // 标题要短：卡片右上角放了暂停/速度控件（宽 470），标题超过约 350px 就会压上去
    title: '实时趋势（滑动窗口）',
    extra: () => {
      const bar = new ICEWidget({
        left: 0,
        top: 0,
        width: 470,
        height: 32,
        fill: false,
        stroke: false,
        interactive: false,
      });
      const toggle = new ICEButton({
        id: 'live-toggle',
        left: 0,
        top: 0,
        width: 92,
        height: 32,
        text: deps.isRunning() ? '暂停' : '继续',
        size: 'small',
        variant: 'primary',
      });
      toggle.on('click', () => deps.onToggleRunning());
      bar.addChild(toggle, false);
      toggleButton = toggle;

      bar.addChild(
        new ICELabel({
          left: 104,
          top: 8,
          text: '采样速度',
          style: { fontSize: 12, fillStyle: theme.colors.textSecondary },
        }),
        false
      );
      bar.addChild(
        new ICESegmented({
          id: 'live-speed',
          left: 176,
          top: 0,
          width: 232,
          value: '1',
          options: [
            { value: '1', label: '1×' },
            { value: '2', label: '2×' },
            { value: '4', label: '4×' },
          ],
          // ICESegmented 走构造参数 onChange（它不抛 change 事件）
          onChange: (value: string) => deps.onSpeedChange(Number(value)),
        }),
        false
      );
      return bar;
    },
  });
  page.addChild(trendCard, false);

  /* ---------------- 右栏：仪表（岛） ---------------- */
  const gaugeRect = gaugeCardRect(layout);
  const gaugeCard = createCard({ id: 'live-gauge-card', rect: gaugeRect, title: '关键仪表' });
  page.addChild(gaugeCard, false);

  /* ---------------- 右栏：采集状态（纯控件） ---------------- */
  const statusRect = liveStatusCardRect(layout);
  const statusCard = createCard({ id: 'live-status-card', rect: statusRect, title: '采集状态' });
  const statusBody = new ICEWidget({
    left: 0,
    top: 0,
    width: statusRect.width,
    height: statusRect.height,
    fill: false,
    stroke: false,
    interactive: false,
  });
  statusCard.addChild(statusBody, false);
  const statusHeading = sectionHeading(ctx, CARD_INSET, 52, '正在采样');
  const statusText = paragraph(ctx, { left: CARD_INSET, top: 72, width: statusRect.width - CARD_INSET * 2, text: '' });
  statusBody.addChild(statusHeading, false);
  statusBody.addChild(statusText, false);
  page.addChild(statusCard, false);

  /* ---------------- 右栏：热力图（岛） ---------------- */
  const heatRect = heatCardRect(layout);
  const heatCard = createCard({ id: 'live-heat-card', rect: heatRect, title: '生化池分区溶解氧' });
  page.addChild(heatCard, false);

  /* ---------------- 动态刷新 ---------------- */
  function update(readings: SignalReading[], summary: { alarm: number; warning: number; text: string }): void {
    summaryState = summary;
    readings.slice(0, statCards.length).forEach((reading, index) => {
      statCards[index].setValue(`${reading.text} ${reading.unit}`);
      statCards[index].setTrend(
        reading.level === 'alarm' ? '越限告警' : reading.level === 'warning' ? '需关注' : `位号 ${reading.tag}`
      );
    });
    statusHeading.setText(summary.alarm ? '有越限点位' : summary.warning ? '有需关注点位' : '全部点位正常');
    statusHeading.setTextColor(
      summary.alarm ? theme.colors.error : summary.warning ? theme.colors.warning : theme.colors.textSecondary
    );
    statusText.setText(summary.text);
    ctx.ice.dirty = true;
  }

  return {
    node: page,
    islands: [
      { id: 'live-trend', rect: liveTrendIslandRect(layout) },
      { id: 'live-gauge', rect: gaugeIslandRect(layout) },
      { id: 'live-heat', rect: heatIslandRect(layout) },
    ],
    actions: [
      {
        key: 'live-toggle',
        label: deps.isRunning() ? '暂停采样' : '继续采样',
        variant: 'primary',
        onClick: () => deps.onToggleRunning(),
      },
    ],
    statusTags: () => [
      { text: deps.isRunning() ? '采样中' : '已暂停', status: deps.isRunning() ? 'success' : 'warning', width: 84 },
      {
        text: summaryState.alarm
          ? `${summaryState.alarm} 点位越限`
          : summaryState.warning
          ? `${summaryState.warning} 点位关注`
          : '点位正常',
        status: summaryState.alarm ? 'error' : summaryState.warning ? 'warning' : 'success',
        width: 108,
      },
    ],
    update,
    setRunning(running: boolean): void {
      if (toggleButton) toggleButton.setText(running ? '暂停' : '继续');
      ctx.ice.dirty = true;
    },
    refresh(): void {
      /* 读数由 update() 驱动，不需要额外重排 */
    },
  };
}
