/**
 * 运行看板：用 **ice-chart** 做的图表区。
 *
 * 职责分工（这也是 ice-chart 的设计前提）：图表层只做「数据 ↔ 像素 ↔ 语义事件」，
 * 命中测试与事件派发交给引擎。所以这里**不写任何绘制代码**，只给一份声明式 option；
 * 跨图联动、缩放平移、图例开关、键盘导航都是库的内建能力。
 *
 * 图表都建在**自己的画布**上，容器尺寸变了由 `autoResize` 重排（ResizeObserver）。
 */
import { createChart, type ChartOption } from '@damoqiongqiu/ice-chart';
import type { DayPoint } from '../domain/process-model';
import { DISCHARGE_LIMIT_1A } from '../domain/water-quality';
import type { CategoryMeta } from '../domain/symbol-catalog';

export type ChartHandle = {
  chart: any;
  /** 重新按当前数据算 option 并应用（保留当前缩放窗口） */
  refresh: () => void;
  resize: () => void;
  destroy: () => void;
};

/**
 * 挂一张图：`buildOption` 每次 refresh 时重新算 —— 数据在业务层，
 * 图表层只负责把最新数据编译成像素。
 */
export function mountChart(canvas: HTMLCanvasElement, buildOption: () => ChartOption): ChartHandle {
  const chart = createChart(canvas, buildOption(), { autoResize: true, renderMode: 'dirty-rect' });
  return {
    chart,
    refresh(): void {
      chart.setOption(buildOption(), { animate: true, preserveView: true });
    },
    resize(): void {
      if (typeof chart.resize === 'function') chart.resize();
    },
    destroy(): void {
      if (typeof chart.destroy === 'function') chart.destroy();
    },
  };
}

/**
 * 24 小时进出水趋势。
 *
 * 双 y 轴是必须的：流量是 m³/h（几千量级）、浓度是 mg/L（几十量级），
 * 挤在一根轴上浓度曲线会被压成一条直线，什么都看不出来。
 */
export function dailyTrendOption(
  points: DayPoint[],
  meta: { modeLabel: string; standard: string },
  limit = DISCHARGE_LIMIT_1A
): ChartOption {
  const labels = points.map((point) => point.label);
  return {
    title: {
      text: '24 小时进出水趋势',
      subtext: `${meta.modeLabel} · 执行 ${meta.standard}`,
    },
    theme: 'light',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    crosshair: { show: true, axis: 'x', showAxisLabel: true },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '时刻', data: labels },
    yAxis: [
      { name: '进水流量 m³/h' },
      { name: '出水浓度 mg/L', position: 'right' },
    ],
    interaction: {
      hover: { enabled: true, mode: 'nearest-x' },
      zoom: { enabled: true, axes: 'x', wheel: true },
      pan: { enabled: true, axes: 'x' },
      select: { enabled: true, mode: 'single' },
      keyboard: true,
    },
    animation: { enabled: true, duration: 520, easing: 'easeOutCubic' },
    series: [
      {
        id: 'inflow',
        type: 'area',
        name: '进水流量',
        data: points.map((point) => point.inflow),
        smooth: true,
        areaOpacity: 0.18,
      },
      {
        id: 'cod',
        type: 'line',
        name: `出水 COD（限值 ${limit.COD}）`,
        yAxisIndex: 1,
        data: points.map((point) => point.cod),
        smooth: true,
        symbolSize: 4,
        lineWidth: 2,
      },
      {
        id: 'nh3n',
        type: 'line',
        name: `出水氨氮（限值 ${limit.NH3N}）`,
        yAxisIndex: 1,
        data: points.map((point) => point.nh3n),
        smooth: true,
        symbolSize: 4,
        lineDash: [5, 4],
      },
      {
        id: 'tn',
        type: 'line',
        name: `出水总氮（限值 ${limit.TN}）`,
        yAxisIndex: 1,
        data: points.map((point) => point.tn),
        smooth: true,
        symbolSize: 4,
        lineDash: [2, 3],
      },
    ],
  } as ChartOption;
}

/** 符号库构成：按分类数符号个数 */
export function symbolMixOption(stats: Array<CategoryMeta & { count: number }>): ChartOption {
  return {
    title: { text: '符号库构成', subtext: '按工艺分类计数' },
    theme: 'light',
    legend: { show: false },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '分类', data: stats.map((item) => item.label) },
    yAxis: { name: '符号数' },
    animation: { enabled: true, duration: 480, easing: 'easeOutCubic' },
    series: [
      {
        id: 'count',
        type: 'bar',
        name: '符号数',
        data: stats.map((item) => item.count),
        barWidth: 0.5,
      },
    ],
  } as ChartOption;
}
