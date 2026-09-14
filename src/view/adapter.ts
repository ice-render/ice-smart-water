/**
 * 适配层：把设计器里的**可编辑图**翻成业务层的**扁平图描述**。
 *
 * 这一层薄，但不能省：它是"引擎的数据结构"与"业务的数据结构"之间**唯一**的接触点。
 * 引擎改 state 结构，只改这里；业务模型永远只看 `PlantGraph`。
 */
import type { PlantGraph } from '../domain/plant-graph';

type DesignerLike = {
  nodes: any[];
  edges: any[];
};

export function graphOfDesigner(designer: DesignerLike): PlantGraph {
  const nodes = designer.nodes.map((node: any) => {
    const state = node.state || {};
    return {
      id: String(state.id),
      kind: state.kind,
      name: String(state.name || ''),
      tag: String(state.tag || ''),
      valveState: state.kind === 'valve' ? state.valveState || 'open' : undefined,
      idle: !!state.idle,
    };
  });
  const pipes = designer.edges
    .map((edge: any) => {
      const state = edge.state || {};
      const links = state.links || {};
      return {
        id: String(state.id),
        sourceId: links.start && links.start.id ? String(links.start.id) : '',
        targetId: links.end && links.end.id ? String(links.end.id) : '',
        medium: state.medium,
        dn: String(state.dn || ''),
      };
    })
    .filter((pipe) => !!pipe.sourceId && !!pipe.targetId);
  return { nodes, pipes };
}

/** 图上现有的全部位号（位号顺延、唯一性检查用） */
export function tagsOfDesigner(designer: DesignerLike): string[] {
  return designer.nodes.map((node: any) => String((node.state || {}).tag || '').trim()).filter((tag) => !!tag);
}
