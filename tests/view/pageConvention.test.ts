/**
 * 应用层页面写法的棘轮（2026-09-17 立）。
 *
 * 契约（见 AGENTS「页面写法」）：**一页 = 一个继承 `WaterPage` 的类**，
 * 文件名与类名一致、大驼峰；页面不再返回"node + 闭包"的句柄。
 *
 * 为什么要有这条测试：外壳的类型签名已经挡住"不是容器"的页面（`build` 只收
 * `PageContent`），但挡不住"又开一个 `xxx-page.ts` 工厂"这种走回头路的写法 ——
 * 那正是这次要消灭的东西（12 页各写一份 refresh 脚手架）。这里用一条便宜的正则守住。
 */
// 本仓的 `tsc --noEmit` 用**浏览器**那份 tsconfig（`types: ["jest"]`，不含 node）——
// 应用代码本来就不该碰 node API。这条测试跑在 jest（node）里，所以显式声明这两个入口，
// 而不是给整个工程塞 @types/node。
declare const require: (id: string) => any;
declare const __dirname: string;
const { readdirSync, readFileSync } = require('node:fs') as { readdirSync: (p: string) => string[]; readFileSync: (p: string, enc: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const PAGES_DIR = join(__dirname, '../../src/view/pages');

const pageFiles = readdirSync(PAGES_DIR).filter((file) => file.endsWith('.ts'));

describe('页面写法棘轮', () => {
  it('页面文件一律大驼峰（纯 OO 文件命名）', () => {
    const bad = pageFiles.filter((file) => !/^[A-Z][A-Za-z0-9]*Page\.ts$/.test(file));
    expect(bad).toEqual([]);
  });

  it('每个页面文件导出一个同名 Page 类，且继承 WaterPage', () => {
    const wrong: string[] = [];
    pageFiles.forEach((file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      const name = file.replace(/\.ts$/, '');
      if (!new RegExp(`export class ${name} extends WaterPage\\b`).test(source)) {
        wrong.push(file);
      }
    });
    expect(wrong).toEqual([]);
  });

  it('页面里不再出现老的工厂写法（buildXxxPage / PageHandle 句柄）', () => {
    const legacy: string[] = [];
    pageFiles.forEach((file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      if (/export function build[A-Z]\w*Page\b/.test(source) || /type\s+\w*PageHandle\b/.test(source) || /\brefresh\s*\(\s*\)/.test(source)) {
        legacy.push(file);
      }
    });
    expect(legacy).toEqual([]);
  });

  it('页面数量自检（正则没扫到就得先修这条测试）', () => {
    expect(pageFiles.length).toBeGreaterThanOrEqual(12);
  });
});

/**
 * 类体里的成员序列：`S` 静态字段 / `F` 实例字段 / `C` 构造函数 / `A` 访问器 /
 * `T` 静态方法 / `M` 实例方法。
 *
 * 只看**类体这一层**（缩进回到 0 的行），方法体里的东西不算；注释行整行跳过。
 */
const memberSequence = (classBody: string): string => {
  const kinds: string[] = [];
  let depth = 0;
  for (const line of classBody.split('\n')) {
    const t = line.trim();
    if (depth === 0 && t && !/^(\*|\/\/|\/\*)/.test(t)) {
      const isCtor = /^(?:public |protected |private )?constructor\s*\(/.test(t);
      const isStatic = /^(?:public |protected |private )?static\b/.test(t);
      const isAccessor = /^(?:public |private |protected )?(?:get|set)\s+[A-Za-z_$]/.test(t);
      const isCall = /\b(if|for|while|switch|catch|return|new|super|await|void|typeof)\b/.test(t.split('(')[0]);
      const mods = '(?:(?:public|private|protected|readonly|declare|abstract|override|static|async|\\*)\\s+)*';
      const isMethod =
        !isCtor &&
        !isAccessor &&
        !isCall &&
        /\(/.test(t) &&
        new RegExp(`^${mods}[A-Za-z_$#][\\w$]*(?:\\s*<[^>]*>)?\\s*\\(`).test(t);
      const isField =
        !isCtor &&
        !isAccessor &&
        !isMethod &&
        new RegExp(`^${mods}[A-Za-z_$#][\\w$]*(?:!|\\?)?\\s*(?::[^=;]*)?(?:=|;)`).test(t);
      if (isCtor) kinds.push('C');
      else if (isField) kinds.push(isStatic ? 'S' : 'F');
      else if (isAccessor) kinds.push('A');
      else if (isMethod) kinds.push(isStatic ? 'T' : 'M');
    }
    depth += (line.match(/[{([]/g) || []).length - (line.match(/[})\]]/g) || []).length;
    if (depth < 0) depth = 0;
  }
  return kinds.join('');
};

/**
 * 成员顺序棘轮（2026-09-17 定，全家族同口径）。
 *
 * 契约：`static 常量/字段 → static 方法 → 实例字段 → 构造函数 → 访问器 / 实例方法`
 * —— 就是这条正则：`S*T*F*C*(A|M)*`。
 *
 * 为什么 static 方法在实例字段**之前**：本仓的静态方法都是"**这个页面类型的**版面几何"
 * （`DataPage.boardIslandRect()` 那类）—— 宿主在建引擎之前就要拿它摆岛，那时页面实例
 * 还不存在（见 `DataPage` 里那段"为什么是静态方法"的注释）。所以"类级的东西在前、
 * 实例级的东西在后"在这里是有依据的顺序，不只是审美。
 *
 * 为什么只到这一层：Google Java Style §3.4.2 明确说 class 成员顺序"**没有唯一正确的配方**"
 * （要的是"每种顺序都讲得通、维护者能解释"），Google 的 TypeScript 指南对顺序**完全沉默**
 * （全文 "ordering" 出现 0 次）。所以 public/private 的先后、同组内谁先谁后，留给作者判断。
 *
 * ⚠️ 挪位置前先分清挪的是什么：**方法随便挪**（类定义时方法就全部装好，与文本顺序无关），
 * **字段的声明顺序有语义**（初始化按声明顺序执行 + 影响 V8 的 class shape）。
 */
describe('成员顺序棘轮（static 常量 → 实例字段 → 构造函数 → 方法）', () => {
  it('每个页面类的成员序列都是 S*T*F*C*(A|M)*', () => {
    const bad: string[] = [];
    let scanned = 0;
    pageFiles.forEach((file) => {
      const source = readFileSync(join(PAGES_DIR, file), 'utf8');
      const at = source.indexOf('class ');
      if (at < 0) return;
      const seq = memberSequence(source.slice(at).split('\n').slice(1).join('\n'));
      if (!seq) return;
      scanned++;
      if (!/^S*T*F*C*(?:A|M)*$/.test(seq)) bad.push(`${file}(${seq})`);
    });
    expect(bad).toEqual([]);
    // 自检：一条都没扫到就说明这条测试已经失效了
    expect(scanned).toBeGreaterThanOrEqual(12);
  });
});
