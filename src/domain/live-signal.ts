/**
 * 实时信号源 —— 模拟 SCADA / PLC 往控制台推的数据。
 *
 * 真实现场里这些是 4~20mA 变送器经 PLC 上来的点位；这里用**确定性随机游走 + 目标值回归**
 * 造出"像真的"信号：带惯性（不会瞬移）、有上下限、偶发尖峰（模拟工况扰动）。
 *
 * 关键约定：**同一个种子给出同一串数据**。现场数据是活的，但演示与端到端测试需要一个可复现的
 * 输入 —— 想看"跑起来"的样子就用定时器推，想断言就用 `seed` 复算一遍。
 */
import { DISCHARGE_LIMIT_1A, type QualityIndex } from './water-quality';

export type SignalSpec = {
  id: string;
  /** 位号（仪表编号，图纸上对得上） */
  tag: string;
  name: string;
  unit: string;
  /** 起始值 */
  base: number;
  /** 目标值（回归目标，会缓慢漂移） */
  target: number;
  /** 每步波动幅度（相对量级） */
  volatility: number;
  /** 回归强度：越大越贴目标 */
  drift: number;
  min: number;
  max: number;
  /** 小数位（显示用） */
  decimals: number;
  /** 尖峰概率（每次采样） */
  spikeChance: number;
  /** 尖峰幅度 */
  spikeSize: number;
  /** 告警阈值（上界）；超过判 alarm */
  alarmAbove?: number;
  /** 注意阈值（上界）；超过判 warning */
  warnAbove?: number;
  /** 告警阈值（下界，溶解氧这类"不能太低"的用它） */
  alarmBelow?: number;
  warnBelow?: number;
  /** 与出水指标挂钩时用来取一级 A 限值 */
  limitOf?: QualityIndex;
};

/**
 * 本厂联网的实时点位（按工艺位置排）。
 *
 * 阈值取自工艺常识：好氧池溶解氧低于 1.5 mg/L 硝化就吃紧、低于 1.0 基本就不硝化了；
 * 出水氨氮/COD 的阈值直接取一级 A 限值（`limitOf`）。
 */
export const LIVE_SIGNALS: SignalSpec[] = [
  {
    id: 'inflow',
    tag: 'FIT-101',
    name: '进水流量',
    unit: 'm³/h',
    base: 4166,
    target: 4166,
    volatility: 120,
    drift: 0.06,
    min: 2600,
    max: 6200,
    decimals: 0,
    spikeChance: 0.02,
    spikeSize: 900,
  },
  {
    id: 'do',
    tag: 'AIT-201',
    name: '好氧池溶解氧',
    unit: 'mg/L',
    base: 2.1,
    target: 2.0,
    volatility: 0.16,
    drift: 0.1,
    min: 0.2,
    max: 5.5,
    decimals: 2,
    spikeChance: 0.015,
    spikeSize: 1.1,
    warnBelow: 1.5,
    alarmBelow: 1.0,
  },
  {
    id: 'mlss',
    tag: 'AIT-202',
    name: '生物池污泥浓度',
    unit: 'g/L',
    base: 4.04,
    target: 4.0,
    volatility: 0.06,
    drift: 0.05,
    min: 2.0,
    max: 6.5,
    decimals: 2,
    spikeChance: 0.01,
    spikeSize: 0.7,
    warnAbove: 5.0,
  },
  {
    id: 'nh3n',
    tag: 'AIT-301',
    name: '出水氨氮',
    unit: 'mg/L',
    base: 3.5,
    target: 3.5,
    volatility: 0.35,
    drift: 0.08,
    min: 0.2,
    max: 9,
    decimals: 2,
    spikeChance: 0.02,
    spikeSize: 2.4,
    limitOf: 'NH3N',
  },
  {
    id: 'cod',
    tag: 'AIT-302',
    name: '出水 COD',
    unit: 'mg/L',
    base: 35.5,
    target: 35,
    volatility: 2.4,
    drift: 0.07,
    min: 12,
    max: 70,
    decimals: 1,
    spikeChance: 0.02,
    spikeSize: 14,
    limitOf: 'COD',
  },
  {
    id: 'blower',
    tag: 'VIB-401',
    name: '鼓风机振动',
    unit: 'mm/s',
    base: 2.4,
    target: 2.4,
    volatility: 0.25,
    drift: 0.12,
    min: 0.4,
    max: 9,
    decimals: 2,
    spikeChance: 0.01,
    spikeSize: 2.2,
    warnAbove: 4.5,
    alarmAbove: 7.1,
  },
];

/** 好氧池按廊道分成 6 个分区（热力图的行） */
export const AERATION_ZONES = ['A1 廊道', 'A2 廊道', 'A3 廊道', 'B1 廊道', 'B2 廊道', 'B3 廊道'];

export type SignalLevel = 'normal' | 'warning' | 'alarm';

export type SignalReading = {
  id: string;
  tag: string;
  name: string;
  unit: string;
  value: number;
  /** 显示用文本（按 decimals 定小数位） */
  text: string;
  level: SignalLevel;
  /** 偏离目标的比例（用于热力/颜色） */
  deviation: number;
};

/** 确定性伪随机（与 daily-profile 同一套口径，见那里的说明） */
export function createSignalRandom(seed: number): () => number {
  let state = (seed >>> 0) || 1;
  return function random(): number {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 1000000) / 1000000;
  };
}

/**
 * 推进一个信号。
 *
 * 口径：`next = value + (target - value) × drift + (random - 0.5) × volatility`，
 * 再按 min/max 夹取；命中尖峰概率时在结果上叠一个定向偏移（模拟扰动）。
 */
export function nextSignalValue(spec: SignalSpec, value: number, random: () => number): number {
  let next = value + (spec.target - value) * spec.drift + (random() - 0.5) * spec.volatility;
  if (random() < spec.spikeChance) {
    next += (random() < 0.5 ? -1 : 1) * spec.spikeSize;
  }
  return Math.max(spec.min, Math.min(spec.max, next));
}

/** 判定一个读数处于正常 / 注意 / 告警 */
export function judgeSignal(spec: SignalSpec, value: number): SignalLevel {
  const limit = spec.limitOf ? DISCHARGE_LIMIT_1A[spec.limitOf] : undefined;
  const warnAbove = spec.warnAbove !== undefined ? spec.warnAbove : limit;
  const alarmAbove = spec.limitOf ? DISCHARGE_LIMIT_1A[spec.limitOf] : spec.alarmAbove;
  if (alarmAbove !== undefined && value >= alarmAbove) return 'alarm';
  if (spec.alarmBelow !== undefined && value <= spec.alarmBelow) return 'alarm';
  if (warnAbove !== undefined && value >= warnAbove) return 'warning';
  if (spec.warnBelow !== undefined && value <= spec.warnBelow) return 'warning';
  return 'normal';
}

export function formatReading(spec: SignalSpec, value: number): string {
  return value.toFixed(spec.decimals);
}

/** 一次采样：所有点位各推一步，产出读数表 */
export function sampleSignals(
  signals: SignalSpec[],
  values: Record<string, number>,
  random: () => number
): { readings: SignalReading[]; values: Record<string, number> } {
  const nextValues: Record<string, number> = { ...values };
  const readings = signals.map((spec) => {
    const raw = nextValues[spec.id] === undefined ? spec.base : nextValues[spec.id];
    const value = nextSignalValue(spec, raw, random);
    nextValues[spec.id] = value;
    const level = judgeSignal(spec, value);
    return {
      id: spec.id,
      tag: spec.tag,
      name: spec.name,
      unit: spec.unit,
      value,
      text: formatReading(spec, value),
      level,
      deviation: spec.target ? (value - spec.target) / spec.target : 0,
    };
  });
  return { readings, values: nextValues };
}

export function initialSignalValues(signals: SignalSpec[] = LIVE_SIGNALS): Record<string, number> {
  const values: Record<string, number> = {};
  signals.forEach((spec) => {
    values[spec.id] = spec.base;
  });
  return values;
}

/**
 * 生化池分区溶解氧矩阵：**列 = 时间片（新的从右边进），行 = 廊道**。
 *
 * 工艺含义：沿水流方向（A1 → B3）溶解氧应当**逐段升高**（前面耗氧大、后面接近饱和），
 * 所以用"位置权重 + 噪声"生成；某一段突然掉下去，就是该段曝气头堵了或管道漏气。
 */
export function createZoneMatrix(columns: number, zones = AERATION_ZONES.length, seed = 7): number[][] {
  const random = createSignalRandom(seed);
  return Array.from({ length: columns }, (_, column) =>
    Array.from({ length: zones }, (_, row) => zoneBaseline(row, zones) + (random() - 0.5) * 0.5)
  );
}

/** 廊道基线溶解氧：沿程升高，A 段偏低 B 段偏高 */
export function zoneBaseline(row: number, zones = AERATION_ZONES.length): number {
  const ratio = zones > 1 ? row / (zones - 1) : 0;
  return 1.5 + ratio * 2.1;
}

/**
 * 左移一列（最左边丢掉，右边补一列新的）—— 热力图滚动的数据侧。
 *
 * 返回新矩阵，不改原对象（页面可以直接把它当"上一帧"对比）。
 */
export function rollZoneMatrix(matrix: number[][], random: () => number, zones = AERATION_ZONES.length): number[][] {
  const next = matrix.map((column) => column.slice());
  next.shift();
  next.push(Array.from({ length: zones }, (_, row) => zoneBaseline(row, zones) + (random() - 0.5) * 0.5));
  return next;
}

/** 热力图数据：`[时间片, 廊道, 值]` */
export function zoneMatrixData(matrix: number[][], zones = AERATION_ZONES): Array<[string, string, number]> {
  const out: Array<[string, string, number]> = [];
  matrix.forEach((column, columnIndex) => {
    column.forEach((value, row) => {
      out.push([`T${columnIndex + 1}`, zones[row], Number(value.toFixed(2))]);
    });
  });
  return out;
}

/** 实时看板的结论：几条点位里有几条越限 */
export function summarizeReadings(readings: SignalReading[]): {
  alarm: number;
  warning: number;
  worst: SignalReading | null;
  text: string;
} {
  const alarms = readings.filter((item) => item.level === 'alarm');
  const warnings = readings.filter((item) => item.level === 'warning');
  const worst = alarms[0] || warnings[0] || null;
  const text = alarms.length
    ? `${alarms.length} 点位越限：${alarms.map((item) => item.name).join('、')}`
    : warnings.length
    ? `${warnings.length} 点位需关注：${warnings.map((item) => item.name).join('、')}`
    : '全部点位在正常区间';
  return { alarm: alarms.length, warning: warnings.length, worst, text };
}
