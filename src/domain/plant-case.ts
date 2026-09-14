/**
 * 示范厂案例：10 万 m³/d 市政污水厂（AAO + 混凝沉淀 + 滤布滤池 + 消毒）。
 *
 * 这里放的是**业务数据**，不是画图代码：
 * - 单元清单（工艺专业关心的设计参数：设计流量、有效容积、面积、装机功率、水头损失）；
 * - 管线清单（介质 + 公称管径，给排水图纸的通行标注）；
 * - 全厂工艺参数（回流比、污泥产率、需氧量系数、运行负荷系数）。
 *
 * 视图层拿这份数据去"画图"（ice-entity-designer），拿它算水量 / 负荷 / 水质（本目录的模型）。
 * 图上的坐标只是**初始布置**，用户拖动不会回头改这里 —— 案例只是"默认打开的那张图"。
 *
 * ⚠️ 设计参数为**演示取值**（量级与工程惯例一致，便于演示数值分布），不构成工程依据。
 */
import type { WaterMedium, WaterSymbolKind } from 'ice-entity-designer';
import { TYPICAL_INFLUENT, type WaterQuality } from './water-quality';
import type { PlantGraph, PlantPipe, PlantNode } from './plant-graph';

/** 单元的设计参数（工艺专业的核心数据） */
export type UnitDesign = {
  /** 设计流量 m³/d。0 = 不过水（鼓风机、加药装置这类辅助设备） */
  flow: number;
  /** 有效容积 m³。0 = 无池容 */
  volume: number;
  /** 单池 / 单组面积 m²。用于沉淀类单元算表面负荷 */
  area: number;
  /** 装机功率 kW */
  power: number;
  /** 水头损失估算 m */
  headLoss: number;
};

export type PlantUnitSpec = {
  id: string;
  kind: WaterSymbolKind;
  name: string;
  /** 位号（行业习惯代号 + 区域码 + 序号） */
  tag: string;
  left: number;
  top: number;
  design: UnitDesign;
};

export type PlantPipeSpec = {
  id: string;
  sourceId: string;
  targetId: string;
  medium: WaterMedium;
  dn: string;
  sourcePort?: string;
  targetPort?: string;
};

export type PlantMeta = {
  id: string;
  name: string;
  /** 设计规模 m³/d */
  capacity: number;
  processRoute: string;
  standard: string;
  /** 回流污泥比 R = 回流污泥量 / 进水流量 */
  sludgeReturnRatio: number;
  /** 混合液内回流比 r = 内回流量 / 进水流量（AAO 脱氮的关键参数） */
  mixedLiquorRecycleRatio: number;
  /** 污泥产率系数 Y，kgVSS / kgBOD₅（含内源衰减后的净产率） */
  sludgeYield: number;
  /** 回流污泥浓度 Xr，mg/L（二沉池底流） */
  returnSludgeConcentration: number;
  /** 全厂运行负荷系数：装机功率 → 实际运行功率 */
  powerLoadFactor: number;
  /** 需氧量系数：合成项 a'（kgO₂/kgBOD₅）+ 内源呼吸项 b'（kgO₂/(kgMLSS·d)） */
  oxygenCoefficients: { synthesis: number; endogenous: number };
  /** 硝化需氧量系数，kgO₂ / kgN（氨氮完全硝化理论值 4.57） */
  nitrificationOxygen: number;
  influent: WaterQuality;
  /** 设计出水水质（工艺设计目标，严于排放标准） */
  effluentDesign: WaterQuality;
};

export type PlantCase = {
  meta: PlantMeta;
  units: PlantUnitSpec[];
  pipes: PlantPipeSpec[];
};

export function design(partial: Partial<UnitDesign> = {}): UnitDesign {
  return { flow: 0, volume: 0, area: 0, power: 0, headLoss: 0, ...partial };
}

/**
 * 平时处于关闭位置的阀门（业务约定）。
 *
 * 超越管、联络管这类**备用通路**的阀门平时是关的 —— 这跟"默认全开"不是一回事：
 * 走线时它们要被降优先级（主线能通就不走备用线），工况复位时也要回到关位。
 * 所以必须显式列出来，而不是靠"阀门都默认开"。
 */
export const NORMALLY_CLOSED_VALVES: string[] = [
  /** 初沉池超越阀：雨季水量大时才开 */
  'bypassValve',
  /** 事故水回流阀：出水超标时才开，把水切入事故池 */
  'accidentValve',
];

/** 生物池（AAO 三段）：算污泥龄、容积负荷、总 HRT 时只认这三种 */
export const BIOLOGICAL_TANK_KINDS: WaterSymbolKind[] = ['anaerobicTank', 'anoxicTank', 'aerobicTank'];

/** 会产出剩余污泥的单元 */
export const SLUDGE_SOURCE_KINDS: WaterSymbolKind[] = ['primaryClarifier', 'secondaryClarifier'];

/**
 * 各处理单元的**目标去除率**（业务经验值）。
 *
 * 取值口径：城市污水厂的常规运行水平，不是极限值 —— 这样算出来的出水水质
 * 落在设计出水附近，运行监视看板才有意义（否则永远"远远达标"，看不出波动）。
 *
 * 两条自洽性约束（改数之前先看这两条，否则模型会自相矛盾）：
 * 1. **总氮的去除率上界由回流比决定**：AAO 的理论脱氮率 = (R+r)/(1+R+r)。
 *    本厂 R=100%、r=200% → 上界 75%；下表连乘得到的脱氮率约 74.8%，正好贴着上界 ——
 *    这也是"一级 A 里总氮最难达标"在模型里的体现（六项里它裕度最小）。
 * 2. 生物除磷 + 化学除磷要能兜住总磷：厌氧段释磷只能到 65% 左右，
 *    剩下靠混凝沉淀的化学除磷（90%）压到 0.2 mg/L 量级。
 */
export const UNIT_REMOVAL: Partial<Record<WaterSymbolKind, Partial<WaterQuality>>> = {
  barScreen: { SS: 0.05, COD: 0.05 },
  gritChamber: { SS: 0.03 },
  primaryClarifier: { SS: 0.55, COD: 0.3, BOD5: 0.3, TP: 0.1 },
  anaerobicTank: { COD: 0.1, TP: 0.35 },
  anoxicTank: { TN: 0.65, COD: 0.15 },
  aerobicTank: { COD: 0.7, BOD5: 0.92, NH3N: 0.9, TN: 0.2 },
  secondaryClarifier: { SS: 0.85, COD: 0.15, BOD5: 0.1, TN: 0.1 },
  coagulationTank: { TP: 0.9, SS: 0.45, COD: 0.2, BOD5: 0.1 },
  filterBed: { SS: 0.7, COD: 0.1, TP: 0.3, BOD5: 0.15 },
  disinfectionTank: {},
};

const Q = 100000;

/**
 * 示范厂：10 万 m³/d AAO 市政污水厂。
 *
 * 布置三行一列（水线主线 / 深度处理 / 污泥线），另加一条**初沉池超越管**（雨季用）
 * 与鼓风机、加药装置两组辅助设备。
 */
export const SEWAGE_PLANT: PlantCase = {
  meta: {
    id: 'WWTP-100K',
    name: '示范厂 10 万 m³/d 市政污水厂',
    capacity: Q,
    processRoute: 'AAO + 混凝沉淀 + 滤布滤池 + 消毒',
    standard: 'GB 18918-2002 一级 A',
    sludgeReturnRatio: 1.0,
    mixedLiquorRecycleRatio: 2.0,
    sludgeYield: 0.75,
    returnSludgeConcentration: 8000,
    powerLoadFactor: 0.85,
    oxygenCoefficients: { synthesis: 0.6, endogenous: 0.06 },
    nitrificationOxygen: 4.57,
    influent: { ...TYPICAL_INFLUENT },
    effluentDesign: { COD: 35, BOD5: 8, SS: 8, NH3N: 3, TN: 12, TP: 0.4 },
  },
  units: [
    // ---- 第一行：预处理 + 生化 + 二沉池 ----
    { id: 'inlet', kind: 'inlet', name: '厂外进水', tag: 'IN', left: 30, top: 120, design: design({ flow: Q }) },
    { id: 'pump', kind: 'pump', name: '进水泵', tag: 'P-101', left: 130, top: 128, design: design({ flow: Q, power: 180 }) },
    { id: 'screen', kind: 'barScreen', name: '细格栅', tag: 'GR-101', left: 240, top: 120, design: design({ flow: Q, power: 4, headLoss: 0.15 }) },
    { id: 'grit', kind: 'gritChamber', name: '曝气沉砂池', tag: 'GC-101', left: 400, top: 120, design: design({ flow: Q, volume: 600, power: 22, headLoss: 0.2 }) },
    { id: 'primary', kind: 'primaryClarifier', name: '初沉池', tag: 'PC-101', left: 600, top: 120, design: design({ flow: Q, volume: 5000, area: 1600, power: 12, headLoss: 0.3 }) },
    { id: 'ana', kind: 'anaerobicTank', name: '厌氧池', tag: 'AT-101', left: 790, top: 120, design: design({ volume: 5200, power: 15, headLoss: 0.1 }) },
    { id: 'anx', kind: 'anoxicTank', name: '缺氧池', tag: 'AX-101', left: 950, top: 120, design: design({ volume: 7800, power: 20, headLoss: 0.1 }) },
    { id: 'aer', kind: 'aerobicTank', name: '好氧池', tag: 'AE-101', left: 1130, top: 120, design: design({ volume: 20800, power: 60, headLoss: 0.2 }) },
    { id: 'sec', kind: 'secondaryClarifier', name: '二沉池', tag: 'SC-101', left: 1340, top: 120, design: design({ volume: 14700, area: 4200, power: 60, headLoss: 0.3 }) },

    // ---- 第二行：深度处理 + 出水 ----
    { id: 'dosing', kind: 'dosingUnit', name: '加药装置', tag: 'DU-101', left: 210, top: 400, design: design({ power: 12 }) },
    { id: 'coag', kind: 'coagulationTank', name: '混凝沉淀池', tag: 'CO-101', left: 400, top: 400, design: design({ volume: 4200, area: 2200, power: 18, headLoss: 0.3 }) },
    { id: 'filter', kind: 'filterBed', name: '滤布滤池', tag: 'FL-101', left: 620, top: 400, design: design({ volume: 1500, area: 600, power: 25, headLoss: 0.8 }) },
    { id: 'disinfect', kind: 'disinfectionTank', name: '消毒接触池', tag: 'DT-101', left: 820, top: 400, design: design({ volume: 2400, power: 8, headLoss: 0.2 }) },
    { id: 'analyzer', kind: 'analyzer', name: '在线水质监测', tag: 'AIT-101', left: 1010, top: 400, design: design({ power: 2 }) },
    { id: 'meter', kind: 'flowMeter', name: '出水计量', tag: 'FIT-101', left: 1110, top: 400, design: design({ power: 1 }) },
    { id: 'outletValve', kind: 'valve', name: '出水阀', tag: 'V-101', left: 1210, top: 400, design: design() },
    { id: 'outlet', kind: 'outlet', name: '排放口', tag: 'OUT', left: 1320, top: 400, design: design({ flow: Q }) },

    // ---- 第三行：污泥线 ----
    { id: 'returnPump', kind: 'submersiblePump', name: '回流污泥泵', tag: 'P-SB-101', left: 1060, top: 292, design: design({ flow: Q, power: 45 }) },
    { id: 'thickener', kind: 'sludgeThickener', name: '污泥浓缩池', tag: 'ST-101', left: 440, top: 660, design: design({ volume: 900, area: 300, power: 6, headLoss: 0.5 }) },
    { id: 'dewater', kind: 'dewateringMachine', name: '污泥脱水机', tag: 'DW-101', left: 660, top: 660, design: design({ power: 90, headLoss: 0.5 }) },
    { id: 'screwPump', kind: 'screwPump', name: '污泥输送螺杆泵', tag: 'P-SC-101', left: 762, top: 692, design: design({ power: 15 }) },
    { id: 'sludgeSilo', kind: 'sludgeSilo', name: '污泥料仓', tag: 'SIL-101', left: 880, top: 652, design: design({ volume: 120, power: 4 }) },
    { id: 'sludgeOut', kind: 'sludgeOut', name: '污泥外运', tag: 'SO-101', left: 1020, top: 672, design: design() },
    { id: 'deodorizer', kind: 'deodorizer', name: '除臭装置', tag: 'OD-101', left: 430, top: 806, design: design({ volume: 400, power: 30 }) },

    // ---- 串联元件与仪表（自控阀门 / 在线仪表 / 变频器）----
    { id: 'checkValve', kind: 'checkValve', name: '出水止回阀', tag: 'CV-101', left: 185, top: 128, design: design({ flow: Q, headLoss: 0.1 }) },
    { id: 'recycleValve', kind: 'motorValve', name: '内回流调节阀', tag: 'MOV-102', left: 1030, top: 36, design: design({ flow: Q * 2 }) },
    { id: 'accidentValve', kind: 'motorValve', name: '事故水回流阀', tag: 'MOV-101', left: 1150, top: 520, design: design() },
    { id: 'levelGauge', kind: 'levelGauge', name: '事故池液位计', tag: 'LT-101', left: 1082, top: 476, design: design() },
    { id: 'pressureGauge', kind: 'pressureGauge', name: '供气干管压力表', tag: 'PT-101', left: 1070, top: -70, design: design() },
    { id: 'vfd', kind: 'vfd', name: '鼓风机变频器', tag: 'VFD-101', left: 1204, top: -62, design: design() },

    // ---- 事故水支路（出水超标时切入，再回流到生化工段）----
    { id: 'accidentTank', kind: 'storageTank', name: '事故池', tag: 'EQ-101', left: 970, top: 520, design: design({ volume: 8000, area: 1200 }) },
    { id: 'accidentPump', kind: 'submersiblePump', name: '事故水回流泵', tag: 'P-SB-102', left: 838, top: 528, design: design({ power: 22 }) },

    // ---- 辅助设备与超越管阀门 ----
    { id: 'blower', kind: 'blower', name: '鼓风机', tag: 'B-201', left: 1130, top: -60, design: design({ power: 780 }) },
    { id: 'bypassValve', kind: 'valve', name: '初沉池超越阀', tag: 'V-102', left: 700, top: 265, design: design() },
  ],
  pipes: [
    // 水线主线（预处理 → 生化 → 二沉池）
    { id: 'pipe-inlet-pump', sourceId: 'inlet', targetId: 'pump', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-pump-check', sourceId: 'pump', targetId: 'checkValve', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-check-screen', sourceId: 'checkValve', targetId: 'screen', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-screen-grit', sourceId: 'screen', targetId: 'grit', medium: 'sewage', dn: 'DN800' },
    { id: 'pipe-grit-primary', sourceId: 'grit', targetId: 'primary', medium: 'sewage', dn: 'DN700' },
    { id: 'pipe-primary-ana', sourceId: 'primary', targetId: 'ana', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-ana-anx', sourceId: 'ana', targetId: 'anx', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-anx-aer', sourceId: 'anx', targetId: 'aer', medium: 'sewage', dn: 'DN600' },
    { id: 'pipe-aer-sec', sourceId: 'aer', targetId: 'sec', medium: 'sewage', dn: 'DN600' },
    // 深度处理（二沉池出水 → 混凝 → 滤池 → 消毒 → 监测 → 排放）
    { id: 'pipe-sec-coag', sourceId: 'sec', targetId: 'coag', medium: 'effluent', dn: 'DN500', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-coag-filter', sourceId: 'coag', targetId: 'filter', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-filter-disinfect', sourceId: 'filter', targetId: 'disinfect', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-disinfect-analyzer', sourceId: 'disinfect', targetId: 'analyzer', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-analyzer-meter', sourceId: 'analyzer', targetId: 'meter', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-meter-valve', sourceId: 'meter', targetId: 'outletValve', medium: 'effluent', dn: 'DN500' },
    { id: 'pipe-valve-outlet', sourceId: 'outletValve', targetId: 'outlet', medium: 'effluent', dn: 'DN500' },

    // 事故水支路：出水超标时开事故阀 → 事故池 → 回流泵 → 生物池（平时阀门常闭）
    // 接入点选在消毒池之后、在线监测之前：计量点之后再分叉会让"出水路径"绕开在线监测（图纸校验会拦）
    { id: 'pipe-disinfect-accident', sourceId: 'disinfect', targetId: 'accidentValve', medium: 'effluent', dn: 'DN400' },
    { id: 'pipe-accident-tank', sourceId: 'accidentValve', targetId: 'accidentTank', medium: 'effluent', dn: 'DN400' },
    { id: 'pipe-tank-accidentPump', sourceId: 'accidentTank', targetId: 'accidentPump', medium: 'returnSludge', dn: 'DN400' },
    { id: 'pipe-accidentPump-ana', sourceId: 'accidentPump', targetId: 'ana', medium: 'returnSludge', dn: 'DN400' },
    // 回流（AAO 的两条命脉）
    { id: 'pipe-aer-recycleValve', sourceId: 'aer', targetId: 'recycleValve', medium: 'recycle', dn: 'DN300', sourcePort: 'T', targetPort: 'B' },
    { id: 'pipe-recycleValve-anx', sourceId: 'recycleValve', targetId: 'anx', medium: 'recycle', dn: 'DN300', sourcePort: 'T', targetPort: 'T' },
    { id: 'pipe-sec-returnPump', sourceId: 'sec', targetId: 'returnPump', medium: 'returnSludge', dn: 'DN200', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-returnPump-ana', sourceId: 'returnPump', targetId: 'ana', medium: 'returnSludge', dn: 'DN200', sourcePort: 'L', targetPort: 'B' },
    // 污泥线
    { id: 'pipe-sec-thickener', sourceId: 'sec', targetId: 'thickener', medium: 'sludge', dn: 'DN200', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-thickener-dewater', sourceId: 'thickener', targetId: 'dewater', medium: 'sludge', dn: 'DN200' },
    { id: 'pipe-dewater-screw', sourceId: 'dewater', targetId: 'screwPump', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-screw-silo', sourceId: 'screwPump', targetId: 'sludgeSilo', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-silo-out', sourceId: 'sludgeSilo', targetId: 'sludgeOut', medium: 'sludge', dn: 'DN150' },
    { id: 'pipe-dewater-deodor', sourceId: 'dewater', targetId: 'deodorizer', medium: 'air', dn: 'DN300' },

    // 信号线与动力线（不是管道，没有管径）：仪表 / 变频器要画出来接在哪
    { id: 'pipe-tank-level', sourceId: 'accidentTank', targetId: 'levelGauge', medium: 'signal', dn: '' },
    { id: 'pipe-blower-pressure', sourceId: 'blower', targetId: 'pressureGauge', medium: 'signal', dn: '' },
    { id: 'pipe-vfd-blower', sourceId: 'vfd', targetId: 'blower', medium: 'power', dn: '' },
    // 辅助管线
    { id: 'pipe-blower-aer', sourceId: 'blower', targetId: 'aer', medium: 'air', dn: 'DN100', sourcePort: 'B', targetPort: 'T' },
    { id: 'pipe-dosing-coag', sourceId: 'dosing', targetId: 'coag', medium: 'chemical', dn: 'DN25' },
    // 雨季超越管（正常运行时阀门关闭，管线仍在图上）
    { id: 'pipe-grit-bypass', sourceId: 'grit', targetId: 'bypassValve', medium: 'sewage', dn: 'DN600', sourcePort: 'R', targetPort: 'T' },
    { id: 'pipe-bypass-ana', sourceId: 'bypassValve', targetId: 'ana', medium: 'sewage', dn: 'DN600', sourcePort: 'T', targetPort: 'B' },
  ],
};

/** 案例 → 业务图描述（不含阀门状态：那是运行工况的事） */
export function toPlantGraph(plant: PlantCase = SEWAGE_PLANT): PlantGraph {
  const nodes: PlantNode[] = plant.units.map((unit) => ({
    id: unit.id,
    kind: unit.kind,
    name: unit.name,
    tag: unit.tag,
    valveState: unit.kind === 'valve' ? 'open' : undefined,
    idle: false,
  }));
  const pipes: PlantPipe[] = plant.pipes.map((pipe) => ({
    id: pipe.id,
    sourceId: pipe.sourceId,
    targetId: pipe.targetId,
    medium: pipe.medium,
    dn: pipe.dn,
  }));
  return { nodes, pipes };
}

/** 单元 id → 设计参数（按 id 取值，因为同一 kind 可能出现多次，例如两台阀） */
export function designMap(plant: PlantCase = SEWAGE_PLANT): Record<string, UnitDesign> {
  const map: Record<string, UnitDesign> = {};
  plant.units.forEach((unit) => {
    map[unit.id] = unit.design;
  });
  return map;
}

/** kind → 预设位号（位号规则用，取案例里第一个该 kind 的位号前缀） */
export function tagPrefixOf(tag: string): string {
  const index = String(tag || '').lastIndexOf('-');
  return index > 0 ? tag.slice(0, index) : String(tag || '');
}
