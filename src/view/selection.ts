/**
 * 统一单元选择总线（Plant Selection Bus）。
 *
 * 为什么需要它：智慧水务里"选中一个处理单元"这件事，会同时牵动好几处 UI ——
 *   - 工艺图（设计器）上的选中高亮；
 *   - 右侧"单元检视"面板（同一套 ice-web-components 画的属性面板）；
 *   - 事件中心里点「定位」跳到这个单元；
 *   - 符号库里选一个符号，联动到图上同类型的真实单元。
 *
 * 如果每一处都各自记一份"当前选中谁"，很快就会对不上。这里把它们收敛成**单一数据源**：
 * 谁改了选中，谁就调 `selectUnit`；谁关心选中变化，就 `onUnitSelect` 订阅。一处变，处处变 ——
 * 这就是 ICE 家族"一套控件、一份状态、处处联动"在应用层的具体落地。
 *
 * 本模块**不依赖任何 ICE 运行时**，纯 view 层：它只管"现在选中了谁"，真正的图元数据
 * 由 `app.ts` 通过 `setInspectorSource` 注入（避免 view 反向依赖引擎 / 设计器）。
 */
import { inspectUnit, type InspectorSource, type UnitInspector } from '../domain';

export type SelectListener = (
  id: string | null,
  opts?: { suppressRecompute?: boolean; source?: string }
) => void;

let selectedId: string | null = null;
const listeners = new Set<SelectListener>();
let sourceProvider: (() => InspectorSource) | null = null;

/** 当前选中的单元 id（null = 没选） */
export function getSelectedUnit(): string | null {
  return selectedId;
}

/**
 * 选中某个单元（幂等：选中同一个不再广播，避免回环）。
 * `source` 仅用于调试 / 去重，标记这次选中是谁触发的（canvas / events / legend）。
 */
export function selectUnit(id: string | null, opts?: { suppressRecompute?: boolean; source?: string }): void {
  if (id === selectedId) return;
  selectedId = id;
  listeners.forEach((cb) => cb(id, opts));
}

/** 订阅选中变化；返回取消订阅的函数 */
export function onUnitSelect(cb: SelectListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 注入"图元数据探针"：由 `app.ts` 提供当前最新的 PlantGraph / 设计 / KPI / 水力 / 审计 / 报警。
 * 这样本模块不需要 import 引擎或设计器，业务数据只在运行时提供（也避免循环依赖）。
 */
export function setInspectorSource(provider: () => InspectorSource): void {
  sourceProvider = provider;
}

/**
 * 探针：给一个单元 id，返回它的检视结果（`inspectUnit` 纯函数算出来的）。
 * 没选中 / 还没注入数据源时返回 null。
 */
export function inspectorProbe(id: string | null = getSelectedUnit()): UnitInspector | null {
  if (!id || !sourceProvider) return null;
  return inspectUnit(sourceProvider(), id);
}
