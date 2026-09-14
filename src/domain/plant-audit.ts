/**
 * 运行审计：拿"现在这个工况 + 现在这张图"去核对工艺与运行上的硬约束。
 *
 * 与图纸校验的分工（**刻意分开，别混**）：
 * - **图纸级**由 `ice-entity-designer` 的 `WaterProcessDesigner.validateWater()` 提供
 *   —— 位号唯一、孤立单元、管线缺介质/管径、断流、出水缺在线监测、污泥出路、AAO 内回流。
 *   那些规则只跟"图本身"有关，与运行无关，属于领域设计器的职责。
 * - **运行级**（本模块）只问"这台厂按这个工况跑，行不行"：
 *   出水达不达标、裕度够不够、停运的单元在不在流程上、表面负荷/停留时间/泥龄/负荷率在不在设计区间。
 *
 * 两类问题在界面上分两个面板展示，不合并、不去重 —— 运行人员需要知道"这是图纸问题还是运行问题"。
 */
import type { WaterSymbolKind } from 'ice-entity-designer';
import type { OperatingMode } from './operating-modes';
import {
  SLUDGE_SOURCE_KINDS,
  type PlantMeta,
  type UnitDesign,
} from './plant-case';
import type { PlantGraph } from './plant-graph';
import type { PlantKpi, QualityChainResult, UnitHydraulics } from './process-model';
import { QUALITY_LABELS, round2, type WaterQuality } from './water-quality';

export type AuditLevel = 'error' | 'warning';

export type AuditIssue = {
  level: AuditLevel;
  code: string;
  message: string;
  /** 关联的单元 / 管线 id（界面上可以定位） */
  id?: string;
};

/**
 * 各单元的设计区间（业务经验值）。
 *
 * - `surfaceLoad`：沉淀类单元的表面负荷 m³/(m²·h)；滤池这一项实际是**滤速** m/h（同一个公式）；
 * - `hrt`：水力停留时间 h；
 * - `solidLoad`：污泥浓缩池的固体负荷 kg/(m²·d)。
 */
export type DesignLimit = {
  surfaceLoad?: [number, number];
  hrt?: [number, number];
  solidLoad?: [number, number];
};

export const DESIGN_LIMITS: Partial<Record<WaterSymbolKind, DesignLimit>> = {
  primaryClarifier: { surfaceLoad: [1.5, 3.0], hrt: [1.0, 2.5] },
  secondaryClarifier: { surfaceLoad: [1.5, 2.5], hrt: [1.5, 4.0] },
  coagulationTank: { surfaceLoad: [1.5, 3.0], hrt: [0.8, 2.0] },
  filterBed: { surfaceLoad: [5, 10] },
  disinfectionTank: { hrt: [0.5, 2.0] },
  sludgeThickener: { solidLoad: [10, 35] },
};

/** 污泥龄的合理区间（AAO 同步脱氮除磷的常规设计值） */
export const SRT_RANGE: [number, number] = [12, 25];
/** 污泥负荷 F/M 的合理区间 kgBOD₅/(kgMLSS·d) */
export const FM_RANGE: [number, number] = [0.05, 0.15];
/** 出水裕度告警线：裕度低于这个值就要提前调加药 / 曝气 */
export const TIGHT_MARGIN = 0.1;
/** 负荷率告警线（%） */
export const OVERLOAD_PERCENT = 110;

export type AuditInput = {
  graph: PlantGraph;
  designs: Record<string, UnitDesign>;
  meta: PlantMeta;
  mode: OperatingMode;
  kpi: PlantKpi;
  chain: QualityChainResult;
  hydraulics: UnitHydraulics[];
  /** 排放限值；缺省用一级 A */
  limit?: WaterQuality;
};

export function auditPlant(input: AuditInput): AuditIssue[] {
  const { graph, meta, mode, kpi, chain, hydraulics } = input;
  const issues: AuditIssue[] = [];
  const nameOf = (id: string) => {
    const node = graph.nodes.filter((item) => item.id === id)[0];
    return node ? `${node.name}（${node.tag}）` : id;
  };

  // 1) 出水能不能出得去
  if (!chain.connected) {
    issues.push({
      level: 'error',
      code: 'flow-disconnected',
      message: chain.blockedAt
        ? `水流在「${nameOf(chain.blockedAt)}」处断开：该阀门处于关闭位，进水到不了出水`
        : '主流程未接通：进水走不到出水',
      id: chain.blockedAt,
    });
  }

  // 2) 出水达不达标
  if (!kpi.compliance.pass) {
    issues.push({
      level: 'error',
      code: 'effluent-exceed',
      message: `出水超标：${kpi.compliance.exceeded
        .map((index) => QUALITY_LABELS[index])
        .join('、')}（${kpi.compliance.passed}/${kpi.compliance.total} 项达标）`,
    });
  } else if (kpi.compliance.tightest && kpi.compliance.tightest.margin < TIGHT_MARGIN) {
    const tightest = kpi.compliance.tightest;
    issues.push({
      level: 'warning',
      code: 'tight-margin',
      message: `${tightest.label} 裕度只剩 ${Math.round(tightest.margin * 100)}%（${tightest.value} / 限值 ${tightest.limit}），建议提前调整运行参数`,
    });
  }

  // 3) 停运的单元在不在流程上
  const onChain = new Set(chain.stages.map((stage) => stage.id));
  graph.nodes
    .filter((node) => node.idle)
    .forEach((node) => {
      issues.push({
        level: onChain.has(node.id) ? 'error' : 'warning',
        code: onChain.has(node.id) ? 'idle-on-process' : 'idle-off-process',
        message: onChain.has(node.id)
          ? `「${node.name}」已停运，但它在水流走线上 —— 出水水质推演已跳过该单元`
          : `「${node.name}」已停运，不在水流走线上，注意它的服务对象是否受影响`,
        id: node.id,
      });
    });

  // 4) 负荷与停留时间校核
  hydraulics.forEach((unit) => {
    const limits = DESIGN_LIMITS[unit.kind];
    if (!limits || unit.flow <= 0) return;
    const design = input.designs[unit.id];
    if (limits.surfaceLoad && unit.surfaceLoad > 0) {
      const [min, max] = limits.surfaceLoad;
      if (unit.surfaceLoad < min || unit.surfaceLoad > max) {
        issues.push({
          level: 'warning',
          code: 'surface-load-out-of-range',
          message: `${unit.name} 表面负荷 ${unit.surfaceLoad} m³/(m²·h) 超出设计区间 ${min}~${max}`,
          id: unit.id,
        });
      }
    }
    if (limits.hrt && unit.hrt > 0) {
      const [min, max] = limits.hrt;
      if (unit.hrt < min || unit.hrt > max) {
        issues.push({
          level: 'warning',
          code: 'hrt-out-of-range',
          message: `${unit.name} 停留时间 ${unit.hrt} h 超出设计区间 ${min}~${max} h`,
          id: unit.id,
        });
      }
    }
    if (limits.solidLoad && design && design.area > 0) {
      const solidLoad = round2((kpi.sludge.wasteSludgeFlow * (meta.returnSludgeConcentration / 1000)) / design.area);
      const [min, max] = limits.solidLoad;
      if (solidLoad < min || solidLoad > max) {
        issues.push({
          level: 'warning',
          code: 'solid-load-out-of-range',
          message: `${unit.name} 固体负荷 ${solidLoad} kg/(m²·d) 超出设计区间 ${min}~${max}`,
          id: unit.id,
        });
      }
    }
  });

  // 5) 生物池的三条关键指标：泥龄、污泥负荷、总停留时间
  const srt = kpi.sludge.srt;
  if (srt > 0 && (srt < SRT_RANGE[0] || srt > SRT_RANGE[1])) {
    issues.push({
      level: 'warning',
      code: 'srt-out-of-range',
      message: `污泥龄 ${srt} d 超出 ${SRT_RANGE[0]}~${SRT_RANGE[1]} d：${
        srt < SRT_RANGE[0] ? '泥龄偏短，硝化菌容易流失' : '泥龄偏长，污泥易老化、能耗上升'
      }`,
    });
  }
  const fm = kpi.sludge.fm;
  if (fm > 0 && (fm < FM_RANGE[0] || fm > FM_RANGE[1])) {
    issues.push({
      level: 'warning',
      code: 'fm-out-of-range',
      message: `污泥负荷 F/M = ${fm} kgBOD₅/(kgMLSS·d) 超出 ${FM_RANGE[0]}~${FM_RANGE[1]}`,
    });
  }

  // 6) 全厂负荷率
  if (kpi.utilization > OVERLOAD_PERCENT) {
    issues.push({
      level: 'warning',
      code: 'over-capacity',
      message: `负荷率 ${kpi.utilization}% 已超过设计规模（${kpi.capacity} m³/d），注意二沉池与鼓风机余量`,
    });
  }

  // 7) 污泥有没有出路（运行视角：外运单元是不是在正常运行）
  const hasSludgeLine = graph.pipes.some((pipe) => pipe.medium === 'sludge');
  if (hasSludgeLine) {
    const outlet = graph.nodes.filter((node) => node.kind === 'sludgeOut')[0];
    if (!outlet) {
      issues.push({ level: 'error', code: 'sludge-no-outlet', message: '有剩余污泥管线，但图上没有污泥外运单元' });
    } else if (outlet.idle) {
      issues.push({
        level: 'error',
        code: 'sludge-outlet-idle',
        message: `「${outlet.name}」已停运，剩余污泥没有出路`,
        id: outlet.id,
      });
    }
  }

  // 8) 有剩余污泥产生、却没有浓缩 / 脱水单元
  const producesSludge = graph.nodes.some((node) => SLUDGE_SOURCE_KINDS.indexOf(node.kind) !== -1);
  const hasTreatment = graph.nodes.some((node) => ['sludgeThickener', 'dewateringMachine', 'sludgeOut'].indexOf(node.kind) !== -1);
  if (producesSludge && !hasTreatment) {
    issues.push({ level: 'warning', code: 'sludge-without-disposal', message: '有剩余污泥产生，但图上没有浓缩 / 脱水 / 外运单元' });
  }

  // 9) 工况自身的提示（不做判定，只把运行要点摆在审计结果里）
  void mode;

  return issues;
}

/** 按级别统计（面板标题上用） */
export function countIssues(issues: AuditIssue[]): { error: number; warning: number } {
  return {
    error: issues.filter((issue) => issue.level === 'error').length,
    warning: issues.filter((issue) => issue.level === 'warning').length,
  };
}
