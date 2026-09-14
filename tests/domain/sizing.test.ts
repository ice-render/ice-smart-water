import { SEWAGE_PLANT, designMap, toPlantGraph } from '../../src/domain/plant-case';
import { computeKpi } from '../../src/domain/process-model';
import {
  DEFAULT_SCENARIO,
  ceilingCurve,
  denitrificationCeiling,
  evaluateScenario,
  scenarioMetrics,
  scenarioQualityRows,
  srtFactorOf,
  temperatureFactorOf,
} from '../../src/domain/sizing';

/** 图纸模型的设计工况（用来做交叉校验） */
function designCaseKpi() {
  return computeKpi(toPlantGraph(SEWAGE_PLANT), designMap(SEWAGE_PLANT), SEWAGE_PLANT.meta);
}

describe('理论脱氮上界', () => {
  it('(R+r)/(1+R+r)：本厂 R=1 r=2 → 75%', () => {
    expect(denitrificationCeiling(1, 2)).toBeCloseTo(0.75, 6);
    expect(denitrificationCeiling(0, 0)).toBe(0);
    expect(denitrificationCeiling(1, 0)).toBeCloseTo(0.5, 6);
    // 单调不减
    expect(denitrificationCeiling(2, 2)).toBeGreaterThan(denitrificationCeiling(1, 2));
  });

  it('温度与泥龄修正：20℃ 及以上不打折，低于 12 d 泥龄开始掉', () => {
    expect(temperatureFactorOf(20)).toBe(1);
    expect(temperatureFactorOf(25)).toBe(1);
    expect(temperatureFactorOf(15)).toBeCloseTo(0.9, 6);
    expect(temperatureFactorOf(5)).toBeCloseTo(0.7, 6); // 1 − 15×0.02
    expect(temperatureFactorOf(-5)).toBe(0.55); // 触到下限保护（1 − 25×0.02 = 0.5 → 0.55）

    expect(srtFactorOf(20, 12)).toBe(1);
    expect(srtFactorOf(9, 12)).toBeCloseTo(0.75, 6);
    expect(srtFactorOf(6, 12)).toBe(0.6); // 6/12 = 0.5 → 触到下限 0.6
    expect(srtFactorOf(1, 12)).toBe(0.6);
  });
});

describe('参数化试算', () => {
  const design = designCaseKpi();
  const result = evaluateScenario(DEFAULT_SCENARIO);

  it('默认参数下的结果必须落回图纸模型的设计工况（口径一致性）', () => {
    // 泥龄：图纸 17.2 d
    expect(result.srt).toBeCloseTo(design.sludge.srt, 0);
    // 需氧量：图纸 28938 kgO₂/d（偏差 < 2%）
    expect(Math.abs(result.oxygenDemand - design.oxygenDemand) / design.oxygenDemand).toBeLessThan(0.02);
    // 剩余污泥：图纸 992 m³/d
    expect(Math.abs(result.wasteSludge - design.sludge.wasteSludgeFlow) / design.sludge.wasteSludgeFlow).toBeLessThan(0.03);
    // 吨水电耗：图纸 0.268 kWh/m³（偏差 < 5%）
    expect(Math.abs(result.energyPerCubicMeter - design.energyPerCubicMeter) / design.energyPerCubicMeter).toBeLessThan(0.05);
    // 出水总氮：图纸 11.34 mg/L（回流比口径 vs 去除率连乘，允许 1% 级偏差）
    expect(Math.abs(result.effluent.TN - design.effluent.TN) / design.effluent.TN).toBeLessThan(0.02);
    // 出水氨氮走的是同一套去除率链，应当完全一致
    expect(result.effluent.NH3N).toBeCloseTo(design.effluent.NH3N, 2);
  });

  it('默认参数下六项达标且无告警', () => {
    expect(result.compliance.passed).toBe(6);
    expect(result.warnings).toEqual([]);
    expect(result.removalRate).toBeGreaterThan(0.7);
    expect(result.removalRate).toBeLessThanOrEqual(result.ceiling);
  });

  it('调旋钮的响应方向正确：加大内回流提脱氮、降水温掉脱氮、减 MLSS 掉泥龄', () => {
    const moreRecycle = evaluateScenario({ ...DEFAULT_SCENARIO, internalRatio: 3 });
    expect(moreRecycle.ceiling).toBeGreaterThan(result.ceiling);
    expect(moreRecycle.removalRate).toBeGreaterThan(result.removalRate);
    expect(moreRecycle.effluent.TN).toBeLessThan(result.effluent.TN);

    const cold = evaluateScenario({ ...DEFAULT_SCENARIO, temperature: 12 });
    expect(cold.removalRate).toBeLessThan(result.removalRate);
    expect(cold.effluent.TN).toBeGreaterThan(result.effluent.TN);
    expect(cold.warnings.join('|')).toContain('水温');

    const thin = evaluateScenario({ ...DEFAULT_SCENARIO, mlss: 2000 });
    expect(thin.srt).toBeLessThan(result.srt);
    expect(thin.warnings.join('|')).toContain('泥龄');
  });

  it('负荷率影响电耗与规模：负荷越高，吨水电耗越低（固定电耗被摊薄）', () => {
    const half = evaluateScenario({ ...DEFAULT_SCENARIO, loadFactor: 0.5 });
    expect(half.inflow).toBe(50000);
    expect(half.energyPerCubicMeter).toBeGreaterThan(result.energyPerCubicMeter);
  });

  it('指标行与进出水对照行给得出来', () => {
    const metrics = scenarioMetrics(result);
    expect(metrics.length).toBe(8);
    metrics.forEach((item) => expect(item.label.length).toBeGreaterThan(0));
    const rows = scenarioQualityRows(result);
    expect(rows.length).toBe(6);
    expect(rows.map((row) => row.label)).toContain('总氮');
    expect(rows.every((row) => row.influent >= row.effluent)).toBe(true);
  });

  it('上界曲线：随污泥回流比单调上升并趋近 1', () => {
    const curve = ceilingCurve(0.5, 3, 0.5, 2);
    expect(curve.length).toBe(6);
    for (let index = 1; index < curve.length; index += 1) {
      expect(curve[index][1]).toBeGreaterThan(curve[index - 1][1]);
    }
    expect(curve[curve.length - 1][0]).toBe(3);
    expect(curve[curve.length - 1][1]).toBeLessThan(100);
  });
});
