/**
 * 符号库页的画布控件面板（**ice-web-components**）：分类筛选 + 选中符号的两个关键属性。
 *
 * 筛选是"离散选项"的典型场景，用画布上的分段控件（`ICESegmented`）；
 * 而符号的作用 / 设计关注 / 巡检要点这些**长文本**留在 DOM 侧栏 ——
 * 画布控件擅长点按与状态，原生 DOM 擅长排版长文与复制粘贴，各干各的擅长的活。
 */
import { ICE } from 'ice-render';
import { WATER_MEDIUM_STYLES, WATER_SYMBOL_PRESETS } from 'ice-entity-designer';
import {
  ICEHoverManager,
  ICELabel,
  ICESegmented,
  ICEStatCard,
  ICETag,
  getICEFocusManager,
  iceUIManager,
  mountICEAccessibilityMirror,
} from 'ice-web-components';
import { SYMBOL_CATEGORIES, categoryMetaOf, type LegendFilter, type SymbolEntry } from '../domain/symbol-catalog';

export const SYMBOL_CONSOLE_WIDTH = 390;
export const SYMBOL_CONSOLE_HEIGHT = 196;
export const SYMBOL_CONSOLE_CARD_WIDTH = 185;

export type SymbolConsoleState = {
  filter: LegendFilter;
  /** 当前筛选下的符号数 */
  matched: number;
  selected: SymbolEntry | null;
};

export type SymbolConsole = {
  ice: any;
  update(state: SymbolConsoleState): void;
};

export function mountSymbolConsole(options: {
  canvas: HTMLCanvasElement;
  filter: LegendFilter;
  onFilterChange: (filter: LegendFilter) => void;
}): SymbolConsole {
  const canvas = options.canvas;
  canvas.width = SYMBOL_CONSOLE_WIDTH;
  canvas.height = SYMBOL_CONSOLE_HEIGHT;
  canvas.style.width = `${SYMBOL_CONSOLE_WIDTH}px`;
  canvas.style.height = `${SYMBOL_CONSOLE_HEIGHT}px`;

  const ice = new ICE().init(canvas, { renderMode: 'dirty-rect' });
  const theme = iceUIManager.getTheme();
  new ICEHoverManager(ice).start();
  getICEFocusManager(ice).start();

  ice.addChild(
    new ICELabel({
      left: 0,
      top: 0,
      width: SYMBOL_CONSOLE_WIDTH,
      height: 20,
      text: '符号筛选',
      style: { fontSize: 13, fontWeight: '600', fillStyle: theme.colors.text },
    })
  );

  /**
   * 注意两代控件的回调口径**不一样**（踩过）：
   * - `ICESegmented` 走**构造参数** `onChange`，它不抛 `change` 事件（`.on('change')` 永远不触发）；
   * - `ICERadioGroup` 走**事件** `change`（`trigger('change', null, { value })`）。
   * 用错口径的表现是"点了没反应"，且不报任何错 —— 很难查。
   */
  const segmented = new ICESegmented({
    id: 'symbol-filter',
    left: 0,
    top: 26,
    width: SYMBOL_CONSOLE_WIDTH,
    value: options.filter,
    options: [{ value: 'all', label: '全部' }].concat(
      SYMBOL_CATEGORIES.map((item) => ({ value: item.id, label: item.short }))
    ),
    onChange: (value: string) => {
      options.onFilterChange(value as LegendFilter);
    },
  });
  ice.addChild(segmented);

  const countCard = new ICEStatCard({
    left: 0,
    top: 72,
    width: SYMBOL_CONSOLE_CARD_WIDTH,
    height: 84,
    title: '当前分类符号数',
    value: '21',
    trend: '种',
    trendType: 'info',
    icon: '⊞',
  });
  const sizeCard = new ICEStatCard({
    left: SYMBOL_CONSOLE_WIDTH - SYMBOL_CONSOLE_CARD_WIDTH,
    top: 72,
    width: SYMBOL_CONSOLE_CARD_WIDTH,
    height: 84,
    title: '图形基准尺寸',
    value: '—',
    trend: '宽 × 高',
    trendType: 'info',
    icon: '⌗',
  });
  ice.addChild(countCard);
  ice.addChild(sizeCard);

  let tag: any = null;
  function setTag(text: string): void {
    if (tag) {
      tag.setText(text);
      return;
    }
    tag = new ICETag({
      id: 'symbol-category-tag',
      left: 0,
      top: 166,
      width: 104,
      height: 24,
      text,
      status: 'info',
      variant: 'soft',
    });
    ice.addChild(tag);
  }

  const detail = new ICELabel({
    left: 116,
    top: 170,
    width: SYMBOL_CONSOLE_WIDTH - 116,
    height: 18,
    text: '',
    style: { fontSize: 12, fillStyle: theme.colors.textSecondary },
  });
  ice.addChild(detail);

  mountICEAccessibilityMirror(ice, { id: 'symbol-console-a11y' });

  return {
    ice,
    update(state: SymbolConsoleState): void {
      countCard.setValue(String(state.matched));
      if (state.selected) {
        const preset = (WATER_SYMBOL_PRESETS as any)[state.selected.kind];
        sizeCard.setValue(`${preset.width}×${preset.height}`);
        sizeCard.setTrend(`位号代号 ${state.selected.tag}`);
        const meta = categoryMetaOf(state.selected.category);
        setTag(meta.label);
        detail.setText(`介质：${state.selected.mediums.map(mediumOf).join(' / ')}`);
      } else {
        sizeCard.setValue('—');
        sizeCard.setTrend('未选中符号');
        setTag('未选中');
        detail.setText('点击左侧图例里的任意符号查看详情');
      }
      if (segmented.getValue() !== state.filter) segmented.setValue(state.filter);
      ice.dirty = true;
    },
  };
}

/** 介质代号 → 中文（词典来自设计器的水工艺域包，不另抄一份） */
function mediumOf(medium: string): string {
  const style = (WATER_MEDIUM_STYLES as any)[medium];
  return style ? style.label : medium;
}
