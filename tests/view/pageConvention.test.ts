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
