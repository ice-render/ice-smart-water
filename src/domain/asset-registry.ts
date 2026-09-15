/**
 * 设备资产全生命周期：**台账 / 健康度 / 维保计划 / 备件库存**。
 *
 * 台账**直接从厂站的 34 个工艺单元派生**（`SEWAGE_PLANT.units` —— 图上有几个单元，就有几台设备），
 * 所以"图"和"账"永远对得上：图上删掉一个单元，台账第二天就少一条。
 *
 * 所有"看起来像历史数据"的字段（型号 / 供应商 / 投运日 / 健康度 / 累计运行小时）
 * 都由 `hashOf(unit.id)` **确定性**生成 —— 同一个单元永远同一份账，e2e 可复现。
 *
 * 单位口径：功率 `kW`、健康度 `0~100`、MTBF / MTTR `h`、可用率 `0~1`。
 */
import type { WaterSymbolKind } from 'ice-entity-designer';
import { SEWAGE_PLANT, designMap, type UnitDesign } from './plant-case';
import { SYMBOL_CATALOG } from './symbol-catalog';

/** 台账只需要单元的这四个字段 —— 所以既吃得下 `SEWAGE_PLANT.units`，也吃得下图上实时读出来的节点。 */
export type AssetUnitLike = { id: string; kind: WaterSymbolKind; name: string; tag: string };

/** 健康度的五个观测维度（列是维度、行是装置分类） */
export const HEALTH_DIMS = ['运行工况', '润滑', '振动', '密封', '电气'];

/** 健康度分档：良好 / 关注 / 预警 */
export const HEALTH_BANDS: Array<{ min: number; label: string; status: string }> = [
  { min: 85, label: '良好', status: 'success' },
  { min: 70, label: '关注', status: 'warning' },
  { min: 0, label: '预警', status: 'error' },
];

/** 供应商（演示数据） */
export const VENDORS = ['南方泵业', '中环装备', '博天环境', '格兰富', '景津装备', '中大贝莱特'];

/** 型号代号：按单元 kind 拼一个像样的型号串 */
export const MODEL_BY_CATEGORY: Record<string, string> = {
  water: 'WS',
  sludge: 'SD',
  equipment: 'EQ',
  boundary: 'BD',
};

/** 装置分类（台账分组 / 热力图的行） */
export const ASSET_CATEGORY_LABELS: Record<string, string> = {
  water: '水线处理装置',
  sludge: '污泥线装置',
  equipment: '设备与仪表',
  boundary: '边界装置',
};

export type SparePart = {
  name: string;
  required: number;
  inStock: number;
  /** 是否齐套 */
  ok: boolean;
};

export type MaintenancePlan = {
  /** 周期（天）：月度 30 / 季度 90 / 年度 365 */
  intervalDays: number;
  label: string;
  /** 上次保养日 YYYY-MM-DD */
  lastAt: string;
  /** 下次到期日 YYYY-MM-DD */
  nextAt: string;
  /** 是否已到期（nextAt <= today） */
  due: boolean;
  /** 是否已完成本次（演示：未到期的都算已完成） */
  done: boolean;
};

export type AssetRecord = {
  id: string;
  tag: string;
  name: string;
  kind: string;
  category: string;
  /** 型号 */
  model: string;
  vendor: string;
  /** 投运日 YYYY-MM-DD */
  commissionedAt: string;
  /** 已运行小时 h */
  runningHours: number;
  /** 装机功率 kW */
  power: number;
  /** 关键度：承接主要负荷的设备 */
  criticality: 'high' | 'normal';
  /** 综合健康度 0~100 */
  health: number;
  /** 分维度健康度（顺序同 HEALTH_DIMS） */
  healthByDim: number[];
  /** 平均无故障时间 h */
  mtbfH: number;
  /** 平均修复时间 h */
  mttrH: number;
  /** 可用率 0~1 */
  availability: number;
  maintenance: MaintenancePlan;
  spares: SparePart[];
};

export type AssetKpi = {
  total: number;
  /** 完好率（健康度 ≥70 的占比） */
  intactRate: number;
  /** 可用率（按设备加权平均） */
  availability: number;
  /** 平均 MTBF h */
  mtbfH: number;
  /** 平均 MTTR h */
  mttrH: number;
  /** 维保计划完成率 */
  maintenanceRate: number;
  /** 备件齐套率 */
  spareRate: number;
  /** 预警设备数（健康度 <70） */
  risky: number;
  /** 关键设备数 */
  critical: number;
};

/** 台账"今天"（演示基准日，写死以保证可复现） */
export const ASSET_TODAY = '2026-09-15';

/** 由单元 id 派生一个稳定的 0~1 数（同 id 同结果 → 台账可复现）。 */
export function hashOf(id: string): number {
  let hash = 2166136261;
  const text = String(id);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967296;
}

/**
 * 工艺单元 → 设备台账。
 *
 * 入参收成「单元四字段 + 设计参数表」而不是 `PlantCase` —— 这样入口可以直接把**图上实时读到的节点**
 * （`graphOfDesigner` 的结果）喂进来，台账跟着图纸走；单测不传则用示范厂案例。
 */
export function buildAssetRegistry(
  units: AssetUnitLike[] = SEWAGE_PLANT.units,
  designs: Record<string, UnitDesign> = designMap(),
  today = ASSET_TODAY
): AssetRecord[] {
  const list = (units || []).filter((unit) => !isBoundary(unit));
  return list.map((unit) => buildAsset(unit, designs, today));
}

/** 综合健康度 → 分档标签与状态色 */
export function healthBand(health: number): { label: string; status: string } {
  const band = HEALTH_BANDS.filter((item) => health >= item.min)[0];
  return { label: band.label, status: band.status };
}

export function assetKpi(assets: AssetRecord[]): AssetKpi {
  const total = assets.length;
  if (!total) {
    return { total: 0, intactRate: 0, availability: 0, mtbfH: 0, mttrH: 0, maintenanceRate: 0, spareRate: 0, risky: 0, critical: 0 };
  }
  const intact = assets.filter((asset) => asset.health >= 70).length;
  const availability = assets.reduce((sum, asset) => sum + asset.availability, 0) / total;
  const mtbf = assets.reduce((sum, asset) => sum + asset.mtbfH, 0) / total;
  const mttr = assets.reduce((sum, asset) => sum + asset.mttrH, 0) / total;
  const maintained = assets.filter((asset) => asset.maintenance.done).length;
  const sparesOk = assets.filter((asset) => asset.spares.every((part) => part.ok)).length;
  return {
    total,
    intactRate: round2(intact / total),
    availability: round2(availability),
    mtbfH: Math.round(mtbf),
    mttrH: round2(mttr),
    maintenanceRate: round2(maintained / total),
    spareRate: round2(sparesOk / total),
    risky: assets.filter((asset) => asset.health < 70).length,
    critical: assets.filter((asset) => asset.criticality === 'high').length,
  };
}

/** 已到期但未完成的维保任务（按到期日升序）。 */
export function maintenanceDue(assets: AssetRecord[]): AssetRecord[] {
  return assets
    .filter((asset) => asset.maintenance.due && !asset.maintenance.done)
    .sort((a, b) => (a.maintenance.nextAt < b.maintenance.nextAt ? -1 : 1));
}

/**
 * 健康度热力图矩阵：**横轴 = 装置分类、纵轴 = 五个维度**，格值 = 该分类下的平均分。
 *
 * 为什么维度放纵轴：维度的标签是 2~4 个字、恒定短；装置分类是 6 个字。纵轴标签按行居中，
 * 行数多时反而更好排（实测维度放横轴时第一行的标签会被裁）。
 * 返回 `ice-chart` heatmap 要的 `[x, y, value]` 三元组。
 */
export function assetHealthMatrix(assets: AssetRecord[]): Array<[string, string, number]> {
  const categories = Object.keys(ASSET_CATEGORY_LABELS).filter((key) =>
    assets.some((asset) => asset.category === key)
  );
  const out: Array<[string, string, number]> = [];
  HEALTH_DIMS.forEach((dim, dimIndex) => {
    categories.forEach((category) => {
      const group = assets.filter((asset) => asset.category === category);
      const value = group.length
        ? group.reduce((sum, asset) => sum + (asset.healthByDim[dimIndex] || 0), 0) / group.length
        : 0;
      out.push([ASSET_CATEGORY_LABELS[category], dim, Math.round(value)]);
    });
  });
  return out;
}

/** 热力图纵轴的分类标签（只保留台账里真的出现过的分类，顺序与 `ASSET_CATEGORY_LABELS` 一致）。 */
export function assetHealthCategories(assets: AssetRecord[]): string[] {
  return Object.keys(ASSET_CATEGORY_LABELS)
    .filter((key) => assets.some((asset) => asset.category === key))
    .map((key) => ASSET_CATEGORY_LABELS[key]);
}

/** 表格行（列 key 与页面 `columns` 对齐） */
export function assetRows(assets: AssetRecord[]): Array<Record<string, string>> {
  return assets.map((asset) => ({
    id: asset.id,
    tag: asset.tag,
    name: asset.name,
    model: `${asset.model}`,
    vendor: asset.vendor,
    commissionedAt: asset.commissionedAt,
    runningHours: `${asset.runningHours.toLocaleString('en-US')} h`,
    health: String(asset.health),
    band: healthBand(asset.health).label,
    mtbf: `${Math.round(asset.mtbfH)} h`,
    availability: `${Math.round(asset.availability * 100)}%`,
    nextAt: asset.maintenance.nextAt,
  }));
}

/* ------------------------------------------------------------------ 内部 */

function buildAsset(unit: AssetUnitLike, designs: Record<string, UnitDesign>, today: string): AssetRecord {
  const entry = SYMBOL_CATALOG[unit.kind];
  const category = entry ? String(entry.category) : 'water';
  const seed = hashOf(unit.id);
  const seed2 = hashOf(`${unit.id}:2`);
  const seed3 = hashOf(`${unit.id}:3`);

  const design = designs[unit.id] as UnitDesign | undefined;
  const power = Number(design && design.power) || 0;
  // 健康度：基础 72~98，功率越大的关键设备略低（负载重）
  const health = clamp(Math.round(72 + seed * 26 - Math.min(8, power / 40)), 45, 99);
  const healthByDim = HEALTH_DIMS.map((_, dimIndex) =>
    clamp(Math.round(health + (hashOf(`${unit.id}:d${dimIndex}`) - 0.5) * 16), 40, 100)
  );
  const mtbfH = Math.round(900 + seed2 * 3200);
  const mttrH = round2(1.5 + seed3 * 6);
  const commissionedYear = 2016 + Math.floor(seed * 8);
  const month = 1 + Math.floor(seed2 * 12);
  const day = 1 + Math.floor(seed3 * 27);
  const commissionedAt = `${commissionedYear}-${pad(month)}-${pad(day)}`;
  const runningHours = Math.round((340 + seed2 * 30) * 24 * Math.max(1, 2026 - commissionedYear));

  const intervalDays = power >= 45 ? 30 : seed > 0.6 ? 90 : 30;
  const lastAt = dateBefore(today, Math.floor(seed * intervalDays));
  const nextAt = dateAfter(lastAt, intervalDays);

  return {
    id: unit.id,
    tag: unit.tag,
    name: unit.name,
    kind: String(unit.kind),
    category,
    model: `${MODEL_BY_CATEGORY[category] || 'EQ'}-${100 + Math.floor(seed2 * 900)}`,
    vendor: VENDORS[Math.floor(seed3 * VENDORS.length) % VENDORS.length],
    commissionedAt,
    runningHours,
    power,
    criticality: power >= 45 ? 'high' : 'normal',
    health,
    healthByDim,
    mtbfH,
    mttrH,
    availability: round2(mtbfH / (mtbfH + mttrH)),
    maintenance: {
      intervalDays,
      label: intervalDays <= 30 ? '月度保养' : '季度保养',
      lastAt,
      nextAt,
      due: nextAt <= today,
      done: nextAt > today,
    },
    spares: sparesFor(unit, seed3),
  };
}

/** 边界符号（进出口标记）不是设备，不进台账。 */
function isBoundary(unit: AssetUnitLike): boolean {
  const entry = SYMBOL_CATALOG[unit.kind];
  return !!entry && String(entry.category) === 'boundary';
}

function sparesFor(unit: AssetUnitLike, seed: number): SparePart[] {
  const required = 2;
  const base: Array<{ name: string; ratio: number }> = [
    { name: `${unit.tag} 密封件`, ratio: seed },
    { name: `${unit.tag} 专用轴承`, ratio: (seed + 0.37) % 1 },
  ];
  return base.map((item) => {
    const inStock = item.ratio > 0.72 ? 0 : required;
    return { name: item.name, required, inStock, ok: inStock >= required };
  });
}

function dateBefore(iso: string, days: number): string {
  return shift(iso, -days);
}

function dateAfter(iso: string, days: number): string {
  return shift(iso, days);
}

function shift(iso: string, days: number): string {
  const parts = String(iso).split('-').map(Number);
  const date = new Date(Date.UTC(parts[0], (parts[1] || 1) - 1, parts[2] || 1));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
