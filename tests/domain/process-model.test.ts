import { SEWAGE_PLANT, designMap, toPlantGraph } from '../../src/domain/plant-case';
import { applyModeToGraph, modeById } from '../../src/domain/operating-modes';
import {
  chainHydraulics,
  computeHydraulics,
  computeKpi,
  evaluateQualityChain,
  flowOfNode,
  simulateDay,
} from '../../src/domain/process-model';
import { TYPICAL_INFLUENT } from '../../src/domain/water-quality';

const graph = toPlantGraph(SEWAGE_PLANT);
const designs = designMap(SEWAGE_PLANT);
const meta = SEWAGE_PLANT.meta;

describe('水量平衡', () => {
  const hydraulics = computeHydraulics(graph, designs, meta, meta.capacity, 974);
  const byId = (id: string) => hydraulics.filter((unit) => unit.id === id)[0];

  it('AAO 分段流量：预处理走 Q，厌氧池加回流污泥，缺氧/好氧加内回流，二沉池不含内回流', () => {
    expect(byId('primary').flow).toBe(100000);
    expect(byId('ana').flow).toBe(200000); // Q(1+R) = 100000×2
    expect(byId('anx').flow).toBe(400000); // Q(1+R+r) = 100000×4
    expect(byId('aer').flow).toBe(400000);
    expect(byId('sec').flow).toBe(200000); // 内回流是生物池内部循环，不进二沉池
    expect(byId('coag').flow).toBe(100000);
  });

  it('阀门按开 / 闭过水，辅助设备不过水', () => {
    const openValve = { id: 'outletValve', kind: 'valve' as const, name: '出水阀', tag: 'V-101' };
    expect(flowOfNode({ ...openValve, valveState: 'open' }, meta, 100000, 900)).toBe(100000);
    expect(flowOfNode({ ...openValve, valveState: 'closed' }, meta, 100000, 900)).toBe(0);
    expect(byId('blower').flow).toBe(0);
    expect(byId('dosing').flow).toBe(0);
    // 二沉池底流走泥线流量
    expect(byId('thickener').flow).toBe(974);
  });

  it('停留时间与表面负荷', () => {
    expect(byId('aer').hrt).toBeCloseTo(1.25, 2); // 20800 / 400000 × 24
    expect(byId('sec').hrt).toBeCloseTo(1.76, 2); // 14700 / 200000 × 24
    expect(byId('sec').surfaceLoad).toBeCloseTo(1.98, 2); // 200000 / 24 / 4200
    expect(byId('disinfect').hrt).toBeCloseTo(0.58, 2); // 2400 / 100000 × 24
    expect(byId('filter').surfaceLoad).toBeCloseTo(6.94, 2); // 滤速 m/h
  });
});

describe('沿程水质推演', () => {
  it('从进水逐单元折减，出水在一级 A 以内', () => {
    const chain = evaluateQualityChain(graph, meta, TYPICAL_INFLUENT);
    expect(chain.connected).toBe(true);
    expect(chain.stages.length).toBe(17); // 主流程 16 个单元 + 新增的出水止回阀
    expect(chain.stages[0].id).toBe('inlet');
    // 初沉池去除 30% BOD₅ / COD、55% SS
    const afterPrimary = chain.stages.filter((stage) => stage.id === 'primary')[0];
    expect(afterPrimary.quality.BOD5).toBeCloseTo(112, 2);
    // 200 ×0.95（格栅）×0.97（沉砂池）×0.45（初沉池 55%）≈ 82.94
    expect(afterPrimary.quality.SS).toBeCloseTo(82.94, 2);
    // 好氧池脱氮硝化：氨氮降到 10% 以下
    const afterAer = chain.stages.filter((stage) => stage.id === 'aer')[0];
    expect(afterAer.quality.NH3N).toBeCloseTo(3.5, 2);
    expect(chain.compliance.pass).toBe(true);
    expect(chain.effluent.TP).toBeLessThanOrEqual(0.5);
  });

  it('缺了某个单元，出水水质立刻不同（图就是数据源）', () => {
    const withoutFilter = {
      nodes: graph.nodes.filter((node) => node.id !== 'filter'),
      pipes: graph.pipes.filter((pipe) => pipe.sourceId !== 'filter' && pipe.targetId !== 'filter'),
    };
    const bypassed = {
      nodes: graph.nodes,
      pipes: graph.pipes
        .filter((pipe) => pipe.id !== 'pipe-coag-filter' && pipe.id !== 'pipe-filter-disinfect')
        .concat([{ id: 'pipe-coag-disinfect', sourceId: 'coag', targetId: 'disinfect', medium: 'effluent' as const, dn: 'DN500' }]),
    };
    const full = evaluateQualityChain(graph, meta, TYPICAL_INFLUENT);
    const reduced = evaluateQualityChain(bypassed, meta, TYPICAL_INFLUENT);
    expect(withoutFilter.nodes.length).toBe(graph.nodes.length - 1);
    expect(reduced.stages.map((stage) => stage.id)).not.toContain('filter');
    expect(reduced.effluent.SS).toBeGreaterThan(full.effluent.SS);
  });

  it('断流时连接标记为 false', () => {
    const closed = applyModeToGraph(graph, modeById('maintenance'));
    const chain = evaluateQualityChain(closed, meta, TYPICAL_INFLUENT);
    expect(chain.connected).toBe(false);
    expect(chain.blockedAt).toBe('outletValve');
  });
});

describe('全厂 KPI', () => {
  const kpi = computeKpi(graph, designs, meta);

  it('设计工况下污泥平衡落在常规区间', () => {
    expect(kpi.sludge.mlss).toBeGreaterThan(3500);
    expect(kpi.sludge.mlss).toBeLessThan(4500);
    expect(kpi.sludge.srt).toBeGreaterThan(12);
    expect(kpi.sludge.srt).toBeLessThan(25);
    expect(kpi.sludge.fm).toBeGreaterThan(0.05);
    expect(kpi.sludge.fm).toBeLessThan(0.15);
    expect(kpi.sludge.totalHrt).toBeCloseTo(8.11, 1); // 33800 / 100000 × 24
  });

  it('剩余污泥量与干泥产量自洽（WQ × Xr = 干泥量）', () => {
    expect(kpi.sludge.drySludge).toBeGreaterThan(6);
    expect(kpi.sludge.drySludge).toBeLessThan(9);
    expect(kpi.sludge.wasteSludgeFlow * (meta.returnSludgeConcentration / 1000)).toBeCloseTo(
      kpi.sludge.drySludge * 1000,
      -1
    );
  });

  it('能耗：吨水电耗落在市政厂常规区间，且运行时功率不含停运单元', () => {
    expect(kpi.powerInstalled).toBeGreaterThanOrEqual(kpi.powerRunning); // 无停运单元时两者相等
    expect(kpi.energyPerCubicMeter).toBeGreaterThan(0.2);
    expect(kpi.energyPerCubicMeter).toBeLessThan(0.35);
    const maintenance = computeKpi(
      applyModeToGraph(graph, modeById('maintenance')),
      designs,
      meta
    );
    expect(maintenance.powerRunning).toBeCloseTo(kpi.powerRunning - 90, 1); // 脱水机 90kW 停运
  });

  it('需氧量含硝化项（10 万 m³/d 的 AAO 量级在 2~4 万 kgO₂/d）', () => {
    expect(kpi.oxygenDemand).toBeGreaterThan(20000);
    expect(kpi.oxygenDemand).toBeLessThan(40000);
    expect(kpi.airDemand).toBeGreaterThan(kpi.oxygenDemand * 10);
  });

  it('雨季工况：水量上升、负荷率上升、水质被稀释', () => {
    const rain = computeKpi(applyModeToGraph(graph, modeById('rain')), designs, meta, {
      inflow: meta.capacity * modeById('rain').inflowFactor,
      influent: { ...TYPICAL_INFLUENT, COD: TYPICAL_INFLUENT.COD * 0.8 },
    });
    expect(rain.inflow).toBeCloseTo(135000, 0);
    expect(rain.utilization).toBeCloseTo(135, 0);
    expect(rain.effluent.COD).toBeLessThan(kpi.effluent.COD);
    expect(rain.compliance.pass).toBe(true);
  });
});

describe('一天 24 小时模拟', () => {
  const mode = modeById('normal');
  const points = simulateDay(applyModeToGraph(graph, mode), designs, meta, mode);

  it('产出 24 个点，小时标签连续', () => {
    expect(points.length).toBe(24);
    expect(points[0].label).toBe('00:00');
    expect(points[23].label).toBe('23:00');
  });

  it('同种子结果完全一致（确定性，便于截图与断言）', () => {
    const again = simulateDay(applyModeToGraph(graph, mode), designs, meta, mode);
    expect(again).toEqual(points);
    const otherSeed = simulateDay(applyModeToGraph(graph, mode), designs, meta, mode, { seed: 7 });
    expect(otherSeed).not.toEqual(points);
  });

  it('日变化系数均值为 1（日均水量对得上设计规模）', () => {
    const mean = points.reduce((total, point) => total + point.hourlyFactor, 0) / points.length;
    expect(mean).toBeCloseTo(1, 2);
    // 8 点早高峰、凌晨 3 点低谷
    expect(points[8].inflow).toBeGreaterThan(points[3].inflow);
    expect(points[8].hourlyFactor).toBeGreaterThan(1);
    expect(points[3].hourlyFactor).toBeLessThan(1);
  });

  it('每小时都给出出水水质、能耗与达标项数', () => {
    points.forEach((point) => {
      expect(point.cod).toBeGreaterThan(0);
      expect(point.energy).toBeGreaterThan(0);
      expect(point.passed).toBeGreaterThanOrEqual(0);
      expect(point.passed).toBeLessThanOrEqual(6);
    });
    expect(points.every((point) => point.passed === 6)).toBe(true);
  });

  it('沿程水量表按水流顺序输出', () => {
    const hydraulics = computeHydraulics(graph, designs, meta, meta.capacity, kpiWaste());
    const chain = chainHydraulics(graph, hydraulics);
    expect(chain[0].id).toBe('inlet');
    expect(chain[chain.length - 1].id).toBe('outlet');
    expect(chain.map((unit) => unit.id)).toContain('sec');
  });

  function kpiWaste(): number {
    return computeKpi(graph, designs, meta).sludge.wasteSludgeFlow;
  }
});
