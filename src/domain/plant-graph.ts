/**
 * 工艺图的「业务视角」数据结构。
 *
 * 设计器（ice-entity-designer）里的图是**可编辑对象树**；业务计算不该直接去爬那棵树 ——
 * 那样业务逻辑就绑死在引擎的数据结构上了（引擎改一次 state 结构，业务层全得跟着改）。
 *
 * 这里定义一份扁平的、可序列化的图描述，由视图层做一次 adapter（designer → PlantGraph）。
 * domain 只认这份数据，于是全部业务计算都是**纯函数**，可以脱离浏览器单测。
 */
import type { WaterMedium, WaterSymbolKind, WaterValveState } from 'ice-entity-designer';

export type PlantNode = {
  id: string;
  kind: WaterSymbolKind;
  name: string;
  tag: string;
  /** 阀门开 / 闭；非阀门节点忽略此字段 */
  valveState?: WaterValveState;
  /** 停用 / 旁通（画成灰色，且不参与运行工况计算） */
  idle?: boolean;
};

export type PlantPipe = {
  id: string;
  sourceId: string;
  targetId: string;
  medium: WaterMedium;
  /** 公称管径，如 DN600 */
  dn: string;
};

export type PlantGraph = {
  nodes: PlantNode[];
  pipes: PlantPipe[];
};

/** 走线结果：从进水沿管线能不能走到出水 */
export type FlowTrace = {
  connected: boolean;
  /** 途经节点 id（连不上时为空） */
  path: string[];
  outletId?: string;
  /** 卡在哪个关断的阀门上（连不上时给出，用于定位断点） */
  blockedAt?: string;
  /** 沿途经过的管线 id（导出走线报表用） */
  pipePath: string[];
};

/** 水线介质：沿程水质推演只跟这两种介质走 */
export const WATER_LINE_MEDIUMS: WaterMedium[] = ['sewage', 'effluent'];

export type TraceOptions = {
  /** 起点；缺省用图上所有进水符号 */
  fromId?: string;
  /**
   * 走线方向：
   * - `forward`（默认）：按管线**声明的方向**（source → target）走，且只走水线介质。
   *   这是"水到底怎么流的"—— 沿程水质推演必须用它；
   * - `both`：把管线当无向边做连通性搜索，只回答"通不通"，不保证顺序。
   */
  direction?: 'forward' | 'both';
  /** forward 模式下参与走线的介质，缺省水线（污水 / 出水） */
  mediums?: WaterMedium[];
  /**
   * 低优先级的节点：主通路能走通时不会被选中。
   *
   * 用在**备用通路**上（平时关闭的超越阀）：正常运行时走主线，
   * 主线断了才轮到备用线 —— 否则"雨天超越管"会被当成主流程，沿程水质全错。
   */
  deprioritizedNodes?: string[];
};

/** 边界节点类型：工艺流程的起点与终点 */
export const INLET_KIND: WaterSymbolKind = 'inlet';
export const OUTLET_KIND: WaterSymbolKind = 'outlet';

export function findNode(graph: PlantGraph, id: string): PlantNode | null {
  return graph.nodes.filter((node) => node.id === id)[0] || null;
}

export function nodesOfKind(graph: PlantGraph, kind: WaterSymbolKind): PlantNode[] {
  return graph.nodes.filter((node) => node.kind === kind);
}

/** 关断的阀门：不通行 */
/**
 * 阀门类图元（关断即断流）。
 *
 * **与上游同口径**：`ice-entity-designer` 的 `WATER_VALVE_KINDS = ['valve', 'motorValve']` ——
 * 电动阀只是驱动方式不同，在"通不通"这件事上和手动阀完全等价。
 * 这里不 import 那个常量（domain 层零运行时依赖），只镜像它的取值并在此说明。
 */
export const VALVE_KINDS: WaterSymbolKind[] = ['valve', 'motorValve'];

export function isBlockingValve(node: PlantNode | null): boolean {
  return !!node && VALVE_KINDS.indexOf(node.kind) !== -1 && node.valveState === 'closed';
}

/** 邻接表（无向 —— 走线只关心"通不通"，不关心水流方向） */
export function adjacencyOf(graph: PlantGraph): Map<string, Array<{ to: string; pipe: PlantPipe }>> {
  const map = new Map<string, Array<{ to: string; pipe: PlantPipe }>>();
  graph.nodes.forEach((node) => map.set(node.id, []));
  graph.pipes.forEach((pipe) => {
    if (!map.has(pipe.sourceId)) map.set(pipe.sourceId, []);
    if (!map.has(pipe.targetId)) map.set(pipe.targetId, []);
    (map.get(pipe.sourceId) as Array<{ to: string; pipe: PlantPipe }>).push({ to: pipe.targetId, pipe });
    (map.get(pipe.targetId) as Array<{ to: string; pipe: PlantPipe }>).push({ to: pipe.sourceId, pipe });
  });
  return map;
}

/** 每个节点挂了几段管线（孤立节点 = 0，工艺校验要用） */
export function degreeOf(graph: PlantGraph): Map<string, number> {
  const degree = new Map<string, number>();
  graph.nodes.forEach((node) => degree.set(node.id, 0));
  graph.pipes.forEach((pipe) => {
    degree.set(pipe.sourceId, (degree.get(pipe.sourceId) || 0) + 1);
    degree.set(pipe.targetId, (degree.get(pipe.targetId) || 0) + 1);
  });
  return degree;
}

/**
 * 流径分析：从进水（`inlet`）沿管线走到出水（`outlet`），**关断的阀门不通行**。
 *
 * 这是水厂「这张图现在通不通」的回答 —— 相当于电力一次图里的带电分析。
 *
 * 默认走 **forward**（沿管线声明方向 + 只走水线介质）：水质推演要的是"水依次经过了谁"。
 * 用无向最短路径会出事 —— 二沉池到厌氧池的**回流污泥管**会把 `ana → sec` 变成一跳，
 * 于是最短路径直接跳过整段生物池，算出来的出水水质是假的。
 */
export function traceProcessFlow(graph: PlantGraph, options: TraceOptions = {}): FlowTrace {
  const starts = options.fromId
    ? [options.fromId]
    : nodesOfKind(graph, INLET_KIND).map((node) => node.id);
  if (!starts.length) return { connected: false, path: [], pipePath: [] };
  return (options.direction || 'forward') === 'both'
    ? traceUndirected(graph, starts)
    : traceForward(graph, starts, options);
}

/** 沿管线声明方向走（DFB + 备用通路降优先级 + 断点定位） */
function traceForward(graph: PlantGraph, starts: string[], options: TraceOptions): FlowTrace {
  const allowed = new Set(options.mediums && options.mediums.length ? options.mediums : WATER_LINE_MEDIUMS);
  const deprioritized = options.deprioritizedNodes || [];
  const outgoing = new Map<string, PlantPipe[]>();
  graph.pipes.forEach((pipe) => {
    if (!allowed.has(pipe.medium)) return;
    if (!outgoing.has(pipe.sourceId)) outgoing.set(pipe.sourceId, []);
    (outgoing.get(pipe.sourceId) as PlantPipe[]).push(pipe);
  });
  // 备用通路（通向"平时关闭的阀门"）排在后面：主通路能通就不走它
  outgoing.forEach((list) => {
    list.sort((a, b) => {
      const pa = deprioritized.indexOf(a.targetId) === -1 ? 0 : 1;
      const pb = deprioritized.indexOf(b.targetId) === -1 ? 0 : 1;
      return pa - pb;
    });
  });

  const path: string[] = [];
  const pipePath: string[] = [];
  const onPath = new Set<string>();

  function walk(id: string): boolean {
    const node = findNode(graph, id);
    if (!node || isBlockingValve(node)) return false;
    path.push(id);
    onPath.add(id);
    if (node.kind === OUTLET_KIND) return true;
    const next = outgoing.get(id) || [];
    for (let index = 0; index < next.length; index += 1) {
      const pipe = next[index];
      if (onPath.has(pipe.targetId)) continue;
      if (walk(pipe.targetId)) {
        pipePath.unshift(pipe.id);
        return true;
      }
    }
    path.pop();
    onPath.delete(id);
    return false;
  }

  for (let index = 0; index < starts.length; index += 1) {
    if (walk(starts[index])) {
      return { connected: true, path, pipePath, outletId: path[path.length - 1] };
    }
  }
  const blockedAt = locateBlockingValve(graph, starts);
  const trace: FlowTrace = { connected: false, path: [], pipePath: [] };
  if (blockedAt) trace.blockedAt = blockedAt;
  return trace;
}

/** 无向连通性搜索（只回答通不通） */
function traceUndirected(graph: PlantGraph, starts: string[]): FlowTrace {
  const adjacency = adjacencyOf(graph);
  const visited = new Set<string>(starts);
  const prev = new Map<string, { from: string; pipe: string }>();
  const queue: string[] = starts.slice();
  let outletId: string | undefined;

  while (queue.length) {
    const current = queue.shift() as string;
    const node = findNode(graph, current);
    if (!node || isBlockingValve(node)) continue;
    if (node.kind === OUTLET_KIND) {
      outletId = current;
      break;
    }
    (adjacency.get(current) || []).forEach((item) => {
      const next = findNode(graph, item.to);
      if (!next || isBlockingValve(next)) return;
      if (!visited.has(item.to)) {
        visited.add(item.to);
        prev.set(item.to, { from: current, pipe: item.pipe.id });
        queue.push(item.to);
      }
    });
  }

  const path: string[] = [];
  const pipePath: string[] = [];
  if (outletId) {
    let cursor: string | undefined = outletId;
    while (cursor) {
      path.unshift(cursor);
      const step = prev.get(cursor);
      if (step) pipePath.unshift(step.pipe);
      cursor = step ? step.from : undefined;
    }
  }
  const trace: FlowTrace = { connected: !!outletId, path, pipePath };
  if (outletId) trace.outletId = outletId;
  else {
    const blockedAt = locateBlockingValve(graph, starts);
    if (blockedAt) trace.blockedAt = blockedAt;
  }
  return trace;
}

/**
 * 断点定位：找出"又断了路、又离出水最近"的那个关断阀门。
 *
 * 做法：把关断阀门当成搜索的**终止节点**（不穿过去），分别从进水与出水做无向搜索，
 * 两边都能到达的那些关断阀门就是割点；取离出水最近的一个 —— 那就是运行人员该去看的那台阀。
 * （不这么做的话，图上一台常年关闭的备用阀会把断点定位带偏。）
 */
export function locateBlockingValve(graph: PlantGraph, starts: string[]): string | undefined {
  const blocking = graph.nodes.filter((node) => isBlockingValve(node)).map((node) => node.id);
  if (!blocking.length) return undefined;
  const adjacency = adjacencyOf(graph);

  const flood = (from: string[], includeSelf: boolean): Set<string> => {
    const seen = new Set<string>(from);
    const queue = from.slice();
    while (queue.length) {
      const current = queue.shift() as string;
      if (!includeSelf && blocking.indexOf(current) !== -1) continue;
      (adjacency.get(current) || []).forEach((item) => {
        if (seen.has(item.to)) return;
        if (!includeSelf && blocking.indexOf(item.to) !== -1) {
          seen.add(item.to);
          return;
        }
        seen.add(item.to);
        queue.push(item.to);
      });
    }
    return seen;
  };

  const fromInlet = flood(starts, false);
  const outletIds = nodesOfKind(graph, OUTLET_KIND).map((node) => node.id);
  const fromOutlet = flood(outletIds.length ? outletIds : [starts[0]], false);
  const cut = blocking.filter((id) => fromInlet.has(id) && fromOutlet.has(id));
  if (!cut.length) return undefined;

  // 离出水最近的那个：从出水做 BFS 记录距离（可穿过其他关断阀门，只为排名）
  const distanceToOutlet = new Map<string, number>();
  const seeds = outletIds.length ? outletIds : [starts[0]];
  seeds.forEach((id) => distanceToOutlet.set(id, 0));
  const queue = seeds.slice();
  while (queue.length) {
    const current = queue.shift() as string;
    (adjacency.get(current) || []).forEach((item) => {
      if (distanceToOutlet.has(item.to)) return;
      distanceToOutlet.set(item.to, (distanceToOutlet.get(current) || 0) + 1);
      queue.push(item.to);
    });
  }
  return cut.sort((a, b) => (distanceToOutlet.get(a) || 0) - (distanceToOutlet.get(b) || 0))[0];
}

/** 沿程节点序列（走线成功时把 id 换成节点对象，给水质推演用） */
export function processChain(graph: PlantGraph, options: TraceOptions = {}): { nodes: PlantNode[]; trace: FlowTrace } {
  const trace = traceProcessFlow(graph, options);
  const nodes = trace.path
    .map((id) => findNode(graph, id))
    .filter((node): node is PlantNode => !!node);
  return { nodes, trace };
}

/** 旁路：不在这条走线上、但有管线连上来的节点（例如污泥线、加药线） */
export function detachedNodes(graph: PlantGraph, chainIds: string[]): PlantNode[] {
  const onChain = new Set(chainIds);
  return graph.nodes.filter((node) => !onChain.has(node.id));
}

export function cloneGraph(graph: PlantGraph): PlantGraph {
  return {
    nodes: graph.nodes.map((node) => ({ ...node })),
    pipes: graph.pipes.map((pipe) => ({ ...pipe })),
  };
}
