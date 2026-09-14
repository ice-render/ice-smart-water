/**
 * 符号库的**业务目录**：每个符号是干什么的、接什么介质、设计时看哪几个量、巡检看什么。
 *
 * 形状是 `ice-entity-designer` 给的（`WATER_SYMBOL_PRESETS` 里有 label / 尺寸 / 画法分组），
 * 这里补的是**业务语义** —— 图纸上画得出符号，不等于新人知道该怎么用。
 * `water-symbols` 页就是把这两半拼在一起看的。
 *
 * 记法依据：GB/T 50106《建筑给水排水制图标准》第 3 章「图例」；
 * 工艺单元按工艺专业通行画法，位号给行业习惯代号（可覆盖）。
 */
import type { WaterMedium, WaterSymbolKind } from 'ice-entity-designer';

/** 展示用分类（比引擎的 kind 列表更贴业务：水线 / 泥线 / 设备 / 边界） */
export type SymbolCategory = 'water' | 'sludge' | 'equipment' | 'boundary';

export type CategoryMeta = {
  id: SymbolCategory;
  label: string;
  /** 紧凑标签（画布上的分段控件放不下全称） */
  short: string;
  description: string;
};

export const SYMBOL_CATEGORIES: CategoryMeta[] = [
  { id: 'water', label: '水线处理单元', short: '水线', description: '主流程上的构筑物：预处理 → 生化 → 深度处理' },
  { id: 'sludge', label: '污泥线单元', short: '泥线', description: '剩余污泥的浓缩、脱水与外运' },
  { id: 'equipment', label: '设备与仪表', short: '设备', description: '泵、风机、阀门、流量计、在线仪表' },
  { id: 'boundary', label: '边界符号', short: '边界', description: '厂界进出水，图上标明流程的起终点' },
];

/** 符号库页的筛选：某个分类，或全部分类 */
export type LegendFilter = SymbolCategory | 'all';

export function categoryMetaOf(id: SymbolCategory): CategoryMeta {
  return SYMBOL_CATEGORIES.filter((item) => item.id === id)[0];
}

export type SymbolEntry = {
  kind: WaterSymbolKind;
  label: string;
  category: SymbolCategory;
  /** 行业习惯位号代号 */
  tag: string;
  /** 该符号可能出现的介质 */
  mediums: WaterMedium[];
  /** 工艺作用（一句话） */
  role: string;
  /** 设计关注的量 */
  designFocus: string[];
  /** 运行巡检要点 */
  checks: string[];
};

export const SYMBOL_CATALOG: Record<WaterSymbolKind, SymbolEntry> = {
  // ---------------- 水线处理单元 ----------------
  barScreen: {
    kind: 'barScreen',
    label: '格栅',
    category: 'water',
    tag: 'GR',
    mediums: ['sewage'],
    role: '拦截漂浮物与大颗粒杂质，保护后续水泵与管道',
    designFocus: ['栅距（粗 20~25mm / 细 5~10mm）', '过栅流速 0.6~1.0 m/s', '栅渣量'],
    checks: ['栅前后水位差（>0.2m 说明堵了）', '除污机耙齿与链条', '栅渣外运记录'],
  },
  gritChamber: {
    kind: 'gritChamber',
    label: '曝气沉砂池',
    category: 'water',
    tag: 'GC',
    mediums: ['sewage'],
    role: '去除砂粒等无机颗粒，防止管道磨损与池底积砂',
    designFocus: ['停留时间 3~5 min', '曝气量', '砂水分离效率'],
    checks: ['曝气是否均匀（局部不曝气会积砂）', '砂水分离器出力', '排砂管是否堵塞'],
  },
  primaryClarifier: {
    kind: 'primaryClarifier',
    label: '初沉池',
    category: 'water',
    tag: 'PC',
    mediums: ['sewage', 'sludge'],
    role: '重力沉淀去除可沉悬浮物，降低生物池负荷',
    designFocus: ['表面负荷 1.5~3.0 m³/(m²·h)', '停留时间 1.0~2.5 h', '排泥周期'],
    checks: ['表面有无浮渣与藻类', '刮泥机运行电流', '排泥阀与排泥浓度'],
  },
  anaerobicTank: {
    kind: 'anaerobicTank',
    label: '厌氧池',
    category: 'water',
    tag: 'AT',
    mediums: ['sewage', 'returnSludge'],
    role: 'AAO 的第一段：聚磷菌释磷，兼有反硝化消耗回流污泥带入的硝酸盐',
    designFocus: ['停留时间 1~2 h', '溶解氧 < 0.2 mg/L', '搅拌强度'],
    checks: ['严格厌氧（曝气串气会破坏释磷）', '搅拌器是否停转', '回流污泥是否均匀进入'],
  },
  anoxicTank: {
    kind: 'anoxicTank',
    label: '缺氧池',
    category: 'water',
    tag: 'AX',
    mediums: ['sewage', 'recycle'],
    role: 'AAO 的第二段：反硝化脱氮，消耗混合液内回流带来的硝酸盐',
    designFocus: ['内回流比 100%~300%', '溶解氧 0.2~0.5 mg/L', '停留时间 2~4 h'],
    checks: ['内回流泵流量', '池面有无翻泥与气泡', '缺氧末端硝酸盐氮'],
  },
  aerobicTank: {
    kind: 'aerobicTank',
    label: '好氧池',
    category: 'water',
    tag: 'AE',
    mediums: ['sewage', 'air', 'recycle'],
    role: 'AAO 的第三段：有机物降解 + 氨氮硝化 + 聚磷菌吸磷',
    designFocus: ['污泥龄 12~25 d', 'F/M 0.05~0.15', '溶解氧 2 mg/L', '需氧量'],
    checks: ['溶解氧在线值与鼓风机风量匹配', '曝气盘是否堵塞', 'MLSS 与 SVI'],
  },
  secondaryClarifier: {
    kind: 'secondaryClarifier',
    label: '二沉池',
    category: 'water',
    tag: 'SC',
    mediums: ['effluent', 'returnSludge', 'sludge'],
    role: '泥水分离：上清液作出水，底部污泥一部分回流、一部分作剩余污泥排出',
    designFocus: ['表面负荷 1.5~2.5 m³/(m²·h)', '固体负荷', '回流比 50%~100%'],
    checks: ['出水 SS 与泥面高度', '回流污泥浓度与回流泵', '有无反硝化上浮污泥'],
  },
  coagulationTank: {
    kind: 'coagulationTank',
    label: '混凝沉淀池',
    category: 'water',
    tag: 'CO',
    mediums: ['effluent', 'chemical'],
    role: '投加混凝剂去除总磷与残余悬浮物，是 TP 达标的最后一道保障',
    designFocus: ['投加量 20~40 mg/L', '混合 30~60 s + 絮凝 10~20 min', '表面负荷'],
    checks: ['加药泵行程与药液液位', '絮体大小与沉降速度', '化学污泥量与排泥'],
  },
  filterBed: {
    kind: 'filterBed',
    label: '滤池',
    category: 'water',
    tag: 'FL',
    mediums: ['effluent'],
    role: '过滤截留细微悬浮物，把出水 SS 稳定压在一级 A 以内',
    designFocus: ['滤速 5~10 m/h', '反冲洗强度与周期', '水头损失'],
    checks: ['滤池水头损失（到设定值必须反冲）', '反冲洗泵与风机', '出水浊度'],
  },
  disinfectionTank: {
    kind: 'disinfectionTank',
    label: '消毒接触池',
    category: 'water',
    tag: 'DT',
    mediums: ['effluent'],
    role: '保证消毒接触时间，灭活致病微生物（排放与回用的强制要求）',
    designFocus: ['接触时间 ≥ 30 min', '折流板布置', '余氯控制'],
    checks: ['加氯 / 紫外剂量与余氯值', '折流板是否破损短路', '接触池无短流'],
  },

  // ---------------- 污泥线单元 ----------------
  sludgeThickener: {
    kind: 'sludgeThickener',
    label: '污泥浓缩池',
    category: 'sludge',
    tag: 'ST',
    mediums: ['sludge'],
    role: '重力浓缩降低含水率，减小后续脱水机的处理量',
    designFocus: ['固体负荷 10~35 kg/(m²·d)', '浓缩后含水率 96%~97%', '上清液回流'],
    checks: ['泥位与出泥浓度', '上清液是否澄清（浑浊说明负荷过高）', '刮泥机扭矩'],
  },
  dewateringMachine: {
    kind: 'dewateringMachine',
    label: '污泥脱水机',
    category: 'sludge',
    tag: 'DW',
    mediums: ['sludge'],
    role: '机械脱水把污泥含水率降到 80% 以下，满足外运要求',
    designFocus: ['干污泥量 tDS/d', 'PAM 投加量', '泥饼含水率 ≤ 80%'],
    checks: ['PAM 配药浓度与流量', '滤带跑偏 / 螺旋磨损', '泥饼含水率与滤液浑浊度'],
  },
  sludgeOut: {
    kind: 'sludgeOut',
    label: '污泥外运',
    category: 'sludge',
    tag: 'SO',
    mediums: ['sludge'],
    role: '脱水后泥饼外运处置（焚烧 / 建材 / 土地利用）',
    designFocus: ['泥饼日产量', '外运车辆与联单', '暂存棚容量'],
    checks: ['外运联单与称重记录', '暂存区防渗防雨', '去向是否合规'],
  },

  // ---------------- 设备与仪表 ----------------
  pump: {
    kind: 'pump',
    label: '水泵',
    category: 'equipment',
    tag: 'P',
    mediums: ['sewage', 'sludge', 'returnSludge'],
    role: '提升与输送（进水泵、回流污泥泵、剩余污泥泵）',
    designFocus: ['流量 m³/h', '扬程 m', '轴功率与备用台数'],
    checks: ['电流与振动', '集水井液位联锁', '备用泵能否正常切换'],
  },
  blower: {
    kind: 'blower',
    label: '鼓风机',
    category: 'equipment',
    tag: 'B',
    mediums: ['air'],
    role: '向好氧池供气，是全厂能耗的大头（约 50%）',
    designFocus: ['风量 m³/h', '风压 kPa', '氧转移效率'],
    checks: ['出口压力与温度', '空气过滤器压差', '与溶解氧联动的风量调节'],
  },
  dosingUnit: {
    kind: 'dosingUnit',
    label: '加药装置',
    category: 'equipment',
    tag: 'DU',
    mediums: ['chemical'],
    role: '投加混凝剂 / 助凝剂 / 消毒剂，除磷消毒的药剂入口',
    designFocus: ['投加量 mg/L', '药液浓度', '计量泵量程'],
    checks: ['药液液位与搅拌', '计量泵行程与背压', '药剂库存与有效期'],
  },
  valve: {
    kind: 'valve',
    label: '阀门',
    category: 'equipment',
    tag: 'V',
    mediums: ['sewage', 'effluent', 'sludge', 'returnSludge', 'recycle', 'air', 'chemical'],
    role: '控制通断与分流。**出厂状态直接影响流径**：关阀即断流',
    designFocus: ['通径 DN', '开关时间', '是否电动 / 手动'],
    checks: ['开到位 / 关到位信号', '电动执行器力矩报警', '长期不动的阀门定期活动'],
  },
  flowMeter: {
    kind: 'flowMeter',
    label: '流量计',
    category: 'equipment',
    tag: 'FIT',
    mediums: ['sewage', 'effluent'],
    role: '计量过流流量，是水量平衡、能耗考核与排污申报的数据源',
    designFocus: ['量程与精度', '前后直管段', '是否带累积量'],
    checks: ['瞬时流量是否合理', '累积量清零与校准周期', '信号是否上传平台'],
  },
  analyzer: {
    kind: 'analyzer',
    label: '在线水质分析仪',
    category: 'equipment',
    tag: 'AIT',
    mediums: ['effluent'],
    role: '在线监测出水水质并联网上传 —— **排污许可的强制要求**',
    designFocus: ['监测项目（COD / 氨氮 / 总磷 / 总氮 / pH）', '采样点代表性', '数据有效率 ≥ 90%'],
    checks: ['标液核查与比对', '采样管路是否堵塞', '数据是否正常上传环保平台'],
  },

  // ---------------- 边界符号 ----------------
  inlet: {
    kind: 'inlet',
    label: '进水',
    category: 'boundary',
    tag: 'IN',
    mediums: ['sewage'],
    role: '厂外进水边界：流径分析的起点',
    designFocus: ['设计流量', '时变化系数', '进水水质'],
    checks: ['进水水量水质在线数据', '溢流与事故排放口', '上游来水异常（工业废水偷排）'],
  },
  outlet: {
    kind: 'outlet',
    label: '出水 / 排放',
    category: 'boundary',
    tag: 'OUT',
    mediums: ['effluent'],
    role: '排放边界：流径分析的终点，达标判定的考核点',
    designFocus: ['执行标准（GB 18918 一级 A）', '排放去向', '排放口规范化'],
    checks: ['出水水质在线数据与超标报警', '排放口标志与采样平台', '排放量是否超过许可'],
  },
};

export function symbolsOfCategory(category: SymbolCategory): SymbolEntry[] {
  return Object.keys(SYMBOL_CATALOG)
    .map((kind) => SYMBOL_CATALOG[kind as WaterSymbolKind])
    .filter((entry) => entry.category === category);
}

/** 分类计数：符号库页的构成图直接用 */
export function categoryStats(): Array<CategoryMeta & { count: number }> {
  return SYMBOL_CATEGORIES.map((meta) => ({ ...meta, count: symbolsOfCategory(meta.id).length }));
}

/** 全部 symbols（按 kind 在预设表里的顺序） */
export function allSymbols(): SymbolEntry[] {
  return Object.keys(SYMBOL_CATALOG).map((kind) => SYMBOL_CATALOG[kind as WaterSymbolKind]);
}

/**
 * 位号规则：`代号-区域码序号`，例如 `GR-101`。
 *
 * 新增单元时按同代号的现有位号**顺延序号**，而不是从 101 开始撞号 ——
 * 位号在同一张图里必须唯一（图纸校验会拦重复位号，这里从源头避免）。
 * 区域码默认 101（预处理区），调用方可以按工艺分区传不同的码。
 */
export function nextTag(kind: WaterSymbolKind, existingTags: string[], areaCode = 101): string {
  const prefix = SYMBOL_CATALOG[kind] ? SYMBOL_CATALOG[kind].tag : 'X';
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let max = 0;
  existingTags.forEach((tag) => {
    const matched = pattern.exec(String(tag || '').trim());
    if (matched) max = Math.max(max, Number(matched[1]));
  });
  return `${prefix}-${max > 0 ? max + 1 : areaCode}`;
}

/** 按位号找单元 id（图纸上按位号搜索用），找不到返回 null */
export function findNodeIdByTag(nodes: Array<{ id: string; tag?: string }>, tag: string): string | null {
  const target = String(tag || '').trim();
  const hit = nodes.filter((node) => String(node.tag || '').trim() === target)[0];
  return hit ? hit.id : null;
}
