/**
 * 报警与工单（事件中心）。
 *
 * 现场逻辑：**报警不是"再多一张列表"** —— 它必须能落到人头上、有处置轨迹、能闭环。
 * 所以这里的数据模型是 `AlarmEvent`：来源（哪条规则触发）→ 归口（哪个班组）→ 状态
 * （未处理 / 已确认 / 已闭环）→ 处置轨迹（谁在什么时候做了什么）。
 *
 * 事件从三处汇总（都是**确定性**的，便于演示与测试）：
 * 1. **运行审计**（`plant-audit`）的条目 —— 图纸与运行状态算出来的问题；
 * 2. **24 小时曲线**里越限或逼近限值的小时 —— 水质类报警；
 * 3. **工况相关的固定事件** —— 检修停运通知、超越阀开启、设备停机这类"人做的事"。
 */
import type { AuditIssue } from './plant-audit';
import type { DayPoint } from './process-model';
import type { OperatingMode } from './operating-modes';
import type { PlantMeta } from './plant-case';
import { DISCHARGE_LIMIT_1A, QUALITY_LABELS, type QualityIndex } from './water-quality';

/** 报警级别：与审计的 error / warning / info 一一对应 */
export type AlarmLevel = 'critical' | 'major' | 'minor';

/** 处置状态：未处理 → 已确认 → 已闭环 */
export type AlarmStatus = 'open' | 'acked' | 'closed';

export type AlarmAction = {
  at: string;
  by: string;
  text: string;
};

export type AlarmEvent = {
  id: string;
  /** 触发时刻（HH:mm，取自 24 小时曲线的刻度或工况时刻） */
  raisedAt: string;
  level: AlarmLevel;
  /** 规则码（同一类报警可统计频次） */
  code: string;
  /** 归口班组 */
  owner: string;
  domain: '工艺' | '水质' | '设备' | '电气自控';
  status: AlarmStatus;
  /** 关联单元 */
  unitId: string;
  unitTag: string;
  unitName: string;
  title: string;
  detail: string;
  /** 建议处置（写给值班人的那一句） */
  advice: string;
  /** 处置轨迹（第一条是系统自动生成） */
  actions: AlarmAction[];
};

export const ALARM_LEVEL_LABELS: Record<AlarmLevel, string> = {
  critical: '严重',
  major: '重要',
  minor: '提示',
};

export const ALARM_STATUS_LABELS: Record<AlarmStatus, string> = {
  open: '未处理',
  acked: '已确认',
  closed: '已闭环',
};

/** 值班班组（演示用固定名单，实际来自排班系统） */
export const ALARM_OWNERS = ['工艺一班 · 张工', '工艺二班 · 李工', '设备班 · 王工', '电气自控 · 赵工', '化验室 · 孙工'];

/**
 * 审计码 → 值班人的处置建议。
 *
 * 建议写在**报警这一层**而不是审计层：审计只回答"哪里不合规"，
 * "该先动哪个旋钮"是运行经验，属于事件中心。
 */
const ADVICE_BY_CODE: Record<string, string> = {
  'flow-disconnected': '先确认关断的阀门是不是有意为之；不是的话复位，是切换备用通路。',
  'effluent-exceed': '按超标指标追工段：氨氮查溶氧与内回流、总磷查加药、SS 查二沉池与滤池。',
  'tight-margin': '裕度不足 10%：加密监测频次，必要时提前加药 / 加风量。',
  'surface-load-out-of-range': '沉淀单元表面负荷偏离设计区间：调水量分配，或启用超越 / 备用池。',
  'hrt-out-of-range': '停留时间不足：适当降低进水量或提高回流比，避免短流。',
  'solid-load-out-of-range': '污泥固体负荷超标：降低排泥量或投运备用浓缩池。',
  'over-capacity': '运行规模超设计：按雨季工况调度，注意设备连续运行时间与备用机。',
  'idle-off-process': '确认停运设备是否工艺需要：不需要走停运审批，需要则尽快复位。',
  'srt-out-of-range': '泥龄偏离设计区间：调整排泥量（泥龄偏短就少排泥）。',
  'fm-out-of-range': '食微比偏离常规：结合进水浓度与 MLSS 调整排泥与回流。',
  'sludge-no-outlet': '污泥没有出口，尽快恢复脱水 / 外运通道，避免浓缩池溢流。',
  'sludge-without-disposal': '污泥产生但没有处置去向，核对外运联单与料仓容量。',
  'sludge-outlet-idle': '污泥外运环节停运：确认是计划内停机还是设备故障。',
};

function adviceOf(code: string): string {
  return ADVICE_BY_CODE[code] || '先到现场确认实际状态，再按工艺卡处置。';
}

function levelOf(issue: AuditIssue): AlarmLevel {
  if (issue.level === 'error') return 'critical';
  if (issue.level === 'warning') return 'major';
  return 'minor';
}

function ownerOf(domain: AlarmEvent['domain']): string {
  if (domain === '设备') return ALARM_OWNERS[2];
  if (domain === '电气自控') return ALARM_OWNERS[3];
  if (domain === '水质') return ALARM_OWNERS[4];
  return ALARM_OWNERS[0];
}

/**
 * 历史事件（昨日至今的存量）。
 *
 * 真实的报警中心不会是空的：值班人接班时看到的永远是一批**未闭环 + 已闭环**的存量。
 * 这里固定几条（确定性），用来演示状态筛选、批量派单与闭环轨迹 —— 现场事件则由当前工况算。
 */
export const HISTORIC_EVENTS: AlarmEvent[] = [
  {
    id: 'ALM-H1',
    raisedAt: '昨 08:12',
    level: 'critical',
    code: 'grit-diff-pressure-high',
    owner: ALARM_OWNERS[2],
    domain: '设备',
    status: 'closed',
    unitId: 'grit',
    unitTag: 'GC-101',
    unitName: '曝气沉砂池',
    title: '沉砂池砂水分离器扭矩过高，已停机检修',
    detail: '砂斗内积砂板结，分离器扭矩保护动作；清理后复位。',
    advice: '检查砂斗排砂阀开度与排砂频次；板结期内加密巡检。',
    actions: [
      { at: '昨 08:12', by: '系统', text: '扭矩保护动作，自动生成报警' },
      { at: '昨 08:20', by: ALARM_OWNERS[2], text: '已确认，切手动并停机' },
      { at: '昨 10:05', by: ALARM_OWNERS[2], text: '清理砂斗积砂，复位后扭矩正常' },
      { at: '昨 10:30', by: '工艺一班 · 张工', text: '复核运行 30 分钟无异常，闭环' },
    ],
  },
  {
    id: 'ALM-H2',
    raisedAt: '昨 14:36',
    level: 'major',
    code: 'dosing-pump-fault',
    owner: ALARM_OWNERS[3],
    domain: '电气自控',
    status: 'closed',
    unitId: 'dosing',
    unitTag: 'DU-101',
    unitName: '加药装置',
    title: '1# 加药泵故障停机，已切备用泵',
    detail: '计量泵隔膜破损导致流量不足，除磷加药量短时偏低（未造成出水总磷超标）。',
    advice: '备件更换后做一次流量标定；关注加药泵运行小时数。',
    actions: [
      { at: '昨 14:36', by: '系统', text: '加药泵运行信号丢失' },
      { at: '昨 14:41', by: ALARM_OWNERS[3], text: '切 2# 备用泵，加药量恢复' },
      { at: '昨 17:20', by: ALARM_OWNERS[3], text: '更换隔膜并标定流量' },
      { at: '昨 17:50', by: '化验室 · 孙工', text: '出水总磷复核 0.26 mg/L，闭环' },
    ],
  },
  {
    id: 'ALM-H3',
    raisedAt: '昨 21:05',
    level: 'major',
    code: 'belt-filter-replace',
    owner: ALARM_OWNERS[2],
    domain: '设备',
    status: 'acked',
    unitId: 'dewater',
    unitTag: 'DW-101',
    unitName: '污泥脱水机',
    title: '脱水机滤带跑偏报警，已降负荷运行',
    detail: '滤带跑偏开关动作，降负荷后恢复正常；滤带张力偏低，计划明早更换。',
    advice: '更换滤带并复核张力；检查纠偏气缸与气源压力。',
    actions: [
      { at: '昨 21:05', by: '系统', text: '跑偏开关动作，自动降负荷' },
      { at: '昨 21:12', by: ALARM_OWNERS[2], text: '已确认，维持低负荷运行至次晨' },
    ],
  },
  {
    id: 'ALM-H4',
    raisedAt: '今 05:40',
    level: 'minor',
    code: 'sample-check-due',
    owner: ALARM_OWNERS[4],
    domain: '水质',
    status: 'open',
    unitId: 'analyzer',
    unitTag: 'AIT-101',
    unitName: '在线水质监测',
    title: '在线仪表比对试验到期（距上次 7 天）',
    detail: '按运行规程需每周做一次在线仪表与手工化验的比对。',
    advice: '取样做平行样比对；偏差超 ±10% 时标定探头。',
    actions: [{ at: '今 05:40', by: '系统', text: '比对试验到期提醒' }],
  },
];

export type AlarmSource = {
  issues: AuditIssue[];
  points: DayPoint[];
  mode: OperatingMode;
  meta: PlantMeta;
};

/**
 * 汇总报警清单。
 *
 * 顺序：先审计条目（图纸/运行算出来的），再水质越限小时，最后工况相关事件；
 * 最后按级别 + 时刻排序（严重优先，同级按时间倒序）。
 */
export function buildAlarmEvents(source: AlarmSource): AlarmEvent[] {
  // 历史存量打底：现场报警叠加在它上面（真实值班就是"接着上一班继续"）
  const events: AlarmEvent[] = HISTORIC_EVENTS.map((event) => ({ ...event, actions: event.actions.slice() }));
  const { issues, points, mode, meta } = source;
  const stamp = points.length ? points[points.length - 1].label : '00:00';

  // 1) 运行审计条目
  issues.forEach((issue, index) => {
    const unit = issue.id
      ? { id: issue.id, tag: issue.id.startsWith('outletValve') ? 'V-101' : issue.id, name: issue.id }
      : { id: '-', tag: '-', name: '全厂' };
    const domain: AlarmEvent['domain'] =
      issue.code.indexOf('effluent') === 0 || issue.code === 'tight-margin' ? '水质' : issue.code === 'idle-off-process' ? '设备' : '工艺';
    events.push({
      id: `ALM-A${index + 1}`,
      raisedAt: stamp,
      level: levelOf(issue),
      code: issue.code,
      owner: ownerOf(domain),
      domain,
      status: 'open',
      unitId: unit.id,
      unitTag: unit.tag,
      unitName: unit.name,
      title: issue.message,
      detail: `由运行审计在「${mode.label}」工况下判定；审计码 ${issue.code}。`,
      advice: adviceOf(issue.code),
      actions: [{ at: stamp, by: '系统', text: '运行审计自动生成报警' }],
    });
  });

  // 2) 水质越限 / 逼近限值的小时
  const watched: QualityIndex[] = ['NH3N', 'COD', 'TN'];
  const fieldOf: Record<string, keyof DayPoint> = { NH3N: 'nh3n', COD: 'cod', TN: 'tn' };
  const worst: Partial<Record<QualityIndex, { point: DayPoint; margin: number; exceeded: boolean }>> = {};
  points.forEach((point) => {
    watched.forEach((index) => {
      const value = Number(point[fieldOf[index]]);
      const limit = DISCHARGE_LIMIT_1A[index];
      const margin = (limit - value) / limit;
      const current = worst[index];
      if (!current || margin < current.margin) {
        worst[index] = { point, margin, exceeded: value > limit };
      }
    });
  });
  Object.keys(worst).forEach((key, order) => {
    const index = key as QualityIndex;
    const hit = worst[index] as { point: DayPoint; margin: number; exceeded: boolean };
    if (hit.margin > 0.15) return; // 裕度还有 15% 以上就不打扰值班人
    const domain: AlarmEvent['domain'] = '水质';
    events.push({
      id: `ALM-W${order + 1}`,
      raisedAt: hit.point.label,
      level: hit.exceeded ? 'critical' : 'major',
      code: hit.exceeded ? 'limit-exceeded' : 'approaching-limit',
      owner: ownerOf(domain),
      domain,
      status: 'open',
      unitId: 'analyzer',
      unitTag: 'AIT-101',
      unitName: '在线水质监测',
      title: `${QUALITY_LABELS[index]}在 ${hit.point.label} 达到 ${Number(hit.point[fieldOf[index]])} mg/L（限值 ${DISCHARGE_LIMIT_1A[index]}）`,
      detail: `该小时进水流量 ${hit.point.inflow} m³/d，裕度仅剩 ${Math.round(hit.margin * 100)}%。`,
      advice:
        index === 'NH3N'
          ? '优先查溶解氧与内回流比：溶氧低于 1.5 mg/L 先加风量，再看内回流阀开度。'
          : index === 'COD'
          ? '查初沉池与混凝加药：加药泵是否投运、混凝 pH 是否在 6.5~7.5。'
          : '查缺氧段碳源与内回流：碳氮比不足时按工艺卡补碳源。',
      actions: [{ at: hit.point.label, by: '系统', text: '小时均值逼近限值，自动生成报警' }],
    });
  });

  // 2.5) 水量高峰：小时流量超过「设计规模折算到小时」的 5%
  //      ⚠️ 量纲：`DayPoint.inflow` 是 **m³/h**（日水量 / 24），不是 m³/d
  const designHourly = meta.capacity / 24;
  const peak = points.reduce((worst, point) => (!worst || point.inflow > worst.inflow ? point : worst), null as DayPoint | null);
  if (peak && peak.inflow > designHourly * 1.05) {
    events.push({
      id: 'ALM-F1',
      raisedAt: peak.label,
      level: 'major',
      code: 'flow-peak',
      owner: ownerOf('工艺'),
      domain: '工艺',
      status: 'open',
      unitId: 'pump',
      unitTag: 'P-101',
      unitName: '进水泵',
      title: `${peak.label} 进水高峰 ${Math.round(peak.inflow).toLocaleString()} m³/h，超设计折算值 ${Math.round((peak.inflow / designHourly - 1) * 100)}%`,
      detail: `设计规模 ${meta.capacity.toLocaleString()} m³/d 折算 ${Math.round(designHourly).toLocaleString()} m³/h；日变化系数高峰段叠加早间用水高峰，泵组需注意切换与备用机投运。`,
      advice: '确认备用泵可随时投运；必要时启用调节池削峰。',
      actions: [{ at: peak.label, by: '系统', text: '小时流量超设计规模，自动生成报警' }],
    });
  }

  // 3) 工况相关的固定事件
  if (mode.id === 'maintenance') {
    events.push({
      id: 'ALM-M1',
      raisedAt: stamp,
      level: 'major',
      code: 'maintenance-shutdown',
      owner: ownerOf('设备'),
      domain: '设备',
      status: 'acked',
      unitId: 'dewater',
      unitTag: 'DW-101',
      unitName: '污泥脱水机',
      title: '检修停运：脱水机已停，污泥转入浓缩池暂存',
      detail: '检修工况下污泥线停机，浓缩池液位需在 4 h 内复核一次。',
      advice: '确认浓缩池剩余容积；必要时启动备用脱水机或调整排泥节奏。',
      actions: [
        { at: stamp, by: '系统', text: '工况切换为「检修停运」，自动生成' },
        { at: stamp, by: ALARM_OWNERS[2], text: '已到现场确认，挂检修牌' },
      ],
    });
  }
  if (mode.id === 'rain') {
    events.push({
      id: 'ALM-R1',
      raisedAt: stamp,
      level: 'major',
      code: 'bypass-opened',
      owner: ownerOf('工艺'),
      domain: '工艺',
      status: 'acked',
      unitId: 'bypassValve',
      unitTag: 'V-102',
      unitName: '初沉池超越阀',
      title: '雨季超越阀开启，初沉池部分超越',
      detail: `进水量按 ${Math.round(mode.inflowFactor * 100)}% 设计规模运行，超越是为了保护初沉池表面负荷。`,
      advice: '雨后及时关闭超越阀，并复核初沉池排泥是否跟上。',
      actions: [
        { at: stamp, by: '系统', text: '工况切换为「雨季超越」，阀门自动开启' },
        { at: stamp, by: ALARM_OWNERS[1], text: '已确认，观察初沉池出水 SS' },
      ],
    });
  }
  events.push({
    id: 'ALM-D1',
    raisedAt: points.length > 6 ? points[6].label : '06:00',
    level: 'minor',
    code: 'blower-vibration-trend',
    owner: ownerOf('设备'),
    domain: '设备',
    status: 'open',
    unitId: 'blower',
    unitTag: 'B-201',
    unitName: '鼓风机',
    title: '鼓风机振动趋势上升（2.4 → 3.1 mm/s，仍在告警线内）',
    detail: '最近 6 小时振动缓慢上升，尚未越限；轴承温度未同步上升。',
    advice: '下次停机时检查地脚螺栓与联轴器对中；并记录趋势。',
    actions: [{ at: '06:00', by: '系统', text: '趋势偏离基线，自动生成提示' }],
  });

  const order: Record<AlarmLevel, number> = { critical: 0, major: 1, minor: 2 };
  return events.sort((a, b) => {
    if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
    return a.raisedAt < b.raisedAt ? 1 : -1;
  });
}

export function summarizeAlarms(events: AlarmEvent[]): {
  total: number;
  open: number;
  acked: number;
  closed: number;
  critical: number;
  major: number;
  minor: number;
  text: string;
} {
  const count = (status: AlarmStatus) => events.filter((item) => item.status === status).length;
  const level = (value: AlarmLevel) => events.filter((item) => item.level === value).length;
  const open = count('open');
  const critical = level('critical');
  const text = critical ? `${critical} 条严重报警待处置` : open ? `${open} 条未处理` : '报警已全部闭环';
  return {
    total: events.length,
    open,
    acked: count('acked'),
    closed: count('closed'),
    critical,
    major: level('major'),
    minor: level('minor'),
    text,
  };
}

/** 派单 / 确认（不可变：返回新数组，页面直接替换状态） */
export function ackAlarm(events: AlarmEvent[], id: string, by: string, note = '已确认，处理中'): AlarmEvent[] {
  return events.map((event) =>
    event.id === id && event.status === 'open'
      ? {
          ...event,
          status: 'acked' as AlarmStatus,
          owner: by,
          actions: event.actions.concat([{ at: '现在', by, text: note }]),
        }
      : event
  );
}

/** 闭环 */
export function closeAlarm(events: AlarmEvent[], id: string, by: string, note = '处置完成，已复核'): AlarmEvent[] {
  return events.map((event) =>
    event.id === id && event.status !== 'closed'
      ? {
          ...event,
          status: 'closed' as AlarmStatus,
          owner: by,
          actions: event.actions.concat([{ at: '现在', by, text: note }]),
        }
      : event
  );
}

export type AlarmFilter = {
  status?: AlarmStatus | 'all';
  keyword?: string;
};

export function filterAlarms(events: AlarmEvent[], filter: AlarmFilter): AlarmEvent[] {
  const status = filter.status || 'all';
  const keyword = (filter.keyword || '').trim();
  return events.filter((event) => {
    if (status !== 'all' && event.status !== status) return false;
    if (!keyword) return true;
    return (
      event.title.indexOf(keyword) >= 0 ||
      event.unitName.indexOf(keyword) >= 0 ||
      event.unitTag.indexOf(keyword) >= 0 ||
      event.domain.indexOf(keyword) >= 0
    );
  });
}

/** 表格行（把事件摊成表格要的列） */
export function alarmRows(events: AlarmEvent[]): Array<Record<string, string>> {
  return events.map((event) => ({
    id: event.id,
    time: event.raisedAt,
    level: ALARM_LEVEL_LABELS[event.level],
    code: event.code,
    unit: `${event.unitTag} ${event.unitName}`,
    domain: event.domain,
    title: event.title,
    status: ALARM_STATUS_LABELS[event.status],
    owner: event.owner,
  }));
}
