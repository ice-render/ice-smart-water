/**
 * 页 —— 工艺试算（工程师调参台）。
 *
 * 三个旋钮（污泥回流比 R、内回流比 r、MLSS）+ 水温与负荷率 → 实时算：
 * 脱氮理论上界、实际脱氮率、泥龄、食微比、需氧量、剩余污泥、曝气功率、吨水电耗，
 * 以及六项出水指标与达标裕度。
 *
 * 图纸页回答"现在怎么样"，这一页回答"**如果改成这样会怎么样**" —— 用的是同一套口径
 * （`domain/sizing.ts` 有单测专门做交叉校验：默认参数必须落回图纸模型的设计工况）。
 *
 * 曲线卡是**岛**（`ice-chart` 的 `function` 系列）：把"理论脱氮上界 vs 总回流比"画出来，
 * 并用 `sweep` 参数扫动让当前工作点在曲线上来回走 —— 参数与曲线的关系一眼可见。
 */
import {
  ICEButton,
  ICEForm,
  ICEFormItem,
  ICEInputNumber,
  ICELabel,
  ICEProgressBar,
  ICESlider,
  ICEStatistic,
  ICETable,
  ICEWidget,
} from 'ice-web-components';
import { DEFAULT_SCENARIO, scenarioMetrics, scenarioQualityRows, type ScenarioParams, type ScenarioResult } from '../../domain';
import {
  CARD_INSET,
  PAGE_GAP,
  PAGE_PADDING,
  cardBodyRect,
  createCard,
  paragraph,
  sectionHeading,
  type PageContext,
  type PageHandle,
  type Rect,
  type ShellLayout,
} from '../shell';

export type CalcPageHandle = PageHandle & {
  /** 参数变了：刷新结果、指标行与出入水对照 */
  apply: (result: ScenarioResult) => void;
};

const PARAM_WIDTH = 404;
const RESULT_WIDTH = 344;
const RESULT_ROW_HEIGHT = 252;

/** 曲线卡（岛） */
export function curveCardRect(layout: ShellLayout): Rect {
  const x0 = layout.content.left + PAGE_PADDING;
  const y0 = layout.content.top + PAGE_PADDING;
  return {
    left: x0 + PARAM_WIDTH + PAGE_GAP,
    top: y0,
    width: layout.inner.width - PARAM_WIDTH - RESULT_WIDTH - PAGE_GAP * 2,
    height: layout.inner.height - RESULT_ROW_HEIGHT - PAGE_GAP,
  };
}

export function curveIslandRect(layout: ShellLayout): Rect {
  return cardBodyRect(curveCardRect(layout));
}

export function paramCardRect(layout: ShellLayout): Rect {
  const curve = curveCardRect(layout);
  return { left: layout.content.left + PAGE_PADDING, top: layout.content.top + PAGE_PADDING, width: PARAM_WIDTH, height: curve.height };
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

  const page = new ICEWidget({
    left: 0,
    top: 0,
    width: layout.content.width,
    height: layout.content.height,
    fill: false,
    stroke: false,
    interactive: false,
  });

  /* ---------------- 左：参数表单 ---------------- */
  const paramRect = paramCardRect(layout);
  const paramCard = createCard({ id: 'calc-param-card', rect: paramRect, title: '设计参数（拖动 / 输入即时试算）' });
  page.addChild(paramCard, false);

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

  /** R：污泥回流比 —— 滑块 + 数字框联动（两个控件一份值） */
  const returnSlider = new ICESlider({ value: deps.initial.returnRatio * 100, min: 30, max: 200, step: 5, width: 372, height: 24 });
  const returnInput = new ICEInputNumber({ id: 'calc-return', value: deps.initial.returnRatio * 100, min: 30, max: 200, step: 5, width: 96, height: 30, precision: 0 });
  /** r：内回流比 */
  const internalSlider = new ICESlider({ value: deps.initial.internalRatio * 100, min: 0, max: 400, step: 10, width: 372, height: 24 });
  const internalInput = new ICEInputNumber({ id: 'calc-internal', value: deps.initial.internalRatio * 100, min: 0, max: 400, step: 10, width: 96, height: 30, precision: 0 });
  /** MLSS */
  const mlssInput = new ICEInputNumber({ id: 'calc-mlss', value: deps.initial.mlss, min: 1500, max: 6000, step: 100, width: 372, height: 30, precision: 0 });
  /** 水温 */
  const tempSlider = new ICESlider({ value: deps.initial.temperature, min: 8, max: 30, step: 1, width: 372, height: 24 });
  /** 负荷率 */
  const loadSlider = new ICESlider({ value: deps.initial.loadFactor * 100, min: 40, max: 130, step: 5, width: 372, height: 24 });

  const form = new ICEForm({
    id: 'calc-form',
    left: CARD_INSET,
    top: 52,
    width: paramRect.width - CARD_INSET * 2,
    gap: 10,
    items: [
      new ICEFormItem({
        name: 'returnRatio',
        label: '污泥回流比 R（%）· 决定回流污泥量',
        control: returnInput,
        rules: [{ required: true }, { min: 30, max: 200 }],
      }),
      new ICEFormItem({
        name: 'internalRatio',
        label: '内回流比 r（%）· AAO 脱氮的关键旋钮',
        control: internalInput,
        rules: [{ required: true }, { min: 0, max: 400 }],
      }),
      new ICEFormItem({
        name: 'mlss',
        label: '生物池 MLSS（mg/L）· 影响泥龄与二沉池固体负荷',
        control: mlssInput,
        rules: [{ required: true }, { min: 1500, max: 6000 }],
      }),
    ],
  });
  paramBody.addChild(form, false);

  // 滑块与数字框的双向同步（画布控件：滑块给视觉、数字框给精确输入）
  const bind = (slider: ICESlider, input: ICEInputNumber, commit: (value: number) => void) => {
    slider.on('change', () => {
      const value = Math.round(slider.getValue());
      input.setValue(value);
      commit(value);
    });
    input.on('change', () => {
      const value = Math.round(input.getValue());
      slider.setValue(value);
      commit(value);
    });
  };

  const label = (top: number, text: string) => sectionHeading(ctx, CARD_INSET, top, text);
  paramBody.addChild(label(232, '水温（℃）· 影响硝化速率'), false);
  tempSlider.setState({ left: CARD_INSET, top: 252 });
  paramBody.addChild(tempSlider, false);
  const tempText = new ICELabel({
    left: CARD_INSET + 384,
    top: 254,
    width: 60,
    text: `${deps.initial.temperature}℃`,
    style: { fontSize: 12, fillStyle: theme.colors.textSecondary },
  });
  paramBody.addChild(tempText, false);

  paramBody.addChild(label(300, '负荷率（%）· 实际进水 / 设计规模'), false);
  loadSlider.setState({ left: CARD_INSET, top: 320 });
  paramBody.addChild(loadSlider, false);
  const loadText = new ICELabel({
    left: CARD_INSET + 384,
    top: 322,
    width: 60,
    text: `${Math.round(deps.initial.loadFactor * 100)}%`,
    style: { fontSize: 12, fillStyle: theme.colors.textSecondary },
  });
  paramBody.addChild(loadText, false);

  const resetButton = new ICEButton({
    id: 'calc-reset',
    left: CARD_INSET,
    top: 368,
    width: 132,
    height: 34,
    text: '恢复设计参数',
    size: 'small',
  });
  resetButton.on('click', () => {
    const next = { ...DEFAULT_SCENARIO };
    returnSlider.setValue(next.returnRatio * 100);
    returnInput.setValue(next.returnRatio * 100);
    internalSlider.setValue(next.internalRatio * 100);
    internalInput.setValue(next.internalRatio * 100);
    mlssInput.setValue(next.mlss);
    tempSlider.setValue(next.temperature);
    loadSlider.setValue(next.loadFactor * 100);
    tempText.setText(`${next.temperature}℃`);
    loadText.setText(`${Math.round(next.loadFactor * 100)}%`);
    deps.onReset();
  });
  paramBody.addChild(resetButton, false);

  const advance = paragraph(ctx, {
    left: CARD_INSET,
    top: 414,
    width: paramRect.width - CARD_INSET * 2,
    text: '上界公式：脱氮率上限 = (R+r)/(1+R+r)。本厂设计值 R=100%、r=200% → 上限 75%；实算 74.8% —— 总氮是一级 A 里最难的一项，原因就在这里。',
  });
  paramBody.addChild(advance, false);

  const current = () => ({
    returnRatio: Math.round(returnInput.getValue()) / 100,
    internalRatio: Math.round(internalInput.getValue()) / 100,
    mlss: Math.round(mlssInput.getValue()),
    temperature: Math.round(tempSlider.getValue()),
    loadFactor: Math.round(loadSlider.getValue()) / 100,
  });

  bind(returnSlider, returnInput, () => deps.onChange(current()));
  bind(internalSlider, internalInput, () => deps.onChange(current()));
  returnSlider.setState({ left: CARD_INSET, top: 96 });
  returnInput.setState({ left: paramRect.width - CARD_INSET - 96, top: 92 });
  paramBody.addChild(returnSlider, false);
  paramBody.addChild(returnInput, false);
  internalSlider.setState({ left: CARD_INSET, top: 172 });
  internalInput.setState({ left: paramRect.width - CARD_INSET - 96, top: 168 });
  paramBody.addChild(internalSlider, false);
  paramBody.addChild(internalInput, false);
  mlssInput.setState({ left: CARD_INSET, top: 196 });
  paramBody.addChild(mlssInput, false);

  // 水温 / 负荷率滑块的联动（数字框只用文字显示，不占位）
  tempSlider.on('change', () => {
    tempText.setText(`${Math.round(tempSlider.getValue())}℃`);
    deps.onChange(current());
  });
  loadSlider.on('change', () => {
    loadText.setText(`${Math.round(loadSlider.getValue())}%`);
    deps.onChange(current());
  });
  mlssInput.on('change', () => deps.onChange(current()));

  /* ---------------- 中：曲线卡（岛） ---------------- */
  const curveRect = curveCardRect(layout);
  const curveCard = createCard({
    id: 'calc-curve-card',
    rect: curveRect,
    title: '脱氮上界曲线 · 参数扫动演示（横轴：污泥回流比 R；纵轴：脱氮率 %）',
  });
  page.addChild(curveCard, false);

  /* ---------------- 右：结果卡 ---------------- */
  const resultRect = resultCardRect(layout);
  const resultCard = createCard({ id: 'calc-result-card', rect: resultRect, title: '试算结果' });
  page.addChild(resultCard, false);

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

  const hero = new ICEStatistic({
    id: 'calc-hero',
    left: CARD_INSET,
    top: 54,
    width: resultRect.width - CARD_INSET * 2,
    title: '实际脱氮率',
    value: 0,
    suffix: '%',
    precision: 1,
  });
  resultBody.addChild(hero, false);

  const rows: Array<{ key: string; node: ICELabel; hint: ICELabel }> = [];
  const metricKeys = scenarioMetrics(deps.result()).map((item) => item.key);
  metricKeys.forEach((key, index) => {
    const top = 128 + index * 34;
    const name = new ICELabel({
      left: CARD_INSET,
      top: top + 3,
      width: 150,
      text: '',
      style: { fontSize: 12, fillStyle: theme.colors.textSecondary },
    });
    const value = new ICELabel({
      left: resultRect.width - CARD_INSET - 120,
      top,
      width: 120,
      text: '',
      style: { fontSize: 13, fontWeight: '600', fillStyle: theme.colors.text, textAlign: 'right' },
    });
    const hint = new ICELabel({
      left: CARD_INSET,
      top: top + 18,
      width: resultRect.width - CARD_INSET * 2,
      text: '',
      style: { fontSize: 10.5, fillStyle: theme.colors.textTertiary },
    });
    resultBody.addChild(name, false);
    resultBody.addChild(value, false);
    resultBody.addChild(hint, false);
    rows.push({ key, node: value, hint });
    // 名称写一次即可
    name.setText(scenarioMetrics(deps.result())[index].label);
  });

  const marginBar = new ICEProgressBar({
    id: 'calc-margin',
    left: CARD_INSET,
    top: resultRect.height - 64,
    width: resultRect.width - CARD_INSET * 2,
    height: 10,
    value: 0,
    max: 100,
  });
  const marginText = new ICELabel({
    left: CARD_INSET,
    top: resultRect.height - 44,
    width: resultRect.width - CARD_INSET * 2,
    text: '',
    style: { fontSize: 11, fillStyle: theme.colors.textSecondary },
  });
  resultBody.addChild(marginBar, false);
  resultBody.addChild(marginText, false);

  /* ---------------- 下：进出水对照 + 提醒 ---------------- */
  const tableRect: Rect = {
    left: x0,
    top: y0 + curveRect.height + PAGE_GAP,
    width: layout.inner.width - 300 - PAGE_GAP,
    height: RESULT_ROW_HEIGHT,
  };
  const tableCard = createCard({ id: 'calc-table-card', rect: tableRect, title: '进水 → 出水 → 一级 A 限值' });
  const table = new ICETable({
    id: 'calc-quality-table',
    left: CARD_INSET,
    top: 46,
    width: tableRect.width - CARD_INSET * 2,
    rowHeight: 28,
    columns: [
      { key: 'item', title: '指标' },
      { key: 'influent', title: '进水 mg/L', align: 'right' as const },
      { key: 'effluent', title: '出水 mg/L', align: 'right' as const },
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
    top: tableRect.top,
    width: 300,
    height: RESULT_ROW_HEIGHT,
  };
  const adviceCard = createCard({ id: 'calc-advice-card', rect: adviceRect, title: '工程提醒' });
  const adviceBody = new ICEWidget({
    left: 0,
    top: 0,
    width: adviceRect.width,
    height: adviceRect.height,
    fill: false,
    stroke: false,
    interactive: false,
  });
  adviceCard.addChild(adviceBody, false);
  page.addChild(adviceCard, false);

  /* ---------------- 应用结果 ---------------- */
  function apply(result: ScenarioResult): void {
    hero.setValue(Number((result.removalRate * 100).toFixed(1)));
    const metrics = scenarioMetrics(result);
    metrics.forEach((item, index) => {
      const row = rows[index];
      if (!row) return;
      row.node.setText(`${item.value}${item.unit ? ' ' + item.unit : ''}`);
      row.hint.setText(item.hint);
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
    const width = adviceRect.width - CARD_INSET * 2;
    const lines = result.warnings.length ? result.warnings : ['参数组合落在常规区间：六项达标，可按此参数出设计条件。'];
    let cursor = 52;
    lines.forEach((text) => {
      const node = paragraph(ctx, {
        left: CARD_INSET,
        top: cursor,
        width,
        text: `• ${text}`,
        fontSize: 11.5,
        color: result.warnings.length ? theme.colors.warning : theme.colors.success,
      });
      adviceBody.addChild(node, false);
      cursor += Math.max(20, Math.ceil((text.length + 2) / (width / 11.5)) * 18) + 4;
    });
    ctx.ice.dirty = true;
  }

  return {
    node: page,
    islands: [{ id: 'calc-curve', rect: curveIslandRect(layout) }],
    actions: [
      { key: 'calc-reset', label: '恢复设计参数', onClick: () => resetButton.trigger('click') },
    ],
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
    refresh(): void {
      apply(deps.result());
    },
  };
}
