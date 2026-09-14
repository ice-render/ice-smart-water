import {
  SYMBOL_CATALOG,
  SYMBOL_CATEGORIES,
  allSymbols,
  categoryStats,
  findNodeIdByTag,
  nextTag,
  symbolsOfCategory,
} from '../../src/domain/symbol-catalog';

/**
 * 与 ice-entity-designer 的符号预设（`WATER_SYMBOL_PRESETS`）的**奇偶校验**放在 e2e 里做
 * （那边有真实产物、能拿到域包的实际 kind 列表）；这里只保证**业务目录自身**的完整性 ——
 * 单测保持零运行时依赖，`npm test` 不依赖任何兄弟仓库的构建产物。
 */
const EXPECTED_KINDS = [
  'barScreen',
  'gritChamber',
  'primaryClarifier',
  'anaerobicTank',
  'anoxicTank',
  'aerobicTank',
  'secondaryClarifier',
  'coagulationTank',
  'filterBed',
  'disinfectionTank',
  'sludgeThickener',
  'dewateringMachine',
  'sludgeOut',
  'pump',
  'blower',
  'dosingUnit',
  'valve',
  'flowMeter',
  'analyzer',
  'inlet',
  'outlet',
  // 2026-09-14 上游（ice-entity-designer）补齐的 10 个图元
  'storageTank',
  'deodorizer',
  'sludgeSilo',
  'submersiblePump',
  'screwPump',
  'vfd',
  'motorValve',
  'checkValve',
  'levelGauge',
  'pressureGauge',
];

describe('符号业务目录', () => {
  it('覆盖给排水域包的全部 31 种符号', () => {
    expect(Object.keys(SYMBOL_CATALOG).sort()).toEqual(EXPECTED_KINDS.slice().sort());
    expect(allSymbols().length).toBe(31);
  });

  it('四个分类的计数加起来是 31，且与分类内符号数一致', () => {
    const stats = categoryStats();
    expect(stats.map((item) => item.id)).toEqual(SYMBOL_CATEGORIES.map((item) => item.id));
    expect(stats.reduce((total, item) => total + item.count, 0)).toBe(31);
    expect(symbolsOfCategory('water').length).toBe(12);
    expect(symbolsOfCategory('sludge').length).toBe(4);
    expect(symbolsOfCategory('equipment').length).toBe(13);
    expect(symbolsOfCategory('boundary').length).toBe(2);
  });

  it('每条目录都补齐了业务语义（作用 / 设计关注 / 巡检要点）', () => {
    allSymbols().forEach((entry) => {
      expect(entry.kind).toBeDefined();
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.tag.length).toBeGreaterThan(0);
      expect(entry.role.length).toBeGreaterThan(6);
      expect(entry.designFocus.length).toBeGreaterThan(0);
      expect(entry.checks.length).toBeGreaterThan(0);
      expect(entry.mediums.length).toBeGreaterThan(0);
    });
  });

  it('位号代号符合行业习惯（抽查几个关键代号）', () => {
    expect(SYMBOL_CATALOG.valve.tag).toBe('V');
    expect(SYMBOL_CATALOG.barScreen.tag).toBe('GR');
    expect(SYMBOL_CATALOG.analyzer.tag).toBe('AIT');
    expect(SYMBOL_CATALOG.flowMeter.tag).toBe('FIT');
    expect(SYMBOL_CATALOG.inlet.tag).toBe('IN');
    expect(SYMBOL_CATALOG.outlet.tag).toBe('OUT');
  });

  it('同一代号不分配给两种符号（位号规则不冲突）', () => {
    const seen = new Map<string, string>();
    allSymbols().forEach((entry) => {
      const conflict = seen.get(entry.tag);
      if (conflict) throw new Error(`代号 ${entry.tag} 被 ${conflict} 与 ${entry.kind} 同时占用`);
      seen.set(entry.tag, entry.kind);
    });
    expect(seen.size).toBe(31);
  });

  it('介质引用不出现空值（介质词典在 water_shapes 里，这里是引用方）', () => {
    allSymbols().forEach((entry) => {
      entry.mediums.forEach((medium) => expect(typeof medium).toBe('string'));
    });
  });
});

describe('位号规则', () => {
  it('首个位号用区域码 101', () => {
    expect(nextTag('barScreen', [])).toBe('GR-101');
    expect(nextTag('aerobicTank', [], 201)).toBe('AE-201');
  });

  it('按同代号顺延，不撞号', () => {
    expect(nextTag('barScreen', ['GR-101'])).toBe('GR-102');
    expect(nextTag('barScreen', ['GR-101', 'GR-103', 'AE-101'])).toBe('GR-104');
  });

  it('忽略不符合规则的位号（人工改过的位号不参与顺延）', () => {
    expect(nextTag('valve', ['V-101', '阀门A', 'V-'])).toBe('V-102');
  });

  it('按位号找单元 id', () => {
    const nodes = [
      { id: 'a', tag: 'GR-101' },
      { id: 'b', tag: 'AE-101' },
    ];
    expect(findNodeIdByTag(nodes, 'AE-101')).toBe('b');
    expect(findNodeIdByTag(nodes, 'NOPE')).toBeNull();
  });
});
