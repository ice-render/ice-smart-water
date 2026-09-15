/**
 * 能耗分项：摊分守恒 + 峰谷分摊 + 确定性。
 */
import { SEWAGE_PLANT, designMap, toPlantGraph } from '../../src/domain/plant-case';
import { computeKpi, simulateDay } from '../../src/domain/process-model';
import { modeById } from '../../src/domain/operating-modes';
import {
  ENERGY_GROUPS,
  TARIFF_PRICE,
  energyKpi,
  energyMixData,
  meterTree,
  tariffBandData,
  tariffSplit,
} from '../../src/domain/energy-meter';

const designs = () => designMap();
const kpiOf = () => computeKpi(toPlantGraph(), designs(), SEWAGE_PLANT.meta);
const pointsOf = () => simulateDay(toPlantGraph(), designs(), SEWAGE_PLANT.meta, modeById('normal'));

describe('分项电表树', () => {
  it('分项装机之和 = 厂站里所有带功率单元的装机之和', () => {
    const nodes = meterTree(kpiOf());
    const sum = nodes.reduce((total, node) => total + node.power, 0);
    const expected = SEWAGE_PLANT.units.reduce((total, unit) => total + (unit.design.power || 0), 0);
    expect(Math.abs(sum - expected)).toBeLessThan(1);
  });

  it('五个分项都在，且摊分后的日耗电之和 ≈ 全厂日耗电（守恒）', () => {
    const kpi = kpiOf();
    const nodes = meterTree(kpi);
    expect(nodes).toHaveLength(ENERGY_GROUPS.length);
    const sum = nodes.reduce((total, node) => total + node.energy, 0);
    expect(Math.abs(sum - kpi.energyTotal)).toBeLessThan(1);
    // 占比之和 = 1
    const shareSum = nodes.reduce((total, node) => total + node.share, 0);
    expect(Math.abs(shareSum - 1)).toBeLessThan(0.02);
  });

  it('曝气与鼓风是最大头（占比 > 40%）', () => {
    const nodes = meterTree(kpiOf());
    const aeration = nodes.filter((node) => node.id === 'aeration')[0];
    nodes.forEach((node) => expect(aeration.share).toBeGreaterThanOrEqual(node.share));
    expect(aeration.share).toBeGreaterThan(0.4);
  });

  it('确定性：两次结果完全一致', () => {
    expect(meterTree(kpiOf())).toEqual(meterTree(kpiOf()));
  });
});

describe('峰谷分摊', () => {
  it('三档电量之和 = 全天电量；电费 = 各档电量 × 各档电价', () => {
    const points = pointsOf();
    const split = tariffSplit(points);
    const total = points.reduce((sum, point) => sum + point.energy, 0);
    expect(Math.abs(split.peak + split.flat + split.valley - total)).toBeLessThan(1);
    const expectedCost =
      split.peak * TARIFF_PRICE.peak + split.flat * TARIFF_PRICE.flat + split.valley * TARIFF_PRICE.valley;
    expect(Math.abs(split.cost - expectedCost)).toBeLessThan(2);
    // 平均电价必然落在最低与最高电价之间
    expect(split.avgPrice).toBeGreaterThanOrEqual(TARIFF_PRICE.valley);
    expect(split.avgPrice).toBeLessThanOrEqual(TARIFF_PRICE.peak);
  });

  it('跨零点的时段（23 点属低谷）按小时正确归档', () => {
    const split = tariffSplit([{ hour: 23, energy: 100 } as any]);
    expect(split.valley).toBe(100);
    expect(split.energy).toBe(100);
    // 8 点属高峰
    expect(tariffSplit([{ hour: 8, energy: 50 } as any]).peak).toBe(50);
    // 12 点属平段
    expect(tariffSplit([{ hour: 12, energy: 30 } as any]).flat).toBe(30);
  });
});

describe('能耗 KPI', () => {
  it('曝气占比、单位污染物去除电耗、吨水电费都算得出来', () => {
    const kpi = energyKpi(kpiOf(), pointsOf());
    expect(kpi.blowerShare).toBeGreaterThan(0.4);
    expect(kpi.removalEnergy).toBeGreaterThan(0);
    expect(kpi.costPerCubicMeter).toBeGreaterThan(0);
    expect(kpi.installedPower).toBeGreaterThan(1000);
  });

  it('图表数据与 KPI 同源', () => {
    const kpi = energyKpi(kpiOf(), pointsOf());
    const nodes = meterTree(kpiOf());
    const mix = energyMixData(nodes);
    expect(mix.names).toHaveLength(nodes.length);
    expect(mix.energy.reduce((sum, value) => sum + value, 0)).toBeCloseTo(kpi.energyTotal, 0);
    const bands = tariffBandData(kpi.tariff);
    expect(bands.names).toEqual(['低谷', '平段', '高峰']);
    expect(bands.energy.reduce((sum, value) => sum + value, 0)).toBeCloseTo(kpi.tariff.energy, 0);
  });
});
