/**
 * 污泥产运联单：沿流程折算 + 联单状态机。
 *
 * 盯两条口径：① **干泥量沿流程恒定**（质量守恒，湿泥量随含水率收缩）；② 联单推进是**纯函数**。
 */
import { SEWAGE_PLANT } from '../../src/domain/plant-case';
import { computeKpi } from '../../src/domain/process-model';
import { designMap } from '../../src/domain/plant-case';
import { toPlantGraph } from '../../src/domain/plant-case';
import {
  CAKE_WATER_RATE_MAX,
  DISPOSAL_UNIT_PRICE,
  MANIFEST_STATUS_LABELS,
  MANIFEST_STATUS_ORDER,
  PAM_UNIT,
  TRUCK_LOAD_WET_T,
  advanceManifest,
  buildManifests,
  manifestRows,
  sludgeKpi,
  sludgeStages,
  summarizeManifests,
} from '../../src/domain/sludge-manifest';

const kpiOf = () => computeKpi(toPlantGraph(), designMap(), SEWAGE_PLANT.meta);
const sludge = () => kpiOf().sludge;

describe('污泥沿流程折算（干泥守恒、湿泥收缩）', () => {
  it('三个环节的干泥量完全相同（质量守恒）', () => {
    const stages = sludgeStages(sludge());
    expect(stages).toHaveLength(3);
    const dry = stages.map((stage) => stage.dryFlow);
    expect(dry[0]).toBeCloseTo(dry[1], 6);
    expect(dry[1]).toBeCloseTo(dry[2], 6);
  });

  it('湿泥量随含水率下降而单调收缩，且首段等于剩余污泥量', () => {
    const balance = sludge();
    const stages = sludgeStages(balance);
    expect(stages[0].wetFlow).toBeGreaterThan(stages[1].wetFlow);
    expect(stages[1].wetFlow).toBeGreaterThan(stages[2].wetFlow);
    // 首段（含水率 99.2%）就是 process-model 算出来的剩余污泥体积流量
    // （两者各自取整，实测差 0.25 m³/d，所以容差放到 0.5）
    expect(Math.abs(stages[0].wetFlow - balance.wasteSludgeFlow)).toBeLessThan(0.5);
    // 末段含水率 = 泥饼上限
    expect(stages[2].waterRate).toBe(CAKE_WATER_RATE_MAX);
  });

  it('湿泥量 = 干泥 / (1 - 含水率)', () => {
    const stages = sludgeStages(sludge());
    stages.forEach((stage) => {
      expect(stage.wetFlow).toBeCloseTo(stage.dryFlow / (1 - stage.waterRate), 1);
    });
  });
});

describe('污泥 KPI', () => {
  it('车次 = ceil(泥饼量 / 单车载重)，成本 = 干泥 × 单价，PAM = 干泥 × 单耗', () => {
    const kpi = sludgeKpi(sludge());
    expect(kpi.trucks).toBe(Math.max(1, Math.ceil(kpi.cakeVolume / TRUCK_LOAD_WET_T)));
    expect(kpi.cost).toBe(Math.round(kpi.drySludge * DISPOSAL_UNIT_PRICE));
    expect(kpi.pamDaily).toBeCloseTo(kpi.drySludge * PAM_UNIT, 1);
    expect(kpi.unitPrice).toBe(DISPOSAL_UNIT_PRICE);
  });

  it('联单闭合率来自联单本身', () => {
    const manifests = buildManifests(sludge());
    const kpi = sludgeKpi(sludge(), manifests);
    expect(kpi.total).toBe(manifests.length);
    expect(kpi.closed).toBe(manifests.filter((item) => item.status === 'closed').length);
    expect(kpi.closureRate).toBeCloseTo(kpi.closed / kpi.total, 3);
  });
});

describe('联单生成（确定性）与状态机', () => {
  it('同种子同结果；张数等于当日车次（有上限）', () => {
    const kpi = sludgeKpi(sludge());
    const a = buildManifests(sludge(), 20260914);
    const b = buildManifests(sludge(), 20260914);
    const c = buildManifests(sludge(), 20260915);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBeLessThanOrEqual(kpi.trucks);
    expect(a.length).toBeGreaterThan(0);
  });

  it('四种状态都覆盖到，轨迹随状态递进', () => {
    const manifests = buildManifests(sludge());
    const summary = summarizeManifests(manifests);
    expect(Object.keys(summary).sort()).toEqual([...MANIFEST_STATUS_ORDER].sort());
    // 至少有一张已归档、一张还没归档
    expect(summary.closed).toBeGreaterThan(0);
    expect(summary.closed).toBeLessThan(manifests.length);
    manifests.forEach((item) => {
      // 轨迹条数 = 状态在推进序列里的下标 + 1
      expect(item.actions.length).toBe(MANIFEST_STATUS_ORDER.indexOf(item.status) + 1);
    });
  });

  it('advanceManifest 是纯函数：不改原数组，状态前进一步，已归档不再动', () => {
    const manifests = buildManifests(sludge());
    const before = JSON.stringify(manifests);
    const target = manifests.filter((item) => item.status !== 'closed')[0];
    const next = advanceManifest(manifests, target.id, '环保台账');
    expect(JSON.stringify(manifests)).toBe(before); // 原数组未被改
    const advanced = next.filter((item) => item.id === target.id)[0];
    expect(MANIFEST_STATUS_ORDER.indexOf(advanced.status)).toBe(
      MANIFEST_STATUS_ORDER.indexOf(target.status) + 1
    );
    expect(advanced.actions.length).toBe(target.actions.length + 1);

    // 已归档的推不动
    const closed = manifests.filter((item) => item.status === 'closed')[0];
    const again = advanceManifest(next, closed.id, '环保台账');
    expect(again.filter((item) => item.id === closed.id)[0].status).toBe('closed');
  });

  it('表格行：列 key 齐全，状态是可读标签', () => {
    const rows = manifestRows(buildManifests(sludge()));
    expect(rows.length).toBeGreaterThan(0);
    const keys = Object.keys(rows[0]);
    ['id', 'issuedAt', 'truck', 'receiver', 'wetTon', 'dryTon', 'waterRate', 'pamKg', 'status', 'action'].forEach(
      (key) => expect(keys).toContain(key)
    );
    expect(Object.values(MANIFEST_STATUS_LABELS)).toContain(rows[0].status);
  });
});
