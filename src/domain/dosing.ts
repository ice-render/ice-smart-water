/**
 * 加药优化（厂级）。
 *
 * 把 `process-model` 已经算到的进/出水水量与水质，喂成**三种药剂**的"优化投加 vs 朴素恒定过量基线"
 * 的对比，给出**节药率** —— 与「精确曝气」的节电率同口径，是污水厂除曝气外第二大可变成本。
 *
 * 三种药剂（量级取 10 万 m³/d AAO 厂的常规口径，演示模型的价值在**自洽**不在精确；每一条假设写在注释里）：
 *
 * 1. **除磷剂（PAC）**：化学除磷，按实际 TP 去除负荷算投加量（金属盐沉淀 P，含电荷中和 / 助凝余量）。
 * 2. **外加碳源（乙酸钠）**：只在进水碳源不足（BOD₅/N < 4）时补投，按反硝化 COD 缺口算。
 * 3. **消毒剂（次氯酸钠）**：按出水流量与余氯需求算。
 *
 * 优化 vs 基线：基线是"不优化、按设计最大值恒投"；优化是"按实际负荷算 + 投加安全系数余量"。
 * 典型日优化 < 基线（节药率为正），高负荷日优化逼近 / 超过基线（节药率夹到 0）。
 *
 * 全部是**纯函数**（零运行时依赖，只用 `PlantKpi` / `PlantMeta` 的类型）；`DISCHARGE_LIMIT_1A`
 * 取自同层 `water-quality`（同包，非兄弟包，可引运行时常量）。
 */
import type { PlantKpi } from './process-model';
import type { PlantMeta } from './plant-case';
import { DISCHARGE_LIMIT_1A } from './water-quality';

/** 除磷剂（PAC）朴素基线投加率 mg/L（不优化时按设计最大值恒定过量投加）。 */
export const COAGULANT_BASELINE_RATE = 45;
/** 除磷剂投加系数：kg PAC / kg P 去除（含电荷中和与助凝余量，经验值）。 */
export const P_COEF = 8;

/** 外加碳源（乙酸钠）朴素基线投加率 mg/L。 */
export const CARBON_BASELINE_RATE = 25;
/** 反硝化所需 BOD₅/N（碳源不足判据：进水 BOD₅/N < 此值即需补碳）。 */
export const BOD_N_FLOOR = 4;
/** 进水 BOD₅ 中可生物降解比例（用于反硝化的有效碳源）。 */
export const BIODEGRADABLE = 0.7;
/** 乙酸钠折算系数：kg 乙酸钠 / kg COD 缺口（乙酸钠 COD 约 0.78 g COD/g，留余量取 1.3）。 */
export const ACETATE_FACTOR = 1.3;

/** 消毒剂（次氯酸钠）朴素基线投加率 mg/L。 */
export const DISINFECT_BASELINE_RATE = 8;
/** 消毒剂优化投加率 mg/L（余氯需求 + 接触池耗量）。 */
export const DISINFECT_RATE = 5;

/** 三种药剂单价 元/kg（市场量级，演示取值）。 */
export const CHEMICAL_PRICES = {
  coagulant: 1.2,
  carbon: 2.5,
  disinfection: 1.0,
} as const;

/** 药剂主键。 */
export type ChemicalKey = 'coagulant' | 'carbon' | 'disinfection';

/** 单一药剂的投加方案（优化 vs 基线）。 */
export type ChemicalDose = {
  /** 主键 */
  key: ChemicalKey;
  /** 短名（作图表轴标签） */
  name: string;
  /** 优化投加量 kg/d */
  optimizedMass: number;
  /** 朴素基线投加量 kg/d */
  baselineMass: number;
  /** 优化日成本 元/d */
  optimizedCost: number;
  /** 基线日成本 元/d */
  baselineCost: number;
  /** 该药剂节药率 0~1（优化相对基线；优化超过基线时夹到 0） */
  savingPct: number;
  /** 单价 元/kg */
  price: number;
};

/** 一套加药优化方案（给定水量、水质与投加安全系数）。 */
export type DosingPlan = {
  /** 三种药剂各自的投加方案 */
  chemicals: ChemicalDose[];
  /** 进水流量 m³/d */
  inflow: number;
  /** 优化总投加量 kg/d */
  totalOptimizedMass: number;
  /** 基线总投加量 kg/d */
  totalBaselineMass: number;
  /** 优化总日成本 元/d */
  totalOptimizedCost: number;
  /** 基线总日成本 元/d */
  totalBaselineCost: number;
  /** 整体节药率 0~1 */
  savingPct: number;
  /** 投加安全系数（≥1，乘以优化投加量作为操作余量） */
  safetyFactor: number;
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function chemicalDose(key: ChemicalKey, name: string, optimizedMass: number, baselineMass: number): ChemicalDose {
  const price = CHEMICAL_PRICES[key];
  const optimizedCost = round2(optimizedMass * price);
  const baselineCost = round2(baselineMass * price);
  const saving = baselineMass > 0 ? (baselineMass - optimizedMass) / baselineMass : 0;
  return {
    key,
    name,
    optimizedMass: round2(optimizedMass),
    baselineMass: round2(baselineMass),
    optimizedCost,
    baselineCost,
    savingPct: Math.round(clamp(saving, 0, 1) * 10000) / 10000,
    price,
  };
}

/**
 * 给定水量、水质与投加安全系数，求三种药剂的优化投加方案。
 *
 * 目标出水限值取一级 A（`DISCHARGE_LIMIT_1A`），与 `computeKpi` 的默认达标口径一致。
 * 投加安全系数 `safetyFactor` 乘以"优化投加量"作为操作余量（越大越稳健、越费药）；
 * 朴素基线不受其影响（它本身就是恒定过量投加）。
 */
export function evaluateDosing(kpi: PlantKpi, meta: PlantMeta, safetyFactor: number): DosingPlan {
  const inflow = kpi.inflow;
  const targetTP = DISCHARGE_LIMIT_1A.TP;
  const targetTN = DISCHARGE_LIMIT_1A.TN;
  const influTP = meta.influent.TP;
  const influTN = meta.influent.TN;
  const influBOD = meta.influent.BOD5;
  const sf = Math.max(1, safetyFactor);

  /* 1) 除磷剂（PAC）：按实际 TP 去除负荷算投加 */
  const pRemoved = Math.max(0, (inflow * (influTP - targetTP)) / 1000); // kg P/d
  const coagulantOpt = pRemoved * P_COEF * sf;
  const coagulantBase = (inflow * COAGULANT_BASELINE_RATE) / 1000;
  const coagulant = chemicalDose('coagulant', '除磷剂', coagulantOpt, coagulantBase);

  /* 2) 外加碳源（乙酸钠）：只在进水碳源不足时按反硝化 COD 缺口补投 */
  const nRemoved = Math.max(0, (inflow * (influTN - targetTN)) / 1000); // kg N/d
  const requiredCOD = nRemoved * BOD_N_FLOOR; // 反硝化所需可生物降解 COD
  const availableCOD = (inflow * influBOD * BIODEGRADABLE) / 1000; // 进水可生物降解 COD
  const deficitCOD = Math.max(0, requiredCOD - availableCOD); // COD 缺口
  const carbonOpt = deficitCOD * ACETATE_FACTOR * sf;
  const carbonBase = (inflow * CARBON_BASELINE_RATE) / 1000;
  const carbon = chemicalDose('carbon', '碳源', carbonOpt, carbonBase);

  /* 3) 消毒剂（次氯酸钠）：按出水流量与余氯需求算 */
  const disinfectOpt = ((inflow * DISINFECT_RATE) / 1000) * sf;
  const disinfectBase = (inflow * DISINFECT_BASELINE_RATE) / 1000;
  const disinfection = chemicalDose('disinfection', '消毒剂', disinfectOpt, disinfectBase);

  const chemicals = [coagulant, carbon, disinfection];
  const totalOptimizedMass = round2(chemicals.reduce((sum, item) => sum + item.optimizedMass, 0));
  const totalBaselineMass = round2(chemicals.reduce((sum, item) => sum + item.baselineMass, 0));
  const totalOptimizedCost = round2(chemicals.reduce((sum, item) => sum + item.optimizedCost, 0));
  const totalBaselineCost = round2(chemicals.reduce((sum, item) => sum + item.baselineCost, 0));
  const saving = totalBaselineCost > 0 ? (totalBaselineCost - totalOptimizedCost) / totalBaselineCost : 0;

  return {
    chemicals,
    inflow: round2(inflow),
    totalOptimizedMass,
    totalBaselineMass,
    totalOptimizedCost,
    totalBaselineCost,
    savingPct: Math.round(clamp(saving, 0, 1) * 10000) / 10000,
    safetyFactor: round2(sf),
  };
}
