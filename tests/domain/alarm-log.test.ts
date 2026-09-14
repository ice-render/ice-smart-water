import { SEWAGE_PLANT, designMap, toPlantGraph } from '../../src/domain/plant-case';
import { applyModeToGraph, modeById } from '../../src/domain/operating-modes';
import { auditPlant } from '../../src/domain/plant-audit';
import { computeHydraulics, computeKpi, evaluateQualityChain, simulateDay } from '../../src/domain/process-model';
import { scaledBy } from '../../src/domain/water-quality';
import {
  ALARM_LEVEL_LABELS,
  ALARM_STATUS_LABELS,
  ackAlarm,
  alarmRows,
  buildAlarmEvents,
  closeAlarm,
  filterAlarms,
  summarizeAlarms,
  type AlarmSource,
} from '../../src/domain/alarm-log';

function sourceOf(modeId: 'normal' | 'rain' | 'maintenance'): AlarmSource {
  const base = toPlantGraph(SEWAGE_PLANT);
  const mode = modeById(modeId);
  const graph = applyModeToGraph(base, mode);
  const designs = designMap(SEWAGE_PLANT);
  const meta = SEWAGE_PLANT.meta;
  // 与页面同口径：工况会改水量与进水浓度，不能拿设计工况算
  const influent = scaledBy(meta.influent, mode.qualityFactor);
  const kpi = computeKpi(graph, designs, meta, {
    inflow: meta.capacity * mode.inflowFactor,
    influent,
  });
  const chain = evaluateQualityChain(graph, meta, influent);
  const hydraulics = computeHydraulics(graph, designs, meta, kpi.inflow, kpi.sludge.wasteSludgeFlow);
  const points = simulateDay(graph, designs, meta, mode);
  const issues = auditPlant({ graph, designs, meta, mode, kpi, chain, hydraulics });
  return { issues, points, mode, meta };
}

describe('报警清单', () => {
  it('正常运行：审计干净，但水质与设备趋势仍会给出可处置的报警', () => {
    const events = buildAlarmEvents(sourceOf('normal'));
    expect(events.length).toBeGreaterThan(0);
    events.forEach((event) => {
      expect(event.id.length).toBeGreaterThan(0);
      expect(event.owner.length).toBeGreaterThan(0);
      expect(event.advice.length).toBeGreaterThan(0);
      expect(event.actions.length).toBeGreaterThanOrEqual(1);
      expect(ALARM_LEVEL_LABELS[event.level].length).toBeGreaterThan(0);
      expect(ALARM_STATUS_LABELS[event.status].length).toBeGreaterThan(0);
    });
    // 鼓风机振动趋势这类"提示级"必须在
    expect(events.map((event) => event.code)).toContain('blower-vibration-trend');
  });

  it('雨季工况：超越阀开启与负荷类报警进清单', () => {
    const events = buildAlarmEvents(sourceOf('rain'));
    const codes = events.map((event) => event.code);
    expect(codes).toContain('bypass-opened');
    expect(codes).toContain('surface-load-out-of-range');
    // 排序不变量：严重 → 重要 → 提示（同级按时刻倒序）
    const order: Record<string, number> = { critical: 0, major: 1, minor: 2 };
    for (let index = 1; index < events.length; index += 1) {
      expect(order[events[index].level]).toBeGreaterThanOrEqual(order[events[index - 1].level]);
    }
  });

  it('检修工况：出现停运通知，且脱水机停机已被确认（带着处置轨迹）', () => {
    const events = buildAlarmEvents(sourceOf('maintenance'));
    const shutdown = events.filter((event) => event.code === 'maintenance-shutdown')[0];
    expect(shutdown).toBeTruthy();
    expect(shutdown.status).toBe('acked');
    expect(shutdown.actions.length).toBeGreaterThanOrEqual(2);
    expect(shutdown.actions[0].by).toBe('系统');
  });

  it('汇总：按状态与级别分类计数', () => {
    const events = buildAlarmEvents(sourceOf('maintenance'));
    const summary = summarizeAlarms(events);
    expect(summary.total).toBe(events.length);
    expect(summary.open + summary.acked + summary.closed).toBe(summary.total);
    expect(summary.critical + summary.major + summary.minor).toBe(summary.total);
    expect(summary.text.length).toBeGreaterThan(0);
  });

  it('派单与闭环是不可变的，并追加处置轨迹', () => {
    const events = buildAlarmEvents(sourceOf('normal'));
    const target = events.filter((event) => event.status === 'open')[0];
    expect(target).toBeTruthy();

    const acked = ackAlarm(events, target.id, '工艺一班 · 张工', '已到现场');
    const after = acked.filter((event) => event.id === target.id)[0];
    expect(after.status).toBe('acked');
    expect(after.owner).toBe('工艺一班 · 张工');
    expect(after.actions.length).toBe(target.actions.length + 1);
    // 原数组未被改动
    expect(events.filter((event) => event.id === target.id)[0].status).toBe('open');

    const closed = closeAlarm(acked, target.id, '工艺一班 · 张工');
    expect(closed.filter((event) => event.id === target.id)[0].status).toBe('closed');
    // 已闭环的不会被重复确认
    expect(ackAlarm(closed, target.id, '别人').filter((event) => event.id === target.id)[0].owner).toBe('工艺一班 · 张工');
  });

  it('筛选：按状态与关键字（单元 / 域 / 标题）', () => {
    const events = buildAlarmEvents(sourceOf('maintenance'));
    const opened = filterAlarms(events, { status: 'open' });
    expect(opened.every((event) => event.status === 'open')).toBe(true);

    const byUnit = filterAlarms(events, { keyword: 'B-201' });
    expect(byUnit.length).toBeGreaterThan(0);
    expect(byUnit.every((event) => event.unitTag === 'B-201' || event.title.indexOf('B-201') >= 0)).toBe(true);

    expect(filterAlarms(events, { status: 'all', keyword: '' }).length).toBe(events.length);
  });

  it('表格行给得出，且列齐全', () => {
    const rows = alarmRows(buildAlarmEvents(sourceOf('rain')));
    expect(rows.length).toBeGreaterThan(0);
    ['time', 'level', 'unit', 'status', 'owner', 'title'].forEach((key) => {
      expect(Object.prototype.hasOwnProperty.call(rows[0], key)).toBe(true);
    });
  });
});
