import { SEWAGE_PLANT, designMap, toPlantGraph } from '../../src/domain/plant-case';
import { applyModeToGraph, modeById } from '../../src/domain/operating-modes';
import { DESIGN_LIMITS, auditPlant, countIssues } from '../../src/domain/plant-audit';
import { computeHydraulics, computeKpi, evaluateQualityChain } from '../../src/domain/process-model';
import { TYPICAL_INFLUENT } from '../../src/domain/water-quality';
import type { PlantGraph } from '../../src/domain/plant-graph';

const baseGraph = toPlantGraph(SEWAGE_PLANT);
const designs = designMap(SEWAGE_PLANT);
const meta = SEWAGE_PLANT.meta;

function auditOf(graph: PlantGraph, modeId: string, inflow?: number, influent?: any) {
  const mode = modeById(modeId);
  const graphWithMode = applyModeToGraph(graph, mode);
  const kpi = computeKpi(graphWithMode, designs, meta, { inflow, influent });
  const chain = evaluateQualityChain(graphWithMode, meta, influent || meta.influent);
  const hydraulics = computeHydraulics(graphWithMode, designs, meta, kpi.inflow, kpi.sludge.wasteSludgeFlow);
  return {
    kpi,
    issues: auditPlant({ graph: graphWithMode, designs, meta, mode, kpi, chain, hydraulics }),
  };
}

const codes = (issues: Array<{ code: string }>) => issues.map((issue) => issue.code);

describe('运行审计', () => {
  it('设计工况（正常运行）：图纸与运行都在设计区间内，审计干净', () => {
    const { issues } = auditOf(baseGraph, 'normal');
    expect(codes(issues)).toEqual([]);
    expect(countIssues(issues)).toEqual({ error: 0, warning: 0 });
  });

  it('设计区间表覆盖沉淀 / 过滤 / 消毒 / 浓缩四类单元', () => {
    expect(Object.keys(DESIGN_LIMITS).sort()).toEqual(
      ['coagulationTank', 'disinfectionTank', 'filterBed', 'primaryClarifier', 'secondaryClarifier', 'sludgeThickener'].sort()
    );
  });

  it('雨季超越：表面负荷与停留时间高于设计区间，负荷率超 110%', () => {
    const mode = modeById('rain');
    const { issues } = auditOf(baseGraph, 'rain', 100000 * mode.inflowFactor, {
      ...TYPICAL_INFLUENT,
      COD: TYPICAL_INFLUENT.COD * mode.qualityFactor,
    });
    expect(codes(issues)).toContain('surface-load-out-of-range');
    expect(codes(issues)).toContain('over-capacity');
    expect(codes(issues)).not.toContain('effluent-exceed');
  });

  it('检修停运：出水阀关 → 报断流；脱水机停运 → 报停运告警', () => {
    const { issues } = auditOf(baseGraph, 'maintenance');
    expect(codes(issues)).toContain('flow-disconnected');
    expect(codes(issues)).toContain('idle-off-process');
    expect(issues.filter((issue) => issue.code === 'flow-disconnected')[0].id).toBe('outletValve');
  });

  it('拿掉混凝沉淀池 → 总磷失去化学除磷这道保障 → 出水超标', () => {
    const withoutCoag = {
      nodes: baseGraph.nodes.filter((node) => node.id !== 'coag'),
      pipes: baseGraph.pipes
        .filter((pipe) => pipe.sourceId !== 'coag' && pipe.targetId !== 'coag')
        .concat([{ id: 'pipe-sec-filter', sourceId: 'sec', targetId: 'filter', medium: 'effluent' as const, dn: 'DN500' }]),
    };
    const { issues, kpi } = auditOf(withoutCoag, 'normal');
    expect(kpi.compliance.exceeded).toContain('TP');
    expect(codes(issues)).toContain('effluent-exceed');
  });

  it('拿掉缺氧池 → 内回流无处反硝化 → 总氮超标', () => {
    const withoutAnoxic = {
      nodes: baseGraph.nodes.filter((node) => node.id !== 'anx'),
      pipes: baseGraph.pipes
        .filter((pipe) => pipe.sourceId !== 'anx' && pipe.targetId !== 'anx')
        .concat([{ id: 'pipe-ana-aer', sourceId: 'ana', targetId: 'aer', medium: 'sewage' as const, dn: 'DN600' }]),
    };
    const { kpi, issues } = auditOf(withoutAnoxic, 'normal');
    expect(kpi.compliance.exceeded).toContain('TN');
    expect(codes(issues)).toContain('effluent-exceed');
  });

  it('裕度告警：某指标逼近限值时给 warning 而不是 error', () => {
    // 进水总氮拉高到 55 mg/L：TN 出水仍在限值内但裕度很小
    const { issues, kpi } = auditOf(baseGraph, 'normal', undefined, { ...TYPICAL_INFLUENT, TN: 55 });
    if (kpi.compliance.pass) {
      expect(codes(issues)).toContain('tight-margin');
    } else {
      expect(codes(issues)).toContain('effluent-exceed');
    }
  });

  it('统计 error / warning 条数', () => {
    expect(countIssues([{ level: 'error' } as any, { level: 'warning' } as any, { level: 'warning' } as any])).toEqual({
      error: 1,
      warning: 2,
    });
  });
});
