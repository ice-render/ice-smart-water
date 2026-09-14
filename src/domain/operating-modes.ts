/**
 * 运行工况：把「厂里现在是什么状态」这件事当成一等业务对象。
 *
 * 一个工况 = 阀门目标状态 + 停运单元 + 进出水的水量水质修正系数 + 给运行人员的提示。
 * 它是**纯数据 + 纯函数**：`applyModeToGraph` 返回一张新的图，怎么画是视图层的事。
 *
 * 为什么要有工况这一层：水厂的图是同一张，但"通不通、达标不达标、耗多少电"完全取决于
 * 现在按哪个工况运行 —— 静态图纸回答不了这个问题。
 */
import type { WaterValveState } from 'ice-entity-designer';
import { NORMALLY_CLOSED_VALVES } from './plant-case';
import type { PlantGraph } from './plant-graph';

// 平时关闭的阀门属于厂站的业务约定，定义在 plant-case（见那里的注释）；这里转出去方便调用方一处引用
export { NORMALLY_CLOSED_VALVES };

export type OperatingModeId = 'normal' | 'rain' | 'maintenance';

export type OperatingMode = {
  id: OperatingModeId;
  label: string;
  /** 一句话说明这个工况在干什么 */
  summary: string;
  /** 阀门目标状态：只写**非默认**的那些，其余阀门按 `NORMALLY_CLOSED_VALVES` 规则复位 */
  valveStates: Record<string, WaterValveState>;
  /** 停运单元 id（图上置灰、不计入运行功率） */
  idleUnits: string[];
  /** 进水流量倍数（雨季流量增大） */
  inflowFactor: number;
  /** 进水水质倍数（雨季初期雨水稀释 < 1） */
  qualityFactor: number;
  /** 运行要点：面板上给运行人员的提示 */
  notes: string[];
};

/**
 * 平时处于关闭位置的阀门（业务约定）。
 *
 * 超越管、联络管这类**备用通路**的阀门平时是关的 —— 这跟"默认全开"不是一回事，
 * 所以必须显式列出来，否则运行工况复位时会把备用通路一起打开。
 * 定义已上移到 `plant-case`（属于厂站数据），这里保留说明与再导出。
 */

export const OPERATING_MODES: OperatingMode[] = [
  {
    id: 'normal',
    label: '正常运行',
    summary: 'AAO 全流程投运，超越阀关闭，出水连续排放',
    valveStates: {},
    idleUnits: [],
    inflowFactor: 1,
    qualityFactor: 1,
    notes: ['出水阀开、初沉池超越阀关', '内回流比 200%、污泥回流比 100%', '污泥线浓缩 → 脱水 → 外运全线运行'],
  },
  {
    id: 'rain',
    label: '雨季超越',
    summary: '开超越阀分流，进水水量上升、水质被稀释',
    valveStates: { bypassValve: 'open' },
    idleUnits: [],
    // 雨季设计流量取 1.35 倍（合流制截流倍数取 1.5，扣除上游调蓄）
    inflowFactor: 1.35,
    // 初期雨水稀释进水浓度，COD / 氨氮同比例下降
    qualityFactor: 0.8,
    notes: [
      '初沉池超越阀开，多余水量绕过初沉池直接进生物池',
      '生物池水力停留时间下降，注意二沉池表面负荷与出水 SS',
      '雨天进水氨氮被稀释，但仍要保证硝化所需泥龄，不要盲目减曝气',
    ],
  },
  {
    id: 'maintenance',
    label: '检修停运',
    summary: '关出水阀停排，污泥脱水机停运待检',
    valveStates: { outletValve: 'closed' },
    idleUnits: ['dewater'],
    inflowFactor: 1,
    qualityFactor: 1,
    notes: [
      '出水阀关闭 → 水流在阀门处断开，流径分析会报断流',
      '污泥脱水机停运，剩余污泥只能暂存于浓缩池，注意泥位',
      '停排期间上游需同步限流，否则生物池会淹',
    ],
  },
];

export const DEFAULT_MODE_ID: OperatingModeId = 'normal';

export function modeById(id: OperatingModeId | string): OperatingMode {
  return OPERATING_MODES.filter((mode) => mode.id === id)[0] || OPERATING_MODES[0];
}

/** 某工况下的进水流量（含工况的水量修正） */
export function inflowOfMode(capacity: number, mode: OperatingMode, hourlyFactor = 1): number {
  return capacity * mode.inflowFactor * hourlyFactor;
}

/**
 * 某个阀门在某个工况下的**目标位置**（唯一口径）。
 *
 * 编辑页把它铺到设计器上、单测与 `applyModeToGraph` 用它算图 —— 一处定义，
 * 不会出现"界面上是开的、算出来是关的"这种两套规则打架。
 */
export function targetValveState(mode: OperatingMode, id: string): WaterValveState {
  const declared = mode.valveStates[id];
  if (declared !== undefined) return declared;
  return NORMALLY_CLOSED_VALVES.indexOf(id) === -1 ? 'open' : 'closed';
}

/** 某个单元在该工况下是否停运 */
export function isIdleInMode(mode: OperatingMode, id: string): boolean {
  return mode.idleUnits.indexOf(id) !== -1;
}

/**
 * 把工况铺到图上，返回**新的图**（不改原对象）。
 *
 * 复位规则：阀门先按 `NORMALLY_CLOSED_VALVES` 回到默认位置，再叠加工况的阀门目标；
 * 停运标记每次重建（不残留上一个工况的状态）。
 */
export function applyModeToGraph(graph: PlantGraph, mode: OperatingMode): PlantGraph {
  return {
    nodes: graph.nodes.map((node) => {
      if (node.kind !== 'valve') {
        return { ...node, idle: isIdleInMode(mode, node.id) };
      }
      return {
        ...node,
        valveState: targetValveState(mode, node.id),
        idle: isIdleInMode(mode, node.id),
      };
    }),
    pipes: graph.pipes.map((pipe) => ({ ...pipe })),
  };
}

/** 阀门是不是"按业务约定不该是这个位置"（给业务审计用） */
export function isDefaultValvePosition(mode: OperatingMode, id: string): boolean {
  const declared = mode.valveStates[id];
  if (declared !== undefined) return false;
  return NORMALLY_CLOSED_VALVES.indexOf(id) !== -1;
}
