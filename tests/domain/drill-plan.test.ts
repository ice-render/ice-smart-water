/**
 * 工况预案演练：预案完整 + 预演复用现有模型 + 偏差口径 + 确定性。
 */
import { DRILL_PLANS, DEFAULT_TARGETS, deviationsOf, drillCompareData, drillKpi, drillRows, makeDrillPlan, runDrill } from '../../src/domain/drill-plan';
import { evaluateScenario } from '../../src/domain/sizing';

describe('预案定义', () => {
  it('四个预案：雨天 / 检修 / 低温 / 冲击，都带步骤与验收口径', () => {
    expect(DRILL_PLANS).toHaveLength(4);
    expect(DRILL_PLANS.map((plan) => plan.id).sort()).toEqual(['maintenance', 'rain', 'shock', 'winter']);
    DRILL_PLANS.forEach((plan) => {
      expect(plan.steps.length).toBeGreaterThanOrEqual(4);
      expect(plan.modeId).toBeTruthy();
      expect(plan.targets.minSrt).toBeGreaterThan(0);
    });
  });

  it('makeDrillPlan 按 id 取，未知 id 返回 null', () => {
    expect(makeDrillPlan('rain')!.name).toBe('雨季超越');
    expect(makeDrillPlan('nope')).toBeNull();
  });
});

describe('预演：复用 evaluateScenario，不另造模型', () => {
  it('after 就是"用预案参数跑一遍 evaluateScenario"的结果', () => {
    const plan = makeDrillPlan('rain')!;
    const run = runDrill(plan);
    const expected = evaluateScenario(plan.params);
    expect(run.after.removalRate).toBeCloseTo(expected.removalRate, 6);
    expect(run.after.srt).toBeCloseTo(expected.srt, 6);
    expect(run.after.energyPerCubicMeter).toBeCloseTo(expected.energyPerCubicMeter, 6);
  });

  it('before 是当前参数（基线）的结果，两个预案的 before 相同', () => {
    const rain = runDrill(makeDrillPlan('rain')!);
    const winter = runDrill(makeDrillPlan('winter')!);
    expect(rain.before).toEqual(winter.before);
    expect(rain.after).not.toEqual(winter.after);
  });

  it('确定性：同一预案两次预演结果完全一致', () => {
    const plan = makeDrillPlan('shock')!;
    expect(runDrill(plan)).toEqual(runDrill(plan));
  });

  it('雨季超越：水量上去、单位水量电耗反而下降（同样装机摊到更多水上）', () => {
    const run = runDrill(makeDrillPlan('rain')!);
    expect(run.after.inflow).toBeGreaterThan(run.before.inflow);
    // 这条是**模型的输出**、不是我们先验假设：稀释后吨水电耗下降
    expect(run.energyDelta).toBeLessThan(0);
  });

  it('低温硝化：泥龄修正让脱氮率相对基线下降', () => {
    const run = runDrill(makeDrillPlan('winter')!);
    expect(run.removalDelta).toBeLessThan(0);
  });
});

describe('偏差口径', () => {
  it('五条指标、方向正确：下限类「≥ 目标」为达标、上限类「≤ 目标」为达标', () => {
    const run = runDrill(makeDrillPlan('rain')!);
    expect(run.deviations).toHaveLength(5);
    run.deviations.forEach((item) => {
      const ok = item.direction === 'min' ? item.value >= item.target : item.value <= item.target;
      expect(item.ok).toBe(ok);
      expect(item.score).toBeGreaterThan(0);
    });
    expect(run.passed).toBe(run.deviations.filter((item) => item.ok).length);
    expect(run.total).toBe(5);
  });

  it('达标度：正好压线 = 100%，优于目标 > 100%', () => {
    const rows = deviationsOf(
      { removalRate: 0.7, srt: 12, fm: 0.15, energyPerCubicMeter: 0.45, compliance: { passed: 6 } } as any,
      DEFAULT_TARGETS
    );
    rows.forEach((item) => expect(item.score).toBe(100));
    expect(rows.every((item) => item.ok)).toBe(true);

    const better = deviationsOf(
      { removalRate: 0.8, srt: 20, fm: 0.1, energyPerCubicMeter: 0.3, compliance: { passed: 6 } } as any,
      DEFAULT_TARGETS
    );
    // 「达标项数」上限就是 6/6=100%，所以只能断言"不低于 100"；其余四条严格优于目标
    better.forEach((item) => expect(item.score).toBeGreaterThanOrEqual(100));
    expect(better.slice(0, 4).every((item) => item.score > 100)).toBe(true);
  });

  it('对比图与表格与偏差同源', () => {
    const run = runDrill(makeDrillPlan('maintenance')!);
    const compare = drillCompareData(run);
    expect(compare.names).toHaveLength(run.deviations.length);
    expect(compare.after).toHaveLength(run.deviations.length);
    expect(compare.before).toHaveLength(run.deviations.length);
    expect(drillRows(run)).toHaveLength(run.deviations.length);
    const kpi = drillKpi(run);
    expect(kpi.total).toBe(run.deviations.length);
    expect(kpi.switchMinutes).toBe(run.plan.switchMinutes);
  });
});
