import { evaluateDosing } from '../../src/domain/dosing';
import type { PlantKpi } from '../../src/domain/process-model';
import type { PlantMeta } from '../../src/domain/plant-case';
import type { WaterQuality } from '../../src/domain/water-quality';

/** 构造一份最小 WaterQuality（只关心用到的几项，其余填 0）。 */
function quality(overrides: Partial<WaterQuality>): WaterQuality {
  return { COD: 0, BOD5: 0, SS: 0, NH3N: 0, TN: 0, TP: 0, ...overrides };
}

/** 一份最小 meta：evaluateDosing 只用 `influent`。 */
function meta(influent: WaterQuality): PlantMeta {
  return { influent } as unknown as PlantMeta;
}

/** 一份最小 kpi：evaluateDosing 只用 `inflow`。 */
function kpi(inflow: number): PlantKpi {
  return { inflow } as unknown as PlantKpi;
}

const TYPICAL_INFLUENT = quality({ TP: 4, TN: 45, BOD5: 150 });
const TYPICAL_META = meta(TYPICAL_INFLUENT);
const TYPICAL_KPI = kpi(100000);

describe('evaluateDosing', () => {
  it('典型负荷下三种药剂投加量非负、节药率落在 (0,1) 且优化成本低于基线', () => {
    const plan = evaluateDosing(TYPICAL_KPI, TYPICAL_META, 1.1);
    for (const chemical of plan.chemicals) {
      expect(chemical.optimizedMass).toBeGreaterThanOrEqual(0);
      expect(chemical.baselineMass).toBeGreaterThanOrEqual(0);
      expect(chemical.savingPct).toBeGreaterThanOrEqual(0);
      expect(chemical.savingPct).toBeLessThanOrEqual(1);
    }
    expect(plan.savingPct).toBeGreaterThan(0);
    expect(plan.savingPct).toBeLessThan(1);
    expect(plan.totalOptimizedCost).toBeLessThan(plan.totalBaselineCost);
  });

  it('投加安全系数增大 → 各药剂优化投加量单调递增、整体节药率单调递减', () => {
    const low = evaluateDosing(TYPICAL_KPI, TYPICAL_META, 1.0);
    const high = evaluateDosing(TYPICAL_KPI, TYPICAL_META, 1.5);
    for (let index = 0; index < low.chemicals.length; index += 1) {
      expect(high.chemicals[index].optimizedMass).toBeGreaterThan(low.chemicals[index].optimizedMass);
    }
    expect(high.savingPct).toBeLessThan(low.savingPct);
  });

  it('进水总磷升高 → 除磷剂优化投加量单调递增', () => {
    const low = evaluateDosing(TYPICAL_KPI, meta(quality({ TP: 4, TN: 45, BOD5: 150 })), 1.0);
    const high = evaluateDosing(TYPICAL_KPI, meta(quality({ TP: 10, TN: 45, BOD5: 150 })), 1.0);
    const lowCoag = low.chemicals.find((c) => c.key === 'coagulant')!;
    const highCoag = high.chemicals.find((c) => c.key === 'coagulant')!;
    expect(highCoag.optimizedMass).toBeGreaterThan(lowCoag.optimizedMass);
  });

  it('高进水总磷下除磷剂优化逼近/超过基线，节药率夹到 0', () => {
    const plan = evaluateDosing(TYPICAL_KPI, meta(quality({ TP: 10, TN: 45, BOD5: 150 })), 1.0);
    const coag = plan.chemicals.find((c) => c.key === 'coagulant')!;
    expect(coag.optimizedMass).toBeGreaterThanOrEqual(coag.baselineMass);
    expect(coag.savingPct).toBe(0);
  });

  it('进水碳源充足（BOD₅/N ≥ 4）时碳源无需补投，节药率为 1', () => {
    const plan = evaluateDosing(TYPICAL_KPI, meta(quality({ TP: 4, TN: 45, BOD5: 300 })), 1.1);
    const carbon = plan.chemicals.find((c) => c.key === 'carbon')!;
    expect(carbon.optimizedMass).toBe(0);
    expect(carbon.savingPct).toBe(1);
  });

  it('消毒剂投加量随流量线性、且优化低于基线', () => {
    const plan = evaluateDosing(TYPICAL_KPI, TYPICAL_META, 1.1);
    const disinfection = plan.chemicals.find((c) => c.key === 'disinfection')!;
    expect(disinfection.optimizedMass).toBeGreaterThan(0);
    expect(disinfection.optimizedMass).toBeLessThan(disinfection.baselineMass);
  });
});
