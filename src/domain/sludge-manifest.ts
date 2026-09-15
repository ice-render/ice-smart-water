/**
 * 污泥处理与处置：**产泥 → 浓缩 → 脱水 → 泥饼外运 → 联单归档**。
 *
 * 与 `process-model` 的分工：那边算的是**生物池产泥**（剩余污泥体积流量、干泥产量 tDS/d），
 * 这里管的是产泥**出门**这一段 —— 沿流程把湿泥量按含水率逐段折算，再按车次生成**转移联单**
 * （固体废物转移联单的简化版：签发 → 过磅 → 签收 → 归档）。
 *
 * 单位口径：湿泥 `m³/d`、干泥 `tDS/d`、含水率 `0~1`、药耗 `kg/tDS`、成本 `元/tDS`。
 *
 * 质量守恒口径：沿流程**干泥量不变**（忽略脱水机的固体流失），湿泥量随含水率下降而收缩 ——
 * 所以「浓缩 992 m³/d → 脱水 39.7 m³/d」是同一份干泥的两种含水率表达，不是凭空少的泥。
 */
import { createRandom } from './daily-profile';
import type { SludgeBalance } from './process-model';

/** 剩余污泥（进浓缩池）含水率：二沉池底流典型 99.2% */
export const RAW_SLUDGE_WATER_RATE = 0.992;
/** 重力浓缩后含水率（典型 96~98%） */
export const THICKENED_WATER_RATE = 0.97;
/** 脱水后泥饼含水率上限（处置常见要求 ≤80%） */
export const CAKE_WATER_RATE_MAX = 0.8;
/** PAM（聚丙烯酰胺）单耗区间，kg/tDS */
export const PAM_RANGE: [number, number] = [3, 6];
/** 本厂 PAM 单耗取值，kg/tDS（确定性常量，落在区间内） */
export const PAM_UNIT = 4.2;
/** 一车泥饼的载重，t（湿泥） */
export const TRUCK_LOAD_WET_T = 12;
/** 外运处置单价区间，元/tDS */
export const DISPOSAL_PRICE: [number, number] = [180, 320];
/** 本厂处置单价取值，元/tDS（确定性常量，落在区间内） */
export const DISPOSAL_UNIT_PRICE = 240;
/** 默认生成多少张联单（一天的出车次数上限，避免表格过长） */
export const MANIFEST_LIMIT = 8;

/** 外运接收单位（演示数据） */
export const RECEIVERS = ['市污泥处置中心（干化焚烧）', '绿源建材（制砖掺料）', '沃土农资（堆肥）'];
/** 运输车号（演示数据） */
export const TRUCKS = ['苏A·W1207', '苏A·W3391', '苏A·W5528', '苏A·W6714'];

export type SludgeStage = {
  id: string;
  name: string;
  /** 该环节的湿泥量 m³/d */
  wetFlow: number;
  /** 含水率 0~1 */
  waterRate: number;
  /** 该环节的干泥量 tDS/d（沿流程恒定） */
  dryFlow: number;
  note: string;
};

/** 沿流程的三个环节：进浓缩池 → 浓缩后 → 脱水后（泥饼）。 */
export function sludgeStages(sludge: SludgeBalance): SludgeStage[] {
  const dry = Number(sludge.drySludge) || 0;
  return [
    {
      id: 'raw',
      name: '剩余污泥',
      wetFlow: round2(wetFlowOf(dry, RAW_SLUDGE_WATER_RATE)),
      waterRate: RAW_SLUDGE_WATER_RATE,
      dryFlow: round2(dry),
      note: '二沉池底流 · 进浓缩池',
    },
    {
      id: 'thickened',
      name: '浓缩污泥',
      wetFlow: round2(wetFlowOf(dry, THICKENED_WATER_RATE)),
      waterRate: THICKENED_WATER_RATE,
      dryFlow: round2(dry),
      note: '重力浓缩 · 体积缩到约 1/4',
    },
    {
      id: 'cake',
      name: '脱水泥饼',
      wetFlow: round2(wetFlowOf(dry, CAKE_WATER_RATE_MAX)),
      waterRate: CAKE_WATER_RATE_MAX,
      dryFlow: round2(dry),
      note: '离心脱水 + PAM 调理 · 外运',
    },
  ];
}

export type SludgeKpi = {
  /** 干泥产量 tDS/d */
  drySludge: number;
  /** 泥饼量（湿）m³/d */
  cakeVolume: number;
  /** 泥饼含水率 0~1 */
  waterRate: number;
  /** PAM 单耗 kg/tDS */
  pamUnit: number;
  /** PAM 日耗 kg/d */
  pamDaily: number;
  /** 需外运车次（按 12t/车） */
  trucks: number;
  /** 已归档联单数 */
  closed: number;
  /** 联单总数 */
  total: number;
  /** 联单闭合率 0~1 */
  closureRate: number;
  /** 外运泥饼净重合计 t */
  shippedWet: number;
  /** 日处置成本 元/d */
  cost: number;
  /** 处置单价 元/tDS */
  unitPrice: number;
};

export function sludgeKpi(sludge: SludgeBalance, manifests: SludgeManifest[] = []): SludgeKpi {
  const dry = Number(sludge.drySludge) || 0;
  const cake = wetFlowOf(dry, CAKE_WATER_RATE_MAX);
  const total = manifests.length;
  const closed = manifests.filter((item) => item.status === 'closed').length;
  return {
    drySludge: round2(dry),
    cakeVolume: round2(cake),
    waterRate: CAKE_WATER_RATE_MAX,
    pamUnit: PAM_UNIT,
    pamDaily: round2(dry * PAM_UNIT),
    trucks: Math.max(1, Math.ceil(cake / TRUCK_LOAD_WET_T)),
    closed,
    total,
    closureRate: total ? round2(closed / total) : 0,
    shippedWet: round2(manifests.reduce((sum, item) => sum + item.wetTon, 0)),
    cost: Math.round(dry * DISPOSAL_UNIT_PRICE),
    unitPrice: DISPOSAL_UNIT_PRICE,
  };
}

export type ManifestStatus = 'issued' | 'weighed' | 'signed' | 'closed';

export const MANIFEST_STATUS_LABELS: Record<ManifestStatus, string> = {
  issued: '已签发',
  weighed: '已过磅',
  signed: '已签收',
  closed: '已归档',
};

/** 联单状态推进顺序（`advanceManifest` 按它往后走一步） */
export const MANIFEST_STATUS_ORDER: ManifestStatus[] = ['issued', 'weighed', 'signed', 'closed'];

export type ManifestAction = { at: string; by: string; text: string };

export type SludgeManifest = {
  /** 联单号 */
  id: string;
  /** 出库时刻 HH:mm */
  issuedAt: string;
  /** 车号 */
  truck: string;
  /** 接收单位 */
  receiver: string;
  /** 过磅净重 t（湿泥） */
  wetTon: number;
  /** 折算干泥 tDS */
  dryTon: number;
  /** 含水率 0~1 */
  waterRate: number;
  /** 本车对应 PAM 药耗 kg */
  pamKg: number;
  status: ManifestStatus;
  /** 处置轨迹（第一条是系统生成） */
  actions: ManifestAction[];
};

/**
 * 生成当日联单（**确定性**：同 seed 同结果，e2e 可复现）。
 *
 * 前几张已归档、往后依次是已签收 / 已过磅 / 已签发 —— 正好覆盖四种状态，
 * 让表格与状态机都有东西可看。
 */
export function buildManifests(sludge: SludgeBalance, seed = 20260914): SludgeManifest[] {
  const random = createRandom(seed);
  const dry = Number(sludge.drySludge) || 0;
  const cake = wetFlowOf(dry, CAKE_WATER_RATE_MAX);
  const count = Math.max(1, Math.min(MANIFEST_LIMIT, Math.ceil(cake / TRUCK_LOAD_WET_T)));
  const perTruck = cake / count;
  const list: SludgeManifest[] = [];
  for (let index = 0; index < count; index += 1) {
    // 越靠后越"新"（状态越靠前）：index 0 已归档，最后一张刚签发
    const status = MANIFEST_STATUS_ORDER[Math.max(0, MANIFEST_STATUS_ORDER.length - 1 - Math.min(index, 3))];
    const wetTon = round2(perTruck * (0.9 + random() * 0.2));
    const hour = 8 + index;
    const at = `${String(hour).padStart(2, '0')}:${String(Math.floor(random() * 60)).padStart(2, '0')}`;
    list.push({
      id: `WN-${seed.toString().slice(-4)}-${String(index + 1).padStart(2, '0')}`,
      issuedAt: at,
      truck: TRUCKS[index % TRUCKS.length],
      receiver: RECEIVERS[index % RECEIVERS.length],
      wetTon,
      dryTon: round2(wetTon * (1 - CAKE_WATER_RATE_MAX)),
      waterRate: CAKE_WATER_RATE_MAX,
      pamKg: round2(wetTon * (1 - CAKE_WATER_RATE_MAX) * PAM_UNIT),
      status,
      actions: actionsFor(status, at),
    });
  }
  return list;
}

/**
 * 推进一张联单（**不改原数组**，与 `alarm-log` 的 `ackAlarm/closeAlarm` 同范式）。
 * 已归档的联单原样返回（不可再推进）。
 */
export function advanceManifest(list: SludgeManifest[], id: string, by: string): SludgeManifest[] {
  return list.map((item) => {
    if (item.id !== id) return item;
    const current = MANIFEST_STATUS_ORDER.indexOf(item.status);
    const next = MANIFEST_STATUS_ORDER[Math.min(MANIFEST_STATUS_ORDER.length - 1, current + 1)];
    if (next === item.status) return item;
    return {
      ...item,
      status: next,
      actions: item.actions.concat({ at: item.issuedAt, by, text: MANIFEST_STATUS_LABELS[next] }),
    };
  });
}

/** 表格行（列 key 与页面 `columns` 对齐） */
export function manifestRows(list: SludgeManifest[]): Array<Record<string, string>> {
  return list.map((item) => ({
    id: item.id,
    issuedAt: item.issuedAt,
    truck: item.truck,
    receiver: item.receiver,
    wetTon: item.wetTon.toFixed(1),
    dryTon: item.dryTon.toFixed(2),
    waterRate: `${Math.round(item.waterRate * 1000) / 10}%`,
    pamKg: item.pamKg.toFixed(1),
    status: MANIFEST_STATUS_LABELS[item.status],
    action: item.status === 'closed' ? '已归档' : '推进',
  }));
}

/** 联单状态分布（状态机 / 统计用） */
export function summarizeManifests(list: SludgeManifest[]): Record<ManifestStatus, number> {
  const out: Record<ManifestStatus, number> = { issued: 0, weighed: 0, signed: 0, closed: 0 };
  list.forEach((item) => {
    out[item.status] += 1;
  });
  return out;
}

/* ------------------------------------------------------------------ 内部 */

/** 由干泥量 + 含水率反算湿泥量：湿 = 干 / (1 - 含水率) */
function wetFlowOf(dry: number, waterRate: number): number {
  const solid = 1 - waterRate;
  return solid > 0 ? dry / solid : 0;
}

function actionsFor(status: ManifestStatus, at: string): ManifestAction[] {
  const steps: ManifestAction[] = [{ at, by: '系统', text: '联单签发（脱水机房出库）' }];
  const upto = MANIFEST_STATUS_ORDER.indexOf(status);
  if (upto >= 1) steps.push({ at, by: '地磅房', text: '过磅称重' });
  if (upto >= 2) steps.push({ at, by: '接收单位', text: '双方签收' });
  if (upto >= 3) steps.push({ at, by: '环保台账', text: '联单归档' });
  return steps;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
