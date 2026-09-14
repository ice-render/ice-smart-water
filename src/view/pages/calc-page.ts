/**
 * 页 —— 工艺试算（工程师调参台）。
 *
 * 五个旋钮（污泥回流比 R、内回流比 r、MLSS、水温、负荷率）→ 实时算：
 * 脱氮理论上界、实际脱氮率、泥龄、食微比、需氧量、剩余污泥、曝气功率、吨水电耗，
 * 以及六项出水指标与达标裕度。
 *
 * 图纸页回答"现在怎么样"，这一页回答"**如果改成这样会怎么样**" —— 用的是同一套口径
 * （`domain/sizing.ts` 有单测交叉校验：默认参数必须落回图纸模型的设计工况）。
 *
 * 版面（**全部走 `stackColumn` 流式排，不手算 y**）：
 * ```
 * ┌ 设计参数（ICEForm + 校验）┐┌ 脱氮上界曲线（岛）─────────┐┌ 试算结果 ┐
 * │ 5 个数字输入 + 恢复默认    ││ function 系列 + sweep 扫动  ││ 8 项指标  │
 * └──────────────────────────┘└────────────────────────────┘└──────────┘
 * ┌ 参数微调（滑块）┐┌ 进水 → 出水 → 限值表 ─────┐┌ 工程提醒 ┐
 * └───────────────┘└───────────────────────────┘└─────────┘
 * ```
 * 滑块单独占一张卡是**踩过**的：和数字框挤在同一张卡里时，372 宽的滑块会把数字框压在身下。
 * 现在各给各的地方，两处都用流式排。
 */
import {
  ICEButton,
  ICEForm,
  ICEFormItem,
  ICEInputNumber,
  ICEProgressBar,
  ICESlider,
  ICEStatistic,
  ICETable,
  ICEWidget,
} from 'ice-web-components';
import {
  DEFAULT_SCENARIO,
  scenarioMetrics,
  scenarioQualityRows,
  type ScenarioParams,
  type ScenarioResult,
} from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  paragraph,
  stackColumn,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type CalcPageHandle = PageHandle & {
  /** 参数变了：刷新结果、指标行与出入水对照 */
  apply: (result: ScenarioResult) => void;
  /** 从外部改参数时同步控件（恢复默认 / 菜单预设） */
  syncControls: (params: ScenarioParams) => void;
};

const PARAM_WIDTH = 404;
const RESULT_WIDTH = 344;
const BOTTOM_HEIGHT = 232;
const TUNE_WIDTH = 420;
const ADVICE_WIDTH = 288;

/** 曲线卡（岛） */
export function curveCardRect(layout: ShellLayout): Rect {
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  return {
    left: x0 + PARAM_WIDTH + PAGE_GAP,
    top: y0,
    width: layout.inner.width - PARAM_WIDTH - RESULT_WIDTH - PAGE_GAP * 2,
    height: layout.inner.height - BOTTOM_HEIGHT - PAGE_GAP,
  };
}

export function curveIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(curveCardRect(layout));
}

export function paramCardRect(layout: ShellLayout): Rect {
  const curve = curveCardRect(layout);
  return {
    left: layout.content.left + PAGE_PADDING,
    top: layout.content.top + PAGE_PADDING,
    width: PARAM_WIDTH,
    height: curve.height,
  };
}

export function resultCardRect(layout: ShellLayout): Rect {
  const curve = curveCardRect(layout);
  return { left: curve.left + curve.width + PAGE_GAP, top: curve.top, width: RESULT_WIDTH, height: curve.height };
}

export function buildCalcPage(
  ctx: PageContext,
  deps: {
    initial: ScenarioParams;
    onChange: (params: ScenarioParams) => void;
    onReset: () => void;
    result: () => ScenarioResult;
  }
): CalcPageHandle {
  const { theme, layout } = ctx;
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  const initial = deps.initial;

  const page = new ICEWidget({
    left: 0,
    top: 0,
    width: layout.content.width,
    height: layout.content.height,
    fill: false,
    stroke: false,
    interactive: false,
  });

  /* ================= 左：设计参数（表单 + 校验） ================= */

  const paramRect = paramCardRect(layout);
  const paramCard = createCard({ id: 'calc-param-card', rect: paramRect, title: '设计参数' });
  const paramBody = new ICEWidget({
    left: 0,
    top: 0,
    width: paramRect.width,
    height: paramRect.height,
    fill: false,
    stroke: false,
    interactive: false,
  });
  paramCard.addChild(paramBody, false);
  page.addChild(paramCard, false);

  const returnInput = new ICEInputNumber({ id: 'calc-return', value: initial.returnRatio * 100, min: 30, max: 200, step: 5, width: 108, height: 30, precision: 0 });
  const internalInput = new ICEInputNumber({ id: 'calc-internal', value: initial.internalRatio * 100, min: 0, max: 400, step: 10, width: 108, height: 30, precision: 0 });
  const mlssInput = new ICEInputNumber({ id: 'calc-mlss', value: initial.mlss, min: 1500, max: 6000, step: 100, width: 108, height: 30, precision: 0 });
  const tempInput = new ICEInputNumber({ id: 'calc-temp', value: initial.temperature, min: 8, max: 32, step: 1, width: 108, height: 30, precision: 0 });
  const loadInput = new ICEInputNumber({ id: 'calc-load', value: Math.round(initial.loadFactor * 100), min: 40, max: 130, step: 5, width: 108, height: 30, precision: 0 });

  const form = new ICEForm({
    id: 'calc-form',
    left: CARD_INSET,
    top: 52,
    width: paramRect.width - CARD_INSET * 2,
    gap: 8,
    items: [
      new ICEFormItem({ name: 'returnRatio', label: '污泥回流比 R（%）', layout: 'horizontal', labelWidth: 168, control: returnInput, rules: [{ required: true }, { min: 30, max: 200 }] }),
      new ICEFormItem({ name: 'internalRatio', label: '内回流比 r（%）', layout: 'horizontal', labelWidth: 168, control: internalInput, rules: [{ required: true }, { min: 0, max: 400 }] }),
      new ICEFormItem({ name: 'mlss', label: '生物池 MLSS（mg/L）', layout: 'horizontal', labelWidth: 168, control: mlssInput, rules: [{ required: true }, { min: 1500, max: 6000 }] }),
      new ICEFormItem({ name: 'temperature', label: '设计水温（℃）', layout: 'horizontal', labelWidth: 168, control: tempInput, rules: [{ required: true }, { min: 8, max: 32 }] }),
      new ICEFormItem({ name: 'loadFactor', label: '负荷率（%）', layout: 'horizontal', labelWidth: 168, control: loadInput, rules: [{ required: true }, { min: 40 }, { max: 130 }] }),
    ],
  });
  paramBody.addChild(form, false);

  const readParams = (): ScenarioParams => ({
    returnRatio: Math.round(returnInput.getValue()) / 100,
    internalRatio: Math.round(internalInput.getValue()) / 100,
    mlss: Math.round(mlssInput.getValue()),
    temperature: Math.round(tempInput.getValue()),
    loadFactor: Math.round(loadInput.getValue()) / 100,
  });

  const resetButton = new ICEButton({ id: 'calc-reset', width: 132, height: 34, text: '恢复设计参数', size: 'small' });
  resetButton.on('click', () => {
    syncControls({ ...DEFAULT_SCENARIO });
    deps.onReset();
  });
  const formula = paragraph(ctx, {
    left: 0,
    top: 0,
    width: paramRect.width - CARD_INSET * 2,
    text: '脱氮率上限 = (R+r)/(1+R+r)。本厂 R=100%、r=200% → 上限 75%；实算 74.8% —— 总氮是一级 A 里最难的一项，原因就在这里。',
  } as any);
  const paramTail = [resetButton, formula];
  paramTail.forEach((node) => paramBody.addChild(node, false));
  stackColumn(paramTail, { left: CARD_INSET, top: 356, width: paramRect.width - CARD_INSET * 2, gap: 12 });

  /* ================= 中：曲线卡（岛） ================= */

  const curveRect = curveCardRect(layout);
  const curveCard = createCard({
    id: 'calc-curve-card',
    rect: curveRect,
    title: '脱氮能力 vs 污泥回流比 R（蓝＝理论上界 橙＝修正后）',
  });
  page.addChild(curveCard, false);

  /* ================= 右：试算结果 ================= */

  const resultRect = resultCardRect(layout);
  const resultCard = createCard({ id: 'calc-result-card', rect: resultRect, title: '试算结果' });
  const resultBody = new ICEWidget({
    left: 0,
    top: 0,
    width: resultRect.width,
    height: resultRect.height,
    fill: false,
    stroke: false,
    interactive: false,
  });
  resultCard.addChild(resultBody, false);
  page.addChild(resultCard, false);

  const innerResultWidth = resultRect.width - CARD_INSET * 2;
  const hero = new ICEStatistic({
    id: 'calc-hero',
    width: innerResultWidth,
    title: '实际脱氮率',
    value: 0,
    suffix: '%',
    precision: 1,
  });
  resultBody.addChild(hero, false);

  /**
   * 8 行指标：整行一个 stack 项（名称 + 右侧数值 + 小字提示）。
   *
   * ⚠️ 行高为什么是 40 而不是 32：`ICELabel` 的**实测高度是 19**（12px 字号 + 行距），
   * 我原来按 16 写死，于是名称（0~19）与小字提示（18 起）差 3px 相交 —— 实测抓出来的。
   * 现在按实测高度留位：名称 0~19、提示 20~39，正好 40。
   */
  const ROW_HEIGHT = 40;
  const metricRows = scenarioMetrics(deps.result()).map((metric) => {
    const row = new ICEWidget({ width: innerResultWidth, height: ROW_HEIGHT, fill: false, stroke: false, interactive: false });
    const name = paragraph(ctx, { left: 0, top: 0, width: 140, text: metric.label, fontSize: 12, color: theme.colors.textSecondary } as any);
    const value = paragraph(ctx, { left: 0, top: 0, width: 120, text: '', fontSize: 13, color: theme.colors.text } as any);
    const hint = paragraph(ctx, { left: 0, top: 0, width: innerResultWidth, text: metric.hint, fontSize: 10.5, color: theme.colors.textTertiary } as any);
    name.setState({ left: 0, top: 0, width: 140 });
    value.setState({ left: innerResultWidth - 120, top: 0, width: 120 });
    hint.setState({ left: 0, top: 20, width: innerResultWidth });
    row.addChild(name, false);
    row.addChild(value, false);
    row.addChild(hint, false);
    resultBody.addChild(row, false);
    return { key: metric.key, row, value, hint };
  });

  const marginBar = new ICEProgressBar({ id: 'calc-margin', width: innerResultWidth, height: 10, value: 0, max: 100 });
  const marginText = paragraph(ctx, { left: 0, top: 0, width: innerResultWidth, text: '', fontSize: 11 } as any);
  resultBody.addChild(marginBar, false);
  resultBody.addChild(marginText, false);

  const resultStack: any[] = ([hero] as any[]).concat(metricRows.map((item) => item.row)).concat([marginBar, marginText]);
  stackColumn(resultStack, {
    left: CARD_INSET,
    top: 52,
    width: innerResultWidth,
    gap: 6,
    gapAfter: (index) => (index === 0 ? 10 : index === resultStack.length - 2 ? 8 : 0),
  });

  /* ================= 下排：参数微调（滑块）/ 对照表 / 工程提醒 ================= */

  const bottomTop = y0 + curveRect.height + PAGE_GAP;
  const tuneRect: Rect = { left: x0, top: bottomTop, width: TUNE_WIDTH, height: BOTTOM_HEIGHT };
  const tuneCard = createCard({ id: 'calc-tune-card', rect: tuneRect, title: '参数微调（滑块与数字框实时同步）' });
  const tuneBody = new ICEWidget({ left: 0, top: 0, width: tuneRect.width, height: tuneRect.height, fill: false, stroke: false, interactive: false });
  tuneCard.addChild(tuneBody, false);
  page.addChild(tuneCard, false);

  const tuneInnerWidth = tuneRect.width - CARD_INSET * 2;
  const sliderRow = (id: string, min: number, max: number, step: number, value: number, caption: string) => {
    const row = new ICEWidget({ width: tuneInnerWidth, height: 34, fill: false, stroke: false, interactive: false });
    const label = paragraph(ctx, { left: 0, top: 0, width: 120, text: caption, fontSize: 11, color: theme.colors.textSecondary } as any);
    // 宽度按"标签 118 + 滑块 + 读数 62 + 间隙"分配：滑块给 196，读数从 326 起（388-62）
    const slider = new ICESlider({ id, value, min, max, step, width: 196, height: 24 });
    const readout = paragraph(ctx, { left: 0, top: 0, width: 62, text: '', fontSize: 11, color: theme.colors.text } as any);
    label.setState({ left: 0, top: 8, width: 118, height: 16 });
    slider.setState({ left: 122, top: 5, width: 196, height: 24 });
    readout.setState({ left: tuneInnerWidth - 62, top: 8, width: 62 });
    row.addChild(label, false);
    row.addChild(slider, false);
    row.addChild(readout, false);
    tuneBody.addChild(row, false);
    return { row, slider, readout };
  };

  const tuneRows = [
    sliderRow('tune-return', 30, 200, 5, initial.returnRatio * 100, '污泥回流比 R（%）'),
    sliderRow('tune-internal', 0, 400, 10, initial.internalRatio * 100, '内回流比 r（%）'),
    sliderRow('tune-temp', 8, 32, 1, initial.temperature, '设计水温（℃）'),
  ];
  const tuneHint = paragraph(ctx, {
    left: 0,
    top: 0,
    width: tuneInnerWidth,
    text: '拖滑块看曲线与结果怎么变：脱氮率永远追不上蓝色那条上界，差出来的部分是温度与泥龄的折扣。',
    fontSize: 11,
  });
  tuneBody.addChild(tuneHint, false);
  stackColumn(tuneRows.map((item) => item.row).concat([tuneHint]), {
    left: CARD_INSET,
    top: 52,
    width: tuneInnerWidth,
    gap: 10,
  });

  const tableRect: Rect = {
    left: tuneRect.left + TUNE_WIDTH + PAGE_GAP,
    top: bottomTop,
    width: layout.inner.width - TUNE_WIDTH - ADVICE_WIDTH - PAGE_GAP * 2,
    height: BOTTOM_HEIGHT,
  };
  const tableCard = createCard({ id: 'calc-table-card', rect: tableRect, title: '进水 → 出水 → 一级 A 限值' });
  const table = new ICETable({
    id: 'calc-quality-table',
    left: CARD_INSET,
    top: 48,
    width: tableRect.width - CARD_INSET * 2,
    rowHeight: 26,
    columns: [
      { key: 'item', title: '指标' },
      { key: 'influent', title: '进水', align: 'right' as const },
      { key: 'effluent', title: '出水', align: 'right' as const },
      { key: 'limit', title: '限值', align: 'right' as const },
      { key: 'margin', title: '裕度', align: 'right' as const },
      { key: 'verdict', title: '判定' },
    ],
    data: [],
  });
  tableCard.addChild(table, false);
  page.addChild(tableCard, false);

  const adviceRect: Rect = {
    left: tableRect.left + tableRect.width + PAGE_GAP,
    top: bottomTop,
    width: ADVICE_WIDTH,
    height: BOTTOM_HEIGHT,
  };
  const adviceCard = createCard({ id: 'calc-advice-card', rect: adviceRect, title: '工程提醒' });
  const adviceBody = new ICEWidget({ left: 0, top: 0, width: adviceRect.width, height: adviceRect.height, fill: false, stroke: false, interactive: false });
  adviceCard.addChild(adviceBody, false);
  page.addChild(adviceCard, false);

  /* ================= 同步与刷新 ================= */

  function syncControls(params: ScenarioParams): void {
    returnInput.setValue(params.returnRatio * 100);
    internalInput.setValue(params.internalRatio * 100);
    mlssInput.setValue(params.mlss);
    tempInput.setValue(params.temperature);
    loadInput.setValue(Math.round(params.loadFactor * 100));
    tuneRows[0].slider.setValue(params.returnRatio * 100);
    tuneRows[1].slider.setValue(params.internalRatio * 100);
    tuneRows[2].slider.setValue(params.temperature);
    tuneRows[0].readout.setText(`${Math.round(params.returnRatio * 100)}%`);
    tuneRows[1].readout.setText(`${Math.round(params.internalRatio * 100)}%`);
    tuneRows[2].readout.setText(`${params.temperature}℃`);
  }

  [returnInput, internalInput, mlssInput, tempInput, loadInput].forEach((input) =>
    input.on('change', () => deps.onChange(readParams()))
  );
  tuneRows.forEach((item, index) => {
    item.slider.on('change', () => {
      const value = Math.round(item.slider.getValue());
      if (index === 0) returnInput.setValue(value);
      if (index === 1) internalInput.setValue(value);
      if (index === 2) tempInput.setValue(value);
      item.readout.setText(index === 2 ? `${value}℃` : `${value}%`);
      deps.onChange(readParams());
    });
  });

  function apply(result: ScenarioResult): void {
    hero.setValue(Number((result.removalRate * 100).toFixed(1)));
    scenarioMetrics(result).forEach((metric, index) => {
      const row = metricRows[index];
      if (!row) return;
      row.value.setText(`${metric.value}${metric.unit ? ' ' + metric.unit : ''}`);
      row.hint.setText(metric.hint);
    });

    const tightest = result.compliance.tightest;
    marginBar.setValue(tightest ? Math.max(0, Math.min(100, tightest.margin * 100)) : 0);
    marginText.setText(
      tightest
        ? `最紧项：${tightest.label} 出水 ${tightest.value} / 限值 ${tightest.limit}（裕度 ${Math.round(tightest.margin * 100)}%）`
        : ''
    );

    table.setData(
      scenarioQualityRows(result).map((row) => ({
        item: row.label,
        influent: row.influent.toFixed(1),
        effluent: row.effluent.toFixed(2),
        limit: String(row.limit),
        margin: `${Math.round(row.margin * 100)}%`,
        verdict: row.pass ? '达标' : '超标',
      }))
    );

    adviceBody.removeChildren([...adviceBody.childNodes]);
    const lines = result.warnings.length ? result.warnings : ['参数组合落在常规区间：六项达标，可按此参数出设计条件。'];
    const nodes = lines.map((text) =>
      paragraph(ctx, {
        left: 0,
        top: 0,
        width: adviceRect.width - CARD_INSET * 2,
        text: `• ${text}`,
        fontSize: 11.5,
        color: result.warnings.length ? theme.colors.warning : theme.colors.success,
      } as any)
    );
    nodes.forEach((node) => adviceBody.addChild(node, false));
    stackColumn(nodes, { left: CARD_INSET, top: 52, width: adviceRect.width - CARD_INSET * 2, gap: 6 });

    ctx.ice.dirty = true;
  }

  apply(deps.result());
  syncControls(initial);

  return {
    node: page,
    islands: [{ id: 'calc-curve', rect: curveIslandRect(layout) }],
    actions: [{ key: 'calc-reset', label: '恢复设计参数', onClick: () => resetButton.trigger('click') }],
    statusTags: () => {
      const result = deps.result();
      return [
        { text: `上界 ${(result.ceiling * 100).toFixed(1)}%`, status: 'primary', width: 108 },
        {
          text: result.compliance.pass ? `达标 ${result.compliance.passed}/${result.compliance.total}` : '出水超标',
          status: result.compliance.pass ? (result.warnings.length ? 'warning' : 'success') : 'error',
          width: 108,
        },
      ];
    },
    apply,
    syncControls,
    refresh(): void {
      apply(deps.result());
    },
  };
}
