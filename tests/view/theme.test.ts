/**
 * 主题解析的单元测试 + 「DOM 那半不能漂」的门禁。
 *
 * 背景：`public/index.html` 的 head 里有一段内联脚本，在**任何样式生效之前**给
 * `<html data-theme>` 打标记（否则暗色用户每次开页都先闪一下浅色）。它没法 import
 * TS 模块，所以"优先级"和"存储 key"这两件事在两边各写了一份 —— 这里把两份钉在一起：
 * 改了 `src/view/theme.ts` 却忘了改 index.html（或反过来），这条会红。
 */
import { DEFAULT_THEME, THEME_STORAGE_KEY, resolveThemeName } from '../../src/view/theme';

declare const require: (id: string) => any;
declare const __dirname: string;
const { readFileSync } = require('node:fs') as { readFileSync: (p: string, enc: string) => string };
const { join } = require('node:path') as { join: (...parts: string[]) => string };

const html = readFileSync(join(__dirname, '../../public/index.html'), 'utf8');

describe('主题解析（?theme= → localStorage → 默认）', () => {
  it('什么都不给 → 默认浅色', () => {
    expect(resolveThemeName('', null)).toBe(DEFAULT_THEME);
    expect(DEFAULT_THEME).toBe('light');
  });

  it('显式 ?theme= 优先于已存偏好', () => {
    expect(resolveThemeName('?theme=dark', 'light')).toBe('dark');
    expect(resolveThemeName('?theme=light', 'dark')).toBe('light');
  });

  it('没有参数时用已存偏好', () => {
    expect(resolveThemeName('', 'dark')).toBe('dark');
    expect(resolveThemeName('?foo=1', 'dark')).toBe('dark');
  });

  it('非法值落回下一级（不报错、不白屏）', () => {
    expect(resolveThemeName('?theme=whatever', 'dark')).toBe('dark');
    expect(resolveThemeName('?theme=whatever', null)).toBe('light');
    expect(resolveThemeName('?theme=true', null)).toBe('light');
    expect(resolveThemeName('?theme=', 'dark')).toBe('dark');
  });
});

describe('DOM 那半的内联脚本与 TS 侧口径一致（防漂）', () => {
  it('用了同一个存储 key', () => {
    expect(html).toContain(`'${THEME_STORAGE_KEY}'`);
  });

  it('同一套优先级与同样的合法值', () => {
    // 读参数 → localStorage → 默认，且只认 light / dark
    expect(html).toMatch(/URLSearchParams\(location\.search\)\.get\('theme'\)/);
    expect(html).toMatch(/localStorage\.getItem\(KEY\)/);
    expect(html).toMatch(/'light'\s*\|\|\s*v\s*===\s*'dark'/);
    expect(html).toMatch(/:\s*'light';/);
  });

  it('暗色标记会真的被 CSS 用上（不是白打的）', () => {
    expect(html).toMatch(/:root\[data-theme='dark'\]/);
    // 页面底色与画布底色都要覆盖：不覆盖画布就会"标签是暗的、画布还是白的"
    expect(html).toMatch(/:root\[data-theme='dark'\] canvas#canvas-shell/);
  });
});
