/**
 * 日变化曲线：市政污水厂「一天里水量水质怎么变」这件事的业务数据。
 *
 * 水量呈**双峰**（早 7–9 点、晚 19–21 点），夜间最低；进水浓度与水量大致反相关
 * （夜间流量小、管网停留时间长，浓度反而偏高）。
 *
 * 曲线是**确定性**的：同样的种子永远给同一串数据 —— 运行看板每次刷新不会跳来跳去，
 * 端到端测试也才能断言具体数值。
 */

/** 逐小时水量日变化系数（未归一化的形状，早高峰 8 点、晚高峰 20 点） */
const RAW_HOURLY_FACTORS: number[] = [
  0.7, 0.62, 0.58, 0.56, 0.58, 0.68, 0.82, 1.16, 1.34, 1.3, 1.22, 1.14, 1.2, 1.16, 1.1, 1.0, 1.02, 1.1, 1.2, 1.3, 1.34,
  1.18, 1.0, 0.8,
];

/**
 * 归一化后的日变化系数：**均值恰为 1.0**。
 *
 * 必须归一化：日均水量 = 设计规模 × 工况系数，逐小时系数只有均值为 1，
 * 24 小时累加出来的日水量才对得上日均值。手写一组"差不多"的数字很容易差 3%，报表就露馅了。
 */
export const HOURLY_FLOW_FACTORS: number[] = (() => {
  const mean = RAW_HOURLY_FACTORS.reduce((total, value) => total + value, 0) / RAW_HOURLY_FACTORS.length;
  return RAW_HOURLY_FACTORS.map((value) => Math.round((value / mean) * 1000) / 1000);
})();

export const HOURS_PER_DAY = 24;

/**
 * 夜间进水浓度抬高系数。
 *
 * 经验规律：流量越小，污水在管网里停留越久、越接近厌氧水解，进厂浓度越高。
 * 这里用一条线性近似把「水量低 → 浓度高」表达出来，幅度压在 ±10% 以内。
 */
export function hourQualityFactor(hourlyFlowFactor: number): number {
  const delta = (1 - hourlyFlowFactor) * 0.2;
  return Math.round((1 + delta) * 1000) / 1000;
}

export function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * 确定性伪随机数（mulberry32）。
 *
 * 用自研 PRNG 而不是 `Math.random()`：只要种子一样，曲线就一样 ——
 * 截图对比、e2e 断言、复盘同一个工况才有共同的基准。
 */
export function createRandom(seed: number): () => number {
  let state = (Number(seed) || 1) >>> 0;
  return function random(): number {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 围绕 1 抖动：`1 ± amplitude`（amplitude 取 0.05 就是 ±5%） */
export function jitter(random: () => number, amplitude: number): number {
  return 1 + (random() * 2 - 1) * amplitude;
}

export const DEFAULT_SIMULATION_SEED = 20260914;
