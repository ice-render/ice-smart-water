/**
 * 泵站监视：厂内泵组的运行工况、Q-η 特性、集水井液位。
 *
 * 模型口径（**相似定律**，不是查表也不是实测）：
 * - 转速比 `n = 需求流量 / 额定流量`（夹在 0.35~1.0）；
 * - 相似定律：`流量 ∝ n`、`扬程 ∝ n²`、`轴功率 ∝ n³`；
 * - 效率取一条以 0.85n 为峰值的抛物线（离心泵的典型 Q-η 形状）。
 * 这样"额定点"就是装机参数（`design.power`），当前工况由业务流量推出来，自洽且确定。
 *
 * 单位口径：流量 `m³/h`、扬程 `m`、功率 `kW`、单位提升电耗 `kWh/千m³`、液位与效率 `0~1`。
 */
import type { PlantKpi } from './process-model';
import type { UnitDesign } from './plant-case';
import { createRandom } from './daily-profile';

/** 泵的铭牌参数（流量是**单泵额定**；扬程与效率是选型点） */
export const PUMP_DEFS: Array<{
  id: string;
  station: string;
  ratedFlow: number;
  ratedHead: number;
  role: 'duty' | 'standby';
  /** 该泵抽的是什么（用来解释流量来源） */
  medium: string;
}> = [
  { id: 'pump', station: 'inlet', ratedFlow: 2400, ratedHead: 14, role: 'duty', medium: '进水' },
  { id: 'returnPump', station: 'return', ratedFlow: 2400, ratedHead: 9, role: 'duty', medium: '回流污泥' },
  { id: 'accidentPump', station: 'return', ratedFlow: 1200, ratedHead: 9, role: 'standby', medium: '事故水 / 备用' },
  { id: 'screwPump', station: 'sludge', ratedFlow: 60, ratedHead: 25, role: 'duty', medium: '浓缩污泥' },
];

export const PUMP_STATIONS_DEF: Array<{ id: string; name: string; note: string }> = [
  { id: 'inlet', name: '进水泵房', note: '提升进水，集水井液位联动' },
  { id: 'return', name: '回流污泥泵房', note: '一用一备，事故水回流泵平时备用' },
  { id: 'sludge', name: '污泥泵房', note: '把浓缩污泥送进脱水机' },
];

/** 集水井液位的高 / 低报警线（占有效水深的比例） */
export const SUMP_LEVEL_HIGH = 0.85;
export const SUMP_LEVEL_LOW = 0.25;
/** 集水井液位历史序列的采样点数（每点 1 分钟） */
export const SUMP_SERIES_POINTS = 60;

export type PumpUnit = {
  id: string;
  tag: string;
  name: string;
  station: string;
  role: 'duty' | 'standby';
  medium: string;
  /** 额定流量 m³/h */
  ratedFlow: number;
  /** 当前流量 m³/h */
  flow: number;
  /** 额定扬程 m */
  ratedHead: number;
  /** 当前扬程 m */
  head: number;
  /** 装机功率 kW */
  ratedPower: number;
  /** 当前轴功率 kW */
  power: number;
  /** 转速比 0~1 */
  speed: number;
  /** 当前效率 0~1 */
  efficiency: number;
  /** 单位提升电耗 kWh/千m³ */
  specificEnergy: number;
  /** 今日启停次数 */
  starts: number;
  /** 今日累计运行小时 */
  runtimeH: number;
  /** 是否在运行（备用泵平时不转） */
  running: boolean;
};

export type PumpStationData = {
  id: string;
  name: string;
  note: string;
  pumps: PumpUnit[];
  /** 集水井液位 0~1（相对有效水深） */
  level: number;
  /** 最近 SUMP_SERIES_POINTS 分钟的液位序列 */
  levelSeries: number[];
};

export type PumpKpi = {
  /** 运行中的泵数 */
  running: number;
  /** 备用泵数 */
  standby: number;
  /** 总瞬时流量 m³/h */
  totalFlow: number;
  /** 加权平均单位提升电耗 kWh/千m³ */
  specificEnergy: number;
  /** 今日启停次数合计 */
  startsToday: number;
  /** 装机功率合计 kW */
  ratedPower: number;
  /** 当前轴功率合计 kW */
  runningPower: number;
  /** 是否有液位越限 */
  levelAlarm: boolean;
  /** 液位最高的一台（用于提示） */
  worstLevel: number;
};

/** 效率曲线：以 0.85n 为峰值的抛物线（离心泵典型 Q-η 形状）。 */
export function pumpEfficiency(speed: number): number {
  const peak = 0.86;
  const value = peak * (1 - 2.2 * (speed - 0.85) ** 2);
  return clamp(value, 0.2, peak);
}

/** 单位提升电耗：`轴功率 / 流量` 换成 kWh/千m³。 */
export function specificEnergy(powerKw: number, flowM3h: number): number {
  if (!(flowM3h > 0)) return 0;
  return round2((powerKw / flowM3h) * 1000);
}

/**
 * 由业务流量反推单泵工况（相似定律）。
 * `demand` 是该泵要承担的总流量（m³/h）—— 泵房里多台泵时由 `pumpStations` 分摊；
 * `running` 由调用方给（平时：工作泵转、备用泵停；也可以被人工 override 改）。
 */
export function pumpState(
  def: (typeof PUMP_DEFS)[number],
  plant: { tag: string; name: string },
  ratedPower: number,
  demand: number,
  seed: number,
  running = def.role === 'duty'
): PumpUnit {
  const random = createRandom(seed);
  const standby = !running;
  const speed = standby ? 0 : clamp(demand / def.ratedFlow, 0.35, 1);
  const flow = round2(def.ratedFlow * speed);
  const head = round2(def.ratedHead * speed * speed);
  const power = round2(ratedPower * speed ** 3);
  const efficiency = round2(pumpEfficiency(speed));
  return {
    id: def.id,
    tag: plant.tag,
    name: plant.name,
    station: def.station,
    role: def.role,
    medium: def.medium,
    ratedFlow: def.ratedFlow,
    flow,
    ratedHead: def.ratedHead,
    head,
    ratedPower,
    power,
    speed: round2(speed),
    efficiency,
    specificEnergy: specificEnergy(power, flow),
    starts: def.role === 'standby' ? 2 : 3 + Math.floor(random() * 4),
    runtimeH: standby ? round2(2 + random() * 3) : round2(18 + random() * 6),
    running,
  };
}

/**
 * 泵站工况：按业务流量把需求分给各站的工作泵，并给出集水井液位。
 *
 * 流量来源（全部来自 `kpi`，不另造数）：进水 → `inflow`；回流污泥 → `returnSludgeFlow`；
 * 污泥 → `sludge.wasteSludgeFlow`。
 */
export function pumpStations(
  kpi: PlantKpi,
  units: Array<{ id: string; kind: string; tag: string; name: string }>,
  designs: Record<string, UnitDesign>,
  seed = 20260915,
  /** 人工启停（泵 id → 是否运行）；不传则按铭牌角色（工作泵转、备用泵停） */
  overrides: Record<string, boolean> = {}
): PumpStationData[] {
  const unitOf = (unitId: string) => units.filter((unit) => unit.id === unitId)[0];
  const powerOf = (unitId: string) =>
    Number((designs[unitId] || ({} as UnitDesign)).power) || 0;

  const demandByStation: Record<string, number> = {
    inlet: (Number(kpi.inflow) || 0) / 24,
    return: (Number(kpi.returnSludgeFlow) || 0) / 24,
    sludge: (Number(kpi.sludge && kpi.sludge.wasteSludgeFlow) || 0) / 24,
  };

  /** 该泵此刻是否在运行：override 优先，否则按铭牌角色 */
  const isRunning = (def: (typeof PUMP_DEFS)[number]) => {
    const override = overrides[def.id];
    return override === undefined ? def.role === 'duty' : !!override;
  };

  return PUMP_STATIONS_DEF.map((station, stationIndex) => {
    const defs = PUMP_DEFS.filter((def) => def.station === station.id);
    const runningDefs = defs.filter((def) => isRunning(def));
    const demand = demandByStation[station.id] || 0;
    // 需求在**当下运行的工作泵**之间平摊（投运备用泵 = 降低每台转速）
    const perRunning = runningDefs.length ? demand / runningDefs.length : 0;
    const pumps = defs.map((def, index) => {
      const unit = unitOf(def.id);
      const running = isRunning(def);
      return pumpState(
        def,
        { tag: unit ? unit.tag : def.id, name: unit ? unit.name : def.id },
        powerOf(def.id),
        running ? perRunning : 0,
        seed + stationIndex * 17 + index * 3,
        running
      );
    });
    const levelSeries = sumpLevelSeries(SUMP_SERIES_POINTS, seed + stationIndex * 31, {
      start: levelFromDemand(demand, station.id),
      pumps,
    });
    return {
      id: station.id,
      name: station.name,
      note: station.note,
      pumps,
      level: levelSeries[levelSeries.length - 1],
      levelSeries,
    };
  });
}

/** 液位序列：由需求与泵的抽升能力推一个起点，再走一段**确定性**随机游走。 */
export function sumpLevelSeries(
  count: number,
  seed: number,
  options: { start: number; pumps: PumpUnit[] }
): number[] {
  const random = createRandom(seed);
  const out: number[] = [];
  let level = clamp(options.start, SUMP_LEVEL_LOW, SUMP_LEVEL_HIGH);
  for (let index = 0; index < Math.max(1, count); index += 1) {
    // 泵在转 → 液位往下走；泵停 → 往上走。加一点噪声让曲线像真的
    const lifting = options.pumps.some((pump) => pump.running) ? -0.012 : 0.02;
    level = clamp(level + lifting + (random() - 0.5) * 0.012, 0.05, 0.98);
    out.push(round2(level));
  }
  return out;
}

export function pumpKpi(stations: PumpStationData[]): PumpKpi {
  const pumps = stations.flatMap((station) => station.pumps);
  const running = pumps.filter((pump) => pump.running);
  const totalFlow = round2(running.reduce((sum, pump) => sum + pump.flow, 0));
  const runningPower = round2(running.reduce((sum, pump) => sum + pump.power, 0));
  const worstLevel = stations.reduce((max, station) => Math.max(max, station.level), 0);
  return {
    running: running.length,
    standby: pumps.length - running.length,
    totalFlow,
    specificEnergy: specificEnergy(runningPower, totalFlow),
    startsToday: pumps.reduce((sum, pump) => sum + pump.starts, 0),
    ratedPower: round2(pumps.reduce((sum, pump) => sum + pump.ratedPower, 0)),
    runningPower,
    levelAlarm: stations.some((station) => station.level >= SUMP_LEVEL_HIGH || station.level <= SUMP_LEVEL_LOW),
    worstLevel: round2(worstLevel),
  };
}

/** Q-η 曲线（横轴转速比 35%~100%）：给岛画特性曲线 + 工作点用。 */
export function pumpCurve(): { speeds: number[]; efficiency: number[]; flow: number[] } {
  const speeds = Array.from({ length: 14 }, (_, index) => round2(0.35 + index * 0.05));
  return {
    speeds,
    efficiency: speeds.map((speed) => round2(pumpEfficiency(speed) * 100)),
    flow: speeds.map((speed) => Math.round(2400 * speed)),
  };
}

/** 表格行（列 key 与页面 `columns` 对齐） */
export function pumpRows(stations: PumpStationData[]): Array<Record<string, string>> {
  return stations.flatMap((station) =>
    station.pumps.map((pump) => ({
      id: pump.id,
      tag: pump.tag,
      name: pump.name,
      station: station.name,
      role: pump.role === 'duty' ? '工作泵' : '备用泵',
      medium: pump.medium,
      flow: `${pump.flow.toFixed(0)} m³/h`,
      head: `${pump.head.toFixed(1)} m`,
      speed: `${Math.round(pump.speed * 100)}%`,
      efficiency: `${Math.round(pump.efficiency * 100)}%`,
      power: `${pump.power.toFixed(1)} kW`,
      specific: `${pump.specificEnergy.toFixed(2)}`,
      starts: `${pump.starts} 次`,
      runtime: `${pump.runtimeH.toFixed(1)} h`,
      state: pump.running ? '运行' : '备用',
    }))
  );
}

/* ------------------------------------------------------------------ 内部 */

/** 集水井液位的起点：来水越多、泵抽升能力越弱，液位越高。 */
function levelFromDemand(demand: number, stationId: string): number {
  const capacityPerStation: Record<string, number> = { inlet: 2400, return: 2400, sludge: 60 };
  const capacity = capacityPerStation[stationId] || 1;
  const ratio = capacity > 0 ? demand / capacity : 0;
  return clamp(0.35 + ratio * 0.45, SUMP_LEVEL_LOW, SUMP_LEVEL_HIGH);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
