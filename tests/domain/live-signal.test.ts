import {
  AERATION_ZONES,
  LIVE_SIGNALS,
  createSignalRandom,
  createZoneMatrix,
  initialSignalValues,
  judgeSignal,
  nextSignalValue,
  rollZoneMatrix,
  sampleSignals,
  summarizeReadings,
  zoneBaseline,
  zoneMatrixData,
} from '../../src/domain/live-signal';

describe('实时信号源', () => {
  it('点位表齐全，且每个点位的阈值区间自洽', () => {
    expect(LIVE_SIGNALS.length).toBeGreaterThanOrEqual(6);
    LIVE_SIGNALS.forEach((spec) => {
      expect(spec.tag.length).toBeGreaterThan(0);
      expect(spec.min).toBeLessThan(spec.max);
      expect(spec.base).toBeGreaterThanOrEqual(spec.min);
      expect(spec.base).toBeLessThanOrEqual(spec.max);
    });
    // 好氧池溶解氧必须带下界告警（工艺上它是硝化的命门）
    const oxygen = LIVE_SIGNALS.filter((spec) => spec.id === 'do')[0];
    expect(oxygen.warnBelow).toBe(1.5);
    expect(oxygen.alarmBelow).toBe(1);
  });

  it('确定性随机：同种子同序列，异种子不同序列', () => {
    const a = createSignalRandom(9);
    const b = createSignalRandom(9);
    const c = createSignalRandom(10);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect([a(), a(), a()]).not.toEqual([c(), c(), c()]);
  });

  it('信号推进：有惯性（不会一步跳到目标）、始终夹在上下限内', () => {
    const spec = LIVE_SIGNALS[0];
    const random = createSignalRandom(3);
    let value = spec.base;
    for (let index = 0; index < 200; index += 1) {
      const next = nextSignalValue(spec, value, random);
      expect(next).toBeGreaterThanOrEqual(spec.min);
      expect(next).toBeLessThanOrEqual(spec.max);
      expect(Math.abs(next - value)).toBeLessThan(spec.volatility + spec.spikeSize + Math.abs(spec.target - value));
      value = next;
    }
  });

  it('阈值判定：超限判 alarm / warning，溶解氧低了也算告警', () => {
    const oxygen = LIVE_SIGNALS.filter((spec) => spec.id === 'do')[0];
    expect(judgeSignal(oxygen, 2.4)).toBe('normal');
    expect(judgeSignal(oxygen, 1.4)).toBe('warning');
    expect(judgeSignal(oxygen, 0.8)).toBe('alarm');

    const ammonia = LIVE_SIGNALS.filter((spec) => spec.id === 'nh3n')[0];
    // 出水氨氮的上界直接取一级 A 限值 5 mg/L
    expect(judgeSignal(ammonia, 3.2)).toBe('normal');
    expect(judgeSignal(ammonia, 5.4)).toBe('alarm');
  });

  it('一次采样给出全部读数与汇总结论', () => {
    const random = createSignalRandom(11);
    const first = sampleSignals(LIVE_SIGNALS, initialSignalValues(), random);
    expect(first.readings.length).toBe(LIVE_SIGNALS.length);
    first.readings.forEach((reading) => {
      expect(reading.text.length).toBeGreaterThan(0);
      expect(['normal', 'warning', 'alarm']).toContain(reading.level);
    });
    const summary = summarizeReadings(first.readings);
    expect(summary.alarm + summary.warning).toBeLessThanOrEqual(LIVE_SIGNALS.length);
    expect(summary.text.length).toBeGreaterThan(0);

    // 同种子重放：结果完全一致
    const replay = sampleSignals(LIVE_SIGNALS, initialSignalValues(), createSignalRandom(11));
    expect(replay.readings).toEqual(first.readings);
  });

  it('小区热力图：廊道基线沿程升高，左移一列后列数不变、最右边是新数据', () => {
    expect(zoneBaseline(0)).toBeLessThan(zoneBaseline(AERATION_ZONES.length - 1));
    const matrix = createZoneMatrix(12, AERATION_ZONES.length, 5);
    expect(matrix.length).toBe(12);
    expect(matrix[0].length).toBe(AERATION_ZONES.length);

    const rolled = rollZoneMatrix(matrix, createSignalRandom(6), AERATION_ZONES.length);
    expect(rolled.length).toBe(12);
    // 最左一列被丢掉（原来的第 2 列顶上来）
    expect(rolled[0]).toEqual(matrix[1]);
    // 原矩阵没有被改（纯函数）
    expect(matrix.length).toBe(12);
    expect(rolled[11]).not.toEqual(matrix[11]);
  });

  it('热力图数据按 [时间片, 廊道, 值] 展开', () => {
    const matrix = createZoneMatrix(4, 3, 2);
    const data = zoneMatrixData(matrix, AERATION_ZONES);
    expect(data.length).toBe(12);
    expect(data[0][0]).toBe('T1');
    expect(data[0][1]).toBe(AERATION_ZONES[0]);
    expect(typeof data[0][2]).toBe('number');
  });
});
