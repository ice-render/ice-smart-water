/**
 * 页 1 —— 工艺流程图（外壳内容区）。
 *
 * 版面是一张定死的栅格（统计卡一行五张 / 左图右栏），只有文字是动态的：
 * 每次业务重算后 `refresh()` 把卡片里的数字与要点重写一遍。
 * 工艺图本体是**岛**（独立画布），挖在「工艺流程」卡片的正文区里。
 */
import {
  ICEButton,
  ICECard,
  ICEDescriptions,
  ICELabel,
  ICEProgressBar,
  ICERadioGroup,
  ICEStatCard,
  ICETag,
  ICEWidget,
} from 'ice-web-components';
import type { OperatingMode, OperatingModeId } from '../../domain';
import { OPERATING_MODES } from '../../domain';
import type { AuditIssue } from '../../domain';
import type { PlantKpi } from '../../domain';
import type { FlowTrace } from '../../domain';
import type { UnitInspector } from '../../domain';
import { onUnitSelect, getSelectedUnit, inspectorProbe } from '../selection';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  bullet,
  cardBodyRect,
  createCard,
  emptyBox,
  paragraph,
  sectionHeading,
  stackColumn,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

/** 介质代号 → 中文（符号目录里是英文枚举，界面上给运行人员看中文） */
const MEDIUM_LABELS: Record<string, string> = {
  sewage: '污水',
  effluent: '出水',
  sludge: '污泥',
  returnSludge: '回流污泥',
  recycle: '混合液内回流',
  air: '空气',
  chemical: '药剂',
  signal: '信号',
  power: '动力',
};
function mediumLabelOf(m: string): string {
  return MEDIUM_LABELS[m] || m;
}

/** 检视指标状态 → 进度条配色（与 ICE 主题一致） */
const STATUS_COLOR: Record<string, string> = {
  success: '#198754',
  warning: '#ffc107',
  error: '#dc3545',
  info: '#0d6efd',
};

export type ProcessSnapshot = {
  kpi: PlantKpi;
  issues: AuditIssue[];
  trace: FlowTrace;
  mode: OperatingMode;
  idleCount: number;
};

export type ProcessPageDeps = {
  snapshot: () => ProcessSnapshot;
  onModeChange: (id: OperatingModeId) => void;
  onAction: (key: 'valve' | 'trace' | 'validate' | 'fit' | 'reset' | 'export-svg' | 'export-json' | 'reload') => void;
};

const STAT_HEIGHT = 120;
const CONSOLE_HEIGHT = 248;

/**
 * 「工艺流程」卡片的矩形（纯函数）。
 *
 * 单独导出是为了让入口能在**建引擎之前**就把岛的画布摆到位（引擎初始化要读画布尺寸，
 * 摆之前是 0×0）；页面构建时用的是同一个函数，两处不会算岔。
 */
export function processGraphCardRect(layout: ShellLayout): Rect {
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  return {
    left: x0,
    top: y0 + STAT_HEIGHT + PAGE_GAP,
    width: layout.inner.width - PAGE_GAP - layout.rightWidth,
    height: layout.inner.height - STAT_HEIGHT - PAGE_GAP,
  };
}

/** 工艺图岛的矩形 = 卡片正文区（挖掉标题带与内边距） */
export function processIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(processGraphCardRect(layout));
}

export function buildProcessPage(ctx: PageContext, deps: ProcessPageDeps): PageHandle {
  const { theme, layout } = ctx;
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  const rightWidth = layout.rightWidth;
  const leftWidth = layout.inner.width - PAGE_GAP - rightWidth;
  const mainTop = y0 + STAT_HEIGHT + PAGE_GAP;
  const mainHeight = layout.inner.height - STAT_HEIGHT - PAGE_GAP;

  const page = new ICEWidget({ left: 0, top: 0, width: layout.content.width, height: layout.content.height, fill: false, stroke: false, interactive: false });

  /* ---------------- 第一行：五张统计卡 ---------------- */
  const statWidth = Math.floor((layout.inner.width - PAGE_GAP * 4) / 5);
  const stats = [
    { icon: '〜', title: '进水流量', trendType: 'info' },
    { icon: '◈', title: '出水水质', trendType: 'success' },
    { icon: '⚡', title: '吨水电耗', trendType: 'info' },
    { icon: '◎', title: '剩余污泥', trendType: 'info' },
    { icon: '⌁', title: '生物池泥龄', trendType: 'info' },
  ].map((cfg, index) =>
    new ICEStatCard({
      left: x0 + index * (statWidth + PAGE_GAP),
      top: y0,
      width: statWidth,
      height: STAT_HEIGHT,
      value: '—',
      trend: '',
      ...cfg,
    })
  );
  stats.forEach((card) => page.addChild(card, false));

  /* ---------------- 左：工艺流程（岛挖在正文区） ---------------- */
  const graphRect: Rect = processGraphCardRect(layout);
  const graphCard = createCard({
    id: 'graph-card',
    rect: graphRect,
    title: '工艺流程 · AAO + 混凝沉淀 + 滤布滤池 + 消毒',
    extra: () => {
      const bar = new ICEWidget({
        left: 0,
        top: 0,
        width: 470,
        height: 32,
        fill: false,
        stroke: false,
        interactive: false,
      });
      const buttons: Array<[string, string, () => void]> = [
        ['valve', '阀门开 / 闭', () => deps.onAction('valve')],
        ['trace', '流径分析', () => deps.onAction('trace')],
        ['validate', '图纸校验', () => deps.onAction('validate')],
      ];
      let cursor = 0;
      buttons.forEach(([key, label, handler]) => {
        const button = new ICEButton({
          id: `card-action-${key}`,
          left: cursor,
          top: 0,
          width: 104,
          height: 32,
          text: label,
          size: 'small',
          variant: key === 'validate' ? 'primary' : 'default',
        });
        button.on('click', handler);
        bar.addChild(button, false);
        cursor += 110;
      });
      return bar;
    },
  });
  page.addChild(graphCard, false);

  /* ---------------- 右栏：运行控制台 + 上下文卡（默认运行要点，选中单元时切单元检视） ---------------- */
  const contextHeight = mainHeight - CONSOLE_HEIGHT - PAGE_GAP;
  const consoleRect: Rect = { left: x0 + leftWidth + PAGE_GAP, top: mainTop, width: rightWidth, height: CONSOLE_HEIGHT };
  const consoleCard = createCard({ id: 'console-card', rect: consoleRect, title: '运行控制台' });
  const consoleBody = new ICEWidget({ left: 0, top: 0, width: consoleRect.width, height: consoleRect.height, fill: false, stroke: false, interactive: false });
  consoleCard.addChild(consoleBody, false);

  const modeGroup = new ICERadioGroup({
    id: 'operating-mode',
    left: CARD_INSET,
    top: 52,
    width: rightWidth - CARD_INSET * 2,
    value: deps.snapshot().mode.id,
    options: OPERATING_MODES.map((mode) => ({ value: mode.id, label: mode.label })),
  });
  // ICERadioGroup 走**事件** change（ICESegmented 才是构造参数 onChange）
  modeGroup.on('change', () => deps.onModeChange(modeGroup.getValue() as OperatingModeId));
  consoleBody.addChild(modeGroup, false);

  const modeSummary = paragraph(ctx, { left: CARD_INSET, top: 96, width: rightWidth - CARD_INSET * 2, text: '' });
  consoleBody.addChild(modeSummary, false);

  const utilHeading = sectionHeading(ctx, CARD_INSET, 146, '全厂负荷率');
  const utilBar = new ICEProgressBar({ left: CARD_INSET, top: 166, width: rightWidth - CARD_INSET * 2, height: 10, value: 100, max: 140 });
  const utilText = new ICELabel({
    left: CARD_INSET,
    top: 182,
    width: rightWidth - CARD_INSET * 2,
    text: '',
    style: { fontSize: 11, fillStyle: theme.colors.textSecondary },
  });
  const oxygenHeading = sectionHeading(ctx, CARD_INSET, 208, '需氧量占设计值');
  const oxygenBar = new ICEProgressBar({ left: CARD_INSET, top: 228, width: rightWidth - CARD_INSET * 2, height: 10, value: 0, max: 45000 });
  const oxygenText = new ICELabel({
    left: CARD_INSET,
    top: 244,
    width: rightWidth - CARD_INSET * 2,
    text: '',
    style: { fontSize: 11, fillStyle: theme.colors.textSecondary },
  });
  [utilHeading, utilBar, utilText, oxygenHeading, oxygenBar, oxygenText].forEach((node) =>
    consoleBody.addChild(node, false)
  );

  const contextRect: Rect = { left: x0 + leftWidth + PAGE_GAP, top: mainTop + CONSOLE_HEIGHT + PAGE_GAP, width: rightWidth, height: contextHeight };
  // 注意：id 保持 `notes-card` 不变 —— e2e 的版面体检护栏按这个 id 找卡片、审计正文溢出。
  // 这张卡现在"默认运行要点、选中单元时切单元检视"，但体检只看"正文子节点不溢出卡片"，
  // 两种内容都按同一套贪心 / 紧凑布局，不会溢出。
  const contextCard = createCard({ id: 'notes-card', rect: contextRect, title: '运行要点 / 单元检视' });
  // 正文容器相对卡片原点（卡片本身已在 contextRect 处，子节点不能再用绝对坐标，否则会叠两次偏移）
  const contextBody = emptyBox({ left: 0, top: 0, width: contextRect.width, height: contextRect.height });
  contextCard.addChild(contextBody, false);
  page.addChild(consoleCard, false);
  page.addChild(contextCard, false);

  /** 当前选中的单元（null = 没选，上下文卡显示运行要点） */
  let selectedUnitId: string | null = getSelectedUnit();

  /* ---------------- 动态内容 ---------------- */
  function renderStats(snapshot: ProcessSnapshot): void {
    const { kpi, trace, idleCount } = snapshot;
    const tightest = kpi.compliance.tightest;
    const values: Array<[string, string, string]> = [
      [(kpi.inflow / 10000).toFixed(2), `万 m³/d · 负荷 ${kpi.utilization}%`, trace.connected ? 'info' : 'error'],
      [
        kpi.compliance.pass ? `${kpi.compliance.passed}/${kpi.compliance.total}` : '超标',
        kpi.compliance.pass ? `${tightest ? tightest.label : ''} 裕度 ${Math.round((tightest ? tightest.margin : 0) * 100)}%` : '出水超标',
        kpi.compliance.pass ? 'success' : 'error',
      ],
      [kpi.energyPerCubicMeter.toFixed(3), `kWh/m³ · 运行 ${Math.round(kpi.powerRunning)} kW`, 'info'],
      [kpi.sludge.wasteSludgeFlow.toFixed(0), `m³/d · 干泥 ${kpi.sludge.drySludge.toFixed(2)} tDS/d`, 'info'],
      [
        kpi.sludge.srt.toFixed(1),
        `d · MLSS ${kpi.sludge.mlss.toFixed(0)} · F/M ${kpi.sludge.fm.toFixed(3)}`,
        idleCount ? 'warning' : 'info',
      ],
    ];
    stats.forEach((card, index) => {
      card.setValue(values[index][0]);
      card.setTrend(values[index][1]);
    });
  }

  /**
   * 审计摘要卡：**一律走 `stackColumn` 流式排**，且按卡片可用高度**贪心截取**审计条目。
   *
   * 历史坑：① 手算 y 压标题带；② 段落高度估少一行压下一段 → 已交给 stackColumn 按实测高度排。
   * ③ 上一轮又固定 `slice(0,4)`：雨季 7 条审计每条 2 行，4 条就顶出卡片底把文字甩到卡片外
   * （用户看到的"交叠"）。这里改成：算清卡片正文净高，固定头部（工况标题 + 运行要点 + "运行审计"）
   * 之后，把审计条目一条条往里塞，塞不下的用"还有 N 条（详见「事件中心」）"收口 —— 任何工况都不会溢出。
   */
  function renderNotes(snapshot: ProcessSnapshot): void {
    contextBody.removeChildren([...contextBody.childNodes]);
    const width = contextRect.width - CARD_INSET * 2;
    const TOP = 52; // 正文起点（标题带下方）
    const FOOTER_H = 16;
    const footerTop = contextRect.height - CARD_INSET - FOOTER_H;
    const bodyHeight = footerTop - TOP - 12; // 留给正文（不含页脚）的净高，含一点安全余量

    const modeTitle = new ICELabel({
      width,
      text: `当前工况：${snapshot.mode.label}`,
      style: { fontSize: 12, fontWeight: '600', fillStyle: theme.colors.text },
    });
    const noteNodes = snapshot.mode.notes.map((note) => bullet(ctx, { width, text: note, fontSize: 11 } as any));
    const auditHeading = sectionHeading(ctx, 0, 0, '运行审计');

    // 头部固定占用（工况标题 + 运行要点 + "运行审计"小标题）
    const headItems = [modeTitle, ...noteNodes, auditHeading];
    let headUsed = 0;
    headItems.forEach((n, i) => {
      headUsed += (Number(n.state.height) || 0) + 5 + (i === 0 ? 4 : 0);
    });

    const auditNodes = snapshot.issues.length
      ? snapshot.issues.map((issue) =>
          paragraph(ctx, {
            width,
            text: `${issue.level === 'error' ? '❌' : '⚠️'} ${issue.message}`,
            fontSize: 11,
            color: issue.level === 'error' ? theme.colors.error : theme.colors.warning,
          } as any)
        )
      : [paragraph(ctx, { width, text: '✅ 全厂指标在设计与标准区间内', color: theme.colors.success } as any)];

    // 按可用高度贪心截取；至少留一条审计，塞不进的用"还有 N 条"收口
    const remaining = bodyHeight - headUsed;
    const shown: any[] = [];
    let consumed = 0;
    for (const node of auditNodes) {
      const h = (Number(node.state.height) || 0) + 5;
      if (shown.length > 0 && consumed + h > remaining) break;
      if (shown.length === 0 && h > remaining) break;
      shown.push(node);
      consumed += h;
    }
    const hidden = auditNodes.length - shown.length;
    const tail = hidden > 0 ? paragraph(ctx, { width, text: `…还有 ${hidden} 条（详见「事件中心」）`, fontSize: 11 } as any) : null;

    const stack = tail ? [...headItems, ...shown, tail] : [...headItems, ...shown];
    stack.forEach((node) => contextBody.addChild(node, false));
    // 正文从标题带下方开始（卡片标题占 0~44）
    stackColumn(stack, { left: CARD_INSET, top: TOP, width, gap: 5, gapAfter: (index) => (index === 0 ? 4 : 0) });

    const footer = new ICELabel({
      width,
      text: `停运单元 ${snapshot.idleCount} 个 · 走线 ${snapshot.trace.path.length} 个单元`,
      style: { fontSize: 11, fillStyle: theme.colors.textTertiary },
    });
    contextBody.addChild(footer, false);
    footer.setState({ left: CARD_INSET, top: footerTop });
  }

  function renderConsole(snapshot: ProcessSnapshot): void {
    if (modeGroup.getValue() !== snapshot.mode.id) modeGroup.setValue(snapshot.mode.id);
    modeSummary.setText(snapshot.mode.summary);
    utilBar.setValue(Math.min(140, snapshot.kpi.utilization));
    utilText.setText(`${snapshot.kpi.inflow.toLocaleString()} / 设计 ${snapshot.kpi.capacity.toLocaleString()} m³/d`);
    oxygenBar.setValue(Math.min(45000, snapshot.kpi.oxygenDemand));
    oxygenText.setText(`需氧 ${Math.round(snapshot.kpi.oxygenDemand)} kgO₂/d · 供气 ${Math.round(snapshot.kpi.airDemand).toLocaleString()} m³/d`);
  }

  /**
   * 单元检视：把"当前选中的处理单元"画成一份属性面板。
   *
   * 这里刻意**复用同一套 ice-web-components**（ICETag / ICEDescriptions / ICEProgressBar /
   * ICELabel / sectionHeading / bullet）—— 和设计器、事件中心用的是同一组控件库，
   * 只是数据来源从"整厂快照"换成"单个单元"。这正是 ICE 家族"组件层面一致性"的落点：
   * 选中工艺图上的任何一台设备，右侧立刻用和别处一模一样的卡片把它的指标 / 巡检要点 / 关联报警摆出来。
   */
  function renderInspector(info: UnitInspector): void {
    contextBody.removeChildren([...contextBody.childNodes]);
    const width = contextRect.width - CARD_INSET * 2;
    const left = CARD_INSET;
    let y = 6;

    // 顶部：状态标签 + 名称（位号），阀门再补一个开闭状态
    const statusText = info.idle ? '停用' : info.valveState ? (info.valveState === 'closed' ? '已关闭' : '运行中') : '运行中';
    const statusTag = new ICETag({
      left,
      top: y,
      width: 64,
      height: 22,
      text: statusText,
      status: info.idle ? 'warning' : 'success',
      variant: 'soft',
    });
    contextBody.addChild(statusTag, false);
    const nameLabel = new ICELabel({
      left: left + 72,
      top: y + 1,
      width: width - 72,
      text: `${info.name}（${info.tag}）`,
      style: { fontSize: 13, fontWeight: '600', fillStyle: theme.colors.text },
    });
    contextBody.addChild(nameLabel, false);
    y += 28;

    // 身份描述（同一套 ICEDescriptions）
    const desc = new ICEDescriptions({
      left,
      top: y,
      width,
      column: 1,
      items: [
        { label: '类型', value: info.catalog.label },
        { label: '位号代号', value: info.catalog.tag },
        { label: '介质', value: info.catalog.mediums.map(mediumLabelOf).join(' / ') },
      ],
    });
    contextBody.addChild(desc, false);
    y += 3 * 32;

    // 运行指标（同一套 ICEProgressBar，按设计区间上色）
    if (info.metrics.length) {
      contextBody.addChild(sectionHeading(ctx, left, y, '运行指标'), false);
      y += 20;
      info.metrics.forEach((m) => {
        const label = new ICELabel({
          left,
          top: y,
          width: 72,
          text: m.label,
          style: { fontSize: 11, fillStyle: theme.colors.textSecondary },
        });
        const bar = new ICEProgressBar({
          left: left + 76,
          top: y + 4,
          width: width - 76 - 78,
          height: 8,
          value: Math.round(m.ratio * 100),
          max: 100,
          color: STATUS_COLOR[m.status],
        });
        const value = new ICELabel({
          left: left + width - 74,
          top: y,
          width: 72,
          text: m.value,
          style: { fontSize: 10, fillStyle: theme.colors.textTertiary },
        });
        contextBody.addChild(label, false);
        contextBody.addChild(bar, false);
        contextBody.addChild(value, false);
        y += 20;
      });
    }

    // 设计关注（最多 2 条，避免把卡片撑爆）
    const focus = info.designFocus.slice(0, 2);
    if (focus.length) {
      contextBody.addChild(sectionHeading(ctx, left, y, '设计关注'), false);
      y += 18;
      focus.forEach((text) => {
        const node = bullet(ctx, { left, top: y, width, text, fontSize: 10 } as any);
        contextBody.addChild(node, false);
        y += (Number(node.state.height) || 18) + 3;
      });
    }

    // 关联诊断：运行审计 + 报警，按级别合并（最多 2 条）
    const diag = [
      ...info.auditIssues.map((i) => ({ level: i.level, text: i.message })),
      ...info.alarms.map((a) => ({ level: a.level === 'critical' ? 'error' : 'warning', text: a.title })),
    ].slice(0, 2);
    if (diag.length) {
      contextBody.addChild(sectionHeading(ctx, left, y, '关联诊断'), false);
      y += 18;
      diag.forEach((d) => {
        const node = paragraph(ctx, {
          left,
          top: y,
          width,
          text: `${d.level === 'error' ? '❌' : '⚠️'} ${d.text}`,
          fontSize: 10,
          color: d.level === 'error' ? theme.colors.error : theme.colors.warning,
        } as any);
        contextBody.addChild(node, false);
        y += (Number(node.state.height) || 18) + 3;
      });
    } else {
      const ok = paragraph(ctx, { left, top: y, width, text: '✅ 无关联运行问题', fontSize: 10, color: theme.colors.success } as any);
      contextBody.addChild(ok, false);
      y += (Number(ok.state.height) || 16) + 3;
    }
  }

  /** 上下文卡：没选中单元时显示运行要点，选中时切换到单元检视 */
  function renderContext(snapshot: ProcessSnapshot, unitId: string | null): void {
    if (unitId) {
      const info = inspectorProbe(unitId);
      if (info) {
        renderInspector(info);
        return;
      }
    }
    renderNotes(snapshot);
  }

  function refresh(): void {
    const snapshot = deps.snapshot();
    renderStats(snapshot);
    renderConsole(snapshot);
    renderContext(snapshot, selectedUnitId);
  }
  refresh();

  // 订阅统一选择总线：工艺图 / 事件中心 / 符号库的选中变化都汇聚到这里，
  // 右侧上下文卡随之在「运行要点」与「单元检视」之间切换 —— 一处选中，处处联动。
  onUnitSelect((id) => {
    selectedUnitId = id;
    renderContext(deps.snapshot(), id);
  });

  // 岛：工艺图挖在卡片正文区
  return {
    node: page,
    islands: [{ id: 'process', rect: processIslandRect(layout) }],
    actions: [
      { key: 'fit', label: '适应视图', onClick: () => deps.onAction('fit') },
      { key: 'reset', label: '复位视图', onClick: () => deps.onAction('reset') },
      { key: 'svg', label: '导出 SVG', onClick: () => deps.onAction('export-svg') },
      { key: 'json', label: '导出 JSON', onClick: () => deps.onAction('export-json') },
      { key: 'reload', label: '重载案例', variant: 'primary', onClick: () => deps.onAction('reload') },
    ],
    // 本页关心的状态：当前工况 + 流径通不通
    statusTags: () => {
      const { mode, trace, idleCount } = deps.snapshot();
      return [
        { text: mode.label, status: mode.id === 'maintenance' ? 'warning' : 'primary', width: 92 },
        { text: trace.connected ? '流径通畅' : '断流', status: trace.connected ? 'success' : 'error', width: 84 },
        idleCount ? { text: `停运 ${idleCount} 台`, status: 'warning', width: 84 } : null,
      ].filter(Boolean) as Array<{ text: string; status: string; width?: number }>;
    },
    refresh,
  };
}
