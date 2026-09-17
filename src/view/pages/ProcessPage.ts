/**
 * 页 1 —— 工艺流程图（外壳内容区）。
 *
 * 版面是一张定死的栅格（统计卡一行五张 / 左图右栏），只有文字是动态的：
 * 每次业务重算后 `onUpdate()` 把卡片里的数字与要点重写一遍。
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
  createStatRow,
  emptyBox,
  paragraph,
  sectionHeading,
  stackColumn,
  type HeaderActionSpec,
  type IslandSpec,
  type PageContext,
  type Rect,
  type ShellLayout,
  type StatusTagSpec,
} from '../shell';
import { WaterPage } from '../WaterPage';
import { token } from 'ice-render';

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


/** 工艺流程图页：五张统计卡 + 工艺图（岛）+ 运行控制台 + 运行要点 / 单元检视。 */
export class ProcessPage extends WaterPage {
  private static readonly STAT_HEIGHT = 120;

  private static readonly CONSOLE_HEIGHT = 248;

  /** 介质代号 → 中文（符号目录里是英文枚举，界面上给运行人员看中文） */
  private static readonly MEDIUM_LABELS: Record<string, string> = {
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

  /**
   * 检视指标状态 → 主题里的状态色**名**。
   *
   * 原来是四个写死的 Bootstrap 值（`#198754` / `#ffc107` / `#dc3545` / `#0d6efd`）—— 注释里
   * 写着"与 ICE 主题一致"，但字面量不会随主题走：暗色下这几条进度条还是浅色主题的那套亮度。
   * 现在只记状态名，取色交给**主题引用**（`token('ui.colors.*')`，浅深两套自动对、热切换跟着走）。
   */
  private static readonly STATUS_TOKEN: Record<string, string> = {
    success: 'success',
    warning: 'warning',
    error: 'error',
    info: 'info',
  };

  /**
   * 「工艺流程」卡片的矩形。
   *
   * 是静态方法是为了让入口能在**建引擎之前**就把岛的画布摆到位（引擎初始化要读画布尺寸，
   * 摆之前是 0×0）；页面构建时用的是同一个方法，两处不会算岔。
   */
  private static graphCardRect(layout: ShellLayout): Rect {
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    return {
      left: x0,
      top: y0 + ProcessPage.STAT_HEIGHT + PAGE_GAP,
      width: layout.inner.width - PAGE_GAP - layout.rightWidth,
      height: layout.inner.height - ProcessPage.STAT_HEIGHT - PAGE_GAP,
    };
  }

  /** 工艺图岛的矩形 = 卡片正文区（挖掉标题带与内边距） */
  public static processIslandRect(layout: ShellLayout): Rect {
    return cardBodyRect(ProcessPage.graphCardRect(layout));
  }

  private static mediumLabelOf(medium: string): string {
    return ProcessPage.MEDIUM_LABELS[medium] || medium;
  }

  private readonly deps: ProcessPageDeps;
  private readonly stats: ICEStatCard[];
  private readonly contextBody: ICEWidget;
  private readonly contextRect: Rect;
  private readonly modeGroup: ICERadioGroup;
  private readonly modeSummary: any;
  private readonly utilBar: ICEProgressBar;
  private readonly utilText: ICELabel;
  private readonly oxygenBar: ICEProgressBar;
  private readonly oxygenText: ICELabel;
  /** 当前选中的单元（null = 没选，上下文卡显示运行要点） */
  private selectedUnitId: string | null = getSelectedUnit();

  constructor(ctx: PageContext, deps: ProcessPageDeps) {
    super(ctx);
    this.deps = deps;
    const { theme, layout } = ctx;
    const x0 = layout.content.left + PAGE_PADDING;
    const y0 = layout.content.top + PAGE_PADDING;
    const rightWidth = layout.rightWidth;
    const leftWidth = layout.inner.width - PAGE_GAP - rightWidth;
    const mainTop = y0 + ProcessPage.STAT_HEIGHT + PAGE_GAP;
    const mainHeight = layout.inner.height - ProcessPage.STAT_HEIGHT - PAGE_GAP;

    /* ---------------- 第一行：五张统计卡 ---------------- */
    // 统计卡一行：等宽 + 等间距交给引擎的等分网格（老写法是 index*(statWidth+gap) 手算）
    const statRow = createStatRow({ left: x0, top: y0, width: layout.inner.width, height: ProcessPage.STAT_HEIGHT, count: 5, gap: PAGE_GAP });
    this.addChild(statRow, false);
    this.stats = [
      { icon: '〜', title: '进水流量', trendType: 'info' },
      { icon: '◈', title: '出水水质', trendType: 'success' },
      { icon: '⚡', title: '吨水电耗', trendType: 'info' },
      { icon: '◎', title: '剩余污泥', trendType: 'info' },
      { icon: '⌁', title: '生物池泥龄', trendType: 'info' },
    ].map(
      (cfg) =>
        new ICEStatCard({
          height: ProcessPage.STAT_HEIGHT,
          value: '—',
          trend: '',
          ...cfg,
        })
    );
    this.stats.forEach((card) => statRow.addChild(card, false));

    /* ---------------- 左：工艺流程（岛挖在正文区） ---------------- */
    const graphRect: Rect = ProcessPage.graphCardRect(layout);
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
          ['valve', '阀门开 / 闭', () => this.deps.onAction('valve')],
          ['trace', '流径分析', () => this.deps.onAction('trace')],
          ['validate', '图纸校验', () => this.deps.onAction('validate')],
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
    this.addChild(graphCard, false);

    /* ---------------- 右栏：运行控制台 + 上下文卡（默认运行要点，选中单元时切单元检视） ---------------- */
    const contextHeight = mainHeight - ProcessPage.CONSOLE_HEIGHT - PAGE_GAP;
    const consoleRect: Rect = { left: x0 + leftWidth + PAGE_GAP, top: mainTop, width: rightWidth, height: ProcessPage.CONSOLE_HEIGHT };
    const consoleCard = createCard({ id: 'console-card', rect: consoleRect, title: '运行控制台' });
    const consoleBody = new ICEWidget({ left: 0, top: 0, width: consoleRect.width, height: consoleRect.height, fill: false, stroke: false, interactive: false });
    consoleCard.addChild(consoleBody, false);

    this.modeGroup = new ICERadioGroup({
      id: 'operating-mode',
      left: CARD_INSET,
      top: 52,
      width: rightWidth - CARD_INSET * 2,
      value: deps.snapshot().mode.id,
      options: OPERATING_MODES.map((mode) => ({ value: mode.id, label: mode.label })),
    });
    // ICERadioGroup 走**事件** change（ICESegmented 才是构造参数 onChange）
    this.modeGroup.on('change', () => this.deps.onModeChange(this.modeGroup.getValue() as OperatingModeId));
    consoleBody.addChild(this.modeGroup, false);

    this.modeSummary = paragraph(ctx, { left: CARD_INSET, top: 96, width: rightWidth - CARD_INSET * 2, text: '' });
    consoleBody.addChild(this.modeSummary, false);

    const utilHeading = sectionHeading(ctx, CARD_INSET, 146, '全厂负荷率');
    this.utilBar = new ICEProgressBar({ left: CARD_INSET, top: 166, width: rightWidth - CARD_INSET * 2, height: 10, value: 100, max: 140 });
    this.utilText = new ICELabel({
      left: CARD_INSET,
      top: 182,
      width: rightWidth - CARD_INSET * 2,
      text: '',
      style: { fontSize: 11, fillStyle: token('ui.colors.textSecondary') },
    });
    const oxygenHeading = sectionHeading(ctx, CARD_INSET, 208, '需氧量占设计值');
    this.oxygenBar = new ICEProgressBar({ left: CARD_INSET, top: 228, width: rightWidth - CARD_INSET * 2, height: 10, value: 0, max: 45000 });
    this.oxygenText = new ICELabel({
      left: CARD_INSET,
      top: 244,
      width: rightWidth - CARD_INSET * 2,
      text: '',
      style: { fontSize: 11, fillStyle: token('ui.colors.textSecondary') },
    });
    [utilHeading, this.utilBar, this.utilText, oxygenHeading, this.oxygenBar, this.oxygenText].forEach((node) =>
      consoleBody.addChild(node, false)
    );

    this.contextRect = { left: x0 + leftWidth + PAGE_GAP, top: mainTop + ProcessPage.CONSOLE_HEIGHT + PAGE_GAP, width: rightWidth, height: contextHeight };
    // 注意：id 保持 `notes-card` 不变 —— e2e 的版面体检护栏按这个 id 找卡片、审计正文溢出。
    // 这张卡现在"默认运行要点、选中单元时切单元检视"，但体检只看"正文子节点不溢出卡片"，
    // 两种内容都按同一套贪心 / 紧凑布局，不会溢出。
    const contextCard = createCard({ id: 'notes-card', rect: this.contextRect, title: '运行要点 / 单元检视' });
    // 正文容器相对卡片原点（卡片本身已在 contextRect 处，子节点不能再用绝对坐标，否则会叠两次偏移）
    this.contextBody = emptyBox({ left: 0, top: 0, width: this.contextRect.width, height: this.contextRect.height });
    contextCard.addChild(this.contextBody, false);
    this.addChild(consoleCard, false);
    this.addChild(contextCard, false);

    // 订阅统一选择总线：工艺图 / 事件中心 / 符号库的选中变化都汇聚到这里，
    // 右侧上下文卡随之在「运行要点」与「单元检视」之间切换 —— 一处选中，处处联动。
    onUnitSelect((id) => {
      this.selectedUnitId = id;
      this.__renderInspectorOrNotes(id);
    });

    this.onUpdate();
  }

  public islandSpecs(): IslandSpec[] {
    return [{ id: 'process', rect: ProcessPage.processIslandRect(this.pageCtx.layout) }];
  }

  public headerActions(): HeaderActionSpec[] {
    return [
      { key: 'fit', label: '适应视图', onClick: () => this.deps.onAction('fit') },
      { key: 'reset', label: '复位视图', onClick: () => this.deps.onAction('reset') },
      { key: 'svg', label: '导出 SVG', onClick: () => this.deps.onAction('export-svg') },
      { key: 'json', label: '导出 JSON', onClick: () => this.deps.onAction('export-json') },
      { key: 'reload', label: '重载案例', variant: 'primary', onClick: () => this.deps.onAction('reload') },
    ];
  }

  /** 本页关心的状态：当前工况 + 流径通不通 */
  public statusTags(): StatusTagSpec[] {
    const { mode, trace, idleCount } = this.deps.snapshot();
    return [
      { text: mode.label, status: mode.id === 'maintenance' ? 'warning' : 'primary', width: 92 },
      { text: trace.connected ? '流径通畅' : '断流', status: trace.connected ? 'success' : 'error', width: 84 },
      idleCount ? { text: `停运 ${idleCount} 台`, status: 'warning', width: 84 } : null,
    ].filter(Boolean) as StatusTagSpec[];
  }

  /** 唯一改值入口。 */
  public onUpdate(): void {
    const snapshot = this.deps.snapshot();
    this.__renderStats(snapshot);
    this.__renderConsole(snapshot);
    this.__renderInspectorOrNotes(this.selectedUnitId);
  }

  private __renderStats(snapshot: ProcessSnapshot): void {
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
    this.stats.forEach((card, index) => {
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
  private __renderNotes(snapshot: ProcessSnapshot): void {
    const { theme } = this.pageCtx;
    const ctx = this.pageCtx;
    const contextBody = this.contextBody;
    contextBody.removeChildren([...contextBody.childNodes]);
    const width = this.contextRect.width - CARD_INSET * 2;
    const TOP = 52; // 正文起点（标题带下方）
    const FOOTER_H = 16;
    const footerTop = this.contextRect.height - CARD_INSET - FOOTER_H;
    const bodyHeight = footerTop - TOP - 12; // 留给正文（不含页脚）的净高，含一点安全余量

    const modeTitle = new ICELabel({
      width,
      text: `当前工况：${snapshot.mode.label}`,
      style: { fontSize: 12, fontWeight: '600', fillStyle: token('ui.colors.text') },
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
            color: issue.level === 'error' ? token('ui.colors.error') : token('ui.colors.warning'),
          } as any)
        )
      : [paragraph(ctx, { width, text: '✅ 全厂指标在设计与标准区间内', color: token('ui.colors.success') } as any)];

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
      style: { fontSize: 11, fillStyle: token('ui.colors.textTertiary') },
    });
    contextBody.addChild(footer, false);
    footer.setState({ left: CARD_INSET, top: footerTop });
  }

  private __renderConsole(snapshot: ProcessSnapshot): void {
    if (this.modeGroup.getValue() !== snapshot.mode.id) this.modeGroup.setValue(snapshot.mode.id);
    this.modeSummary.setText(snapshot.mode.summary);
    this.utilBar.setValue(Math.min(140, snapshot.kpi.utilization));
    this.utilText.setText(`${snapshot.kpi.inflow.toLocaleString()} / 设计 ${snapshot.kpi.capacity.toLocaleString()} m³/d`);
    this.oxygenBar.setValue(Math.min(45000, snapshot.kpi.oxygenDemand));
    this.oxygenText.setText(
      `需氧 ${Math.round(snapshot.kpi.oxygenDemand)} kgO₂/d · 供气 ${Math.round(snapshot.kpi.airDemand).toLocaleString()} m³/d`
    );
  }

  /**
   * 单元检视：把"当前选中的处理单元"画成一份属性面板。
   *
   * 这里刻意**复用同一套 ice-web-components**（ICETag / ICEDescriptions / ICEProgressBar /
   * ICELabel / sectionHeading / bullet）—— 和设计器、事件中心用的是同一组控件库，
   * 只是数据来源从"整厂快照"换成"单个单元"。这正是 ICE 家族"组件层面一致性"的落点：
   * 选中工艺图上的任何一台设备，右侧立刻用和别处一模一样的卡片把它的指标 / 巡检要点 / 关联报警摆出来。
   */
  private __renderInspector(info: UnitInspector): void {
    const { theme } = this.pageCtx;
    const ctx = this.pageCtx;
    const contextBody = this.contextBody;
    contextBody.removeChildren([...contextBody.childNodes]);
    const width = this.contextRect.width - CARD_INSET * 2;
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
      style: { fontSize: 13, fontWeight: '600', fillStyle: token('ui.colors.text') },
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
        { label: '介质', value: info.catalog.mediums.map(ProcessPage.mediumLabelOf).join(' / ') },
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
          style: { fontSize: 11, fillStyle: token('ui.colors.textSecondary') },
        });
        const bar = new ICEProgressBar({
          left: left + 76,
          top: y + 4,
          width: width - 76 - 78,
          height: 8,
          value: Math.round(m.ratio * 100),
          max: 100,
          color: token(`ui.colors.${ProcessPage.STATUS_TOKEN[m.status] || 'primary'}`),
        });
        const value = new ICELabel({
          left: left + width - 74,
          top: y,
          width: 72,
          text: m.value,
          style: { fontSize: 10, fillStyle: token('ui.colors.textTertiary') },
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
          color: d.level === 'error' ? token('ui.colors.error') : token('ui.colors.warning'),
        } as any);
        contextBody.addChild(node, false);
        y += (Number(node.state.height) || 18) + 3;
      });
    } else {
      const ok = paragraph(ctx, { left, top: y, width, text: '✅ 无关联运行问题', fontSize: 10, color: token('ui.colors.success') } as any);
      contextBody.addChild(ok, false);
      y += (Number(ok.state.height) || 16) + 3;
    }
  }

  /** 上下文卡：没选中单元时显示运行要点，选中时切换到单元检视 */
  private __renderInspectorOrNotes(unitId: string | null): void {
    if (unitId) {
      const info = inspectorProbe(unitId);
      if (info) {
        this.__renderInspector(info);
        return;
      }
    }
    this.__renderNotes(this.deps.snapshot());
  }
}
