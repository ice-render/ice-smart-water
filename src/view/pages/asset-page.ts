/**
 * 页 —— 设备资产台账（全生命周期）。
 *
 * 台账**从厂站的工艺单元派生**（图上有几台设备，账上就有几条），字段由 `hashOf(id)` 确定性生成；
 * 右侧热力图按「装置分类 × 五个健康维度」给出平均分，一眼看出哪一类设备在退。
 *
 * 表格里健康度用**分档标签 + 数值**（良好 / 关注 / 预警），点行展开看备件齐套情况。
 */
import {
  ICEButton,
  ICENotification,
  ICEStatCard,
  ICETable,
  ICETag,
  ICEWidget,
  attachPopconfirm,
} from 'ice-web-components';
import { assetKpi, assetRows, healthBand, maintenanceDue, type AssetRecord } from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  paragraph,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type AssetPageDeps = {
  /** 台账（入口持有；按当前图纸重算） */
  assets: () => AssetRecord[];
  /** 记一次维保完成 */
  onMaintain?: (id: string) => void;
  operator: () => string;
};

export type AssetPageHandle = PageHandle & {
  reload: () => void;
  /** 当前到期维保数量（e2e 用） */
  dueCount: () => number;
};

const STAT_HEIGHT = 96;
const HEALTH_WIDTH_RATIO = 0.38;

export function assetHealthCardRect(layout: ShellLayout): Rect {
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  return {
    left: x0,
    top: y0 + STAT_HEIGHT + PAGE_GAP,
    width: Math.round(layout.inner.width * HEALTH_WIDTH_RATIO),
    height: layout.inner.height - STAT_HEIGHT - PAGE_GAP,
  };
}

/** 健康度热力图所在的岛 */
export function assetHealthIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(assetHealthCardRect(layout));
}

export function assetTableCardRect(layout: ShellLayout): Rect {
  const health = assetHealthCardRect(layout);
  return {
    left: health.left + health.width + PAGE_GAP,
    top: health.top,
    width: layout.inner.width - health.width - PAGE_GAP,
    height: health.height,
  };
}

export function buildAssetPage(ctx: PageContext, deps: AssetPageDeps): AssetPageHandle {
  const { theme, layout } = ctx;
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;

  const page = new ICEWidget({
    left: 0,
    top: 0,
    width: layout.content.width,
    height: layout.content.height,
    fill: false,
    stroke: false,
    interactive: false,
  });

  /* ---------------- 第一行：六个统计 ---------------- */
  const statWidth = Math.floor((layout.inner.width - PAGE_GAP * 5) / 6);
  const statConfigs = [
    { title: '台账设备', icon: '▦', trend: '与图上单元一一对应', type: 'primary' as const },
    { title: '完好率', icon: '✔', trend: '健康度 ≥ 70', type: 'success' as const },
    { title: '综合可用率', icon: '◔', trend: 'MTBF / (MTBF+MTTR)', type: 'info' as const },
    { title: '平均 MTBF', icon: '⏱', trend: '平均无故障时间', type: 'info' as const },
    { title: '维保完成率', icon: '🛠', trend: '按计划周期', type: 'warning' as const },
    { title: '备件齐套率', icon: '📦', trend: '关键备件', type: 'warning' as const },
  ];
  const statCards = statConfigs.map((config, index) => {
    const card = new ICEStatCard({
      left: x0 + index * (statWidth + PAGE_GAP),
      top: y0,
      width: statWidth,
      height: STAT_HEIGHT,
      icon: config.icon,
      title: config.title,
      value: '0',
      trend: config.trend,
      trendType: config.type,
    });
    page.addChild(card, false);
    return card;
  });

  /* ---------------- 第二行左：健康度热力图（岛） ---------------- */
  const healthCard = createCard({
    id: 'asset-health-card',
    rect: assetHealthCardRect(layout),
    title: '健康度矩阵：装置分类 × 五个维度（平均分）',
  });
  page.addChild(healthCard, false);

  /* ---------------- 第二行右：台账表 ---------------- */
  const tableRect = assetTableCardRect(layout);
  const rowFor = (rowId: string) => deps.assets().filter((item) => item.id === rowId)[0];

  const table = new ICETable({
    id: 'asset-table',
    left: CARD_INSET,
    top: 46,
    width: tableRect.width - CARD_INSET * 2,
    rowHeight: 36,
    rowKey: 'id',
    pagination: { pageSize: 8, showTotal: true },
    columns: [
      { key: 'tag', title: '位号', width: 80, sorter: true },
      { key: 'name', title: '设备名称', width: 126 },
      { key: 'model', title: '型号', width: 86 },
      { key: 'vendor', title: '供应商', width: 100 },
      { key: 'commissionedAt', title: '投运日', width: 92 },
      {
        key: 'health',
        title: '健康度',
        width: 98,
        sorter: true,
        renderCell: (value: string, row: any) => {
          const asset = rowFor(String(row.id));
          const band = healthBand(Number(value));
          return new ICETag({
            left: 0,
            top: 6,
            width: 96,
            height: 22,
            text: `${value} · ${band.label}`,
            status: band.status,
            variant: 'soft',
          });
        },
      },
      {
        key: 'action',
        title: '维保',
        width: 92,
        renderCell: (value: string, row: any) => {
          const cell = new ICEWidget({ left: 0, top: 0, width: 92, height: 30, fill: false, stroke: false, interactive: false });
          const asset = rowFor(String(row.id));
          const due = asset ? asset.maintenance.due && !asset.maintenance.done : false;
          const button = new ICEButton({
            id: `asset-maintain-${row.id}`,
            left: 0,
            top: 4,
            width: 84,
            height: 28,
            text: due ? '登记维保' : '计划内',
            size: 'small',
            variant: due ? 'primary' : 'default',
          });
          if (due && deps.onMaintain) {
            attachPopconfirm(ctx.ice, button, {
              title: '登记一次维保？',
              description: '登记后本次维保计为完成，完成率会跟着变。',
              onConfirm: () => {
                deps.onMaintain!(String(row.id));
                reload();
                ICENotification.open(ctx.ice, {
                  title: '维保已登记',
                  description: `${row.tag} · ${row.name}`,
                  type: 'success',
                });
              },
            });
          }
          cell.addChild(button, false);
          return cell;
        },
      },
    ],
    data: [],
    summary: (rows: any[]) => ({
      tag: `本页 ${rows.length} 台`,
      name: '合计',
      health: rows.length
        ? `均分 ${Math.round(rows.reduce((sum, row) => sum + Number(row.health || 0), 0) / rows.length)}`
        : '—',
      action: '',
    }),
    expandable: {
      expandedRowHeight: 108,
      render: (row: any, cellCtx: { width: number }) => {
        const asset = rowFor(String(row.id));
        const wrap = new ICEWidget({
          left: 0,
          top: 0,
          width: Math.max(200, cellCtx.width - 24),
          height: 100,
          fill: false,
          stroke: false,
          interactive: false,
        });
        if (!asset) return wrap;
        const missing = asset.spares.filter((part) => !part.ok).map((part) => part.name);
        wrap.addChild(
          paragraph(ctx, {
            left: 0,
            top: 0,
            width: wrap.state.width,
            text: `投运 ${asset.commissionedAt} · 已运行 ${asset.runningHours.toLocaleString('en-US')} h · 装机 ${asset.power} kW · 可用率 ${Math.round(asset.availability * 100)}% · ${asset.criticality === 'high' ? '关键设备' : '一般设备'} · ${asset.maintenance.label} 下次到期 ${asset.maintenance.nextAt}`,
            fontSize: 12,
            color: theme.colors.text,
          }),
          false
        );
        wrap.addChild(
          paragraph(ctx, {
            left: 0,
            top: 34,
            width: wrap.state.width,
            text: asset.spares
              .map((part) => `${part.name}：库存 ${part.inStock}/${part.required}${part.ok ? '' : '（缺料）'}`)
              .join('　·　'),
            fontSize: 12,
            color: missing.length ? theme.colors.error : theme.colors.textSecondary,
          }),
          false
        );
        return wrap;
      },
    },
  });

  const tableCard = createCard({
    id: 'asset-table-card',
    rect: tableRect,
    title: '设备台账（点行展开备件与维保计划）',
  });
  tableCard.addChild(table, false);
  page.addChild(tableCard, false);

  /* ---------------- 刷新 ---------------- */
  function reload(): void {
    const assets = deps.assets();
    const kpi = assetKpi(assets);
    statCards[0].setValue(String(kpi.total));
    statCards[0].setTrend(`${kpi.critical} 台关键设备`);
    statCards[1].setValue(`${Math.round(kpi.intactRate * 100)}%`);
    statCards[1].setTrend(`${kpi.risky} 台需要关注`);
    statCards[2].setValue(`${Math.round(kpi.availability * 100)}%`);
    statCards[2].setTrend('MTBF / (MTBF+MTTR)');
    statCards[3].setValue(`${kpi.mtbfH}`);
    statCards[3].setTrend(`MTTR ${kpi.mttrH} h`);
    statCards[4].setValue(`${Math.round(kpi.maintenanceRate * 100)}%`);
    statCards[4].setTrend(`到期 ${maintenanceDue(assets).length} 台`);
    statCards[5].setValue(`${Math.round(kpi.spareRate * 100)}%`);
    statCards[5].setTrend('关键备件齐套');

    table.setData(assetRows(assets));
    ctx.ice.dirty = true;
  }

  reload();

  return {
    node: page,
    islands: [{ id: 'asset-health', rect: assetHealthIslandRect(layout) }],
    actions: [
      {
        key: 'asset-due',
        label: '看今日到期维保',
        onClick: () => {
          const due = maintenanceDue(deps.assets());
          ctx.toast(
            due.length ? `${due.length} 台到期：${due.slice(0, 3).map((asset) => asset.tag).join(' / ')}…` : '今日没有到期维保',
            due.length ? 'warning' : 'success'
          );
        },
      },
    ],
    statusTags: () => {
      const kpi = assetKpi(deps.assets());
      return [
        { text: `完好率 ${Math.round(kpi.intactRate * 100)}%`, status: kpi.risky ? 'warning' : 'success', width: 132 },
        { text: `${kpi.total} 台`, status: 'info', width: 84 },
      ];
    },
    reload,
    dueCount: () => maintenanceDue(deps.assets()).length,
    refresh(): void {
      reload();
    },
  };
}
