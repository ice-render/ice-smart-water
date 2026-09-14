import { inspectUnit, type InspectorSource } from '../../src/domain/unit-inspector';
import type { PlantGraph } from '../../src/domain/plant-graph';
import type { UnitHydraulics } from '../../src/domain/process-model';
import type { AuditIssue } from '../../src/domain/plant-audit';
import type { AlarmEvent } from '../../src/domain/alarm-log';

/**
 * 「统一单元选择总线」的数据侧单测。
 *
 * `inspectUnit` 是纯函数、零运行时依赖（见 unit-inspector.ts），可以直接喂一份最小快照来验：
 * - 已知单元能算出"身份 + 设计区间指标 + 设计关注 + 巡检要点"；
 * - 未知 id（事件中心「定位」到一张空图时的情形）返回 null；
 * - 审计与报警按 `unitId` 精确归集；
 * - 水力数据缺失时不抛、只给空指标。
 */

function makeSource(overrides: Partial<InspectorSource> = {}): InspectorSource {
  const graph: PlantGraph = {
    nodes: [
      { id: 'sec', kind: 'secondaryClarifier', name: '二沉池', tag: 'SC-101' },
      { id: 'ana', kind: 'anaerobicTank', name: '厌氧池', tag: 'AT-101' },
    ],
    pipes: [],
  };
  const hydraulics: UnitHydraulics[] = [
    {
      id: 'sec',
      kind: 'secondaryClarifier',
      name: '二沉池',
      tag: 'SC-101',
      flow: 50000,
      hrt: 2.5,
      surfaceLoad: 0.8,
      power: 60,
      headLoss: 0.3,
      idle: false,
    } as UnitHydraulics,
  ];
  const designs: Record<string, any> = { sec: { area: 4200 } };
  return {
    graph,
    designs,
    meta: { capacity: 100000, returnSludgeConcentration: 8 } as any,
    kpi: { sludge: { wasteSludgeFlow: 1000 } } as any,
    hydraulics,
    issues: [],
    alarms: [],
    ...overrides,
  };
}

describe('单元检视（统一选择总线的数据侧）', () => {
  it('返回已定位单元的完整检视结果，并带设计区间指标', () => {
    const info = inspectUnit(makeSource(), 'sec');
    expect(info).not.toBeNull();
    expect(info!.id).toBe('sec');
    expect(info!.kind).toBe('secondaryClarifier');
    expect(info!.name).toBe('二沉池');
    expect(info!.tag).toBe('SC-101');
    // 与符号目录同源：身份 / 设计关注 / 巡检要点都来自同一份数据
    expect(info!.catalog.kind).toBe('secondaryClarifier');
    expect(info!.catalog.label).toBe('二沉池');
    expect(info!.idle).toBe(false);
    // 二沉池有"表面负荷 + 停留时间"两项设计区间指标
    const labels = info!.metrics.map((m) => m.label);
    expect(labels).toContain('表面负荷');
    expect(labels).toContain('停留时间');
    // 指标占比落在 0~1、状态可取
    info!.metrics.forEach((m) => {
      expect(m.ratio).toBeGreaterThanOrEqual(0);
      expect(m.ratio).toBeLessThanOrEqual(1);
      expect(['success', 'warning', 'error', 'info']).toContain(m.status);
    });
    // 设计关注与巡检要点从目录带来
    expect(info!.designFocus.length).toBeGreaterThan(0);
    expect(info!.checks.length).toBeGreaterThan(0);
  });

  it('找不到该单元时返回 null（事件中心「定位」到一张空图的情形）', () => {
    expect(inspectUnit(makeSource(), 'ghost')).toBeNull();
  });

  it('关联审计与报警按 unitId 精确归集', () => {
    const issue: AuditIssue = {
      id: 'sec',
      level: 'warning',
      code: 'hrt-out-of-range',
      message: '二沉池停留时间偏短',
    } as AuditIssue;
    const alarm: AlarmEvent = {
      id: 'ALM-9',
      raisedAt: '08:00',
      level: 'major',
      code: 'sludge-no-outlet',
      owner: '工艺一班',
      domain: '工艺',
      status: 'open',
      unitId: 'sec',
      unitTag: 'SC-101',
      unitName: '二沉池',
      title: '二沉池泥位偏高',
      detail: '泥位计读数异常',
      advice: '核查排泥',
      actions: [],
    };
    const info = inspectUnit(makeSource({ issues: [issue], alarms: [alarm] }), 'sec');
    expect(info!.auditIssues).toHaveLength(1);
    expect(info!.auditIssues[0].message).toBe('二沉池停留时间偏短');
    expect(info!.alarms).toHaveLength(1);
    expect(info!.alarms[0].title).toBe('二沉池泥位偏高');
    // 另一条单元的审计 / 报警不应被带回
    expect(info!.auditIssues.every((i) => i.id === 'sec')).toBe(true);
    expect(info!.alarms.every((a) => a.unitId === 'sec')).toBe(true);
  });

  it('水力数据缺失时不抛出，只给空指标数组', () => {
    const info = inspectUnit(makeSource({ hydraulics: [] }), 'sec');
    expect(info).not.toBeNull();
    expect(info!.hydraulics).toBeUndefined();
    expect(info!.metrics).toEqual([]);
  });

  it('停运单元标 idle，阀门单元带有开闭状态', () => {
    const withIdle: InspectorSource = makeSource({
      graph: {
        nodes: [
          { id: 'sec', kind: 'secondaryClarifier', name: '二沉池', tag: 'SC-101', idle: true },
          { id: 'v', kind: 'valve', name: '出水阀', tag: 'V-101', valveState: 'closed' },
        ],
        pipes: [],
      } as PlantGraph,
    });
    const stopped = inspectUnit(withIdle, 'sec');
    expect(stopped!.idle).toBe(true);
    const valve = inspectUnit(withIdle, 'v');
    expect(valve!.valveState).toBe('closed');
  });
});
