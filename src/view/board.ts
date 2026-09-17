/**
 * 运行看板：用 **ice-chart** 做的图表区。
 *
 * 职责分工（这也是 ice-chart 的设计前提）：图表层只做「数据 ↔ 像素 ↔ 语义事件」，
 * 命中测试与事件派发交给引擎。所以这里**不写任何绘制代码**，只给一份声明式 option；
 * 跨图联动、缩放平移、图例开关、键盘导航都是库的内建能力。
 *
 * 图表都建在**自己的画布**上，容器尺寸变了由 `autoResize` 重排（ResizeObserver）。
 *
 * **图表库按需加载**（2026-09-17）：`ice-chart` 有 281KB（压缩前），而首屏是「工艺流程图」，
 * 一个图表都不用 —— 实测（Slow 4G + 4x CPU、冷缓存）它占控制台 chunk 的三分之一：
 * 387KB gz 里约 110KB、以及约 400ms 的解析/执行长任务。所以这里改成动态 import：
 * 只有**图表所在的岛真的可见**（切到运行数据 / 实时监视 / 能耗 … 页）时才创建图表。
 * 首屏不加载它；登录后空闲时会 `prefetch()` 预热，用户切过去通常已经就绪。
 *
 * 句柄把 `appendData / setData / setOption` 这些**增量**调用也包住了：图表还没创建时它们会被忽略，
 * 数据由调用方（页面状态）在创建时一次性喂全 —— 图表层的滑动窗口不再兼任"唯一数据源"。
 */
import type { ChartOption } from '@damoqiongqiu/ice-chart';
import type { DayPoint } from '../domain/process-model';
import { DISCHARGE_LIMIT_1A } from '../domain/water-quality';
import type { CategoryMeta } from '../domain/symbol-catalog';
import type { SludgeStage } from '../domain/sludge-manifest';
import { HEALTH_DIMS } from '../domain/asset-registry';
import { applyThemeToIce } from './theme';

export type ChartHandle = {
  /** 图表实例；**按需加载完成前是 `null`**（调试 / e2e 要先等就绪，见 `ready`）。 */
  chart: any | null;
  /** 图表是否已创建（库已加载且这张图已经建好）。 */
  ready: boolean;
  /** 重新按当前数据算 option 并应用（保留当前缩放窗口） */
  refresh: () => void;
  resize: () => void;
  /** 增量追加数据点（图表未就绪时空转；调用方的数据源才是唯一真相） */
  appendData: (seriesId: string, points: Array<[number, number]>, options?: any) => void;
  /** 整体替换某个系列的数据（同上） */
  setData: (seriesId: string, data: any, options?: any) => void;
  /** 直接应用一份 option（同上） */
  setOption: (option: ChartOption, options?: any) => void;
  /** 后台预热图表库（不建图）：登录后空闲时调用，用户切到图表页就不用等 */
  prefetch: () => void;
  /** UI 空闲时预热（内部用，幂等） */
  prefetchWhenIdle: () => void;
  destroy: () => void;
};

/** 动态载入图表库（同一个 Promise 只加载一次）。 */
let chartLibPromise: Promise<any> | null = null;
function loadChartLib(): Promise<any> {
  if (!chartLibPromise) {
    chartLibPromise = import(/* webpackChunkName: "chart" */ '@damoqiongqiu/ice-chart');
  }
  return chartLibPromise;
}

/** 画布当前是否可见：岛被 `display:none` 藏起来时 `offsetParent` 为 null。 */
function isCanvasVisible(canvas: HTMLCanvasElement): boolean {
  return !!canvas && canvas.offsetParent !== null && canvas.width > 0;
}

/**
 * 挂一张图：`buildOption` 每次 refresh 时重新算 —— 数据在业务层，
 * 图表层只负责把最新数据编译成像素。
 */
export function mountChart(canvas: HTMLCanvasElement, buildOption: () => ChartOption): ChartHandle {
  let chart: any = null;
  let loading = false;

  /**
   * 创建图表（幂等）。只在**画布可见**时真正建：不可见时建出来尺寸也不对，
   * 而且那样就失去了"首屏不加载图表库"的意义。
   */
  const ensure = (): void => {
    if (chart || loading || !isCanvasVisible(canvas)) {
      return;
    }
    loading = true;
    void loadChartLib()
      .then((mod: any) => {
        if (chart || !isCanvasVisible(canvas)) {
          return; // 期间被切走了：交给下一次 refresh 再建
        }
        chart = mod.createChart(canvas, buildOption(), { autoResize: true, renderMode: 'dirty-rect' });
        /**
         * 图表 `theme:'auto'` 的明暗 = **它自己那个引擎实例**的背景亮度（`ICEChart` 内部
         * `this.ice = new ICE()`，还会订阅引擎主题变化自己重画）。所以建完图要把当前主题
         * 打到它的实例上 —— 否则 option 传给它的 `auto` 只会解析成默认浅色，
         * 症状就是"外壳深了，图表还是白的"。
         */
        if (chart.ice) applyThemeToIce(chart.ice);
        // 立刻按容器实测尺寸对齐一次：`createChart` 只按画布当前尺寸布图，
        // 而画布刚被塞进"岛"里时还是 300×150 的默认尺寸。容器不可见时 resize() 会自己跳过。
        if (typeof chart.resize === 'function') {
          chart.resize();
        }
      })
      .catch((err: unknown) => {
        console.error('[ice-smart-water] 图表库加载失败：', err);
      })
      .finally(() => {
        loading = false;
      });
  };

  return {
    get chart(): any | null {
      return chart;
    },
    get ready(): boolean {
      return !!chart;
    },
    refresh(): void {
      if (!chart) {
        ensure();
        return;
      }
      chart.setOption(buildOption(), { animate: true, preserveView: true });
    },
    resize(): void {
      if (!chart) {
        ensure();
        return;
      }
      if (typeof chart.resize === 'function') {
        chart.resize();
      }
    },
    appendData(seriesId: string, points: Array<[number, number]>, options?: any): void {
      if (chart && typeof chart.appendData === 'function') {
        chart.appendData(seriesId, points, options);
      }
    },
    setData(seriesId: string, data: any, options?: any): void {
      if (chart && typeof chart.setData === 'function') {
        chart.setData(seriesId, data, options);
      }
    },
    setOption(option: ChartOption, options?: any): void {
      if (chart && typeof chart.setOption === 'function') {
        chart.setOption(option, options);
      }
    },
    prefetch(): void {
      void loadChartLib().catch(() => undefined);
    },
    prefetchWhenIdle(): void {
      // 只在登录后空闲时预热（首帧之前抢带宽反而拖慢首屏）
      const idle = (globalThis as any).requestIdleCallback;
      if (typeof idle === 'function') {
        idle(() => void loadChartLib().catch(() => undefined), { timeout: 4000 });
      } else {
        setTimeout(() => void loadChartLib().catch(() => undefined), 1200);
      }
    },
    destroy(): void {
      if (chart && typeof chart.destroy === 'function') {
        chart.destroy();
      }
      chart = null;
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
    theme: 'auto',
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
    theme: 'auto',
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

/**
 * 污泥流程：湿泥量（柱，左轴）+ 含水率（线，右轴）。
 *
 * 两根轴是必须的：湿泥量是 992 → 39.7 m³/d（跨两个数量级），含水率是 99.2% → 80%，
 * 挤在一根轴上含水率会被压成一条直线。
 */
export function sludgeFlowOption(stages: SludgeStage[]): ChartOption {
  return {
    title: { text: '污泥流程', subtext: '湿泥量随含水率收缩 · 干泥量守恒' },
    theme: 'auto',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '环节', data: stages.map((stage) => stage.name) },
    yAxis: [
      { name: '湿泥量 m³/d' },
      { name: '含水率 %', position: 'right', min: 70, max: 100 },
    ],
    animation: { enabled: true, duration: 480, easing: 'easeOutCubic' },
    series: [
      { id: 'wet', type: 'bar', name: '湿泥量', data: stages.map((stage) => stage.wetFlow), barWidth: 0.45 },
      {
        id: 'water',
        type: 'line',
        name: '含水率',
        yAxisIndex: 1,
        data: stages.map((stage) => Math.round(stage.waterRate * 1000) / 10),
        smooth: true,
        symbolSize: 6,
        lineWidth: 2,
      },
    ],
  } as ChartOption;
}

/** 设备健康度矩阵：横轴 = 装置分类、纵轴 = 五个健康维度（`ice-chart` heatmap 的 `[x, y, value]`）。 */
export function assetHealthOption(
  matrix: Array<[string, string, number]>,
  categories: string[]
): ChartOption {
  return {
    title: { text: '健康度矩阵', subtext: '装置分类 × 五个维度（平均分）' },
    theme: 'auto',
    legend: { show: false },
    tooltip: { trigger: 'item' },
    xAxis: { type: 'category', data: categories },
    // 分类轴是**自下而上**排的，反转一下让「运行工况」在最上面（与 HEALTH_DIMS 的阅读顺序一致）
    yAxis: { type: 'category', data: HEALTH_DIMS.slice().reverse() },
    grid: { x: false, y: false },
    animation: { enabled: true, duration: 400 },
    series: [{ id: 'health', type: 'heatmap', name: '健康度', data: matrix }],
  } as ChartOption;
}

/** 能耗分项：各分项日耗电（柱）。 */
export function energyMixOption(mix: { names: string[]; energy: number[] }): ChartOption {
  return {
    title: { text: '能耗分项', subtext: '按「装机 × 负载系数」摊分全厂日耗电' },
    theme: 'auto',
    legend: { show: false },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '分项', data: mix.names },
    yAxis: { name: '日耗电 kWh' },
    animation: { enabled: true, duration: 440, easing: 'easeOutCubic' },
    series: [{ id: 'energy', type: 'bar', name: '日耗电', data: mix.energy, barWidth: 0.5 }],
  } as ChartOption;
}

/** 峰谷分摊：各时段电量（柱）+ 该时段电价（线，右轴）。 */
export function tariffOption(bands: { names: string[]; energy: number[]; prices: number[] }): ChartOption {
  return {
    title: { text: '峰谷分摊', subtext: '三档各 8 小时 · 谷 / 平 / 峰' },
    theme: 'auto',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '时段', data: bands.names },
    yAxis: [
      { name: '电量 kWh' },
      { name: '电价 元/kWh', position: 'right', min: 0, max: 1.2 },
    ],
    animation: { enabled: true, duration: 440, easing: 'easeOutCubic' },
    series: [
      { id: 'energy', type: 'bar', name: '电量', data: bands.energy, barWidth: 0.45 },
      { id: 'price', type: 'line', name: '电价', yAxisIndex: 1, data: bands.prices, smooth: true, symbolSize: 6, lineWidth: 2 },
    ],
  } as ChartOption;
}

/** 泵的 Q-η 特性：横轴转速比、左轴效率、右轴流量。 */
export function pumpCurveOption(curve: { speeds: number[]; efficiency: number[]; flow: number[] }): ChartOption {
  return {
    title: { text: '泵特性曲线', subtext: '相似定律：流量 ∝ n、扬程 ∝ n²、轴功率 ∝ n³' },
    theme: 'auto',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '转速比', data: curve.speeds.map((speed) => `${Math.round(speed * 100)}%`) },
    yAxis: [
      { name: '效率 %', min: 0, max: 100 },
      { name: '流量 m³/h', position: 'right' },
    ],
    animation: { enabled: true, duration: 440, easing: 'easeOutCubic' },
    series: [
      { id: 'eta', type: 'line', name: '效率', data: curve.efficiency, smooth: true, symbolSize: 5, lineWidth: 2 },
      { id: 'flow', type: 'line', name: '流量', yAxisIndex: 1, data: curve.flow, smooth: true, symbolSize: 5, lineDash: [5, 4] },
    ],
  } as ChartOption;
}

/** 集水井液位：面积 + 高 / 低报警线。 */
export function sumpLevelOption(
  series: number[],
  options: { high: number; low: number }
): ChartOption {
  const labels = series.map((_, index) => `${index - series.length + 1}m`);
  const percent = (value: number) => Math.round(value * 1000) / 10;
  return {
    title: { text: '集水井液位', subtext: '最近 60 分钟 · 液位占有效水深的百分比' },
    theme: 'auto',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '时间', data: labels },
    yAxis: { name: '液位 %', min: 0, max: 100 },
    animation: { enabled: true, duration: 380, easing: 'linear' },
    series: [
      {
        id: 'level',
        type: 'area',
        name: '液位',
        data: series.map(percent),
        smooth: 0.25,
        areaOpacity: 0.2,
        lineWidth: 2,
      },
      { id: 'high', type: 'line', name: '高液位', data: series.map(() => percent(options.high)), lineDash: [6, 4], lineWidth: 1.5, symbolSize: 0 },
      { id: 'low', type: 'line', name: '低液位', data: series.map(() => percent(options.low)), lineDash: [6, 4], lineWidth: 1.5, symbolSize: 0 },
    ],
  } as ChartOption;
}

/** 预案对比：横轴 = 指标、两条柱 = 基线 / 预案（值 = 达标度 %）。 */
export function drillCompareOption(compare: { names: string[]; before: number[]; after: number[] }): ChartOption {
  return {
    title: { text: '达标度对比', subtext: '100% = 正好压线 · 越高越有余量' },
    theme: 'auto',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '指标', data: compare.names },
    yAxis: { name: '达标度 %', min: 0 },
    animation: { enabled: true, duration: 440, easing: 'easeOutCubic' },
    series: [
      { id: 'before', type: 'bar', name: '当前参数', data: compare.before, barWidth: 0.35 },
      { id: 'after', type: 'bar', name: '预案参数', data: compare.after, barWidth: 0.35 },
    ],
  } as ChartOption;
}

/** 巡检路线到位情况：计划 / 已巡 / 超时（三条路线分组柱）。 */
export function inspectionRouteOption(stats: {
  routes: string[];
  planned: number[];
  done: number[];
  missed: number[];
}): ChartOption {
  return {
    title: { text: '路线到位情况', subtext: '按巡检路线统计条数' },
    theme: 'auto',
    legend: { show: true, position: 'top' },
    tooltip: { trigger: 'axis' },
    grid: { show: true, x: false, y: true },
    xAxis: { type: 'category', name: '路线', data: stats.routes },
    yAxis: { name: '条数' },
    animation: { enabled: true, duration: 440, easing: 'easeOutCubic' },
    series: [
      { id: 'planned', type: 'bar', name: '计划', data: stats.planned, barWidth: 0.4 },
      { id: 'done', type: 'bar', name: '已巡', data: stats.done, barWidth: 0.4 },
      { id: 'missed', type: 'bar', name: '超时', data: stats.missed, barWidth: 0.4 },
    ],
  } as ChartOption;
}
