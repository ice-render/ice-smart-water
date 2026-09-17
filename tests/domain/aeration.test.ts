/**
 * 精确曝气与鼓风优化：鼓风调度（投运台数 / 频率 / 节电率）与溶解氧控制判定。
 */
import type { PlantKpi } from '../../src/domain/process-model';
import { BLOWER_FLEET, aerationControlState, evaluateAeration } from '../../src/domain/aeration';

/** 只填函数真正用到的两个字段，避免把整套 PlantKpi 造出来。 */
function kpiWith(airDemand: number, oxygenDemand = 30000): PlantKpi {
  return { airDemand, oxygenDemand } as unknown as PlantKpi;
}

describe('evaluateAeration · 鼓风调度', () => {
  it('投运台数总在 [1, 群数] 内，且等于 ceil(气量 / 单机额定气量)', () => {
    const cases = [0, 75000, 150000, 160000, 300000, 450000, 600000, 1_000_000];
    cases.forEach((airDemand) => {
      const plan = evaluateAeration(kpiWith(airDemand), 2.0);
      expect(plan.runningCount).toBeGreaterThanOrEqual(1);
      expect(plan.runningCount).toBeLessThanOrEqual(BLOWER_FLEET.count);
      const expected = Math.min(BLOWER_FLEET.count, Math.max(1, Math.ceil(airDemand / BLOWER_FLEET.ratedAir)));
      expect(plan.runningCount).toBe(expected);
      // 投运台数 = 标记 running 的风机数
      expect(plan.blowers.filter((blower) => blower.running)).toHaveLength(plan.runningCount);
      expect(plan.blowers).toHaveLength(BLOWER_FLEET.count);
    });
  });

  it('节电率恒在 [0,1]，超出风机能力时夹到 0', () => {
    [75000, 200000, 450000, 600000].forEach((airDemand) => {
      const plan = evaluateAeration(kpiWith(airDemand), 2.0);
      expect(plan.savingPct).toBeGreaterThanOrEqual(0);
      expect(plan.savingPct).toBeLessThanOrEqual(1);
    });
    // 气量远超群能力：4 台满载仍不够 → 优化功率反而 ≥ 基线 → 节电夹到 0
    const overloaded = evaluateAeration(kpiWith(1_000_000), 2.0);
    expect(overloaded.runningCount).toBe(BLOWER_FLEET.count);
    expect(overloaded.savingPct).toBe(0);
  });

  it('同台数区间内：气量越大 → 频率越高 → 功率越高（亲和定律形态）', () => {
    // 都落在 2 台区间（150000 < 气量 ≤ 300000）
    const low = evaluateAeration(kpiWith(160000), 2.0);
    const high = evaluateAeration(kpiWith(250000), 2.0);
    expect(low.runningCount).toBe(2);
    expect(high.runningCount).toBe(2);
    expect(high.blowers[0].frequency).toBeGreaterThan(low.blowers[0].frequency);
    expect(high.aerationPower).toBeGreaterThan(low.aerationPower);
    // 单台功率 ∝ 频率³
    const ratio = high.blowers[0].frequency / low.blowers[0].frequency;
    expect(high.blowers[0].power / low.blowers[0].power).toBeCloseTo(ratio ** 3, 2);
  });

  it('频率不低于下限、运行台数随气量递增', () => {
    const a = evaluateAeration(kpiWith(75000), 2.0);
    const b = evaluateAeration(kpiWith(200000), 2.0);
    const c = evaluateAeration(kpiWith(450000), 2.0);
    a.blowers.forEach((blower) => {
      if (blower.running) expect(blower.frequency).toBeGreaterThanOrEqual(BLOWER_FLEET.minFreq);
    });
    expect(a.runningCount).toBeLessThanOrEqual(b.runningCount);
    expect(b.runningCount).toBeLessThanOrEqual(c.runningCount);
  });

  it('基线功率 = 常规工作台数 × 单机额定功率', () => {
    const plan = evaluateAeration(kpiWith(200000), 2.0);
    expect(plan.baselinePower).toBe(BLOWER_FLEET.workingNormally * BLOWER_FLEET.ratedPower);
    expect(plan.aerationEnergy).toBe(Math.round(plan.aerationPower * 24));
    expect(plan.baselineEnergy).toBe(plan.baselinePower * 24);
  });
});

describe('aerationControlState · 溶解氧控制判定', () => {
  it('实测高于设定 + 带宽 → 过曝', () => {
    expect(aerationControlState(2.0, 2.5).state).toBe('over');
  });
  it('实测低于设定 − 带宽 → 欠曝', () => {
    expect(aerationControlState(2.0, 1.5).state).toBe('under');
  });
  it('落在带宽内 → 正常（含上下边界）', () => {
    expect(aerationControlState(2.0, 2.3).state).toBe('normal');
    expect(aerationControlState(2.0, 1.7).state).toBe('normal');
    expect(aerationControlState(2.0, 2.1).state).toBe('normal');
  });
  it('偏差 = 实测 − 设定，过曝/欠曝方向正确', () => {
    expect(aerationControlState(2.0, 2.5).deviation).toBeCloseTo(0.5, 2);
    expect(aerationControlState(2.0, 1.5).deviation).toBeCloseTo(-0.5, 2);
  });
  it('带宽可配', () => {
    // 偏差 0.5、带宽放宽到 0.6 → 算正常
    expect(aerationControlState(2.0, 2.5, 0.6).state).toBe('normal');
  });
});
