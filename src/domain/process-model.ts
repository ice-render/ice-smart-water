/**
 * 工艺模型：水量平衡、水力停留时间、污泥平衡、需氧量、能耗，以及沿程水质推演。
 *
 * 全部是**纯函数**，输入是一份扁平的图描述（`PlantGraph`）+ 设计参数，输出是报表数字。
 * 公式取城市污水厂的常规算法（《室外排水设计标准》GB 50014 / 《给水排水设计手册》口径），
 * 每一步都在注释里写明假设 —— 演示模型的价值在于**自洽**，不在于精确。
 *
 * 单位约定（全文件统一，别猜）：
 * - 流量 m³/d，容积 m³，面积 m²，功率 kW，电耗 kWh
 * - 浓度 mg/L（= g/m³），污泥浓度同时也用 kg/m³（8000 mg/L = 8 kg/m³）
 */
import type { WaterSymbolKind } from 'ice-entity-designer';
import {
  BIOLOGICAL_TANK_KINDS,
  NORMALLY_CLOSED_VALVES,
  UNIT_REMOVAL,
  type PlantMeta,
  type UnitDesign,
} from './plant-case';
import { processChain, type PlantGraph, type PlantNode } from './plant-graph';
import {
  DEFAULT_SIMULATION_SEED,
  HOURLY_FLOW_FACTORS,
  HOURS_PER_DAY,
  createRandom,
  hourLabel,
  hourQualityFactor,
  jitter,
} from './daily-profile';
import type { OperatingMode } from './operating-modes';
import {
  judgeQuality,
  QUALITY_INDEXES,
  removalRateOf,
  round2,
  scaledBy,
  type ComplianceReport,
  type QualityIndex,
  type WaterQuality,
} from './water-quality';

/** 空气含氧量 kgO₂ / m³（20℃、标准大气压） */
export const AIR_OXYGEN_CONTENT = 0.28;
/** 微孔曝气的氧转移效率（工程常用 15%~25%，取中值） */
export const OXYGEN_TRANSFER_EFFICIENCY = 0.2;
/** 混凝剂投加量 mg/L（PAC/PFS，除磷 + 助凝的常规投加量） */
export const COAGULANT_DOSAGE = 30;

export type UnitHydraulics = {
  id: string;
  kind: WaterSymbolKind;
  name: string;
  tag: string;
  /** 过水流量 m³/d（辅助设备为 0：鼓风机送气、加药装置送药） */
  flow: number;
  /** 水力停留时间 h（无池容的单元为 0） */
  hrt: number;
  /** 表面负荷 m³/(m²·h)（无面积的单元为 0） */
  surfaceLoad: number;
  /** 装机功率 kW */
  power: number;
  /** 水头损失 m */
  headLoss: number;
  /** 停用的单元不计入运行功率 */
  idle: boolean;
};

export type SludgeBalance = {
  /** 生物池混合液浓度 MLSS，mg/L */
  mlss: number;
  /** 生物池总容积 m³ */
  tankVolume: number;
  /** 污泥龄 SRT，d */
  srt: number;
  /** 污泥负荷 F/M，kgBOD₅/(kgMLSS·d) */
  fm: number;
  /** 生物池总停留时间 h */
  totalHrt: number;
  /** 剩余污泥（生化）体积流量 m³/d */
  wasteSludgeFlow: number;
  /** 干污泥产量 tDS/d */
  drySludge: number;
};

export type PlantKpi = {
  capacity: number;
  inflow: number;
  /** 负荷率 = 实际进水 / 设计规模 */
  utilization: number;
  powerInstalled: number;
  powerRunning: number;
  /** 全厂日耗电量 kWh */
  energyTotal: number;
  /** 吨水电耗 kWh/m³ */
  energyPerCubicMeter: number;
  returnSludgeFlow: number;
  recycleFlow: number;
  sludge: SludgeBalance;
  /** 需氧量 kgO₂/d */
  oxygenDemand: number;
  /** 标准状态供气量 m³/d */
  airDemand: number;
  /** 混凝剂投加量 kg/d */
  chemicalDosage: number;
  removalRates: Record<QualityIndex, number>;
  /** 出水水质（走线终点的推演结果） */
  effluent: WaterQuality;
  /** 出水达标判定 */
  compliance: ComplianceReport;
};

export type QualityStage = {
  id: string;
  name: string;
  tag: string;
  kind: WaterSymbolKind;
  quality: WaterQuality;
};

export type QualityChainResult = {
  stages: QualityStage[];
  /** 出水（走线终点）水质 */
  effluent: WaterQuality;
  compliance: ComplianceReport;
  connected: boolean;
  blockedAt?: string;
};

/**
 * 逐单元过水流量。
 *
 * 规则按**单元类型**给，因为水量平衡在 AAO 里就是分段的：
 * - 预处理段与深度处理段只走进水 Q；
 * - 厌氧池进的是「进水 + 回流污泥」= Q(1+R)；
 * - 缺氧池、好氧池再加「混合液内回流」= Q(1+R+r)；
 * - **二沉池只接 Q(1+R)** —— 内回流是生物池内部的循环（好氧池末端 → 缺氧池），
 *   不经过二沉池；把它算进二沉池会凭空抬高表面负荷 50%。
 * - 阀门按开 / 闭：开 = 过 Q，闭 = 0（关阀断流在数字上也要断）。
 */
export function flowOfNode(node: PlantNode, meta: PlantMeta, inflow: number, wasteSludgeFlow: number): number {
  const recycle = meta.sludgeReturnRatio;
  const internalRecycle = meta.mixedLiquorRecycleRatio;
  switch (node.kind) {
    case 'anaerobicTank':
      return inflow * (1 + recycle);
    case 'anoxicTank':
    case 'aerobicTank':
      return inflow * (1 + recycle + internalRecycle);
    case 'secondaryClarifier':
      return inflow * (1 + recycle);
    case 'sludgeThickener':
    case 'dewateringMachine':
    case 'sludgeOut':
      return wasteSludgeFlow;
    case 'blower':
    case 'dosingUnit':
      // 鼓风机送的是空气、加药装置送的是药剂：都不在这条水量平衡里
      return 0;
    case 'valve':
      return node.valveState === 'closed' ? 0 : inflow;
    default:
      return inflow;
  }
}

/** 剩余污泥量：由污泥产率与进出水 BOD₅ 差算干泥量，再按回流污泥浓度折算体积 */
export function computeSludgeBalance(
  meta: PlantMeta,
  inflow: number,
  tankVolume: number,
  bodIn: number,
  bodOut: number
): SludgeBalance {
  // 干污泥产量 kgVSS/d：Y × Q × ΔBOD₅（浓度是 mg/L = g/m³，除 1000 得 kg）
  const drySludge = (meta.sludgeYield * inflow * Math.max(0, bodIn - bodOut)) / 1000;
  // 回流污泥浓度 Xr（mg/L）→ kg/m³
  const xr = meta.returnSludgeConcentration / 1000;
  const wasteSludgeFlow = xr > 0 ? drySludge / xr : 0;
  const returnSludgeFlow = inflow * meta.sludgeReturnRatio;
  // 生物池 MLSS：进出生物池的污泥量平衡 (Q+RQ)·X = (RQ+WQ)·Xr
  const mlss = inflow + returnSludgeFlow > 0 ? ((returnSludgeFlow + wasteSludgeFlow) * meta.returnSludgeConcentration) / (inflow + returnSludgeFlow) : 0;
  // 污泥龄 SRT = 池内污泥总量 / 每日排出污泥量
  const srt = wasteSludgeFlow > 0 && xr > 0 ? (tankVolume * (mlss / 1000)) / (wasteSludgeFlow * xr) : 0;
  // 污泥负荷 F/M = 每日 BOD₅ 负荷 / 池内污泥总量。
  // 单位自检：Q[m³/d]×S0[g/m³] = g/d；V[m³]×X[mg/L = g/m³] = g；相除 = 1/d。
  const fm = tankVolume > 0 && mlss > 0 ? (inflow * bodIn) / (tankVolume * mlss) : 0;
  const totalHrt = inflow > 0 ? (tankVolume / inflow) * 24 : 0;
  return {
    mlss: round2(mlss),
    tankVolume: round2(tankVolume),
    srt: round2(srt),
    fm: Math.round(fm * 10000) / 10000,
    totalHrt: round2(totalHrt),
    wasteSludgeFlow: round2(wasteSludgeFlow),
    drySludge: round2(drySludge / 1000),
  };
}

/**
 * 沿程水质推演：从进水顺着走线，逐单元乘上目标去除率。
 *
 * 走线本身由 `processChain` 给（BFS 最短通行路径），所以**图一改，水质就跟着变** ——
 * 用户把某段管线删掉，出水水质立刻会"跳过"那个单元，这正是运行看板想暴露的事。
 */
export function evaluateQualityChain(
  graph: PlantGraph,
  meta: PlantMeta,
  influent: WaterQuality,
  limit?: WaterQuality
): QualityChainResult {
  const { nodes, trace } = processChain(graph, { deprioritizedNodes: NORMALLY_CLOSED_VALVES });
  const stages: QualityStage[] = [];
  let current: WaterQuality = { ...influent };
  nodes.forEach((node) => {
    const removal = UNIT_REMOVAL[node.kind];
    if (removal) current = applyRemoval(current, removal);
    stages.push({ id: node.id, name: node.name, tag: node.tag, kind: node.kind, quality: { ...current } });
  });
  return {
    stages,
    effluent: current,
    compliance: judgeQuality(current, limit),
    connected: trace.connected,
    blockedAt: trace.blockedAt,
  };
}

function applyRemoval(quality: WaterQuality, removal: Partial<WaterQuality>): WaterQuality {
  const next = {} as WaterQuality;
  QUALITY_INDEXES.forEach((index) => {
    const rate = Math.min(0.999, Math.max(0, Number(removal[index]) || 0));
    next[index] = round2((Number(quality[index]) || 0) * (1 - rate));
  });
  return next;
}

/** 逐单元的流量 / HRT / 表面负荷表 */
export function computeHydraulics(
  graph: PlantGraph,
  designs: Record<string, UnitDesign>,
  meta: PlantMeta,
  inflow: number,
  wasteSludgeFlow: number
): UnitHydraulics[] {
  return graph.nodes.map((node) => {
    const unit = designs[node.id];
    const flow = flowOfNode(node, meta, inflow, wasteSludgeFlow);
    const volume = (unit && unit.volume) || 0;
    const area = (unit && unit.area) || 0;
    return {
      id: node.id,
      kind: node.kind,
      name: node.name,
      tag: node.tag,
      flow: round2(flow),
      hrt: flow > 0 && volume > 0 ? round2((volume / flow) * 24) : 0,
      surfaceLoad: flow > 0 && area > 0 ? round2(flow / 24 / area) : 0,
      power: (unit && unit.power) || 0,
      headLoss: (unit && unit.headLoss) || 0,
      idle: !!node.idle,
    };
  });
}

export type KpiOptions = {
  /** 进水流量；缺省取设计规模 */
  inflow?: number;
  /** 进水水质；缺省取设计进水水质 */
  influent?: WaterQuality;
  /** 出水限值；缺省取一级 A */
  limit?: WaterQuality;
};

/**
 * 全厂 KPI 一次性算完。
 *
 * 顺序上是「先算水质链（拿到生物池进出水 BOD₅）→ 再算污泥平衡 → 再算水力与能耗」，
 * 因为剩余污泥量反过来会影响二沉池之后的泥线流量。
 */
export function computeKpi(
  graph: PlantGraph,
  designs: Record<string, UnitDesign>,
  meta: PlantMeta,
  options: KpiOptions = {}
): PlantKpi {
  const inflow = Number(options.inflow) > 0 ? Number(options.inflow) : meta.capacity;
  const influent = options.influent || meta.influent;

  const chain = evaluateQualityChain(graph, meta, influent, options.limit);
  const nodes = graph.nodes;
  const volumeOf = (kinds: WaterSymbolKind[]) =>
    nodes
      .filter((node) => kinds.indexOf(node.kind) !== -1)
      .reduce((total, node) => total + (((designs[node.id] || ({} as UnitDesign)).volume) || 0), 0);
  const tankVolume = volumeOf(BIOLOGICAL_TANK_KINDS);
  const powerOf = (kinds: WaterSymbolKind[]) =>
    nodes
      .filter((node) => kinds.indexOf(node.kind) !== -1)
      .reduce((total, node) => total + (((designs[node.id] || ({} as UnitDesign)).power) || 0), 0);

  // 生物池进出水 BOD₅：取第一个生物池单元的进水（= 初沉池出水）与最终出水
  const firstBiological = nodes.filter((node) => BIOLOGICAL_TANK_KINDS.indexOf(node.kind) !== -1)[0];
  const bodIn = firstBiological ? bodInOf(chain, firstBiological.id, meta.influent.BOD5) : meta.influent.BOD5;
  const bodOut = chain.effluent.BOD5;

  const sludge = computeSludgeBalance(meta, inflow, tankVolume, bodIn, bodOut);
  const hydraulics = computeHydraulics(graph, designs, meta, inflow, sludge.wasteSludgeFlow);

  // 能耗：停用的单元不计入运行功率
  const powerInstalled = hydraulics.reduce((total, unit) => total + unit.power, 0);
  const powerRunning = hydraulics.reduce((total, unit) => total + (unit.idle ? 0 : unit.power), 0);
  const energyTotal = powerRunning * meta.powerLoadFactor * 24;

  // 需氧量：合成项（BOD₅ 去除）+ 硝化项（氨氮去除）+ 内源呼吸项（池内污泥自身氧化）
  const nh3In = firstBiological ? concentrationAt(chain, firstBiological.id, 'NH3N', meta.influent.NH3N) : meta.influent.NH3N;
  const oxygenDemand =
    meta.oxygenCoefficients.synthesis * inflow * Math.max(0, bodIn - bodOut) * 0.001 +
    meta.nitrificationOxygen * inflow * Math.max(0, nh3In - chain.effluent.NH3N) * 0.001 +
    meta.oxygenCoefficients.endogenous * tankVolume * (sludge.mlss / 1000);
  const airDemand = oxygenDemand / (AIR_OXYGEN_CONTENT * OXYGEN_TRANSFER_EFFICIENCY);

  const removalRates = {} as Record<QualityIndex, number>;
  QUALITY_INDEXES.forEach((index) => {
    removalRates[index] = removalRateOf(influent, chain.effluent, index);
  });

  void powerOf; // 预留：分系统能耗拆分（曝气 / 泵 / 污泥）在后续版本用

  return {
    capacity: meta.capacity,
    inflow: round2(inflow),
    utilization: Math.round((inflow / meta.capacity) * 1000) / 10,
    powerInstalled: round2(powerInstalled),
    powerRunning: round2(powerRunning),
    energyTotal: round2(energyTotal),
    energyPerCubicMeter: inflow > 0 ? Math.round((energyTotal / inflow) * 1000) / 1000 : 0,
    returnSludgeFlow: round2(inflow * meta.sludgeReturnRatio),
    recycleFlow: round2(inflow * meta.mixedLiquorRecycleRatio),
    sludge,
    oxygenDemand: round2(oxygenDemand),
    airDemand: round2(airDemand),
    chemicalDosage: round2((inflow * COAGULANT_DOSAGE) / 1000),
    removalRates,
    effluent: chain.effluent,
    compliance: chain.compliance,
  };
}

/** 取水质链上某个单元**之前**的浓度（= 该单元的进水浓度） */
function concentrationAt(
  chain: QualityChainResult,
  nodeId: string,
  index: QualityIndex,
  fallback: number
): number {
  const position = chain.stages.findIndex((stage) => stage.id === nodeId);
  if (position <= 0) return fallback;
  return chain.stages[position - 1].quality[index];
}

function bodInOf(chain: QualityChainResult, nodeId: string, fallback: number): number {
  return concentrationAt(chain, nodeId, 'BOD5', fallback);
}

/** 沿程水量报表（按走线顺序输出，运行人员看的就是这条线） */
export function chainHydraulics(graph: PlantGraph, hydraulics: UnitHydraulics[]): UnitHydraulics[] {
  const { nodes } = processChain(graph, { deprioritizedNodes: NORMALLY_CLOSED_VALVES });
  const byId = new Map(hydraulics.map((unit) => [unit.id, unit]));
  return nodes.map((node) => byId.get(node.id)).filter((unit): unit is UnitHydraulics => !!unit);
}

/** 把水质链压成图表用得上的数组（进出水对照用） */
export function qualitySeriesOf(chain: QualityChainResult, index: QualityIndex): number[] {
  return chain.stages.map((stage) => stage.quality[index]);
}

/** 24 小时曲线上的一个点（运行看板的原始数据） */
export type DayPoint = {
  hour: number;
  label: string;
  /** 该小时进水流量 m³/h */
  inflow: number;
  /** 该小时日均系数（图上想看"现在处于高峰还是低谷"） */
  hourlyFactor: number;
  /** 该小时出水 COD mg/L */
  cod: number;
  /** 该小时出水氨氮 mg/L */
  nh3n: number;
  /** 该小时出水总氮 mg/L */
  tn: number;
  /** 该小时出水总磷 mg/L */
  tp: number;
  /** 该小时耗电 kWh */
  energy: number;
  /** 该小时吨水电耗 kWh/m³ */
  energyPerCubicMeter: number;
  /** 该小时达标项数（0~6） */
  passed: number;
};

export type SimulateDayOptions = {
  /** 日均进水流量；缺省取设计规模 × 工况水量系数 */
  inflow?: number;
  /** 进水水质；缺省取设计进水水质 × 工况水质系数 */
  influent?: WaterQuality;
  /** 随机种子（同种子 = 同曲线） */
  seed?: number;
  /** 水质抖动幅度（±），缺省 6% */
  noise?: number;
  limit?: WaterQuality;
};

/**
 * 模拟一天：逐小时按日变化系数算水量与水质，跑一遍全厂 KPI，产出图表数据。
 *
 * `graph` 必须是**已经铺过工况**的图（`applyModeToGraph` 的产物）—— 阀门位置会影响
 * 沿程水质与断流判定，先铺后算，曲线才和画布上看到的一致。
 */
export function simulateDay(
  graph: PlantGraph,
  designs: Record<string, UnitDesign>,
  meta: PlantMeta,
  mode: OperatingMode,
  options: SimulateDayOptions = {}
): DayPoint[] {
  const baseInflow = Number(options.inflow) > 0 ? Number(options.inflow) : meta.capacity * mode.inflowFactor;
  const baseInfluent = options.influent || scaledBy(meta.influent, mode.qualityFactor);
  const limit = options.limit;
  const amplitude = Number.isFinite(options.noise) ? Number(options.noise) : 0.06;
  const random = createRandom(options.seed === undefined ? DEFAULT_SIMULATION_SEED : options.seed);
  const points: DayPoint[] = [];

  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const factor = HOURLY_FLOW_FACTORS[hour];
    // 进水浓度与流量反相关（夜间偏高），再叠一点确定性抖动
    const influent = scaledBy(
      scaledBy(baseInfluent, hourQualityFactor(factor)),
      amplitude > 0 ? jitter(random, amplitude) : 1
    );
    const kpi = computeKpi(graph, designs, meta, { inflow: baseInflow * factor, influent, limit });
    points.push({
      hour,
      label: hourLabel(hour),
      inflow: round2(kpi.inflow / 24),
      hourlyFactor: factor,
      cod: kpi.effluent.COD,
      nh3n: kpi.effluent.NH3N,
      tn: kpi.effluent.TN,
      tp: kpi.effluent.TP,
      energy: round2(kpi.energyTotal / 24),
      energyPerCubicMeter: kpi.energyPerCubicMeter,
      passed: kpi.compliance.passed,
    });
  }
  return points;
}
