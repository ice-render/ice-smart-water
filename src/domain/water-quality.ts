/**
 * 水质指标与排放限值 —— 水务业务的「词典」层。
 *
 * 限值依据 **GB 18918-2002《城镇污水处理厂污染物排放标准》一级 A 标准**，
 * 这是国内市政污水厂最常执行的出水限值。浓度单位统一 **mg/L**。
 *
 * 本文件是纯业务逻辑：不 import 任何 ICE 家族的东西，可以直接单测。
 */

/** 本应用关心的六项基本控制指标（一级 A 的常规项目） */
export type QualityIndex = 'COD' | 'BOD5' | 'SS' | 'NH3N' | 'TN' | 'TP';

export const QUALITY_INDEXES: QualityIndex[] = ['COD', 'BOD5', 'SS', 'NH3N', 'TN', 'TP'];

export const QUALITY_LABELS: Record<QualityIndex, string> = {
  COD: 'COD',
  BOD5: 'BOD₅',
  SS: 'SS',
  NH3N: '氨氮',
  TN: '总氮',
  TP: '总磷',
};

export type WaterQuality = Record<QualityIndex, number>;

/**
 * 一级 A 标准限值（mg/L）。
 *
 * 注：标准里氨氮括号内的 8 是水温 ≤12℃ 时的放宽值；本应用按常温 5 管控。
 * 括号内的 COD 60 是「工业废水占比高时」的过渡值（2008 年前建成的厂），
 * 新建厂按 50 执行 —— 本应用取 50。
 */
export const DISCHARGE_LIMIT_1A: WaterQuality = { COD: 50, BOD5: 10, SS: 10, NH3N: 5, TN: 15, TP: 0.5 };

/**
 * 典型市政污水进水水质（设计取值，mg/L）。
 *
 * 取值参考《室外排水设计标准》GB 50014 与常见市政污水厂的实测均值的中间段：
 * 这类污水属「中浓度」，BOD₅/COD ≈ 0.42，可生化性良好。
 */
export const TYPICAL_INFLUENT: WaterQuality = { COD: 380, BOD5: 160, SS: 200, NH3N: 35, TN: 45, TP: 4.5 };

export type QualityJudgement = {
  index: QualityIndex;
  label: string;
  /** 实测 / 计算值 */
  value: number;
  /** 标准限值 */
  limit: number;
  /** 裕度 =（限值 − 值）/ 限值。0.35 表示还剩 35% 余量；负数即超标 */
  margin: number;
  pass: boolean;
};

export type ComplianceReport = {
  items: QualityJudgement[];
  passed: number;
  total: number;
  /** 全部达标 */
  pass: boolean;
  exceeded: QualityIndex[];
  /** 最紧的一项（裕度最小），运行人员最该盯的指标 */
  tightest: QualityJudgement | null;
};

/** 保留两位小数：水务报表的通行精度（浓度 mg/L、流量 m³/d 都够用） */
export function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

/**
 * 达标判定：逐项比对限值，给出裕度与最紧项。
 *
 * 用「裕度」而不是简单的通过/不通过，是因为运行调度的真实问题是
 * 「哪一项快顶到限值了」—— 裕度最小的一项决定加药量与曝气量的调整方向。
 */
export function judgeQuality(quality: WaterQuality, limit: WaterQuality = DISCHARGE_LIMIT_1A): ComplianceReport {
  const items: QualityJudgement[] = QUALITY_INDEXES.map((index) => {
    const value = round2(Number(quality[index]) || 0);
    const cap = Number(limit[index]) || 0;
    const margin = cap > 0 ? (cap - value) / cap : 0;
    return { index, label: QUALITY_LABELS[index], value, limit: cap, margin, pass: value <= cap };
  });
  const exceeded = items.filter((item) => !item.pass).map((item) => item.index);
  const sorted = items.slice().sort((a, b) => a.margin - b.margin);
  return {
    items,
    passed: items.length - exceeded.length,
    total: items.length,
    pass: exceeded.length === 0,
    exceeded,
    tightest: sorted.length ? sorted[0] : null,
  };
}

/**
 * 按去除率折减：`出 = 进 ×（1 − 去除率）`。
 *
 * 这是工艺计算里最常用的一步近似 —— 只要拿得到单元去除率，就能顺着水流方向
 * 把水质从进水一路推到出水。未给出（或给 0）的指标原样带回。
 */
export function removedBy(quality: WaterQuality, removal: Partial<WaterQuality>): WaterQuality {
  const next = {} as WaterQuality;
  QUALITY_INDEXES.forEach((index) => {
    const rate = Math.min(0.999, Math.max(0, Number(removal[index]) || 0));
    next[index] = round2((Number(quality[index]) || 0) * (1 - rate));
  });
  return next;
}

/**
 * 整体缩放水质：雨季稀释（<1）、夜间高浓度（>1）这类**同比例波动**用它。
 *
 * 真实波动不是所有指标同比例，但对运行监视来说，同比例已经足以驱动曲线形状；
 * 逐指标的差异交给各单元的去除率去体现。
 */
export function scaledBy(quality: WaterQuality, factor: number): WaterQuality {
  const scale = Number.isFinite(factor) ? factor : 1;
  const next = {} as WaterQuality;
  QUALITY_INDEXES.forEach((index) => {
    next[index] = round2((Number(quality[index]) || 0) * scale);
  });
  return next;
}

/** 按「进水水质 → 沿程水质」算总去除率（%），报表里常要这一栏 */
export function removalRateOf(influent: WaterQuality, effluent: WaterQuality, index: QualityIndex): number {
  const inValue = Number(influent[index]) || 0;
  if (inValue <= 0) return 0;
  const outValue = Number(effluent[index]) || 0;
  return Math.round((1 - outValue / inValue) * 1000) / 10;
}

/** 一行文字形式的水质摘要（状态栏 / 日志用） */
export function formatQuality(quality: WaterQuality, indexes: QualityIndex[] = QUALITY_INDEXES): string {
  return indexes.map((index) => `${QUALITY_LABELS[index]} ${round2(quality[index])}`).join(' / ');
}
