import { SEWAGE_PLANT, toPlantGraph } from '../../src/domain/plant-case';
import {
  DEFAULT_MODE_ID,
  NORMALLY_CLOSED_VALVES,
  OPERATING_MODES,
  applyModeToGraph,
  inflowOfMode,
  isDefaultValvePosition,
  modeById,
} from '../../src/domain/operating-modes';

describe('运行工况', () => {
  it('三个工况：正常运行 / 雨季超越 / 检修停运，id 唯一且默认为正常', () => {
    expect(OPERATING_MODES.map((mode) => mode.id)).toEqual(['normal', 'rain', 'maintenance']);
    expect(DEFAULT_MODE_ID).toBe('normal');
    expect(OPERATING_MODES.every((mode) => mode.label && mode.summary && mode.notes.length > 0)).toBe(true);
  });

  it('未知 id 回退到正常运行（不抛错）', () => {
    expect(modeById('nope').id).toBe('normal');
  });

  it('超越阀是业务约定的常闭阀，雨季工况显式打开它', () => {
    expect(NORMALLY_CLOSED_VALVES).toContain('bypassValve');
    expect(isDefaultValvePosition(modeById('normal'), 'bypassValve')).toBe(true);
    expect(isDefaultValvePosition(modeById('rain'), 'bypassValve')).toBe(false);
    expect(modeById('rain').valveStates.bypassValve).toBe('open');
  });

  it('进出水水量水质系数：雨季水量上升、浓度被稀释', () => {
    expect(modeById('normal').inflowFactor).toBe(1);
    expect(modeById('rain').inflowFactor).toBeGreaterThan(1);
    expect(modeById('rain').qualityFactor).toBeLessThan(1);
    expect(inflowOfMode(100000, modeById('rain'))).toBeCloseTo(135000, 0);
    expect(inflowOfMode(100000, modeById('rain'), 1.2)).toBeCloseTo(162000, 0);
  });

  it('铺工况是纯函数，且每次都重建停运与阀位（不残留上一个工况）', () => {
    const graph = toPlantGraph(SEWAGE_PLANT);
    const snapshot = JSON.stringify(graph);
    const maintenance = applyModeToGraph(graph, modeById('maintenance'));
    expect(JSON.stringify(graph)).toBe(snapshot);
    expect(maintenance.nodes.filter((node) => node.idle).map((node) => node.id)).toEqual(['dewater']);

    const normal = applyModeToGraph(maintenance, modeById('normal'));
    expect(normal.nodes.filter((node) => node.idle).length).toBe(0);
    expect(normal.nodes.filter((node) => node.kind === 'valve' && node.valveState === 'closed').length).toBe(1);
  });
});
