/**
 * 页 —— 加药优化。
 *
 * 把 `domain/dosing.ts` 算出来的三种药剂"优化 vs 基线"投加变成可操作的界面：
 * 顶部五张统计卡（除磷剂 / 外加碳源 / 消毒剂 / 日均药耗 / 节药率），
 * 下方左半图是三种药剂的优化 vs 基线对比柱图（岛 `dosing-bar`），
 * 右下半是投加安全系数滑块（ICESlider）+ 各药剂成本 / 基线成本 / 优化成本回显。
 *
 * 与「精确曝气」对称：曝气是电耗侧的智能回路，加药是药耗侧的智能回路。
 * 加药没有同构的"实测传感器"（不像 DO 有实时仪表），所以本页不做实时闭环，
 * 而是随图纸 / 工况重算（切到「工况预案」等改了水量水质的页会一起变），滑块只调投加安全系数。
 */
import { ICELabel, ICEStatCard, ICESlider, ICEWidget } from 'ice-web-components';
import type { DosingPlan } from '../../domain/dosing';
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

export type DosingPageDeps = {
  /** 当前的投加安全系数（≥1） */
  safetyFactor: () => number;
  /** 滑块改了安全系数 */
  onSafetyFactorChange: (value: number) => void;
  /** 当前的加药优化方案（随图纸 / 工况重算） */
  plan: () => DosingPlan;
};

/** 加药优化页：五张统计 + 药剂对比柱图（岛）+ 投加安全系数与控制。 */
export class DosingPage extends WaterPage {
  private static readonly STAT_HEIGHT = 96;

  private static readonly RIGHT_WIDTH = 372;

  /** 药剂对比柱图卡（岛） */
  private static barCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const row2Top = y0 + DosingPage.STAT_HEIGHT + PAGE_GAP;
    const rest = layout.inner.height - DosingPage.STAT_HEIGHT - PAGE_GAP;
    return {
      left: x0,
      top: row2Top,
      width: layout.inner.width - DosingPage.RIGHT_WIDTH - PAGE_GAP,
      height: rest,
    };
  }

  public static barIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(DosingPage.barCardRect(layout));
  }

  /** 右下：投加安全系数与控制卡 */
  private static controlCardRect(layout: ShellLayout): Rect {
    const bar = DosingPage.barCardRect(layout);
    return {
      left: bar.left + bar.width + PAGE_GAP,
      top: bar.top,
      width: DosingPage.RIGHT_WIDTH,
      height: bar.height,
    };
  }

  private readonly deps: DosingPageDeps;
  private readonly statCards: ICEStatCard[];
  private readonly slider: ICESlider;
  private readonly sliderReadout: any;
  private readonly costReadout: any;

  constructor(ctx: PageContext, deps: DosingPageDeps) {
    super(ctx);
    this.deps = deps;
    const { layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;

    /* ---------------- 第一行：五张统计卡 ---------------- */
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: DosingPage.STAT_HEIGHT, count: 5, gap: PAGE_GAP });
    this.addChild(statRow, false);
    const statConfigs = [
      { title: '除磷剂', icon: '⬡', trend: 'kg/d', kind: 'primary' as const },
      { title: '外加碳源', icon: '⬢', trend: 'kg/d', kind: 'info' as const },
      { title: '消毒剂', icon: '◇', trend: 'kg/d', kind: 'warning' as const },
      { title: '日均药耗', icon: '¥', trend: '元/d', kind: 'success' as const },
      { title: '节药率', icon: '⚗', trend: '较恒投基线', kind: 'primary' as const },
    ];
    this.statCards = statConfigs.map((config) => {
      const card = new ICEStatCard({
        height: DosingPage.STAT_HEIGHT,
        icon: config.icon,
        title: config.title,
        value: '—',
        trend: config.trend,
        trendType: config.kind,
      });
      statRow.addChild(card, false);
      return card;
    });

    /* ---------------- 左：药剂对比柱图（岛） ---------------- */
    const barCard = createCard({ id: 'dosing-bar-card', rect: DosingPage.barCardRect(layout), title: '药剂投加：优化 vs 基线' });
    this.addChild(barCard, false);

    /* ---------------- 右：投加安全系数与控制 ---------------- */
    const controlRect = DosingPage.controlCardRect(layout);
    const controlCard = createCard({ id: 'dosing-control-card', rect: controlRect, title: '投加安全系数与成本' });
    const body = new ICEWidget({ left: 0, top: 0, width: controlRect.width, height: controlRect.height, fill: false, stroke: false, interactive: false });
    controlCard.addChild(body, false);
    this.addChild(controlCard, false);

    const cw = controlRect.width - CARD_INSET * 2;
    body.addChild(sectionHeading(ctx, CARD_INSET, 52, '投加安全系数'), false);

    const sliderWidth = cw - 64;
    this.slider = new ICESlider({
      id: 'dosing-safety',
      left: CARD_INSET,
      top: 78,
      width: sliderWidth,
      height: 24,
      min: 1.0,
      max: 1.5,
      step: 0.05,
      value: deps.safetyFactor(),
    });
    this.slider.on('change', () => {
      const value = Math.round(Number(this.slider.getValue()) * 100) / 100;
      deps.onSafetyFactorChange(value);
    });
    body.addChild(this.slider, false);
    this.sliderReadout = new ICELabel({
      left: CARD_INSET + sliderWidth + 8,
      top: 80,
      width: 56,
      height: 20,
      text: `${deps.safetyFactor().toFixed(2)}`,
      style: { fontSize: 14, fontWeight: '600', fillStyle: token('ui.colors.link') },
    });
    body.addChild(this.sliderReadout, false);

    body.addChild(sectionHeading(ctx, CARD_INSET, 128, '成本对照（元/d）'), false);
    this.costReadout = paragraph(ctx, { left: CARD_INSET, top: 150, width: cw, text: '', fontSize: 12, color: token('ui.colors.text') });
    body.addChild(this.costReadout, false);
  }

  public islandSpecs(): IslandSpec[] {
    return [{ id: 'dosing-bar', rect: DosingPage.barIslandRect(this.pageCtx.layout) }];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      {
        key: 'dosing-baseline',
        label: '看基线药耗',
        onClick: () => {
          const plan = this.deps.plan();
          this.pageCtx.toast(
            `基线（恒投）日均 ${plan.totalBaselineCost} 元 · 优化后 ${plan.totalOptimizedCost} 元 · 日省 ${plan.totalBaselineCost - plan.totalOptimizedCost} 元`,
            plan.savingPct > 0 ? 'success' : 'warning'
          );
        },
      },
    ];
  }

  public statusTags(): StatusTagSpec[] {
    const plan = this.deps.plan();
    return [
      { text: `节药 ${Math.round(plan.savingPct * 100)}%`, status: plan.savingPct > 0.1 ? 'success' : 'info', width: 96 },
      { text: '优化 vs 基线', status: 'info', width: 120 },
    ];
  }

  /** 唯一改值入口：统计卡、滑块回显、成本对照。 */
  public onUpdate(): void {
    const plan = this.deps.plan();
    const byKey = (key: string) => plan.chemicals.find((chemical) => chemical.key === key)!;
    const coagulant = byKey('coagulant');
    const carbon = byKey('carbon');
    const disinfection = byKey('disinfection');
    this.statCards[0].setValue(coagulant.optimizedMass.toLocaleString());
    this.statCards[0].setTrend(`${coagulant.optimizedMass.toLocaleString()} kg/d`);
    this.statCards[1].setValue(carbon.optimizedMass.toLocaleString());
    this.statCards[1].setTrend(`${carbon.optimizedMass.toLocaleString()} kg/d`);
    this.statCards[2].setValue(disinfection.optimizedMass.toLocaleString());
    this.statCards[2].setTrend(`${disinfection.optimizedMass.toLocaleString()} kg/d`);
    this.statCards[3].setValue(plan.totalOptimizedCost.toLocaleString());
    this.statCards[3].setTrend(`日省 ${plan.totalBaselineCost - plan.totalOptimizedCost} 元`);
    this.statCards[4].setValue(`${Math.round(plan.savingPct * 100)}%`);
    this.statCards[4].setTrend(`基线 ${plan.totalBaselineCost} 元/d`);

    const safety = this.deps.safetyFactor();
    if (Math.abs(Number(this.slider.getValue()) - safety) > 0.001) this.slider.setValue(safety);
    this.sliderReadout.setText(safety.toFixed(2));
    this.costReadout.setText(
      `除磷剂 优化 ${coagulant.optimizedCost} / 基线 ${coagulant.baselineCost}\n` +
        `碳源 优化 ${carbon.optimizedCost} / 基线 ${carbon.baselineCost}\n` +
        `消毒剂 优化 ${disinfection.optimizedCost} / 基线 ${disinfection.baselineCost}\n` +
        `合计 优化 ${plan.totalOptimizedCost} / 基线 ${plan.totalBaselineCost} 元/d`
    );
    this.pageCtx.ice.requestRepaint();
  }
}
