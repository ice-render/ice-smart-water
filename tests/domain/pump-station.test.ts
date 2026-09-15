/**
 * 泵站监视：相似定律 + 效率曲线 + 液位序列 + KPI。
 */
import { SEWAGE_PLANT, designMap, toPlantGraph } from '../../src/domain/plant-case';
import { computeKpi } from '../../src/domain/process-model';
import {
  PUMP_DEFS,
  PUMP_STATIONS_DEF,
  SUMP_LEVEL_HIGH,
  SUMP_LEVEL_LOW,
  SUMP_SERIES_POINTS,
  pumpCurve,
  pumpEfficiency,
  pumpKpi,
  pumpRows,
  pumpStations,
  specificEnergy,
} from '../../src/domain/pump-station';

const designs = () => designMap();
const kpiOf = () => computeKpi(toPlantGraph(), designs(), SEWAGE_PLANT.meta);
const stationsOf = () => pumpStations(kpiOf(), SEWAGE_PLANT.units, designs());
const allPumps = () => stationsOf().flatMap((station) => station.pumps);

describe('效率曲线与单位提升电耗', () => {
  it('效率峰值在 0.85n 附近，两端更低', () => {
    const peak = pumpEfficiency(0.85);
    expect(peak).toBeGreaterThan(pumpEfficiency(0.35));
    expect(peak).toBeGreaterThan(pumpEfficiency(1));
    expect(peak).toBeLessThanOrEqual(0.86);
  });

  it('单位提升电耗 = 功率 / 流量 × 1000', () => {
    expect(specificEnergy(100, 1000)).toBe(100);
    expect(specificEnergy(100, 0)).toBe(0);
  });
});

describe('泵站工况', () => {
  it('三个泵站、四台泵，与铭牌定义一一对应', () => {
    const stations = stationsOf();
    expect(stations.map((station) => station.id)).toEqual(PUMP_STATIONS_DEF.map((station) => station.id));
    expect(allPumps().map((pump) => pump.id).sort()).toEqual(PUMP_DEFS.map((def) => def.id).sort());
  });

  it('相似定律：功率 ∝ 转速³、扬程 ∝ 转速²、流量 ∝ 转速', () => {
    allPumps().forEach((pump) => {
      if (!pump.running) return;
      // `speed` 落库时保留两位小数，所以按它反算会有 <0.5 的舍入差
      expect(pump.flow).toBeCloseTo(pump.ratedFlow * pump.speed, 0);
      expect(pump.head).toBeCloseTo(pump.ratedHead * pump.speed ** 2, 0);
      expect(pump.power).toBeCloseTo(pump.ratedPower * pump.speed ** 3, 0);
    });
  });

  it('备用泵平时不转（流量 0），工作泵都转', () => {
    allPumps().forEach((pump) => {
      if (pump.role === 'standby') {
        expect(pump.running).toBe(false);
        expect(pump.flow).toBe(0);
        expect(pump.power).toBe(0);
      } else {
        expect(pump.running).toBe(true);
        expect(pump.flow).toBeGreaterThan(0);
      }
    });
  });

  it('转速夹在 0.35~1.0（低流量也不会算出"泵不转但还出水"）', () => {
    allPumps().forEach((pump) => {
      if (!pump.running) return;
      expect(pump.speed).toBeGreaterThanOrEqual(0.35);
      expect(pump.speed).toBeLessThanOrEqual(1);
    });
  });

  it('集水井液位序列长度固定、取值在 (0,1)、且与当前液位一致', () => {
    stationsOf().forEach((station) => {
      expect(station.levelSeries).toHaveLength(SUMP_SERIES_POINTS);
      station.levelSeries.forEach((value) => {
        expect(value).toBeGreaterThan(0);
        expect(value).toBeLessThan(1);
      });
      expect(station.level).toBe(station.levelSeries[station.levelSeries.length - 1]);
    });
  });

  it('确定性：两次结果完全一致', () => {
    expect(stationsOf()).toEqual(stationsOf());
  });
});

describe('泵站 KPI', () => {
  it('运行 / 备用计数与泵列表一致；加权单位电耗 = 总功率 / 总流量', () => {
    const stations = stationsOf();
    const kpi = pumpKpi(stations);
    const pumps = stations.flatMap((station) => station.pumps);
    expect(kpi.running).toBe(pumps.filter((pump) => pump.running).length);
    expect(kpi.standby).toBe(pumps.length - kpi.running);
    expect(kpi.totalFlow).toBeCloseTo(
      pumps.filter((pump) => pump.running).reduce((sum, pump) => sum + pump.flow, 0),
      1
    );
    expect(kpi.specificEnergy).toBeCloseTo(specificEnergy(kpi.runningPower, kpi.totalFlow), 1);
  });

  it('液位越限判定：全部在高低线之内时不报警', () => {
    const stations = stationsOf();
    const kpi = pumpKpi(stations);
    const outOfRange = stations.some(
      (station) => station.level >= SUMP_LEVEL_HIGH || station.level <= SUMP_LEVEL_LOW
    );
    expect(kpi.levelAlarm).toBe(outOfRange);
  });

  it('Q-η 曲线：14 个采样点、效率在 0~100、流量单调增', () => {
    const curve = pumpCurve();
    expect(curve.speeds).toHaveLength(14);
    curve.efficiency.forEach((value) => {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThanOrEqual(100);
    });
    for (let index = 1; index < curve.flow.length; index += 1) {
      expect(curve.flow[index]).toBeGreaterThan(curve.flow[index - 1]);
    }
  });

  it('表格行：列 key 齐全', () => {
    const rows = pumpRows(stationsOf());
    expect(rows).toHaveLength(PUMP_DEFS.length);
    ['id', 'tag', 'name', 'station', 'flow', 'head', 'efficiency', 'power', 'specific', 'state'].forEach((key) =>
      expect(Object.keys(rows[0])).toContain(key)
    );
  });
});
