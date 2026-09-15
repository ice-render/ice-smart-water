/**
 * 能耗分项与吨水电耗。
 *
 * 与 `process-model` 的分工：那边算的是**全厂总账**（装机功率、日耗电、吨水电耗），
 * 这里把总账**拆到分项**（污水提升 / 曝气与鼓风 / 污泥处理 / 深度处理 / 辅助除臭），
 * 再按时段电价算电费 —— 回答"电花在哪儿、什么时段花的、能不能错峰"。
 *
 * 口径（重要）：
 * - 分项**装机功率**直接来自厂站单元的 `design.power`（按 kind 归组）；
 * - 分项**日耗电**按「装机 × 该分项的负载系数」的比例**摊分**全厂日耗电（`kpi.energyTotal`）。
 *   这是演示级的简化：真实分项要装分表，这里只保证"总量守恒 + 比例合理 + 同输入同输出"。
 * - 电价按时段三档：谷 / 平 / 峰，按 `simulateDay` 的**逐小时耗电**分别累加。
 *
 * 单位口径：功率 `kW`、电量 `kWh`、电费 `元`、吨水电耗 `kWh/m³`。
 */
import type { PlantMeta } from './plant-case';
import { designMap, SEWAGE_PLANT } from './plant-case';
import type { UnitDesign } from './plant-case';
import type { DayPoint, PlantKpi } from './process-model';

/** 电价三档（元/kWh，取市政污水厂常见的工商业分时价） */
export const TARIFF_PRICE = { valley: 0.32, flat: 0.68, peak: 1.05 };

export type TariffBandId = 'valley' | 'flat' | 'peak';

/** 时段划分（按小时）：谷 23~07、峰 08~11 与 18~21、其余为平。三档各 8 小时。 */
export const TARIFF_BANDS: Array<{ id: TariffBandId; label: string; hours: number[] }> = [
  // 按**价格升序**排（谷 → 平 → 峰）：图表与表格都按这个顺序显示，读起来是"从便宜到贵"
  { id: 'valley', label: '低谷', hours: [23, 0, 1, 2, 3, 4, 5, 6] },
  { id: 'flat', label: '平段', hours: [7, 12, 13, 14, 15, 16, 17, 22] },
  { id: 'peak', label: '高峰', hours: [8, 9, 10, 11, 18, 19, 20, 21] },
];

export const TARIFF_PRICE_BY_BAND: Record<TariffBandId, number> = TARIFF_PRICE;

/**
 * 分项定义：按单元 kind 归组 + 该分项的**负载系数**（实际运行小时占比）。
 *
 * 负载系数是"分摊口径"而不是实测值：曝气要连续运行（0.95），污泥线是间歇运行（0.45），
 * 所以不能只按装机功率摊。
 */
export const ENERGY_GROUPS: Array<{ id: string; name: string; kinds: string[]; duty: number; note: string }> = [
  { id: 'lift', name: '污水提升', kinds: ['pump', 'submersiblePump'], duty: 0.85, note: '进水泵 + 回流/事故泵' },
  { id: 'aeration', name: '曝气与鼓风', kinds: ['blower', 'aerobicTank', 'gritChamber'], duty: 0.95, note: '鼓风机 + 好氧池曝气（连续运行）' },
  { id: 'sludge', name: '污泥处理', kinds: ['dewateringMachine', 'screwPump', 'sludgeThickener', 'sludgeSilo', 'primaryClarifier', 'secondaryClarifier'], duty: 0.45, note: '脱水机 + 输泥泵 + 浓缩 + 刮泥机（间歇）' },
  { id: 'tertiary', name: '深度处理与消毒', kinds: ['coagulationTank', 'filterBed', 'disinfectionTank', 'dosingUnit'], duty: 0.6, note: '混凝 / 滤池 / 消毒 / 加药' },
  { id: 'aux', name: '辅助与除臭', kinds: [], duty: 0.7, note: '除臭 + 格栅 + 搅拌 + 在线仪表（兜底归此处）' },
];

export type MeterNode = {
  id: string;
  name: string;
  /** 该分项的装机功率 kW */
  power: number;
  /** 该分项的日耗电 kWh */
  energy: number;
  /** 占全厂日耗电的比例 0~1 */
  share: number;
  /** 负载系数 */
  duty: number;
  note: string;
  /** 归入该分项的单元位号 */
  tags: string[];
};

export type TariffSplit = {
  peak: number;
  flat: number;
  valley: number;
  /** 日耗电合计 kWh */
  energy: number;
  /** 日电费 元 */
  cost: number;
  /** 平均电价 元/kWh */
  avgPrice: number;
  peakShare: number;
};

export type EnergyKpi = {
  /** 全厂日耗电 kWh */
  energyTotal: number;
  /** 吨水电耗 kWh/m³ */
  energyPerCubicMeter: number;
  /** 分项装机合计 kW */
  installedPower: number;
  /** 曝气与鼓风占比 0~1 */
  blowerShare: number;
  /** 单位污染物去除电耗 kWh/kgCOD（去除量） */
  removalEnergy: number;
  tariff: TariffSplit;
  /** 吨水电费 元/m³ */
  costPerCubicMeter: number;
};

/** 分项电表树：总表 → 分项（按装机 × 负载系数摊分全厂日耗电）。 */
export function meterTree(
  kpi: PlantKpi,
  units: Array<{ id: string; kind: string; tag: string }> = SEWAGE_PLANT.units,
  designs: Record<string, UnitDesign> = designMap()
): MeterNode[] {
  const powerOf = (unitId: string) => Number((designs[unitId] || ({} as UnitDesign)).power) || 0;
  const buckets = ENERGY_GROUPS.map((group) => ({ group, power: 0, tags: [] as string[] }));

  (units || []).forEach((unit) => {
    const power = powerOf(unit.id);
    if (!(power > 0)) return;
    // 按 kind 归组；没在任何一个分项里列出的 kind 一律兜底进「辅助与除臭」
    const target =
      buckets.filter((bucket) => bucket.group.kinds.indexOf(String(unit.kind)) >= 0)[0] ||
      buckets.filter((bucket) => bucket.group.id === 'aux')[0];
    if (!target) return;
    target.power += power;
    target.tags.push(unit.tag);
  });

  const weights = buckets.map((bucket) => bucket.power * bucket.group.duty);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0) || 1;
  return buckets.map((bucket, index) => ({
    id: bucket.group.id,
    name: bucket.group.name,
    power: round2(bucket.power),
    energy: round2((Number(kpi.energyTotal) || 0) * (weights[index] / weightTotal)),
    share: round2(weights[index] / weightTotal),
    duty: bucket.group.duty,
    note: bucket.group.note,
    tags: bucket.tags,
  }));
}

/** 峰谷分摊：按 `simulateDay` 的逐小时耗电，落到三个时段。 */
export function tariffSplit(points: DayPoint[] = []): TariffSplit {
  const bandOf = (hour: number): TariffBandId => {
    const band = TARIFF_BANDS.filter((item) => item.hours.indexOf(hour) >= 0)[0];
    return band ? band.id : 'flat';
  };
  let peak = 0;
  let flat = 0;
  let valley = 0;
  points.forEach((point) => {
    const energy = Number(point.energy) || 0;
    const band = bandOf(point.hour);
    if (band === 'peak') peak += energy;
    else if (band === 'valley') valley += energy;
    else flat += energy;
  });
  const energy = peak + flat + valley;
  const cost = peak * TARIFF_PRICE.peak + flat * TARIFF_PRICE.flat + valley * TARIFF_PRICE.valley;
  return {
    peak: round2(peak),
    flat: round2(flat),
    valley: round2(valley),
    energy: round2(energy),
    cost: Math.round(cost),
    avgPrice: energy > 0 ? round2(cost / energy) : 0,
    peakShare: energy > 0 ? round2(peak / energy) : 0,
  };
}

export function energyKpi(
  kpi: PlantKpi,
  points: DayPoint[] = [],
  units: Array<{ id: string; kind: string; tag: string }> = SEWAGE_PLANT.units,
  designs: Record<string, UnitDesign> = designMap(),
  meta: PlantMeta = SEWAGE_PLANT.meta
): EnergyKpi {
  const nodes = meterTree(kpi, units, designs);
  const installedPower = round2(nodes.reduce((sum, node) => sum + node.power, 0));
  const aeration = nodes.filter((node) => node.id === 'aeration')[0];
  const tariff = tariffSplit(points);
  const inflow = Number(kpi.inflow) || 0;
  const codIn = Number(meta.influent.COD) || 0;
  const codOut = Number(kpi.effluent && kpi.effluent.COD) || 0;
  const removedKg = (inflow * Math.max(0, codIn - codOut)) / 1000;
  return {
    energyTotal: round2(kpi.energyTotal),
    energyPerCubicMeter: round2(kpi.energyPerCubicMeter),
    installedPower,
    blowerShare: aeration ? aeration.share : 0,
    removalEnergy: removedKg > 0 ? round2((Number(kpi.energyTotal) || 0) / removedKg) : 0,
    tariff,
    costPerCubicMeter: inflow > 0 ? round2(tariff.cost / inflow) : 0,
  };
}

/** 分项占比（柱状图用）：`[分项名, 日耗电]`。 */
export function energyMixData(nodes: MeterNode[]): { names: string[]; energy: number[] } {
  return { names: nodes.map((node) => node.name), energy: nodes.map((node) => node.energy) };
}

/** 峰谷分摊（柱状图用）：`[时段, 电量, 电价]`。 */
export function tariffBandData(split: TariffSplit): { names: string[]; energy: number[]; prices: number[] } {
  return {
    names: TARIFF_BANDS.map((band) => band.label),
    energy: TARIFF_BANDS.map((band) => split[band.id]),
    prices: TARIFF_BANDS.map((band) => TARIFF_PRICE[band.id]),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
