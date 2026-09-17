/**
 * 主题引用棘轮（2026-09-17 立）：**构造期取色只许减，不许增**。
 *
 * 为什么这条对应用层也重要：本仓现在支持**热切换**（侧栏「界面主题」→ 就地换色、不刷新）。
 * 前提是"界面里没有停在旧主题上的颜色"：
 *
 * | 写法 | 热切换时 |
 * |---|---|
 * | `fillStyle: token('ui.colors.text')`（**主题引用**，paint 时解析） | 跟着换 ✅ |
 * | `const c = theme.colors.text; … fillStyle: c`（构造期取色） | 停在旧主题 ❌ |
 *
 * 2026-09-17 把**直接进样式槽**的 43 处迁成了引用式（迁移前实测：热切换后外壳亮度 113，
 * 而完整暗色应当是 ~48 —— 差的那些就是没迁的构造期取色）。剩下这 27 处是**派生色与条件取色**
 * （混色 / 按状态选色 / 表格列定义里的取值），它们要跟随得挂在
 * `iceUIManager.onThemeChange()` 上重算。
 *
 * 口径与库里的 `tests/theme-refs.test.ts` 一致：按文件记预算，涨了红、降了也红（棘轮只进不退）。
 */
export {};

declare const require: (id: string) => any;
declare const __dirname: string;
const fs = require('node:fs') as {
  readdirSync: (p: string, opts: { withFileTypes: true }) => Array<{ name: string; isDirectory: () => boolean }>;
  readFileSync: (p: string, enc: string) => string;
};
const path = require('node:path') as { resolve: (...p: string[]) => string; join: (...p: string[]) => string; relative: (a: string, b: string) => string; sep: string };

const SRC = path.resolve(__dirname, '..', '..', 'src');

/** 每个文件允许的 `theme.colors.*` 用量（**当前实测值**，只能下调；改到 0 就从表里删）。 */
/** 每个文件允许的 `theme.colors.*` 用量 —— **已经是空的**：应用侧取色全部改成主题引用。 */
const BUDGET: Record<string, number> = {};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
};

function usages(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const n = (fs.readFileSync(file, 'utf8').match(/theme\.colors\.[A-Za-z]/g) || []).length;
    if (n) found[path.relative(SRC, file).split(path.sep).join('/')] = n;
  }
  return found;
}

describe('主题引用棘轮（应用层构造期取色只许减）', () => {
  it('没有文件超出预算（新增取色要写成 token 引用，或说明为什么必须构造期算）', () => {
    const current = usages();
    const over = Object.entries(current)
      .filter(([file, n]) => n > (BUDGET[file] ?? 0))
      .map(([file, n]) => `${file}: ${n} > 预算 ${BUDGET[file] ?? 0}`);
    expect(over).toEqual([]);
  });

  it('预算没有虚高（降下来了要登记，棘轮只进不退）', () => {
    const current = usages();
    const stale = Object.entries(BUDGET)
      .filter(([file, budget]) => (current[file] ?? 0) < budget)
      .map(([file, budget]) => `${file}: 预算 ${budget}，实测 ${current[file] ?? 0}（请调小）`);
    expect(stale).toEqual([]);
  });

  it('迁移进度上限（2026-09-17 起点：70 处 / 8 个文件）', () => {
    const current = usages();
    const total = Object.values(current).reduce((sum, n) => sum + n, 0);
    expect(total).toBeLessThanOrEqual(27);
    expect(Object.keys(current).length).toBeLessThanOrEqual(8);
  });
});
