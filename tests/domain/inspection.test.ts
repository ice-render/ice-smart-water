/**
 * 巡检管理：点位由符号目录派生 + 任务生成确定 + 结论登记是纯函数。
 */
import { SEWAGE_PLANT } from '../../src/domain/plant-case';
import { SYMBOL_CATALOG } from '../../src/domain/symbol-catalog';
import {
  CHECKS_PER_UNIT,
  ROUTE_DEFS,
  buildInspectionTasks,
  inspectionKpi,
  inspectionPoints,
  routeStats,
  setTaskResult,
  taskRows,
} from '../../src/domain/inspection';

const points = () => inspectionPoints();
const tasks = () => buildInspectionTasks(points());

describe('巡检点位由符号目录派生', () => {
  it('总数 = Σ min(每个单元的巡检要点数, CHECKS_PER_UNIT)', () => {
    const expected = SEWAGE_PLANT.units
      .filter((unit) => {
        const entry = SYMBOL_CATALOG[unit.kind];
        return !!entry && String(entry.category) !== 'boundary';
      })
      .reduce((sum, unit) => sum + Math.min(SYMBOL_CATALOG[unit.kind].checks.length, CHECKS_PER_UNIT), 0);
    expect(points()).toHaveLength(expected);
  });

  it('每条的巡检项都来自对应符号的 checks（只有一份真相）', () => {
    points().forEach((point) => {
      const unit = SEWAGE_PLANT.units.filter((item) => item.id === point.unitId)[0];
      expect(unit).toBeTruthy();
      expect(SYMBOL_CATALOG[unit.kind].checks).toContain(point.item);
    });
  });

  it('只覆盖三条路线，时刻是 HH:mm', () => {
    const routeIds = Array.from(new Set(points().map((point) => point.routeId))).sort();
    expect(routeIds).toEqual(ROUTE_DEFS.map((route) => route.id).sort());
    points().forEach((point) => expect(point.planAt).toMatch(/^\d{2}:\d{2}$/));
  });
});

describe('巡检任务（确定性）', () => {
  it('同种子同结果；状态三选一；已巡检才有结论', () => {
    const a = buildInspectionTasks(points(), 20260915);
    const b = buildInspectionTasks(points(), 20260915);
    const c = buildInspectionTasks(points(), 20260916);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    a.forEach((task) => {
      expect(['pending', 'done', 'missed']).toContain(task.status);
      if (task.status !== 'done') expect(task.result).toBe('');
      else expect(['normal', 'hazard']).toContain(task.result);
    });
  });

  it('KPI：三种状态数相加等于总数，各率落在 0~1', () => {
    const list = tasks();
    const kpi = inspectionKpi(list);
    expect(kpi.total).toBe(list.length);
    expect(kpi.done + kpi.pending + kpi.missed).toBe(kpi.total);
    [kpi.arrivalRate, kpi.completionRate, kpi.missRate, kpi.fixRate].forEach((rate) => {
      expect(rate).toBeGreaterThanOrEqual(0);
      expect(rate).toBeLessThanOrEqual(1);
    });
    expect(kpi.hazard).toBe(list.filter((task) => task.result === 'hazard').length);
  });

  it('setTaskResult 是纯函数：不改原数组，结论写回且状态转 done', () => {
    const list = tasks();
    const before = JSON.stringify(list);
    const pending = list.filter((task) => task.status === 'pending')[0] || list[0];
    const next = setTaskResult(list, pending.id, 'hazard', '张工', '');
    expect(JSON.stringify(list)).toBe(before);
    const updated = next.filter((task) => task.id === pending.id)[0];
    expect(updated.status).toBe('done');
    expect(updated.result).toBe('hazard');
    expect(updated.by).toBe('张工');
    expect(updated.note.length).toBeGreaterThan(0);
  });

  it('路线统计：三条路线各自的计划 / 到位 / 超时', () => {
    const stats = routeStats(tasks());
    expect(stats.routes).toHaveLength(ROUTE_DEFS.length);
    expect(stats.planned).toHaveLength(ROUTE_DEFS.length);
    stats.routes.forEach((_, index) => {
      expect(stats.planned[index]).toBeGreaterThanOrEqual(stats.done[index]);
      expect(stats.missed[index]).toBeLessThanOrEqual(stats.planned[index]);
    });
  });

  it('表格行：列 key 齐全，状态是可读标签', () => {
    const rows = taskRows(tasks());
    expect(rows.length).toBeGreaterThan(0);
    ['id', 'planAt', 'route', 'unit', 'item', 'status', 'result', 'by', 'action'].forEach((key) =>
      expect(Object.keys(rows[0])).toContain(key)
    );
  });
});
