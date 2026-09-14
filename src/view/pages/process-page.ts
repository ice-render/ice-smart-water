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
  ICEWidget,
} from 'ice-web-components';
import type { OperatingMode, OperatingModeId } from '../../domain';
import { OPERATING_MODES } from '../../domain';
import type { AuditIssue } from '../../domain';
import type { PlantKpi } from '../../domain';
import type { FlowTrace } from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  bullet,
  cardBodyRect,
  createCard,
  paragraph,
  sectionHeading,
  stackColumn,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

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
const CONSOLE_HEIGHT = 300;

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

  /* ---------------- 右栏：运行控制台 + 运行要点 ---------------- */
  const notesHeight = mainHeight - CONSOLE_HEIGHT - PAGE_GAP;
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

  const notesRect: Rect = { left: x0 + leftWidth + PAGE_GAP, top: mainTop + CONSOLE_HEIGHT + PAGE_GAP, width: rightWidth, height: notesHeight };
  const notesCard = createCard({ id: 'notes-card', rect: notesRect, title: '运行要点 / 审计摘要' });
  const notesBody = new ICEWidget({ left: 0, top: 0, width: notesRect.width, height: notesRect.height, fill: false, stroke: false, interactive: false });
  notesCard.addChild(notesBody, false);
  page.addChild(consoleCard, false);
  page.addChild(notesCard, false);

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
   * 审计摘要卡：**一律走 `stackColumn` 流式排**。
   *
   * 原来手算 y 递增踩了两个坑：① 正文从 `CARD_INSET`(16) 起排，压到卡片标题上（标题带占了 0~44）；
   * ② 段落高度按字数估，估少一行就压下一段。交给 stackColumn 按实测高度排就没这类问题。
   */
  function renderNotes(snapshot: ProcessSnapshot): void {
    notesBody.removeChildren([...notesBody.childNodes]);
    const width = notesRect.width - CARD_INSET * 2;

    const modeTitle = new ICELabel({
      width,
      text: `当前工况：${snapshot.mode.label}`,
      style: { fontSize: 12, fontWeight: '600', fillStyle: theme.colors.text },
    });
    const noteNodes = snapshot.mode.notes.map((note) => bullet(ctx, { width, text: note } as any));
    const auditHeading = sectionHeading(ctx, 0, 0, '运行审计');
    const auditNodes = snapshot.issues.length
      ? snapshot.issues.slice(0, 4).map((issue) =>
          paragraph(ctx, {
            width,
            text: `${issue.level === 'error' ? '❌' : '⚠️'} ${issue.message}`,
            fontSize: 11,
            color: issue.level === 'error' ? theme.colors.error : theme.colors.warning,
          } as any)
        )
      : [paragraph(ctx, { width, text: '✅ 全厂指标在设计与标准区间内', color: theme.colors.success } as any)];

    const stack = [modeTitle].concat(noteNodes).concat([auditHeading]).concat(auditNodes);
    if (snapshot.issues.length > 4) {
      stack.push(paragraph(ctx, { width, text: `…还有 ${snapshot.issues.length - 4} 条（详见「事件中心」）`, fontSize: 11 } as any));
    }
    stack.forEach((node) => notesBody.addChild(node, false));
    // 正文从标题带下方开始（卡片标题占 0~44）
    stackColumn(stack, { left: CARD_INSET, top: 52, width, gap: 6, gapAfter: (index) => (index === 0 ? 4 : 0) });

    const footer = new ICELabel({
      width,
      text: `停运单元 ${snapshot.idleCount} 个 · 走线 ${snapshot.trace.path.length} 个单元`,
      style: { fontSize: 11, fillStyle: theme.colors.textTertiary },
    });
    notesBody.addChild(footer, false);
    footer.setState({ left: CARD_INSET, top: notesRect.height - CARD_INSET - 16 });
  }

  function renderConsole(snapshot: ProcessSnapshot): void {
    if (modeGroup.getValue() !== snapshot.mode.id) modeGroup.setValue(snapshot.mode.id);
    modeSummary.setText(snapshot.mode.summary);
    utilBar.setValue(Math.min(140, snapshot.kpi.utilization));
    utilText.setText(`${snapshot.kpi.inflow.toLocaleString()} / 设计 ${snapshot.kpi.capacity.toLocaleString()} m³/d`);
    oxygenBar.setValue(Math.min(45000, snapshot.kpi.oxygenDemand));
    oxygenText.setText(`需氧 ${Math.round(snapshot.kpi.oxygenDemand)} kgO₂/d · 供气 ${Math.round(snapshot.kpi.airDemand).toLocaleString()} m³/d`);
  }

  function refresh(): void {
    const snapshot = deps.snapshot();
    renderStats(snapshot);
    renderConsole(snapshot);
    renderNotes(snapshot);
  }
  refresh();

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
