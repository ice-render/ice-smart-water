/**
 * 工艺试算（what-if）：把设计参数当自变量，实时算这套 AAO 的脱氮能力、需氧、污泥与电耗。
 *
 * 与 `process-model` 的分工：
 * - `process-model` 回答的是**这张图现在怎么样**（要一张图，沿程推演，含局部单元）；
 * - 这里是**不开图也能算的参数化模型** —— 把工艺链固定成一条标准 AAO 主线，只让
 *   R（污泥回流比）/ r（内回流比）/ MLSS / 水温 / 负荷率 当自变量。
 *
 * 口径必须与图纸模型**一致**，否则"试算"和"实测"两个数打架，工程上就没法用。
 * 所以这里复用同一份 `UNIT_REMOVAL` 去除率链、同一份厂站参数，并且有一条单测专门做交叉校验：
 * 默认参数下的结果要落回图纸模型（`computeKpi`）的设计工况值。
 */
import {
  BIOLOGICAL_TANK_KINDS,
  SEWAGE_PLANT,
  UNIT_REMOVAL,
  type PlantMeta,
  type UnitDesign,
} from './plant-case';
import { designMap } from './plant-case';
import type { WaterQuality, QualityIndex } from './water-quality';
import {
  DISCHARGE_LIMIT_1A,
  QUALITY_INDEXES,
  QUALITY_LABELS,
  judgeQuality,
  scaledBy,
  TYPICAL_INFLUENT,
} from './water-quality';

/** 试算的自变量 */
export type ScenarioParams = {
  /** 污泥回流比 R（回流污泥量 / 进水流量） */
  returnRatio: number;
  /** 混合液内回流比 r（内回流量 / 进水流量）—— AAO 脱氮的关键旋钮 */
  internalRatio: number;
  /** 生物池污泥浓度目标 MLSS，mg/L */
  mlss: number;
  /** 设计水温 ℃（硝化/反硝化的温度修正） */
  temperature: number;
  /** 负荷率：实际进水 / 设计规模 */
  loadFactor: number;
};

export type ScenarioResult = {
  params: ScenarioParams;
  inflow: number;
  /** 理论脱氮上界 (R+r)/(1+R+r) */
  ceiling: number;
  /** 扣除温度与泥龄修正后的实际脱氮率 */
  removalRate: number;
  /** 温度修正系数 */
  temperatureFactor: number;
  /** 泥龄修正系数（泥龄不足则硝化不完全） */
  srtFactor: number;
  /** 实际污泥龄 d */
  srt: number;
  /** 与 MLSS 对应的理论泥龄 d（= SRТ 的目标口径） */
  requiredSrt: number;
  /** 食微比 F/M，kgBOD₅/(kgMLSS·d) */
  fm: number;
  /** 生物池总容积 m³ */
  biologicalVolume: number;
  /** 干泥产量 tDS/d */
  drySludge: number;
  /** 剩余污泥量 m³/d */
  wasteSludge: number;
  /** 需氧量 kgO₂/d */
  oxygenDemand: number;
  /** 标准状态供气量 m³/d */
  airDemand: number;
  /** 曝气风机运行功率 kW（与需氧量挂钩） */
  blowerPower: number;
  /** 全厂运行功率 kW */
  totalPower: number;
  /** 吨水电耗 kWh/m³ */
  energyPerCubicMeter: number;
  /** 出水水质（沿固定工艺链推演） */
  effluent: WaterQuality;
  /** 达标判定 */
  compliance: ReturnType<typeof judgeQuality>;
  /** 工程提醒（参数不合理时给出） */
  warnings: string[];
};

export const DEFAULT_SCENARIO: ScenarioParams = {
  returnRatio: 1.0,
  internalRatio: 2.0,
  mlss: 4000,
  temperature: 20,
  loadFactor: 1,
};

/** 固定工艺链（与图纸主流程一致）：只保留影响水质的单元 */
const QUALITY_CHAIN: Array<keyof typeof UNIT_REMOVAL> = [
  'barScreen',
  'gritChamber',
  'primaryClarifier',
  'anaerobicTank',
  'aerobicTank',
  'secondaryClarifier',
  'coagulationTank',
  'filterBed',
];

/** 生物池总容积由图纸给出（这里只取容积，不重画图） */
function biologicalVolumeOf(designs: Record<string, UnitDesign>): number {
  return BIOLOGICAL_TANK_KINDS.reduce((sum, kind) => {
    const unit = SEWAGE_PLANT.units.filter((item) => item.kind === kind)[0];
    const design = unit ? designs[unit.id] : undefined;
    return sum + (design ? design.volume : 0);
  }, 0);
}

/** 理论脱氮上界：进到缺氧池的硝酸盐回流比 / 总流量比 */
export function denitrificationCeiling(returnRatio: number, internalRatio: number): number {
  const total = returnRatio + internalRatio;
  return total / (1 + total);
}

/** 温度修正：硝化菌对温度很敏感，低于 20℃ 每降 1℃ 大约打 2% 折扣（12℃ 以下急剧恶化） */
export function temperatureFactorOf(temperature: number): number {
  if (temperature >= 20) return 1;
  return Math.max(0.55, 1 - (20 - temperature) * 0.02);
}

/** 泥龄修正：泥龄低于 12 d 硝化菌站不住，脱氮率跟着掉 */
export function srtFactorOf(srt: number, required = 12): number {
  if (srt >= required) return 1;
  return Math.max(0.6, srt / required);
}

/** 用参数算一条水质链（除总氮走回流比口径外，其余与图纸同一套去除率） */
function chainEffluent(influent: WaterQuality, removalRate: number): WaterQuality {
  let quality: WaterQuality = { ...influent };
  QUALITY_CHAIN.forEach((kind) => {
    const removal = (UNIT_REMOVAL[kind] || {}) as Partial<WaterQuality>;
    (Object.keys(removal) as QualityIndex[]).forEach((index) => {
      const rate = removal[index];
      if (rate === undefined) return;
      if (index === 'TN') return; // 总氮单独按回流比口径算
      quality = { ...quality, [index]: quality[index] * (1 - rate) };
    });
  });
  quality.TN = influent.TN * (1 - removalRate);
  return {
    COD: round2(quality.COD),
    BOD5: round2(quality.BOD5),
    SS: round2(quality.SS),
    NH3N: round2(quality.NH3N),
    TN: round2(quality.TN),
    TP: round2(quality.TP),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 按参数试算整套指标。
 *
 * 顺序上有依赖：先由 MLSS 反推泥龄（污泥总量 / 日产泥量），再拿泥龄去修脱氮率，
 * 泥龄又回头影响曝气功率 —— 所以这里是一次**单向前推**，不做迭代（工程上够用，也不必让用户等）。
 */
export function evaluateScenario(
  params: ScenarioParams,
  options: { meta?: PlantMeta; designs?: Record<string, UnitDesign> } = {}
): ScenarioResult {
  const meta = options.meta || SEWAGE_PLANT.meta;
  const designs = options.designs || designMap(SEWAGE_PLANT);
  const biologicalVolume = biologicalVolumeOf(designs);
  const inflow = meta.capacity * params.loadFactor;
  const influent = scaledBy(meta.influent, params.loadFactor >= 1 ? 1 : 1.05);

  // 生物段进水 BOD₅：初沉池之后（与图纸模型同口径）
  const bodToBiological = influent.BOD5 * (1 - (UNIT_REMOVAL.primaryClarifier?.BOD5 || 0));
  const bodOut = bodToBiological * (1 - (UNIT_REMOVAL.aerobicTank?.BOD5 || 0)) * 0.9 * 0.9 * 0.85;
  const deltaBod = Math.max(0, bodToBiological - bodOut);

  // 污泥平衡：产泥量 → 泥龄 → 脱氮率
  const drySludge = (meta.sludgeYield * inflow * deltaBod) / 1000;
  const wasteSludge = (drySludge * 1000) / meta.returnSludgeConcentration;
  const srt = (biologicalVolume * (params.mlss / 1000)) / drySludge;
  const requiredSrt = 12;

  const ceiling = denitrificationCeiling(params.returnRatio, params.internalRatio);
  const temperatureFactor = temperatureFactorOf(params.temperature);
  const srtFactor = srtFactorOf(srt, requiredSrt);
  const removalRate = ceiling * temperatureFactor * srtFactor;
  const effluent = chainEffluent(influent, removalRate);

  // 需氧量：合成项 + 内源呼吸项 + 硝化项（与图纸模型同一套系数）
  const nh3Removed = Math.max(0, influent.NH3N - effluent.NH3N);
  const oxygenDemand =
    meta.oxygenCoefficients.synthesis * inflow * (deltaBod / 1000) +
    meta.oxygenCoefficients.endogenous * biologicalVolume * (params.mlss / 1000) +
    meta.nitrificationOxygen * inflow * (nh3Removed / 1000);
  const airDemand = (oxygenDemand / 0.28) * 10;

  // 电耗：风机是大头，功率与需氧量成正比；其余单元取图纸装机功率
  const installed = SEWAGE_PLANT.units.reduce((sum, unit) => {
    const design = designs[unit.id];
    return sum + (unit.kind === 'blower' ? 0 : design ? design.power : 0);
  }, 0);
  const blowerInstalled = SEWAGE_PLANT.units.reduce((sum, unit) => {
    const design = designs[unit.id];
    return sum + (unit.kind === 'blower' ? (design ? design.power : 0) : 0);
  }, 0);
  const designOxygen = 28900;
  const blowerPower = (blowerInstalled * meta.powerLoadFactor * oxygenDemand) / designOxygen;
  const totalPower = installed * meta.powerLoadFactor + blowerPower;
  const energyPerCubicMeter = (totalPower * 24) / inflow;

  const fm = (inflow * bodToBiological) / (biologicalVolume * params.mlss);
  // 判定口径：执行一级 A（与图纸模型同一份限值表）
  const compliance = judgeQuality(effluent, DISCHARGE_LIMIT_1A);

  const warnings: string[] = [];
  if (srt < requiredSrt) warnings.push(`泥龄 ${srt.toFixed(1)} d 低于硝化所需的 ${requiredSrt} d：提高 MLSS 或加大生物池容积`);
  if (params.temperature < 15) warnings.push(`水温 ${params.temperature}℃ 偏低，硝化菌活性受限（口径：低于 20℃ 每降 1℃ 打 2% 折扣）`);
  if (ceiling < 0.7) warnings.push(`总回流比 ${(params.returnRatio + params.internalRatio).toFixed(2)} 偏低，脱氮上界只有 ${(ceiling * 100).toFixed(1)}%`);
  if (params.mlss > 5000) warnings.push(`MLSS ${params.mlss} mg/L 偏高：二沉池固体负荷吃紧，注意跑泥风险`);
  if (fm < 0.05) warnings.push(`食微比 ${fm.toFixed(3)} 偏低（<0.05）：污泥容易老化、发生解絮`);
  if (!compliance.pass) warnings.push(`出水 ${compliance.exceeded.map((index) => QUALITY_LABELS[index]).join('、')} 超标`);

  return {
    params,
    inflow,
    ceiling,
    removalRate,
    temperatureFactor,
    srtFactor,
    srt,
    requiredSrt,
    fm,
    biologicalVolume,
    drySludge,
    wasteSludge,
    oxygenDemand,
    airDemand,
    blowerPower,
    totalPower,
    energyPerCubicMeter,
    effluent,
    compliance,
    warnings,
  };
}

/**
 * 脱氮上界曲线：固定内回流比、让污泥回流比从 `from` 扫到 `to`。
 *
 * 给图表的 `function` 系列 + `sweep` 用：一条"理论上界"，一条"扣掉温度/泥龄后的实际能力"，
 * 让用户一眼看出旋钮已经拧到哪、还剩多少余量。
 */
export function ceilingCurve(from: number, to: number, step: number, internalRatio: number): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  for (let ratio = from; ratio <= to + 1e-9; ratio += step) {
    points.push([round2(ratio), round2(denitrificationCeiling(ratio, internalRatio) * 100)]);
  }
  return points;
}

/** 进出水对照行（试算页右侧的"进水 → 出水 → 限值"三列） */
export function scenarioQualityRows(result: ScenarioResult): Array<{
  index: QualityIndex;
  label: string;
  influent: number;
  effluent: number;
  limit: number;
  margin: number;
  pass: boolean;
}> {
  return result.compliance.items.map((item) => ({
    index: item.index,
    label: QUALITY_LABELS[item.index],
    influent: TYPICAL_INFLUENT[item.index],
    effluent: item.value,
    limit: item.limit,
    margin: item.margin,
    pass: item.pass,
  }));
}

/** 试算页要展示的指标：把结果摊成"名称 / 值 / 单位 / 提示"的行 */
export function scenarioMetrics(result: ScenarioResult): Array<{ key: string; label: string; value: string; unit: string; hint: string }> {
  return [
    { key: 'ceiling', label: '脱氮理论上界', value: (result.ceiling * 100).toFixed(1), unit: '%', hint: `(R+r)/(1+R+r)，R=${result.params.returnRatio} r=${result.params.internalRatio}` },
    { key: 'removal', label: '实际脱氮率', value: (result.removalRate * 100).toFixed(1), unit: '%', hint: `温度 ×${result.temperatureFactor.toFixed(2)} · 泥龄 ×${result.srtFactor.toFixed(2)}` },
    { key: 'srt', label: '实际污泥龄', value: result.srt.toFixed(1), unit: 'd', hint: `硝化所需 ≥ ${result.requiredSrt} d` },
    { key: 'fm', label: '食微比 F/M', value: result.fm.toFixed(3), unit: '', hint: '常规 0.05~0.15' },
    { key: 'oxygen', label: '需氧量', value: Math.round(result.oxygenDemand).toLocaleString(), unit: 'kgO₂/d', hint: `供气 ${Math.round(result.airDemand).toLocaleString()} m³/d` },
    { key: 'sludge', label: '剩余污泥', value: Math.round(result.wasteSludge).toString(), unit: 'm³/d', hint: `干泥 ${result.drySludge.toFixed(2)} tDS/d` },
    { key: 'blower', label: '曝气风机', value: Math.round(result.blowerPower).toString(), unit: 'kW', hint: '功率与需氧量成正比' },
    { key: 'energy', label: '吨水电耗', value: result.energyPerCubicMeter.toFixed(3), unit: 'kWh/m³', hint: `全厂 ${Math.round(result.totalPower)} kW` },
  ];
}
