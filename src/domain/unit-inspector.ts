/**
 * 单元检视：把"选中一个处理单元"翻译成一份**纯数据**的检视结果。
 *
 * 这是「统一单元选择总线」的数据一侧。`src/view/selection.ts` 只管"现在选中了谁"，
 * 真正要展示什么（指标是否越限、关联哪些报警、设计关注哪些量）由本模块的纯函数算。
 *
 * 纯函数、零运行时依赖（只有类型引用），可以直接单测，也可以将来被 BFF / 计算服务复用。
 */
import type { WaterSymbolKind, WaterValveState } from 'ice-entity-designer';
import { DESIGN_LIMITS, type AuditIssue, type DesignLimit } from './plant-audit';
import type { UnitHydraulics, PlantKpi } from './process-model';
import type { PlantGraph } from './plant-graph';
import { SYMBOL_CATALOG, type SymbolEntry } from './symbol-catalog';
import type { PlantMeta, UnitDesign } from './plant-case';
import type { AlarmEvent } from './alarm-log';

/** 一条可带进度条的运行指标 */
export type InspectorMetric = {
  label: string;
  value: string;
  /** 进度条占比 0~1（无明确上限的指标为 0，只显示文字） */
  ratio: number;
  status: 'success' | 'warning' | 'error' | 'info';
};

/** 检视所需的整厂快照（由入口在运行时注入，避免 view 直接依赖引擎） */
export type InspectorSource = {
  graph: PlantGraph;
  designs: Record<string, UnitDesign>;
  meta: PlantMeta;
  kpi: PlantKpi;
  hydraulics: UnitHydraulics[];
  issues: AuditIssue[];
  alarms: AlarmEvent[];
};

/** 一个单元的完整检视结果 */
export type UnitInspector = {
  id: string;
  kind: WaterSymbolKind;
  name: string;
  tag: string;
  catalog: SymbolEntry;
  idle: boolean;
  valveState?: WaterValveState;
  hydraulics?: UnitHydraulics;
  metrics: InspectorMetric[];
  designFocus: string[];
  checks: string[];
  auditIssues: AuditIssue[];
  alarms: AlarmEvent[];
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * 按单元类型挑出"有设计区间"的指标，算出进度条占比与状态色。
 *
 * - 沉淀类（初沉 / 二沉 / 混凝）/ 滤池：表面负荷（滤池这一项是滤速，同一个公式）；
 * - 沉淀类 / 消毒池：停留时间；
 * - 污泥浓缩池：固体负荷（要靠剩余污泥量与浓缩池面积算）。
 */
function buildMetrics(
  kind: WaterSymbolKind,
  hydro: UnitHydraulics | undefined,
  design: UnitDesign | undefined,
  limits: DesignLimit | undefined,
  kpi: PlantKpi,
  meta: PlantMeta
): InspectorMetric[] {
  const metrics: InspectorMetric[] = [];
  if (!hydro) return metrics;
  const isFilter = kind === 'filterBed';
  if (limits?.surfaceLoad && hydro.surfaceLoad > 0) {
    const [min, max] = limits.surfaceLoad;
    const inRange = hydro.surfaceLoad >= min && hydro.surfaceLoad <= max;
    metrics.push({
      label: isFilter ? '滤速' : '表面负荷',
      value: `${hydro.surfaceLoad} m³/(m²·h)`,
      ratio: clamp01(hydro.surfaceLoad / max),
      status: inRange ? 'success' : 'warning',
    });
  }
  if (limits?.hrt && hydro.hrt > 0) {
    const [min, max] = limits.hrt;
    const inRange = hydro.hrt >= min && hydro.hrt <= max;
    metrics.push({
      label: '停留时间',
      value: `${hydro.hrt} h`,
      ratio: clamp01(hydro.hrt / max),
      status: inRange ? 'success' : 'warning',
    });
  }
  if (limits?.solidLoad && design && design.area > 0) {
    const [min, max] = limits.solidLoad;
    const solidLoad = (kpi.sludge.wasteSludgeFlow * (meta.returnSludgeConcentration / 1000)) / design.area;
    const inRange = solidLoad >= min && solidLoad <= max;
    metrics.push({
      label: '固体负荷',
      value: `${solidLoad} kg/(m²·d)`,
      ratio: clamp01(solidLoad / max),
      status: inRange ? 'success' : 'warning',
    });
  }
  return metrics;
}

/**
 * 纯函数：给整厂数据与单元 id，算出该单元的检视面板所需的一切。
 * 找不到该单元（id 不在图上）返回 null。
 */
export function inspectUnit(src: InspectorSource, id: string): UnitInspector | null {
  const node = src.graph.nodes.filter((n) => n.id === id)[0];
  if (!node) return null;
  const catalog = SYMBOL_CATALOG[node.kind];
  const hydro = src.hydraulics.filter((h) => h.id === id)[0];
  const design = src.designs[id];
  const limits = DESIGN_LIMITS[node.kind];
  const metrics = buildMetrics(node.kind, hydro, design, limits, src.kpi, src.meta);
  const auditIssues = src.issues.filter((issue) => issue.id === id);
  const alarms = src.alarms.filter((alarm) => alarm.unitId === id);
  return {
    id,
    kind: node.kind,
    name: node.name,
    tag: node.tag,
    catalog,
    idle: !!node.idle,
    valveState: node.valveState,
    hydraulics: hydro,
    metrics,
    designFocus: catalog ? catalog.designFocus : [],
    checks: catalog ? catalog.checks : [],
    auditIssues,
    alarms,
  };
}
