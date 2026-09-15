/**
 * 工况预案演练：**预案 → 预演 → 对比**。
 *
 * 复用现有模型，不另造一套：
 * - 预案绑定一个 `operating-modes` 的工况（雨季超越 / 检修停运 …）；
 * - 预演就是把预案的参数丢给 `sizing.evaluateScenario` 重算一遍（脱氮率 / 泥龄 / F/M / 需氧 / 电耗 / 达标）；
 * - 对比是"当前参数（`DEFAULT_SCENARIO`）vs 预案参数"逐指标算**达标度**。
 *
 * `切换耗时` 是**预案自己的属性**（调度要花多久），不是算出来的 —— 这点在 UI 上会写明，
 * 免得看起来像是模型输出。
 *
 * 单位口径：脱氮率 / F/M / 达标度为无量纲，泥龄 `d`、吨水电耗 `kWh/m³`、耗时 `min`。
 */
import { DEFAULT_SCENARIO, evaluateScenario, type ScenarioParams, type ScenarioResult } from './sizing';
import type { PlantMeta } from './plant-case';
import type { UnitDesign } from './plant-case';

/** 预案的验收口径：下限类（≥）与上限类（≤）各几条。 */
export type DrillTargets = {
  /** 脱氮率下限 */
  minRemoval: number;
  /** 泥龄下限 d */
  minSrt: number;
  /** F/M 上限 kgBOD₅/(kgMLSS·d) */
  maxFm: number;
  /** 吨水电耗上限 kWh/m³ */
  maxEnergy: number;
  /** 出水达标项数下限（共 6 项） */
  minPassed: number;
};

/** 全厂统一的验收口径（AAO + 一级 A 的工程惯例值） */
export const DEFAULT_TARGETS: DrillTargets = {
  minRemoval: 0.7,
  minSrt: 12,
  maxFm: 0.15,
  maxEnergy: 0.45,
  minPassed: 6,
};

export type DrillPlan = {
  id: string;
  name: string;
  /** 绑定 `operating-modes` 的工况 id（用于图上的阀门/停运口径） */
  modeId: string;
  description: string;
  /** 预案参数（喂给 `evaluateScenario`） */
  params: ScenarioParams;
  targets: DrillTargets;
  /** 切换耗时 min（**调度属性**，不是模型算出来的） */
  switchMinutes: number;
  /** 预演步骤（页面上按 `ICESteps` 展示） */
  steps: string[];
};

/** 四个预案：覆盖"水量冲击 / 停产 / 低温 / 负荷冲击"四类典型场景。 */
export const DRILL_PLANS: DrillPlan[] = [
  {
    id: 'rain',
    name: '雨季超越',
    modeId: 'rain',
    description: '开初沉池超越阀分流，进水量升到 1.35 倍、浓度被稀释',
    params: { ...DEFAULT_SCENARIO, loadFactor: 1.35, mlss: 3200 },
    targets: DEFAULT_TARGETS,
    switchMinutes: 20,
    steps: ['确认雨情与进水量趋势', '开初沉池超越阀、核对超越管流态', '提高内回流比保硝化泥龄', '盯二沉池表面负荷与出水 SS', '雨停后逐步恢复'],
  },
  {
    id: 'maintenance',
    name: '检修停运',
    modeId: 'maintenance',
    description: '一条生物池放空检修，处理量降到 0.7 倍、泥龄被迫压缩',
    params: { ...DEFAULT_SCENARIO, loadFactor: 0.7, mlss: 4000 },
    targets: DEFAULT_TARGETS,
    switchMinutes: 120,
    steps: ['提前把 MLSS 提到 4000 备泥', '关闭待检修池进水阀并放空', '剩余池提高曝气强度', '核算泥龄是否仍够硝化', '复役前逐步恢复进水'],
  },
  {
    id: 'winter',
    name: '低温硝化',
    modeId: 'normal',
    description: '水温降到 12℃，硝化菌活性下降，泥龄必须往上顶',
    params: { ...DEFAULT_SCENARIO, temperature: 12, mlss: 4500, internalRatio: 2.5 },
    targets: DEFAULT_TARGETS,
    switchMinutes: 0,
    steps: ['确认水温与氨氮趋势', '提高 MLSS 与内回流比', '校验泥龄是否满足低温硝化', '必要时投加外碳源', '回暖前保持高泥龄运行'],
  },
  {
    id: 'shock',
    name: '冲击负荷',
    modeId: 'normal',
    description: '进水负荷骤升到 1.5 倍，需氧量与二沉池负荷同时上抬',
    params: { ...DEFAULT_SCENARIO, loadFactor: 1.5, mlss: 4000, internalRatio: 2.5, returnRatio: 1.2 },
    targets: DEFAULT_TARGETS,
    switchMinutes: 30,
    steps: ['加大曝气、盯溶解氧不低于 2.0', '提高回流比控制二沉池泥位', '取样复测进水 COD / 氨氮', '必要时启用调节池削峰', '负荷回落后逐步回调'],
  },
];

export type DrillDeviation = {
  id: string;
  label: string;
  /** 实际值 */
  value: number;
  /** 目标值 */
  target: number;
  unit: string;
  /** 目标方向：min = 越大越好、max = 越小越好 */
  direction: 'min' | 'max';
  /** 是否达标 */
  ok: boolean;
  /** 达标度 %（100 = 正好在目标上，>100 = 优于目标） */
  score: number;
};

export type DrillRun = {
  plan: DrillPlan;
  /** 当前参数（基线） */
  before: ScenarioResult;
  /** 预案参数（预演） */
  after: ScenarioResult;
  deviations: DrillDeviation[];
  /** 达标条数 / 总条数 */
  passed: number;
  total: number;
  /** 相比基线：吨水电耗变化 % */
  energyDelta: number;
  /** 相比基线：脱氮率变化（绝对值） */
  removalDelta: number;
  warnings: string[];
};

export function makeDrillPlan(id: string): DrillPlan | null {
  return DRILL_PLANS.filter((plan) => plan.id === id)[0] || null;
}

/**
 * 预演：同一条工艺链，跑「基线参数」与「预案参数」两遍，再逐指标算偏差。
 * 不读时钟、不取随机 —— 同一个预案永远同一份结果（e2e 可复现）。
 */
export function runDrill(
  plan: DrillPlan,
  options: { meta?: PlantMeta; designs?: Record<string, UnitDesign> } = {}
): DrillRun {
  const before = evaluateScenario(DEFAULT_SCENARIO, options);
  const after = evaluateScenario(plan.params, options);
  const deviations = deviationsOf(after, plan.targets);
  const passedCount = deviations.filter((item) => item.ok).length;
  const beforeEnergy = Number(before.energyPerCubicMeter) || 0;
  return {
    plan,
    before,
    after,
    deviations,
    passed: passedCount,
    total: deviations.length,
    energyDelta: beforeEnergy > 0 ? round2(((Number(after.energyPerCubicMeter) || 0) - beforeEnergy) / beforeEnergy) : 0,
    removalDelta: round2((Number(after.removalRate) || 0) - (Number(before.removalRate) || 0)),
    warnings: after.warnings || [],
  };
}

/** 逐指标偏差：下限类比"够不够"，上限类比"超没超"。 */
export function deviationsOf(result: ScenarioResult, targets: DrillTargets): DrillDeviation[] {
  const passed = Number(result.compliance && result.compliance.passed) || 0;
  const rows: Array<{ id: string; label: string; value: number; target: number; unit: string; direction: 'min' | 'max' }> = [
    { id: 'removal', label: '脱氮率', value: round2(Number(result.removalRate) || 0), target: targets.minRemoval, unit: '', direction: 'min' },
    { id: 'srt', label: '污泥龄', value: round2(Number(result.srt) || 0), target: targets.minSrt, unit: 'd', direction: 'min' },
    { id: 'fm', label: '食微比 F/M', value: round3(Number(result.fm) || 0), target: targets.maxFm, unit: '', direction: 'max' },
    { id: 'energy', label: '吨水电耗', value: round2(Number(result.energyPerCubicMeter) || 0), target: targets.maxEnergy, unit: 'kWh/m³', direction: 'max' },
    { id: 'passed', label: '达标项数', value: passed, target: targets.minPassed, unit: '/6', direction: 'min' },
  ];
  return rows.map((row) => {
    const ok = row.direction === 'min' ? row.value >= row.target : row.value <= row.target;
    const score =
      row.direction === 'min'
        ? row.target > 0
          ? Math.round((row.value / row.target) * 100)
          : 100
        : row.value > 0
        ? Math.round((row.target / row.value) * 100)
        : 100;
    return { ...row, ok, score };
  });
}

/** 对比图数据：横轴 = 指标、两条柱 = 基线 / 预案（值 = 达标度 %）。 */
export function drillCompareData(run: DrillRun): { names: string[]; before: number[]; after: number[] } {
  const before = deviationsOf(run.before, run.plan.targets);
  return {
    names: run.deviations.map((item) => item.label),
    before: before.map((item) => item.score),
    after: run.deviations.map((item) => item.score),
  };
}

/** 表格行（列 key 与页面 `columns` 对齐） */
export function drillRows(run: DrillRun): Array<Record<string, string>> {
  return run.deviations.map((item) => ({
    id: item.id,
    label: item.label,
    value: `${item.value}${item.unit ? ' ' + item.unit : ''}`,
    target: `${item.direction === 'min' ? '≥' : '≤'} ${item.target}${item.unit ? ' ' + item.unit : ''}`,
    score: `${item.score}%`,
    status: item.ok ? '达标' : '不达标',
  }));
}

/** 页头统计用 */
export function drillKpi(run: DrillRun): {
  passed: number;
  total: number;
  passRate: number;
  energyDelta: number;
  removalDelta: number;
  switchMinutes: number;
} {
  return {
    passed: run.passed,
    total: run.total,
    passRate: run.total ? round2(run.passed / run.total) : 0,
    energyDelta: run.energyDelta,
    removalDelta: run.removalDelta,
    switchMinutes: run.plan.switchMinutes,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}
