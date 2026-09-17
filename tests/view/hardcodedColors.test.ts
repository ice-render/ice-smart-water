/**
 * 硬编码颜色棘轮（2026-09-17 立）：**界面色一律走 token，只许留"语义色"。**
 *
 * 为什么要它：这一轮做深色主题时，界面色的漏水（登录门底、外壳底、图例岛 7 处、状态色 4 处）
 * 是**靠人工 grep** 才挖出来的 —— 它们不会让任何测试变红，只在暗色下露白/糊成一片。
 * 这条把"人工看起来"变成"测试拦下来"。
 *
 * 口径（写死在这里，改口径要改这条测试）：
 * - **界面色**（背景 / 文字 / 边框 / 图标）→ 必须来自 `theme.colors.*` 或库的主题引用；
 * - **语义色 / 数据色**（图表系列、工艺介质、SVG 导出底色）→ 允许写死，但要**登记在下表**并写明理由；
 * - **注释里的色值不算**（文档经常要引用旧色值讲历史），所以扫描前先剥掉注释。
 */
// `export {}` 让本文件成为**模块**：下面的 `declare const` 因此是模块作用域的 ——
// 同一 tsconfig 下 `pageConvention.test.ts` 也声明了 require/__dirname，全局声明会撞名（踩过）。
export {};

// 本仓的 `tsc --noEmit` 用**浏览器**那份 tsconfig（不含 node 类型）—— 应用代码本来就不该碰 node API。
// 这条测试跑在 jest（node）里，所以像 `pageConvention.test.ts` 那样显式声明这两个入口，
// 而不是给整个工程塞 @types/node。
declare const require: (id: string) => any;
declare const __dirname: string;
const fs = require('node:fs') as {
  readdirSync: (p: string, opts: { withFileTypes: true }) => Array<{ name: string; isDirectory: () => boolean }>;
  readFileSync: (p: string, enc: string) => string;
};
const path = require('node:path') as { resolve: (...parts: string[]) => string; join: (...parts: string[]) => string; relative: (a: string, b: string) => string; sep: string };

const SRC = path.resolve(__dirname, '..', '..', 'src');

/**
 * 允许写死的颜色（**只减不增**）：这些不是"界面外观"，而是**语义 / 数据**。
 * 新增一条时要写清为什么它不该跟主题走。
 */
const ALLOWED: Record<string, { colors: string[]; reason: string }> = {
  'entries/app.ts': {
    colors: [
      '#0d6efd',
      '#198754',
      '#dc3545',
      '#ffc107',
      '#fd7e14',
      '#94a3b8',
      '#ffffff',
    ],
    reason:
      '图表系列色与阈值色（数据可视化配色，不随界面主题走；#94a3b8 是"参数扫动演示"那条曲线的灰）' +
      ' + SVG 导出底色（导出的是文件内容，不是界面）',
  },
};

/** 剥掉行注释与块注释（保留字符串与模板里的内容 —— 那里的色值是真代码）。 */
function stripComments(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const c2 = source[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < source.length && source[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // 跳过字符串本身（不涂掉：里面的色值算真代码）
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === c) break;
        j++;
      }
      i = Math.min(j + 1, source.length);
      continue;
    }
    i++;
  }
  return out.join('');
}

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

/** 逐文件收集写死的色值（小写归一）。 */
function collect(): Record<string, string[]> {
  const found: Record<string, string[]> = {};
  for (const file of walk(SRC)) {
    const code = stripComments(fs.readFileSync(file, 'utf8'));
    const colors = [...new Set((code.match(/#[0-9a-fA-F]{3,8}\b/g) || []).map((c) => c.toLowerCase()))];
    if (colors.length) found[path.relative(SRC, file).split(path.sep).join('/')] = colors.sort();
  }
  return found;
}

describe('硬编码颜色棘轮（界面色必须走 token）', () => {
  it('没有未登记的写死颜色（界面色漏了主题，暗色下就会露白）', () => {
    const current = collect();
    const offenders: string[] = [];
    for (const [file, colors] of Object.entries(current)) {
      const allowed = (ALLOWED[file]?.colors || []).map((c) => c.toLowerCase());
      const extra = colors.filter((c) => allowed.indexOf(c) < 0);
      if (extra.length) offenders.push(`${file}: ${extra.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('登记表没有过期条目（颜色不用了要删记录，棘轮只进不退）', () => {
    const current = collect();
    const stale: string[] = [];
    for (const [file, entry] of Object.entries(ALLOWED)) {
      const used = current[file] || [];
      const unused = entry.colors.filter((c) => used.indexOf(c.toLowerCase()) < 0);
      if (unused.length) stale.push(`${file}: ${unused.join(', ')}（已不再使用，请删）`);
      if (!entry.reason) stale.push(`${file}: 没有写理由`);
    }
    expect(stale).toEqual([]);
  });

  it('至少扫到那一处确实允许的语义色（防扫描口径写坏之后静默空转）', () => {
    const current = collect();
    expect(current['entries/app.ts']).toContain('#0d6efd');
  });
});
