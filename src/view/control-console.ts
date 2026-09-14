/**
 * 运行控制台：用 **ice-web-components** 在一张独立画布上做的原生控件面板。
 *
 * 为什么单独开一张画布，不跟工艺图共用：
 * 设计器会把画布上"任意可交互图元"当成可选中、可拖动的图纸元素。控件（按钮、单选组、标签）
 * 一旦落进同一张画布，用户拖图纸时会把控件一起拖走。所以：**图画在图布上、控件画在控件布上**，
 * 两块画布各挂一个 `ICE` 实例（引擎支持多实例，事件总线与帧调度都是各自独立的）。
 */
import { ICE } from 'ice-render';
import {
  ICEHoverManager,
  ICELabel,
  ICERadioGroup,
  ICEStatCard,
  ICETag,
  getICEFocusManager,
  iceUIManager,
  mountICEAccessibilityMirror,
} from 'ice-web-components';
import { OPERATING_MODES, type OperatingModeId } from '../domain/operating-modes';
import type { ComplianceReport } from '../domain/water-quality';

/**
 * 控制台画布尺寸。
 *
 * 侧栏可用宽度 = 420（栅格）− 24（内边距）= 396，画布留到 390 —— 不留这点富余，
 * 侧栏会多出一条横向滚动条（画布比容器宽 4px 也一样滚动）。
 */
export const CONSOLE_WIDTH = 390;
export const CONSOLE_HEIGHT = 200;
export const CONSOLE_CARD_WIDTH = 185;

export type ConsoleState = {
  modeId: OperatingModeId;
  /** 进水流量，万 m³/d（已经除过 10000） */
  inflowWan: number;
  /** 出水 COD mg/L */
  effluentCod: number;
  /** 吨水电耗 kWh/m³ */
  energyPerCubicMeter: number;
  compliance: ComplianceReport;
  idleCount: number;
};

export type ControlConsole = {
  ice: any;
  update(state: ConsoleState): void;
  destroy(): void;
};

export type ControlConsoleOptions = {
  canvas: HTMLCanvasElement;
  modeId: OperatingModeId;
  onModeChange: (modeId: OperatingModeId) => void;
};

export function mountControlConsole(options: ControlConsoleOptions): ControlConsole {
  const canvas = options.canvas;
  canvas.width = CONSOLE_WIDTH;
  canvas.height = CONSOLE_HEIGHT;
  canvas.style.width = `${CONSOLE_WIDTH}px`;
  canvas.style.height = `${CONSOLE_HEIGHT}px`;

  const ice = new ICE().init(canvas, { renderMode: 'dirty-rect' });
  const theme = iceUIManager.getTheme();
  // 悬停与键盘焦点由控件库的两个管理器负责（Tab 轮转、焦点环、hover 态）
  new ICEHoverManager(ice).start();
  getICEFocusManager(ice).start();

  const title = new ICELabel({
    left: 0,
    top: 0,
    width: CONSOLE_WIDTH,
    height: 20,
    text: '运行控制台',
    style: { fontSize: 13, fontWeight: '600', fillStyle: theme.colors.text },
  });
  ice.addChild(title);

  const modeGroup = new ICERadioGroup({
    id: 'operating-mode',
    left: 0,
    top: 26,
    width: CONSOLE_WIDTH,
    value: options.modeId,
    options: OPERATING_MODES.map((mode) => ({ value: mode.id, label: mode.label })),
  });
  modeGroup.on('change', () => {
    options.onModeChange(modeGroup.getValue() as OperatingModeId);
  });
  ice.addChild(modeGroup);

  const inflowCard = new ICEStatCard({
    left: 0,
    top: 74,
    width: CONSOLE_CARD_WIDTH,
    height: 84,
    title: '进水流量',
    value: '0.00',
    trend: '万 m³/d',
    trendType: 'info',
    icon: '〜',
  });
  const codCard = new ICEStatCard({
    left: CONSOLE_WIDTH - CONSOLE_CARD_WIDTH,
    top: 74,
    width: CONSOLE_CARD_WIDTH,
    height: 84,
    title: '出水 COD',
    value: '0.0',
    trend: 'mg/L',
    trendType: 'success',
    icon: '◈',
  });
  ice.addChild(inflowCard);
  ice.addChild(codCard);

  let tagStatus = '';
  let tag: any = null;

  function setTag(text: string, status: string): void {
    if (status === tagStatus && tag) {
      tag.setText(text);
      return;
    }
    if (tag && tag.parentNode === ice) ice.removeChild(tag);
    tag = new ICETag({
      id: 'compliance-tag',
      left: 0,
      top: 170,
      width: 96,
      height: 24,
      text,
      status,
      variant: 'soft',
    });
    ice.addChild(tag);
    tagStatus = status;
  }

  const detail = new ICELabel({
    left: 108,
    top: 174,
    width: CONSOLE_WIDTH - 108,
    height: 18,
    text: '',
    style: { fontSize: 12, fillStyle: theme.colors.textSecondary },
  });
  ice.addChild(detail);

  // 无障碍镜像：把画布里的控件暴露成隐藏 DOM，屏幕阅读器与键盘用户才够得着
  mountICEAccessibilityMirror(ice, { id: 'console-a11y' });

  const api: ControlConsole = {
    ice,
    update(state: ConsoleState): void {
      inflowCard.setValue(state.inflowWan.toFixed(2));
      inflowCard.setTrend(`${state.modeId === 'rain' ? '雨季' : '日均'} · 万 m³/d`);
      codCard.setValue(state.effluentCod.toFixed(1));
      codCard.setTrend(
        state.compliance.pass
          ? `剩余裕度 ${Math.round((state.compliance.tightest ? state.compliance.tightest.margin : 0) * 100)}%`
          : `超标 ${state.compliance.exceeded.length} 项`
      );
      setTag(state.compliance.pass ? '出水达标' : '出水超标', state.compliance.pass ? 'success' : 'error');
      detail.setText(
        `${state.compliance.passed}/${state.compliance.total} 项达标 · ${state.energyPerCubicMeter.toFixed(
          3
        )} kWh/m³${state.idleCount ? ` · ${state.idleCount} 个单元停运` : ''}`
      );
      if (modeGroup.getValue() !== state.modeId) modeGroup.setValue(state.modeId);
      ice.dirty = true;
    },
    destroy(): void {
      if (typeof ice.destroy === 'function') ice.destroy();
    },
  };

  return api;
}
