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
  type HeaderActionSpec,
  type IslandSpec,
  type PageContext,
  type Rect,
  type ShellLayout,
  type StatusTagSpec,
} from '../shell';
import { WaterPage } from '../WaterPage';
import { token } from 'ice-render';

export type LivePageDeps = {
  onToggleRunning: () => void;
  onSpeedChange: (speed: number) => void;
  isRunning: () => boolean;
};


/** 实时监视页：六个读数 + 趋势（岛）+ 仪表（岛）+ 采集状态 + 热力图（岛）。 */
export class LivePage extends WaterPage {
  private static readonly STAT_HEIGHT = 100;

  private static readonly GAUGE_HEIGHT = 288;

  private static readonly STATUS_HEIGHT = 128;

  private static readonly RIGHT_WIDTH = 360;

  /** 「实时趋势」卡片（岛挖在正文区） */
  private static trendCardRect(layout: ShellLayout): Rect {
    return {
      left: layout.content.left + PAGE_PADDING,
      top: layout.content.top + PAGE_PADDING + LivePage.STAT_HEIGHT + PAGE_GAP,
      width: layout.inner.width - PAGE_GAP - LivePage.RIGHT_WIDTH,
      height: layout.inner.height - LivePage.STAT_HEIGHT - PAGE_GAP,
    };
  }

  public static liveTrendIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(LivePage.trendCardRect(layout));
  }

  /** 右栏三张卡：仪表（岛）/ 采集状态（纯控件）/ 热力图（岛） */
  private static gaugeCardRect(layout: ShellLayout): Rect {
    const trend = LivePage.trendCardRect(layout);
    return { left: trend.left + trend.width + PAGE_GAP, top: trend.top, width: LivePage.RIGHT_WIDTH, height: LivePage.GAUGE_HEIGHT };
  }

  public static gaugeIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(LivePage.gaugeCardRect(layout));
  }

  private static statusCardRect(layout: ShellLayout): Rect {
    const gauge = LivePage.gaugeCardRect(layout);
    return {
      left: gauge.left,
      top: gauge.top + gauge.height + PAGE_GAP,
      width: LivePage.RIGHT_WIDTH,
      height: LivePage.STATUS_HEIGHT,
    };
  }

  private static heatCardRect(layout: ShellLayout): Rect {
    const status = LivePage.statusCardRect(layout);
    const trend = LivePage.trendCardRect(layout);
    return {
      left: status.left,
      top: status.top + status.height + PAGE_GAP,
      width: LivePage.RIGHT_WIDTH,
      height: trend.top + trend.height - (status.top + status.height + PAGE_GAP),
    };
  }

  public static heatIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(LivePage.heatCardRect(layout));
  }

  private readonly deps: LivePageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly statusHeading: any;
  private readonly statusText: any;
  /** 最近一次汇总结论（状态标签与采集状态卡读它） */
  private summaryState: { alarm: number; warning: number; text: string } = { alarm: 0, warning: 0, text: '' };
  private toggleButton: ICEButton | null = null;

  constructor(ctx: PageContext, deps: LivePageDeps) {
    super(ctx);
    this.deps = deps;
    const { theme, layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

    /* ---------------- 第一行：实时读数卡 ---------------- */
    const titles = ['进水流量', '溶解氧', '污泥浓度', '出水氨氮', '出水 COD', '风机振动'];
    const icons = ['〜', '◉', '◎', '◈', '◈', '⌁'];
    // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: LivePage.STAT_HEIGHT, count: 6, gap: PAGE_GAP });
    this.addChild(statRow, false);
    this.statCards = titles.map((title, index) => {
      const card = new ICEStatCard({
        height: LivePage.STAT_HEIGHT,
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
    const trendRect = LivePage.trendCardRect(layout);
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
          text: this.deps.isRunning() ? '暂停' : '继续',
          size: 'small',
          variant: 'primary',
        });
        toggle.on('click', () => this.deps.onToggleRunning());
        bar.addChild(toggle, false);
        this.toggleButton = toggle;

        bar.addChild(
          new ICELabel({
            left: 104,
            top: 8,
            text: '采样速度',
            style: { fontSize: 12, fillStyle: token('ui.colors.textSecondary') },
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
            onChange: (value: string) => this.deps.onSpeedChange(Number(value)),
          }),
          false
        );
        return bar;
      },
    });
    this.addChild(trendCard, false);

    /* ---------------- 右栏：仪表（岛） ---------------- */
    const gaugeCard = createCard({ id: 'live-gauge-card', rect: LivePage.gaugeCardRect(layout), title: '关键仪表' });
    this.addChild(gaugeCard, false);

    /* ---------------- 右栏：采集状态（纯控件） ---------------- */
    const statusRect = LivePage.statusCardRect(layout);
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
    this.statusHeading = sectionHeading(ctx, CARD_INSET, 52, '正在采样');
    this.statusText = paragraph(ctx, { left: CARD_INSET, top: 72, width: statusRect.width - CARD_INSET * 2, text: '' });
    statusBody.addChild(this.statusHeading, false);
    statusBody.addChild(this.statusText, false);
    this.addChild(statusCard, false);

    /* ---------------- 右栏：热力图（岛） ---------------- */
    const heatCard = createCard({ id: 'live-heat-card', rect: LivePage.heatCardRect(layout), title: '生化池分区溶解氧' });
    this.addChild(heatCard, false);
  }

  public islandSpecs(): IslandSpec[] {
    return [
      { id: 'live-trend', rect: LivePage.liveTrendIslandRect(this.pageCtx.layout) },
      { id: 'live-gauge', rect: LivePage.gaugeIslandRect(this.pageCtx.layout) },
      { id: 'live-heat', rect: LivePage.heatIslandRect(this.pageCtx.layout) },
    ];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'live-toggle',
        label: this.deps.isRunning() ? '暂停采样' : '继续采样',
        variant: 'primary',
        onClick: () => this.deps.onToggleRunning(),
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    return [
      { text: this.deps.isRunning() ? '采样中' : '已暂停', status: this.deps.isRunning() ? 'success' : 'warning', width: 84 },
      {
        text: this.summaryState.alarm
          ? `${this.summaryState.alarm} 点位越限`
          : this.summaryState.warning
          ? `${this.summaryState.warning} 点位关注`
          : '点位正常',
        status: this.summaryState.alarm ? 'error' : this.summaryState.warning ? 'warning' : 'success',
        width: 108,
      },
    ];
  }

  /** 每个采样周期调一次（入口的定时器驱动）：刷新读数卡与状态文字 */
  public applyReadings(readings: SignalReading[], summary: { alarm: number; warning: number; text: string }): void {
    const { theme } = this.pageCtx;
    this.summaryState = summary;
    readings.slice(0, this.statCards.length).forEach((reading, index) => {
      this.statCards[index].setValue(`${reading.text} ${reading.unit}`);
      this.statCards[index].setTrend(
        reading.level === 'alarm' ? '越限告警' : reading.level === 'warning' ? '需关注' : `位号 ${reading.tag}`
      );
    });
    this.statusHeading.setText(summary.alarm ? '有越限点位' : summary.warning ? '有需关注点位' : '全部点位正常');
    this.statusHeading.setTextColor(
      summary.alarm ? token('ui.colors.error') : summary.warning ? token('ui.colors.warning') : token('ui.colors.textSecondary')
    );
    this.statusText.setText(summary.text);
    this.pageCtx.ice.requestRepaint();
  }

  /** 定时器跑没跑（按钮文案要用） */
  public setRunning(running: boolean): void {
    if (this.toggleButton) this.toggleButton.setText(running ? '暂停' : '继续');
    this.pageCtx.ice.requestRepaint();
  }

  /** 唯一改值入口：读数由 `applyReadings()` 驱动，这里不需要额外重排。 */
  public onUpdate(): void {}
}
