/**
 * 精确曝气与鼓风优化（厂级）。
 *
 * 把 `process-model` 已经算好的两样量 —— `PlantKpi.oxygenDemand`（需氧量 kgO₂/d）、
 * `PlantKpi.airDemand`（标准状态供气量 m³/d）—— 喂成一个**真实可演示的控制闭环**：
 *
 *   溶解氧设定值 → 所需供气量 → 鼓风机投运台数 + 运行频率（亲和定律 P ∝ (f/50)³）
 *   → 曝气电耗 → 对比「工作泵恒 50Hz 直吹」的朴素基线算节电率
 *   → 与实测溶解氧比对给「过曝 / 欠曝」判定。
 *
 * 全部是**纯函数**（零运行时依赖，只用 `PlantKpi` 的类型）：演示模型的价值在**自洽**，
 * 不在精确 —— 量级取 10 万 m³/d AAO 厂的常规口径，每一步假设写在注释里。
 *
 * 为什么是这一环：曝气占全厂电耗约一半，是污水厂"智能化"最核心的落点；而上游已经把
 * 需氧量 / 供气量算出来了，这里只是把它们变成可操作的鼓风调度，而不是另造一套曝气模型。
 */
import type { PlantKpi } from './process-model';

/** 鼓风机群（3 工作 + 1 备用，单机 ~15 万 m³/d、110kW —— 对齐 10 万 m³/d 厂的量级）。 */
export const BLOWER_FLEET = {
  /** 总台数 */
  count: 4,
  /** 常规投运台数（朴素基线按这个数恒 50Hz 算） */
  workingNormally: 3,
  /** 单台额定供气量 m³/d（标准状态） */
  ratedAir: 150000,
  /** 单台额定轴功率 kW */
  ratedPower: 110,
  /** 额定频率 Hz */
  ratedFreq: 50,
  /** 频率下限（低于此不再降频，转为停一台风机） */
  minFreq: 30,
} as const;

/** 单台鼓风机的运行状态。 */
export type BlowerState = {
  /** 位号 B1~B4 */
  id: string;
  /** 是否投运 */
  running: boolean;
  /** 运行频率 Hz（停用为 0） */
  frequency: number;
  /** 实时轴功率 kW（停用为 0） */
  power: number;
  /** 负载率 % = frequency / ratedFreq × 100 */
  loadPct: number;
};

/** 一套鼓风调度方案（给定设定值与当前需气量）。 */
export type AerationPlan = {
  /** 需氧量 kgO₂/d（来自 kpi.oxygenDemand） */
  oxygenDemand: number;
  /** 供气量 m³/d（来自 kpi.airDemand） */
  airDemand: number;
  /** 四台风机各自的运行状态 */
  blowers: BlowerState[];
  /** 投运台数 */
  runningCount: number;
  /** 优化后曝气轴功率 kW（投运台数 × 单台功率） */
  aerationPower: number;
  /** 朴素基线轴功率 kW（workingNormally 台恒 50Hz） */
  baselinePower: number;
  /** 优化后日曝气电耗 kWh/d */
  aerationEnergy: number;
  /** 基线日曝气电耗 kWh/d */
  baselineEnergy: number;
  /** 节电率 0~1（优化相对基线；超出风机能力时夹到 0） */
  savingPct: number;
  /** 溶解氧设定值 mg/L */
  targetDo: number;
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * 给定溶解氧设定值（仅用于回显与语义，风量由需气量决定）与当前需气量，求鼓风调度。
 *
 * 风量由 `kpi.airDemand` 决定（需氧量 → 供气量已经在 `process-model` 里算好），
 * 设定值不参与风量计算 —— 它影响的是"控制目标"，本函数只回答"按这个气量该怎么开风机最省"。
 * 真正的"设定值 → 风量"闭环留给控制环（见 `aerationControlState` 与页面的实测 DO 比对）。
 */
export function evaluateAeration(kpi: PlantKpi, targetDo: number): AerationPlan {
  const airDemand = kpi.airDemand;
  const oxygenDemand = kpi.oxygenDemand;
  const { count, workingNormally, ratedAir, ratedPower, ratedFreq, minFreq } = BLOWER_FLEET;

  // 投运台数：按气量把风机数整除上去；至少 1 台、至多全群。
  const requiredBlowers = clamp(Math.ceil(airDemand / ratedAir), 1, count);
  // 每台运行频率：把气量平摊到投运台数上，再换算到频率；低于下限就不再是降频、而是少开一台。
  const frequency = clamp((airDemand / (requiredBlowers * ratedAir)) * ratedFreq, minFreq, ratedFreq);
  // 亲和定律：轴功率 ∝ 频率³（转速比 = 频率比）。
  const powerPerRunning = ratedPower * (frequency / ratedFreq) ** 3;
  const aerationPower = requiredBlowers * powerPerRunning;
  // 朴素基线：常规工作台数恒额定频率直吹（最常见的"不优化"做法）。
  const baselinePower = workingNormally * ratedPower;

  const blowers: BlowerState[] = [];
  for (let index = 0; index < count; index += 1) {
    const running = index < requiredBlowers;
    blowers.push({
      id: `B${index + 1}`,
      running,
      frequency: running ? Math.round(frequency * 100) / 100 : 0,
      power: running ? Math.round(powerPerRunning * 100) / 100 : 0,
      loadPct: running ? Math.round((frequency / ratedFreq) * 1000) / 10 : 0,
    });
  }

  const aerationPowerRounded = Math.round(aerationPower * 100) / 100;
  const aerationEnergy = Math.round(aerationPowerRounded * 24);
  const baselineEnergy = baselinePower * 24;
  // 超出风机能力（4 台满载仍不够）时 aerationPower 可能 > baselinePower，节电夹到 0。
  const saving = baselinePower > 0 ? (baselinePower - aerationPower) / baselinePower : 0;

  return {
    oxygenDemand: Math.round(oxygenDemand),
    airDemand: Math.round(airDemand),
    blowers,
    runningCount: requiredBlowers,
    aerationPower: aerationPowerRounded,
    baselinePower,
    aerationEnergy,
    baselineEnergy,
    savingPct: Math.round(clamp(saving, 0, 1) * 10000) / 10000,
    targetDo,
  };
}

/** 控制判定结果。 */
export type AerationControlState = {
  /** over=过曝（风量过剩）/ under=欠曝（风量不足）/ normal=正常 */
  state: 'over' | 'under' | 'normal';
  /** 实测 − 设定，mg/L */
  deviation: number;
  /** 给运行员的提示文案 */
  message: string;
};

/**
 * 溶解氧控制判定：实测 DO 相对设定值的偏差落在带宽内为正常，超出则为过曝 / 欠曝。
 *
 * 这是一个**纯判定**（不依赖实时采样），页面把最新实测 DO 喂进来即可 —— 这样既能被单测钉死，
 * 也能在 e2e 里用确定性数值直接验证。
 */
export function aerationControlState(targetDo: number, currentDo: number, band = 0.3): AerationControlState {
  const deviation = Math.round((currentDo - targetDo) * 100) / 100;
  if (currentDo > targetDo + band) {
    return {
      state: 'over',
      deviation,
      message: `溶解氧偏高 ${deviation.toFixed(2)} mg/L：风量过剩，可下调频率或停开一台风机`,
    };
  }
  if (currentDo < targetDo - band) {
    return {
      state: 'under',
      deviation,
      message: `溶解氧偏低 ${Math.abs(deviation).toFixed(2)} mg/L：风量不足，需上调频率或增开风机`,
    };
  }
  return {
    state: 'normal',
    deviation,
    message: `溶解氧在设定值 ±${band} mg/L 内，曝气稳定`,
  };
}
