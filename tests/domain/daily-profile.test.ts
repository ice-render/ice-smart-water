import {
  DEFAULT_SIMULATION_SEED,
  HOURLY_FLOW_FACTORS,
  HOURS_PER_DAY,
  createRandom,
  hourLabel,
  hourQualityFactor,
  jitter,
} from '../../src/domain/daily-profile';

describe('日变化曲线', () => {
  it('24 个小时，均值恰为 1（否则日均水量对不上规模）', () => {
    expect(HOURLY_FLOW_FACTORS.length).toBe(HOURS_PER_DAY);
    const mean = HOURLY_FLOW_FACTORS.reduce((total, value) => total + value, 0) / HOURS_PER_DAY;
    expect(mean).toBeCloseTo(1, 3);
  });

  it('双峰：早晚各一个高峰，凌晨是低谷', () => {
    const morning = HOURLY_FLOW_FACTORS[8];
    const evening = HOURLY_FLOW_FACTORS[20];
    const night = HOURLY_FLOW_FACTORS[3];
    expect(morning).toBeGreaterThan(1.2);
    expect(evening).toBeGreaterThan(1.2);
    expect(night).toBeLessThan(0.7);
    expect(morning).toBeGreaterThan(night);
  });

  it('进水浓度与流量反相关：流量越低浓度越高', () => {
    expect(hourQualityFactor(0.6)).toBeGreaterThan(1);
    expect(hourQualityFactor(1.3)).toBeLessThan(1);
    expect(hourQualityFactor(1)).toBeCloseTo(1, 6);
    expect(hourQualityFactor(0.538)).toBeLessThan(1.12); // 幅度压在 ±10% 量级
  });

  it('小时标签补零', () => {
    expect(hourLabel(0)).toBe('00:00');
    expect(hourLabel(9)).toBe('09:00');
    expect(hourLabel(23)).toBe('23:00');
  });
});

describe('确定性随机数', () => {
  it('同种子同序列、异种子不同序列', () => {
    const a = createRandom(DEFAULT_SIMULATION_SEED);
    const b = createRandom(DEFAULT_SIMULATION_SEED);
    const c = createRandom(1);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    const seqC = [c(), c(), c(), c()];
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('取值落在 [0, 1)', () => {
    const random = createRandom(42);
    for (let index = 0; index < 200; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('抖动不越界', () => {
    const random = createRandom(7);
    for (let index = 0; index < 200; index += 1) {
      const value = jitter(random, 0.06);
      expect(value).toBeGreaterThanOrEqual(0.94);
      expect(value).toBeLessThanOrEqual(1.06);
    }
  });
});
