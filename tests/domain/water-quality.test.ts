import {
  DISCHARGE_LIMIT_1A,
  QUALITY_INDEXES,
  TYPICAL_INFLUENT,
  formatQuality,
  judgeQuality,
  removalRateOf,
  removedBy,
  scaledBy,
  type WaterQuality,
} from '../../src/domain/water-quality';

describe('水质词典与达标判定', () => {
  it('一级 A 限值取标准值，六项指标齐全', () => {
    expect(DISCHARGE_LIMIT_1A).toEqual({ COD: 50, BOD5: 10, SS: 10, NH3N: 5, TN: 15, TP: 0.5 });
    expect(Object.keys(TYPICAL_INFLUENT).sort()).toEqual(QUALITY_INDEXES.slice().sort());
  });

  it('全部低于限值 → 达标，且给出裕度最小的那一项', () => {
    const effluent: WaterQuality = { COD: 30, BOD5: 6, SS: 6, NH3N: 2, TN: 12, TP: 0.45 };
    const report = judgeQuality(effluent);
    expect(report.pass).toBe(true);
    expect(report.passed).toBe(6);
    expect(report.exceeded).toEqual([]);
    // TP 0.45 / 限值 0.5 → 裕度 10%，是六项里最紧的
    expect(report.tightest?.index).toBe('TP');
    expect(report.tightest?.margin).toBeCloseTo(0.1, 4);
  });

  it('任一项超标即整体不达标，并列出超标项', () => {
    const effluent: WaterQuality = { COD: 30, BOD5: 6, SS: 6, NH3N: 7.2, TN: 12, TP: 0.45 };
    const report = judgeQuality(effluent);
    expect(report.pass).toBe(false);
    expect(report.exceeded).toEqual(['NH3N']);
    expect(report.passed).toBe(5);
  });

  it('按去除率折减：出 = 进 ×(1 − 去除率)，未给出的指标原样带回', () => {
    const next = removedBy({ COD: 100, BOD5: 100, SS: 100, NH3N: 100, TN: 100, TP: 100 }, { COD: 0.5, SS: 0.2 });
    expect(next.COD).toBe(50);
    expect(next.SS).toBe(80);
    expect(next.BOD5).toBe(100);
  });

  it('去除率被钳制在 [0, 1)，不会出现负值或翻倍', () => {
    const next = removedBy({ COD: 100, BOD5: 100, SS: 100, NH3N: 100, TN: 100, TP: 100 }, { COD: 1.5, SS: -1 });
    expect(next.COD).toBeGreaterThanOrEqual(0);
    expect(next.SS).toBe(100);
  });

  it('整体缩放用于雨季稀释，比例一致', () => {
    const diluted = scaledBy({ COD: 400, BOD5: 200, SS: 100, NH3N: 40, TN: 50, TP: 4 }, 0.5);
    expect(diluted).toEqual({ COD: 200, BOD5: 100, SS: 50, NH3N: 20, TN: 25, TP: 2 });
  });

  it('总去除率与摘要格式', () => {
    expect(removalRateOf(TYPICAL_INFLUENT, { ...TYPICAL_INFLUENT, COD: 38 }, 'COD')).toBe(90);
    expect(formatQuality({ COD: 12.345, BOD5: 2, SS: 3, NH3N: 4, TN: 5, TP: 6 }, ['COD', 'TP'])).toBe('COD 12.35 / 总磷 6');
  });
});
