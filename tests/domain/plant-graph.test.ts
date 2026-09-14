import { SEWAGE_PLANT, toPlantGraph } from '../../src/domain/plant-case';
import {
  adjacencyOf,
  degreeOf,
  detachedNodes,
  findNode,
  nodesOfKind,
  processChain,
  traceProcessFlow,
} from '../../src/domain/plant-graph';
import { applyModeToGraph, modeById } from '../../src/domain/operating-modes';

describe('工艺图：走线、连通性、邻接', () => {
  const graph = toPlantGraph(SEWAGE_PLANT);

  it('案例覆盖给排水符号库里的常用组合，且每段管线两端都存在', () => {
    expect(graph.nodes.length).toBeGreaterThanOrEqual(34);
    const ids = new Set(graph.nodes.map((node) => node.id));
    graph.pipes.forEach((pipe) => {
      expect(ids.has(pipe.sourceId)).toBe(true);
      expect(ids.has(pipe.targetId)).toBe(true);
      if (pipe.medium === 'signal' || pipe.medium === 'power') {
        // 信号线与动力线不是管道：没有管径，标注也不带 DN
        expect(pipe.dn).toBe('');
        return;
      }
      expect(pipe.dn).toMatch(/^DN\d+$/);
    });
    // 信号 / 动力线必须在图上（仪表与变频器的接线）
    const circuits = graph.pipes.filter((pipe) => pipe.medium === 'signal' || pipe.medium === 'power');
    expect(circuits.length).toBe(3);
  });

  it('正常运行工况下，进水能走到出水，走线是主流程', () => {
    const normal = applyModeToGraph(graph, modeById('normal'));
    const trace = traceProcessFlow(normal);
    expect(trace.connected).toBe(true);
    expect(trace.path[0]).toBe('inlet');
    expect(trace.path[trace.path.length - 1]).toBe('outlet');
    // 主流程：进水泵 → 格栅 → 沉砂池 → 初沉池 → 厌氧 → 缺氧 → 好氧 → 二沉 → 混凝 → 滤池 → 消毒 → 监测 → 计量 → 出水阀 → 排放
    expect(trace.path).toEqual([
      'inlet',
      'pump',
      'checkValve',
      'screen',
      'grit',
      'primary',
      'ana',
      'anx',
      'aer',
      'sec',
      'coag',
      'filter',
      'disinfect',
      'analyzer',
      'meter',
      'outletValve',
      'outlet',
    ]);
    expect(trace.pipePath.length).toBe(trace.path.length - 1);
    expect(trace.blockedAt).toBeUndefined();
  });

  it('关掉出水阀 → 断流，并指出卡在哪个阀门上', () => {
    const closed = {
      nodes: graph.nodes.map((node) =>
        node.id === 'outletValve' ? { ...node, valveState: 'closed' as const } : node
      ),
      pipes: graph.pipes,
    };
    const trace = traceProcessFlow(closed);
    expect(trace.connected).toBe(false);
    expect(trace.blockedAt).toBe('outletValve');
    expect(trace.path).toEqual([]);
  });

  it('超越阀平时关闭（备用通路不会被误判为通路），雨季工况才打开', () => {
    const normal = applyModeToGraph(graph, modeById('normal'));
    expect(findNode(normal, 'bypassValve')?.valveState).toBe('closed');
    const rain = applyModeToGraph(graph, modeById('rain'));
    expect(findNode(rain, 'bypassValve')?.valveState).toBe('open');
    // 打开超越阀后，格栅 → 沉砂池 → 超越阀 → 厌氧池 这条支路是通的
    const adjacency = adjacencyOf(rain);
    expect((adjacency.get('bypassValve') || []).map((item) => item.to).sort()).toEqual(['ana', 'grit']);
  });

  it('检修工况关闭出水阀并把脱水机置为停运', () => {
    const maintenance = applyModeToGraph(graph, modeById('maintenance'));
    expect(findNode(maintenance, 'outletValve')?.valveState).toBe('closed');
    expect(findNode(maintenance, 'dewater')?.idle).toBe(true);
    expect(findNode(maintenance, 'pump')?.idle).toBe(false);
    // 复位：切回正常工况后停运标记不残留
    const normal = applyModeToGraph(maintenance, modeById('normal'));
    expect(findNode(normal, 'dewater')?.idle).toBe(false);
  });

  it('工况切换不改原图（纯函数）', () => {
    const before = JSON.stringify(graph.nodes);
    applyModeToGraph(graph, modeById('rain'));
    expect(JSON.stringify(graph.nodes)).toBe(before);
  });

  it('邻接与度数：孤立节点度数为 0，走线之外的污泥线/加药线能被识别出来', () => {
    const degree = degreeOf(graph);
    expect(degree.get('inlet')).toBe(1);
    expect(degree.get('sec')).toBeGreaterThanOrEqual(4); // 上游 + 混凝 + 回流 + 浓缩
    const { nodes } = processChain(graph);
    const off = detachedNodes(graph, nodes.map((node) => node.id)).map((node) => node.id);
    expect(off).toContain('blower');
    expect(off).toContain('thickener');
    expect(off).not.toContain('ana');
  });

  it('按类型取节点', () => {
    expect(nodesOfKind(graph, 'valve').map((node) => node.id).sort()).toEqual(['bypassValve', 'outletValve']);
    expect(nodesOfKind(graph, 'analyzer').length).toBe(1);
  });
});
