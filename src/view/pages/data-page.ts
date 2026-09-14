/**
 * 页 2 —— 运行数据：24 小时看板（`ice-chart`）+ 沿程水量与负荷表 + 出水达标对照 + 运行审计。
 *
 * 看板是**岛**（`ice-chart` 自己 new 一个引擎、自己一张画布），挖在「24 小时运行看板」卡片的正文区。
 * 三张表都是 `ICETable`，表头/分页/空态都由控件库提供。
 */
import { ICELabel, ICEProgressBar, ICEStatCard, ICETable, ICEWidget } from 'ice-web-components';
import type { AuditIssue, DayPoint, PlantKpi, UnitHydraulics } from '../../domain';
import { QUALITY_LABELS } from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  bullet,
  cardBodyRect,
  createCard,
  paragraph,
  sectionHeading,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type DataSnapshot = {
  kpi: PlantKpi;
  issues: AuditIssue[];
  points: DayPoint[];
  hydraulics: UnitHydraulics[];
  modeLabel: string;
};

export type DataPageDeps = {
  snapshot: () => DataSnapshot;
};

const TREND_HEIGHT = 372;
const LOAD_TABLE_WIDTH = 596;
const COMPLIANCE_WIDTH = 372;

/** 「24 小时运行看板」卡片的矩形（纯函数：入口要在建引擎前摆岛，见 process-page 的注释） */
export function boardCardRect(layout: ShellLayout): Rect {
  return {
    left: layout.content.left + PAGE_PADDING,
    top: layout.content.top + PAGE_PADDING,
    width: layout.inner.width,
    height: TREND_HEIGHT,
  };
}

/** 看板岛的矩形 = 卡片正文区 */
export function boardIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(boardCardRect(layout));
}

export function buildDataPage(ctx: PageContext, deps: DataPageDeps): PageHandle {
  const { theme, layout } = ctx;
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  const auditWidth = layout.inner.width - LOAD_TABLE_WIDTH - COMPLIANCE_WIDTH - PAGE_GAP * 2;

  const page = new ICEWidget({
    left: 0,
    top: 0,
    width: layout.content.width,
    height: layout.content.height,
    fill: false,
    stroke: false,
    interactive: false,
  });

  /* ---------------- 24 小时运行看板（岛） ---------------- */
  const trendRect: Rect = boardCardRect(layout);
  const trendCard = createCard({ id: 'trend-card', rect: trendRect, title: '24 小时进出水趋势 · 滚轮缩放 / 拖拽平移 / 双击图例可只看一条曲线' });
  page.addChild(trendCard, false);

  /* ---------------- 底部三块 ---------------- */
  const bottomTop = y0 + TREND_HEIGHT + PAGE_GAP;
  const bottomHeight = layout.inner.height - TREND_HEIGHT - PAGE_GAP;

  const loadRect: Rect = { left: x0, top: bottomTop, width: LOAD_TABLE_WIDTH, height: bottomHeight };
  const loadCard = createCard({ id: 'load-card', rect: loadRect, title: '沿程水量与负荷' });
  const loadTable = new ICETable({
    id: 'load-table',
    left: 0,
    top: 0,
    width: LOAD_TABLE_WIDTH - CARD_INSET * 2,
    rowHeight: 28,
    columns: [
      { key: 'unit', title: '单元' },
      { key: 'flow', title: 'Q m³/d', align: 'right' as const },
      { key: 'hrt', title: 'HRT h', align: 'right' as const },
      { key: 'load', title: '负荷', align: 'right' as const },
      { key: 'power', title: 'kW', align: 'right' as const },
    ],
    data: [],
    pagination: { pageSize: 6, showTotal: true },
  });
  placeInCard(loadCard, loadTable);

  const complianceRect: Rect = { left: x0 + LOAD_TABLE_WIDTH + PAGE_GAP, top: bottomTop, width: COMPLIANCE_WIDTH, height: bottomHeight };
  const complianceCard = createCard({ id: 'compliance-card', rect: complianceRect, title: '出水达标对照' });
  const complianceTable = new ICETable({
    id: 'compliance-table',
    left: 0,
    top: 0,
    width: COMPLIANCE_WIDTH - CARD_INSET * 2,
    rowHeight: 28,
    columns: [
      { key: 'item', title: '指标' },
      { key: 'value', title: '出水', align: 'right' as const },
      { key: 'limit', title: '限值', align: 'right' as const },
      { key: 'margin', title: '裕度', align: 'right' as const },
    ],
    data: [],
  });
  placeInCard(complianceCard, complianceTable);

  const auditRect: Rect = {
    left: x0 + LOAD_TABLE_WIDTH + COMPLIANCE_WIDTH + PAGE_GAP * 2,
    top: bottomTop,
    width: auditWidth,
    height: bottomHeight,
  };
  const auditCard = createCard({ id: 'audit-card', rect: auditRect, title: '运行审计' });
  const auditBody = new ICEWidget({
    left: auditRect.left + CARD_INSET,
    top: auditRect.top + 44,
    width: auditRect.width - CARD_INSET * 2,
    height: auditRect.height - 60,
    fill: false,
    stroke: false,
    interactive: false,
  });
  page.addChild(auditCard, false);
  page.addChild(auditBody, false);
  page.addChild(loadCard, false);
  page.addChild(complianceCard, false);

  /* ---------------- 动态内容 ---------------- */
  function renderLoadTable(snapshot: DataSnapshot): void {
    const rows = snapshot.hydraulics
      .filter((unit) => unit.flow > 0 || unit.power > 0)
      .map((unit) => ({
        unit: `${unit.tag} ${unit.name}${unit.idle ? '（停运）' : ''}`,
        flow: unit.flow > 0 ? unit.flow.toLocaleString() : '—',
        hrt: unit.hrt > 0 ? unit.hrt.toFixed(2) : '—',
        load: unit.surfaceLoad > 0 ? unit.surfaceLoad.toFixed(2) : '—',
        power: unit.power > 0 ? String(unit.power) : '—',
      }));
    loadTable.setData(rows);
  }

  function renderCompliance(snapshot: DataSnapshot): void {
    complianceTable.setData(
      snapshot.kpi.compliance.items.map((item) => ({
        item: QUALITY_LABELS[item.index],
        value: item.value.toFixed(2),
        limit: String(item.limit),
        margin: `${Math.round(item.margin * 100)}%`,
      }))
    );
  }

  function renderAudit(snapshot: DataSnapshot): void {
    auditBody.removeChildren([...auditBody.childNodes]);
    const width = auditRect.width - CARD_INSET * 2;
    let y = 0;
    auditBody.addChild(
      sectionHeading(ctx, 0, y, `${snapshot.modeLabel} · ${snapshot.issues.length ? `${snapshot.issues.length} 条待关注` : '全部正常'}`),
      false
    );
    y += 22;
    if (!snapshot.issues.length) {
      auditBody.addChild(
        paragraph(ctx, { left: 0, top: y, width, text: '✅ 未发现问题：六项指标达标，负荷与停留时间都在设计区间内', color: theme.colors.success }),
        false
      );
      return;
    }
    snapshot.issues.slice(0, 6).forEach((issue) => {
      const node = paragraph(ctx, {
        left: 0,
        top: y,
        width,
        text: `${issue.level === 'error' ? '❌' : '⚠️'} ${issue.message}`,
        fontSize: 11,
        color: issue.level === 'error' ? theme.colors.error : theme.colors.warning,
      });
      auditBody.addChild(node, false);
      const lines = Math.max(1, Math.ceil((issue.message.length + 3) / (width / 11)));
      y += lines * 18 + 4;
    });
    if (snapshot.issues.length > 6) {
      auditBody.addChild(
        paragraph(ctx, { left: 0, top: y, width, text: `…还有 ${snapshot.issues.length - 6} 条`, fontSize: 11 }),
        false
      );
    }
  }

  function refresh(): void {
    const snapshot = deps.snapshot();
    renderLoadTable(snapshot);
    renderCompliance(snapshot);
    renderAudit(snapshot);
  }
  refresh();

  return {
    node: page,
    islands: [{ id: 'board', rect: boardIslandRect(layout) }],
    actions: [],
    // 本页关心的状态：当前工况 + 审计结论
    statusTags: () => {
      const snapshot = deps.snapshot();
      const errors = snapshot.issues.filter((issue) => issue.level === 'error').length;
      return [
        { text: snapshot.modeLabel, status: snapshot.modeLabel === '检修停运' ? 'warning' : 'primary', width: 92 },
        {
          text: errors ? `${errors} 项超标` : snapshot.issues.length ? `${snapshot.issues.length} 项关注` : '全部达标',
          status: errors ? 'error' : snapshot.issues.length ? 'warning' : 'success',
          width: 96,
        },
      ];
    },
    refresh,
  };
}

/**
 * 把控件放进卡片的正文区。
 *
 * 坐标基准是**卡片内相对坐标** —— 卡片自己已经在 cardRect 上了，这里再加一次 cardRect.left
 * 会让控件整体跑出卡片（症状是"控件在画布外、点不到"）。
 */
function placeInCard(card: any, child: any): void {
  child.setState({ left: CARD_INSET, top: 46 });
  card.addChild(child, false);
}
