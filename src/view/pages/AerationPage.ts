/**
 * 页 —— 精确曝气与鼓风优化。
 *
 * 把 `domain/aeration.ts` 算出来的鼓风调度变成可操作的界面：
 * 顶部五张统计卡（需氧量 / 供气量 / 投运台数 / 运行频率 / 节电率），
 * 左下半图是四台鼓风机的投运与频率（岛 `aeration-bar`），右上仪表是溶解氧设定 vs 实测
 * （岛 `aeration-gauge`，实测值由实时采样循环喂入，对标 `LivePage` 的 DO 仪表），
 * 右下是溶解氧设定滑块（ICESlider）+ 实时对照（过曝 / 欠曝判定）。
 *
 * 风量由图纸模型算好的 `kpi.airDemand` 决定，滑块只调**设定值** —— 真正的"设定值 → 风量"
 * 闭环留给控制环；这一页演示"按当前气量该怎么开风机最省 + 现在过不过曝"。
 */
import { ICELabel, ICEStatCard, ICESlider, ICEWidget } from 'ice-web-components';
import type { AerationControlState, AerationPlan } from '../../domain/aeration';
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

export type AerationPageDeps = {
  /** 当前的溶解氧设定值 mg/L */
  targetDo: () => number;
  /** 滑块改了设定值 */
  onTargetDoChange: (value: number) => void;
  /** 当前的鼓风调度方案（随图纸 / 工况重算） */
  plan: () => AerationPlan;
  /** 最新实测溶解氧 mg/L（由实时采样循环喂入） */
  currentDo: () => number;
  /** 溶解氧控制判定（过曝 / 欠曝 / 正常） */
  control: () => AerationControlState;
};

/** 精确曝气页：五张统计 + 风机频率柱图（岛）+ 溶解氧仪表（岛）+ 设定与控制。 */
export class AerationPage extends WaterPage {
  private static readonly STAT_HEIGHT = 96;

  private static readonly RIGHT_WIDTH = 372;

  private static readonly GAUGE_HEIGHT = 300;

  /** 风机频率柱图卡（岛） */
  private static barCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const row2Top = y0 + AerationPage.STAT_HEIGHT + PAGE_GAP;
    const rest = layout.inner.height - AerationPage.STAT_HEIGHT - PAGE_GAP;
    return {
      left: x0,
      top: row2Top,
      width: layout.inner.width - AerationPage.RIGHT_WIDTH - PAGE_GAP,
      height: rest,
    };
  }

  public static barIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(AerationPage.barCardRect(layout));
  }

  /** 溶解氧仪表卡（岛） */
  private static gaugeCardRect(layout: ShellLayout): Rect {
    const bar = AerationPage.barCardRect(layout);
    return {
      left: bar.left + bar.width + PAGE_GAP,
      top: bar.top,
      width: AerationPage.RIGHT_WIDTH,
      height: AerationPage.GAUGE_HEIGHT,
    };
  }

  public static gaugeIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(AerationPage.gaugeCardRect(layout));
  }

  /** 右下：溶解氧设定与控制卡 */
  private static controlCardRect(layout: ShellLayout): Rect {
    const gauge = AerationPage.gaugeCardRect(layout);
    return {
      left: gauge.left,
      top: gauge.top + gauge.height + PAGE_GAP,
      width: AerationPage.RIGHT_WIDTH,
      height: layout.inner.height - AerationPage.STAT_HEIGHT - PAGE_GAP - gauge.height - PAGE_GAP,
    };
  }

  private readonly deps: AerationPageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly slider: ICESlider;
  private readonly sliderReadout: any;
  private readonly currentReadout: any;
  private readonly controlStatus: any;
  private readonly controlMessage: any;

  constructor(ctx: PageContext, deps: AerationPageDeps) {
    super(ctx);
    this.deps = deps;
    const { layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

    /* ---------------- 第一行：五张统计卡 ---------------- */
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: AerationPage.STAT_HEIGHT, count: 5, gap: PAGE_GAP });
    this.addChild(statRow, false);
    const statConfigs = [
      { title: '需氧量', icon: '◉', trend: 'kgO₂/d', kind: 'primary' as const },
      { title: '供气量', icon: '〜', trend: 'm³/d', kind: 'info' as const },
      { title: '投运台数', icon: '⌁', trend: '台', kind: 'warning' as const },
      { title: '平均频率', icon: '◔', trend: '% 额定', kind: 'success' as const },
      { title: '节电率', icon: '⚡', trend: '较全频基线', kind: 'primary' as const },
    ];
    this.statCards = statConfigs.map((config) => {
      const card = new ICEStatCard({
        height: AerationPage.STAT_HEIGHT,
        icon: config.icon,
        title: config.title,
        value: '—',
        trend: config.trend,
        trendType: config.kind,
      });
      statRow.addChild(card, false);
      return card;
    });

    /* ---------------- 左：风机频率柱图（岛） ---------------- */
    const barCard = createCard({ id: 'aeration-bar-card', rect: AerationPage.barCardRect(layout), title: '鼓风机投运与频率' });
    this.addChild(barCard, false);

    /* ---------------- 右上：溶解氧仪表（岛） ---------------- */
    const gaugeCard = createCard({ id: 'aeration-gauge-card', rect: AerationPage.gaugeCardRect(layout), title: '溶解氧：设定 vs 实测' });
    this.addChild(gaugeCard, false);

    /* ---------------- 右下：溶解氧设定与控制 ---------------- */
    const controlRect = AerationPage.controlCardRect(layout);
    const controlCard = createCard({ id: 'aeration-control-card', rect: controlRect, title: '溶解氧设定与风量控制' });
    const body = new ICEWidget({ left: 0, top: 0, width: controlRect.width, height: controlRect.height, fill: false, stroke: false, interactive: false });
    controlCard.addChild(body, false);
    this.addChild(controlCard, false);

    const cw = controlRect.width - CARD_INSET * 2;
    body.addChild(sectionHeading(ctx, CARD_INSET, 52, '溶解氧设定值（mg/L）'), false);

    const sliderWidth = cw - 64;
    this.slider = new ICESlider({
      id: 'aeration-target',
      left: CARD_INSET,
      top: 78,
      width: sliderWidth,
      height: 24,
      min: 0.5,
      max: 4.0,
      step: 0.1,
      value: deps.targetDo(),
    });
    this.slider.on('change', () => {
      const value = Math.round(Number(this.slider.getValue()) * 10) / 10;
      deps.onTargetDoChange(value);
    });
    body.addChild(this.slider, false);
    this.sliderReadout = new ICELabel({
      left: CARD_INSET + sliderWidth + 8,
      top: 80,
      width: 56,
      height: 20,
      text: `${deps.targetDo().toFixed(1)}`,
      style: { fontSize: 14, fontWeight: '600', fillStyle: token('ui.colors.link') },
    });
    body.addChild(this.sliderReadout, false);

    body.addChild(sectionHeading(ctx, CARD_INSET, 132, '实时对照'), false);
    this.currentReadout = paragraph(ctx, { left: CARD_INSET, top: 152, width: cw, text: '', fontSize: 12, color: token('ui.colors.text') });
    body.addChild(this.currentReadout, false);
    this.controlStatus = new ICELabel({
      left: CARD_INSET,
      top: 182,
      width: cw,
      height: 20,
      text: '—',
      style: { fontSize: 13, fontWeight: '600', fillStyle: token('ui.colors.textSecondary') },
    });
    body.addChild(this.controlStatus, false);
    this.controlMessage = paragraph(ctx, { left: CARD_INSET, top: 206, width: cw, text: '', fontSize: 12, color: token('ui.colors.textSecondary') });
    body.addChild(this.controlMessage, false);
  }

  public islandSpecs(): IslandSpec[] {
    return [
      { id: 'aeration-bar', rect: AerationPage.barIslandRect(this.pageCtx.layout) },
      { id: 'aeration-gauge', rect: AerationPage.gaugeIslandRect(this.pageCtx.layout) },
    ];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'aeration-baseline',
        label: '看基线电耗',
        onClick: () => {
          const plan = this.deps.plan();
          this.pageCtx.toast(
            `基线（全频直吹）${plan.baselinePower} kW · 优化后 ${plan.aerationPower} kW · 日省 ${plan.baselineEnergy - plan.aerationEnergy} kWh`,
            plan.savingPct > 0 ? 'success' : 'warning'
          );
        },
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    const plan = this.deps.plan();
    const control = this.deps.control();
    const controlStatus = control.state === 'normal' ? 'success' : control.state === 'under' ? 'error' : 'warning';
    return [
      { text: `节电 ${Math.round(plan.savingPct * 100)}%`, status: plan.savingPct > 0.1 ? 'success' : 'info', width: 96 },
      { text: control.state === 'over' ? '过曝' : control.state === 'under' ? '欠曝' : '曝气正常', status: controlStatus, width: 96 },
    ];
  }

  /** 唯一改值入口：统计卡、滑块回显、实时对照。 */
  public onUpdate(): void {
    const plan = this.deps.plan();
    const running = plan.blowers.filter((blower) => blower.running);
    const avgFreq = running.length ? running.reduce((sum, blower) => sum + blower.loadPct, 0) / running.length : 0;
    this.statCards[0].setValue(plan.oxygenDemand.toLocaleString());
    this.statCards[0].setTrend(`${plan.oxygenDemand.toLocaleString()} kgO₂/d`);
    this.statCards[1].setValue(plan.airDemand.toLocaleString());
    this.statCards[1].setTrend(`${plan.airDemand.toLocaleString()} m³/d`);
    this.statCards[2].setValue(`${plan.runningCount}/${plan.blowers.length}`);
    this.statCards[2].setTrend(`${plan.runningCount} 台投运`);
    this.statCards[3].setValue(`${avgFreq.toFixed(0)}%`);
    this.statCards[3].setTrend('平均运行频率');
    this.statCards[4].setValue(`${Math.round(plan.savingPct * 100)}%`);
    this.statCards[4].setTrend(`日省 ${plan.baselineEnergy - plan.aerationEnergy} kWh`);

    const target = this.deps.targetDo();
    // 滑块只在数值不一致时回设，避免 onChange → onTargetDoChange → onUpdate 的回环
    if (Math.abs(Number(this.slider.getValue()) - target) > 0.001) this.slider.setValue(target);
    this.sliderReadout.setText(target.toFixed(1));
    this.refreshControl();
    this.pageCtx.ice.requestRepaint();
  }

  /** 实时采样循环喂入最新实测 DO：刷新对照文字与过/欠曝判定（仪表值由宿主直接 setData）。 */
  public applyDo(): void {
    this.refreshControl();
    this.pageCtx.ice.requestRepaint();
  }

  private refreshControl(): void {
    const current = this.deps.currentDo();
    const control = this.deps.control();
    this.currentReadout.setText(`实测溶解氧 ${current.toFixed(2)} mg/L（设定 ${this.deps.targetDo().toFixed(1)}）`);
    const color =
      control.state === 'normal'
        ? token('ui.colors.success')
        : control.state === 'under'
        ? token('ui.colors.error')
        : token('ui.colors.warning');
    this.controlStatus.setText(control.state === 'over' ? '状态：过曝（风量过剩）' : control.state === 'under' ? '状态：欠曝（风量不足）' : '状态：曝气稳定');
    this.controlStatus.setTextColor(color);
    this.controlMessage.setText(control.message);
  }
}
