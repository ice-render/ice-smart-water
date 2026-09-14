/**
 * DOM 侧面板：属性编辑、图纸校验、运行审计、运行指标、沿程水量表、状态栏。
 *
 * 为什么这些不用画布控件做：**表单类**交互（改名称、改管径、看一长串数字）用原生 DOM
 * 更快更无障碍（输入法、复制粘贴、屏幕阅读器都现成）。画布留给**图**与**仪表**——
 * 运行控制台（ice-web-components）与运行看板（ice-chart）就归画布。
 */
import type { AuditIssue } from '../domain/plant-audit';
import type { PlantKpi, UnitHydraulics } from '../domain/process-model';
import { QUALITY_LABELS, QUALITY_INDEXES } from '../domain/water-quality';
import { WATER_MEDIUM_STYLES, WATER_SYMBOL_PRESETS } from 'ice-entity-designer';

export type StatusLevel = 'info' | 'ok' | 'warning' | 'error';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function clear(host: HTMLElement): void {
  while (host.firstChild) host.removeChild(host.firstChild);
}

export type IssueLike = { level: string; code: string; message: string };

/** 问题清单（图纸校验 / 运行审计共用同一套渲染） */
export function renderIssueList(host: HTMLElement, issues: IssueLike[], emptyText: string): void {
  clear(host);
  if (!issues.length) {
    host.className = 'issue-list issue-list--empty';
    host.appendChild(el('div', 'issue issue--ok', `✅ ${emptyText}`));
    return;
  }
  host.className = 'issue-list';
  issues.forEach((issue) => {
    const row = el('div', `issue issue--${issue.level}`);
    row.appendChild(el('span', 'issue__icon', issue.level === 'error' ? '❌' : '⚠️'));
    row.appendChild(el('span', 'issue__text', issue.message));
    row.dataset.code = issue.code;
    host.appendChild(row);
  });
}

export type Metric = { label: string; value: string; hint?: string; level?: StatusLevel };

/** 指标列表（label / value / 备注） */
export function renderMetrics(host: HTMLElement, metrics: Metric[]): void {
  clear(host);
  const list = el('dl', 'metric-list');
  metrics.forEach((metric) => {
    list.appendChild(el('dt', 'metric__label', metric.label));
    const dd = el('dd', `metric__value${metric.level ? ` metric__value--${metric.level}` : ''}`);
    dd.appendChild(el('span', 'metric__number', metric.value));
    if (metric.hint) dd.appendChild(el('span', 'metric__hint', metric.hint));
    list.appendChild(dd);
  });
  host.appendChild(list);
}

/** 由 KPI 拼出运行指标（面板与看板共用同一份口径） */
export function kpiMetrics(kpi: PlantKpi, idleCount: number): Metric[] {
  const tightest = kpi.compliance.tightest;
  return [
    {
      label: '进水流量',
      value: `${(kpi.inflow / 10000).toFixed(2)} 万 m³/d`,
      hint: `负荷率 ${kpi.utilization}%`,
    },
    {
      label: '出水水质',
      value: kpi.compliance.pass ? `${kpi.compliance.passed}/${kpi.compliance.total} 项达标` : '超标',
      hint: tightest ? `最紧：${tightest.label} 裕度 ${Math.round(tightest.margin * 100)}%` : '',
      level: kpi.compliance.pass ? (tightest && tightest.margin < 0.1 ? 'warning' : 'ok') : 'error',
    },
    {
      label: '吨水电耗',
      value: `${kpi.energyPerCubicMeter.toFixed(3)} kWh/m³`,
      hint: `运行功率 ${Math.round(kpi.powerRunning)} / 装机 ${Math.round(kpi.powerInstalled)} kW`,
    },
    {
      label: '剩余污泥',
      value: `${kpi.sludge.wasteSludgeFlow.toFixed(1)} m³/d`,
      hint: `干泥 ${kpi.sludge.drySludge.toFixed(2)} tDS/d`,
    },
    {
      label: '生物池',
      value: `MLSS ${kpi.sludge.mlss.toFixed(0)} mg/L`,
      hint: `泥龄 ${kpi.sludge.srt.toFixed(1)} d · F/M ${kpi.sludge.fm.toFixed(3)} · HRT ${kpi.sludge.totalHrt.toFixed(1)} h`,
    },
    {
      label: '回流',
      value: `内回流 ${(kpi.recycleFlow / 10000).toFixed(1)} 万 m³/d`,
      hint: `污泥回流 ${(kpi.returnSludgeFlow / 10000).toFixed(1)} 万 m³/d`,
    },
    {
      label: '需氧与供气',
      value: `${Math.round(kpi.oxygenDemand)} kgO₂/d`,
      hint: `供气量 ${Math.round(kpi.airDemand).toLocaleString()} m³/d（20% 氧转移效率）`,
    },
    {
      label: '停运单元',
      value: idleCount ? `${idleCount} 个` : '无',
      hint: idleCount ? '见画布置灰符号' : '全厂投运',
      level: idleCount ? 'warning' : 'ok',
    },
  ];
}

/** 沿程水量与负荷表（按画布上的水流顺序） */
export function renderLoadTable(host: HTMLElement, units: UnitHydraulics[], kpi: PlantKpi): void {
  clear(host);
  const table = el('table', 'load-table');
  const head = el('thead');
  const headRow = el('tr');
  ['单元', 'Q m³/d', 'HRT h', '负荷', 'kW'].forEach((title) => headRow.appendChild(el('th', undefined, title)));
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el('tbody');
  units
    .filter((unit) => unit.flow > 0 || unit.power > 0)
    .forEach((unit) => {
      const row = el('tr', unit.idle ? 'load-table__row load-table__row--idle' : 'load-table__row');
      const cell = el('td', 'load-table__name');
      cell.appendChild(el('span', 'load-table__tag', unit.tag));
      cell.appendChild(el('span', 'load-table__label', unit.name));
      row.appendChild(cell);
      row.appendChild(el('td', undefined, unit.flow > 0 ? unit.flow.toLocaleString() : '—'));
      row.appendChild(el('td', undefined, unit.hrt > 0 ? unit.hrt.toFixed(2) : '—'));
      row.appendChild(el('td', undefined, unit.surfaceLoad > 0 ? unit.surfaceLoad.toFixed(2) : '—'));
      row.appendChild(el('td', undefined, unit.power > 0 ? String(unit.power) : '—'));
      body.appendChild(row);
    });
  table.appendChild(body);
  host.appendChild(table);

  const total = el('div', 'load-table__total');
  total.textContent = `过流合计（预处理段）${kpi.inflow.toLocaleString()} m³/d · 装机 ${Math.round(
    kpi.powerInstalled
  )} kW · 运行 ${Math.round(kpi.powerRunning)} kW`;
  host.appendChild(total);
}

/** 出水水质逐项对照（限值 / 实测 / 裕度） */
export function renderComplianceTable(host: HTMLElement, kpi: PlantKpi): void {
  clear(host);
  const table = el('table', 'load-table');
  const head = el('thead');
  const headRow = el('tr');
  ['指标', '出水', '限值', '裕度'].forEach((title) => headRow.appendChild(el('th', undefined, title)));
  head.appendChild(headRow);
  table.appendChild(head);

  const body = el('tbody');
  kpi.compliance.items.forEach((item) => {
    const row = el('tr', item.pass ? 'load-table__row' : 'load-table__row load-table__row--error');
    row.appendChild(el('td', 'load-table__name', QUALITY_LABELS[item.index]));
    row.appendChild(el('td', undefined, item.value.toFixed(2)));
    row.appendChild(el('td', undefined, String(item.limit)));
    row.appendChild(el('td', undefined, `${Math.round(item.margin * 100)}%`));
    body.appendChild(row);
  });
  table.appendChild(body);
  host.appendChild(table);
}

/** 状态栏 */
export function setStatus(host: HTMLElement, text: string, level: StatusLevel = 'info'): void {
  host.textContent = text;
  host.className = `statusbar statusbar--${level}`;
}

/**
 * 属性面板：选中符号 / 管线后编辑业务属性。
 *
 * 改完立刻回调 `onChange()`，让运行指标与看板跟着重算 —— 这就是"图纸即数据源"。
 */
export class PropertyPanel {
  private host: HTMLElement;
  private designer: any;
  private onChange: () => void;

  constructor(options: { host: HTMLElement; designer: any; onChange: () => void }) {
    this.host = options.host;
    this.designer = options.designer;
    this.onChange = options.onChange;
  }

  public render(): void {
    const designer = this.designer;
    const host = this.host;
    clear(host);
    const node = designer.nodes.filter((item: any) => item.state.id === designer.selectedId)[0];
    const edge = designer.edges.filter((item: any) => item.state.id === designer.selectedId)[0];

    if (!node && !edge) {
      host.className = 'hint';
      host.textContent = '点击画布上的符号或管线进行编辑';
      return;
    }
    host.className = 'property-panel';

    if (edge) {
      const medium = edge.state.medium || 'sewage';
      const style = (WATER_MEDIUM_STYLES as any)[medium] || WATER_MEDIUM_STYLES.sewage;
      this.row('介质', el('span', 'property-panel__static', style.label));
      this.row(
        '类型',
        el('span', 'property-panel__static', `${style.lineType === 'dashed' ? '虚线' : '实线'} · ${style.color}`)
      );
      const dnInput = el('input', 'property-panel__input');
      dnInput.value = edge.state.dn || '';
      dnInput.addEventListener('change', () => {
        edge.setState({ dn: dnInput.value, label: '' });
        edge.applyMediumStyle();
        this.onChange();
      });
      this.row('管径', dnInput);
      this.row('标注', el('span', 'property-panel__static', edge.state.label || ''));
      return;
    }

    const preset = (WATER_SYMBOL_PRESETS as any)[node.state.kind];
    this.row('类型', el('span', 'property-panel__static', preset ? preset.label : node.state.kind));
    this.row('符号 ID', el('span', 'property-panel__static', node.state.id));

    const nameInput = el('input', 'property-panel__input');
    nameInput.value = node.state.name || '';
    nameInput.addEventListener('change', () => {
      node.applyPatch({ name: nameInput.value });
      this.onChange();
    });
    this.row('名称', nameInput);

    const tagInput = el('input', 'property-panel__input');
    tagInput.value = node.state.tag || '';
    tagInput.addEventListener('change', () => {
      node.applyPatch({ tag: tagInput.value });
      this.onChange();
    });
    this.row('位号', tagInput);

    if (node.state.kind === 'valve') {
      const select = el('select', 'property-panel__input');
      [
        ['open', '开'],
        ['closed', '闭'],
      ].forEach(([value, label]) => {
        const option = el('option');
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
      });
      select.value = node.state.valveState || 'open';
      select.addEventListener('change', () => {
        this.designer.setValveState(node.state.id, select.value);
        this.onChange();
      });
      this.row('阀位', select);
    }

    const idleBox = el('input', 'property-panel__input property-panel__input--check');
    idleBox.type = 'checkbox';
    idleBox.checked = !!node.state.idle;
    idleBox.addEventListener('change', () => {
      node.applyPatch({ idle: idleBox.checked });
      this.onChange();
    });
    this.row('停用', idleBox);
  }

  private row(label: string, control: HTMLElement): void {
    const row = el('div', 'property-panel__row');
    row.appendChild(el('label', 'property-panel__label', label));
    row.appendChild(control);
    this.host.appendChild(row);
  }
}

/** 出水水质一行摘要（状态栏与日志用） */
export function complianceSummary(kpi: PlantKpi): string {
  return QUALITY_INDEXES.map((index) => `${QUALITY_LABELS[index]} ${kpi.effluent[index].toFixed(2)}`).join(' / ');
}

export function auditCounts(issues: AuditIssue[]): string {
  const error = issues.filter((issue) => issue.level === 'error').length;
  const warning = issues.filter((issue) => issue.level === 'warning').length;
  return `${error} 项 error / ${warning} 项 warning`;
}
