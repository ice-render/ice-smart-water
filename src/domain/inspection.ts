/**
 * 巡检管理：**点位 → 路线 → 班次任务 → 到位 / 隐患闭环**。
 *
 * 巡检点位**不是另写一份清单**，而是从 `SYMBOL_CATALOG` 每个符号的「巡检要点（checks）」**派生**：
 * 图上有几台设备、每台该看哪几项，巡检任务就有几条 —— 这样"业务目录"只有一份真相，
 * 图例页（符号库）里看到的巡检要点，和这里派的活是同一句话。
 *
 * 单位口径：时刻 `HH:mm`、时长 `min`、到位率 / 完成率 / 超时率 `0~1`。
 */
import { SEWAGE_PLANT, type PlantCase } from './plant-case';
import { SYMBOL_CATALOG } from './symbol-catalog';
import { createRandom } from './daily-profile';

/** 每条路线每台设备最多派生几个巡检项（要点通常 3 条，取 2 条避免任务表过长） */
export const CHECKS_PER_UNIT = 2;

/** 三条巡检路线：按符号分类派生（水线 / 污泥线 / 设备与仪表）。 */
export const ROUTE_DEFS: Array<{ id: string; name: string; category: string; start: string; crew: string; durationMin: number }> = [
  { id: 'water', name: '水线巡检线', category: 'water', start: '08:00', crew: '工艺一班 · 张工', durationMin: 90 },
  { id: 'sludge', name: '污泥线巡检线', category: 'sludge', start: '09:30', crew: '工艺二班 · 李工', durationMin: 60 },
  { id: 'equipment', name: '设备与仪表巡检线', category: 'equipment', start: '14:00', crew: '电气自控 · 赵工', durationMin: 75 },
];

export type InspectionPoint = {
  id: string;
  routeId: string;
  unitId: string;
  unitTag: string;
  unitName: string;
  /** 巡检项（就是符号目录里的那条要点） */
  item: string;
  /** 计划时刻 HH:mm */
  planAt: string;
};

export type InspectionStatus = 'pending' | 'done' | 'missed';
export type InspectionResult = 'normal' | 'hazard';

export const INSPECTION_STATUS_LABELS: Record<InspectionStatus, string> = {
  pending: '待巡检',
  done: '已巡检',
  missed: '已超时',
};

export type InspectionTask = {
  id: string;
  routeId: string;
  routeName: string;
  pointId: string;
  unitId: string;
  unitTag: string;
  unitName: string;
  item: string;
  planAt: string;
  crew: string;
  status: InspectionStatus;
  /** 巡检结论（未巡检为空） */
  result: InspectionResult | '';
  /** 巡检人 */
  by: string;
  /** 备注（隐患描述 / 处置） */
  note: string;
};

export type InspectionKpi = {
  total: number;
  done: number;
  pending: number;
  missed: number;
  hazard: number;
  /** 到位率 = 已巡检 / 计划 */
  arrivalRate: number;
  /** 计划完成率 = 已巡检 / 总数 */
  completionRate: number;
  /** 超时率 */
  missRate: number;
  /** 一次修复率（隐患已完成闭环的占比） */
  fixRate: number;
  /** 隐患清单条数 */
  hazardItems: number;
};

/** 从厂站单元 + 符号目录的 checks 派生出全部巡检点位。 */
export function inspectionPoints(plant: PlantCase = SEWAGE_PLANT): InspectionPoint[] {
  const points: InspectionPoint[] = [];
  const units = (plant.units || []).filter((unit) => {
    const entry = SYMBOL_CATALOG[unit.kind];
    return !!entry && String(entry.category) !== 'boundary';
  });
  ROUTE_DEFS.forEach((route) => {
    const routeUnits = units.filter((unit) => {
      const entry = SYMBOL_CATALOG[unit.kind];
      return !!entry && String(entry.category) === route.category;
    });
    routeUnits.forEach((unit) => {
      const entry = SYMBOL_CATALOG[unit.kind];
      (entry.checks || []).slice(0, CHECKS_PER_UNIT).forEach((item, itemIndex) => {
        const minute = Math.floor(((unit.top || 0) / 24 + itemIndex * 12) % route.durationMin);
        points.push({
          id: `pt-${route.id}-${unit.id}-${itemIndex}`,
          routeId: route.id,
          unitId: unit.id,
          unitTag: unit.tag,
          unitName: unit.name,
          item,
          planAt: addMinutes(route.start, minute),
        });
      });
    });
  });
  return points;
}

/**
 * 生成今日巡检任务（**确定性**）：多数已巡检且正常，少数报隐患，个别超时未巡。
 * 与 `alarm-log` 的 `buildAlarmEvents` 同一套路 —— 演示数据由种子决定，不随机。
 */
export function buildInspectionTasks(points: InspectionPoint[], seed = 20260915): InspectionTask[] {
  const random = createRandom(seed);
  return points.map((point, index) => {
    const route = ROUTE_DEFS.filter((item) => item.id === point.routeId)[0];
    const roll = random();
    // 分布：72% 已巡检正常 / 12% 已巡检有隐患 / 10% 待巡检 / 6% 超时
    const status: InspectionStatus = roll < 0.72 ? 'done' : roll < 0.84 ? 'done' : roll < 0.94 ? 'pending' : 'missed';
    const result: InspectionResult | '' = status === 'done' ? (roll >= 0.72 && roll < 0.84 ? 'hazard' : 'normal') : '';
    return {
      id: `tk-${String(index + 1).padStart(3, '0')}`,
      routeId: point.routeId,
      routeName: route ? route.name : point.routeId,
      pointId: point.id,
      unitId: point.unitId,
      unitTag: point.unitTag,
      unitName: point.unitName,
      item: point.item,
      planAt: point.planAt,
      crew: route ? route.crew : '',
      status,
      result,
      by: status === 'done' ? (route ? route.crew.split(' · ')[1] || route.crew : '') : '',
      note: result === 'hazard' ? '现场发现异常，已转工单跟踪' : status === 'done' ? '正常' : '',
    };
  });
}

/**
 * 提交一条巡检结论（**不改原数组**，与 `alarm-log` 的 `ackAlarm` 同范式）。
 * 标隐患时状态记 `done`（巡检确实到位了，只是结论是隐患）。
 */
export function setTaskResult(
  tasks: InspectionTask[],
  id: string,
  result: InspectionResult,
  by: string,
  note = ''
): InspectionTask[] {
  return tasks.map((task) => {
    if (task.id !== id) return task;
    return {
      ...task,
      status: 'done',
      result,
      by,
      note: note || (result === 'hazard' ? '现场发现异常，已转工单跟踪' : '正常'),
    };
  });
}

export function inspectionKpi(tasks: InspectionTask[]): InspectionKpi {
  const total = tasks.length;
  const done = tasks.filter((task) => task.status === 'done').length;
  const missed = tasks.filter((task) => task.status === 'missed').length;
  const pending = total - done - missed;
  const hazardItems = tasks.filter((task) => task.result === 'hazard');
  const fixed = hazardItems.filter((task) => task.status === 'done').length;
  return {
    total,
    done,
    pending,
    missed,
    hazard: hazardItems.length,
    arrivalRate: total ? round2(done / total) : 0,
    completionRate: total ? round2(done / total) : 0,
    missRate: total ? round2(missed / total) : 0,
    fixRate: hazardItems.length ? round2(fixed / hazardItems.length) : 1,
    hazardItems: hazardItems.length,
  };
}

/** 每条路线的到位情况（页面柱状图用）。 */
export function routeStats(tasks: InspectionTask[]): {
  routes: string[];
  planned: number[];
  done: number[];
  missed: number[];
} {
  const routes = ROUTE_DEFS.map((route) => route.name);
  const planned = ROUTE_DEFS.map((route) => tasks.filter((task) => task.routeId === route.id).length);
  const done = ROUTE_DEFS.map((route) => tasks.filter((task) => task.routeId === route.id && task.status === 'done').length);
  const missed = ROUTE_DEFS.map((route) => tasks.filter((task) => task.routeId === route.id && task.status === 'missed').length);
  return { routes, planned, done, missed };
}

/** 表格行（列 key 与页面 `columns` 对齐） */
export function taskRows(tasks: InspectionTask[]): Array<Record<string, string>> {
  return tasks.map((task) => ({
    id: task.id,
    planAt: task.planAt,
    route: task.routeName,
    unit: `${task.unitName} · ${task.unitTag}`,
    item: task.item,
    status: INSPECTION_STATUS_LABELS[task.status],
    result: task.result === 'hazard' ? '发现隐患' : task.result === 'normal' ? '正常' : '—',
    by: task.by || '—',
    action: task.status === 'pending' ? '登记结论' : task.result === 'hazard' ? '已转工单' : '已完成',
  }));
}

/* ------------------------------------------------------------------ 内部 */

function addMinutes(hhmm: string, minutes: number): string {
  const parts = String(hhmm).split(':').map(Number);
  const total = (parts[0] || 0) * 60 + (parts[1] || 0) + Math.max(0, Math.round(minutes));
  const hour = Math.floor(total / 60) % 24;
  const minute = total % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
