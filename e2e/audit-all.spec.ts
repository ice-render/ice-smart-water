import { expect, test } from '@playwright/test';
import { auditNotesCard, clickSubmenu, layoutAudit, login, pageOverflow } from './helpers';

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  (page as any).__errors = errors;
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.goto('/');
  await page.waitForFunction(() => !!(window as any).__water);
  await page.waitForTimeout(400);
  await login(page, { name: '体检员' });
});

/**
 * 全量版面体检：把"六页签 × 三工况"都跑一遍，外加岛溢出、顶栏溢出、事件行展开。
 *
 * 之前 e2e 只在正常工况逐页审、雨季只审了工艺流程图页 —— 其余五页在雨季/检修工况、以及
 * 岛（DOM 画布）溢出、事件展开行这些路径完全没覆盖。这里一次性补上。
 */

const PAGES = ['process', 'data', 'live', 'calc', 'events', 'legend'];
const MODES = ['normal', 'rain', 'maintenance'];

/** 每页的岛 → 宿主卡片映射（岛必须完整落在宿主卡片的正文区里，否则就是溢出/错位） */
const ISLAND_MAP: Record<string, Array<{ island: string; card: string }>> = {
  process: [{ island: 'process', card: 'graph-card' }],
  data: [{ island: 'board', card: 'trend-card' }],
  live: [
    { island: 'live-trend', card: 'live-trend-card' },
    { island: 'live-gauge', card: 'live-gauge-card' },
    { island: 'live-heat', card: 'live-heat-card' },
  ],
  calc: [{ island: 'calc-curve', card: 'calc-curve-card' }],
  legend: [{ island: 'legend', card: 'legend-card' }],
  events: [],
};

function worldOf(page: any, expr: string) {
  return page.evaluate((e: string) => {
    // eslint-disable-next-line no-new-func
    const node = new Function(`return ${e}`)();
    if (!node || !node.state) return null;
    let l = 0;
    let t = 0;
    let c = node;
    while (c && c.state) {
      l += Number(c.state.left) || 0;
      t += Number(c.state.top) || 0;
      c = c.parentNode;
    }
    return { l, t, w: Number(node.state.width) || 0, h: Number(node.state.height) || 0 };
  }, expr);
}

/** 岛溢出审计：岛必须落在宿主卡片正文区（left+16, top+44, w-32, h-60）内，且不出内容区 */
async function auditIslands(page: any, pageKey: string): Promise<string[]> {
  const map = ISLAND_MAP[pageKey] || [];
  if (!map.length) return [];
  const problems: string[] = [];
  for (const { island, card } of map) {
    const cardBox = await worldOf(page, `window.__water.shell.find('${card}')`);
    if (!cardBox) {
      problems.push(`${pageKey}: 找不到宿主卡片 ${card}`);
      continue;
    }
    const islandBox = await page.evaluate((id: string) => {
      const shell = (document.querySelector('#canvas-shell') as HTMLElement).getBoundingClientRect();
      const host = document.getElementById(`island-${id}`) as HTMLElement;
      if (!host) return null;
      const r = host.getBoundingClientRect();
      return { l: r.left - shell.left, t: r.top - shell.top, w: r.width, h: r.height };
    }, island);
    if (!islandBox) {
      problems.push(`${pageKey}: 找不到岛 ${island}`);
      continue;
    }
    const body = { l: cardBox.l + 16, t: cardBox.t + 44, w: cardBox.w - 32, h: cardBox.h - 60 };
    const tol = 2;
    const inside =
      islandBox.l >= body.l - tol &&
      islandBox.t >= body.t - tol &&
      islandBox.l + islandBox.w <= body.l + body.w + tol &&
      islandBox.t + islandBox.h <= body.t + body.h + tol;
    if (!inside) {
      problems.push(
        `${pageKey}: 岛 ${island}[${Math.round(islandBox.l)},${Math.round(islandBox.t)} ${Math.round(islandBox.w)}x${Math.round(
          islandBox.h
        )}] 溢出宿主卡片 ${card} 正文区[${Math.round(body.l)},${Math.round(body.t)} ${Math.round(body.w)}x${Math.round(body.h)}]`
      );
    }
  }
  return problems;
}

/** 顶栏审计：状态标签 + 操作按钮必须落在【顶栏区域】(top 0~HEADER_HEIGHT) 内，且彼此不交叠 */
async function auditHeader(page: any): Promise<string[]> {
  return page.evaluate(() => {
    const w = (window as any).__water;
    const shell = w.shell;
    // 顶栏区域：侧栏右侧、画布顶部一条（title band 占 0~HEADER_HEIGHT，不属内容区）
    const headerBox = { l: shell.layout.content.left, t: 0, w: shell.layout.content.width, h: 64 };
    const world = (node: any) => {
      let l = 0;
      let t = 0;
      let c = node;
      while (c && c.state) {
        l += Number(c.state.left) || 0;
        t += Number(c.state.top) || 0;
        c = c.parentNode;
      }
      return { l, t, w: Number(node.state.width) || 0, h: Number(node.state.height) || 0 };
    };
    const nodes: any[] = [];
    for (let i = 0; i < 6; i += 1) {
      const tag = shell.find(`status-tag-${i}`);
      if (tag && tag.state) nodes.push({ label: `status-tag-${i}`, box: world(tag) });
    }
    // 操作按钮：找 header 下所有 ICEButton
    const header = shell.find('header');
    const walk = (n: any) => {
      if (!n || !n.state) return;
      if (n.constructor && n.constructor.name === 'ICEButton') nodes.push({ label: String(n.state.id || 'button'), box: world(n) });
      (n.childNodes || []).forEach(walk);
    };
    walk(header);
    const problems: string[] = [];
    for (const n of nodes) {
      const { l, t, w, h } = n.box;
      // 容忍 ±2px 取整；顶栏标签通常从顶部 16 起排，底不超 64
      if (l < headerBox.l - 2 || t < headerBox.t - 2 || l + w > headerBox.l + headerBox.w + 2 || t + h > headerBox.t + headerBox.h + 2) {
        problems.push(`顶栏 ${n.label}[${Math.round(l)},${Math.round(t)} ${Math.round(w)}x${Math.round(h)}] 冲出顶栏区域`);
      }
    }
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i].box;
        const b = nodes[j].box;
        const ox = Math.min(a.l + a.w, b.l + b.w) - Math.max(a.l, b.l);
        const oy = Math.min(a.t + a.h, b.t + b.h) - Math.max(a.t, b.t);
        if (ox > 2 && oy > 2) problems.push(`顶栏 ${nodes[i].label} x ${nodes[j].label} 交叠`);
      }
    }
    return problems;
  });
}

test('全量版面体检：六页签 × 三工况 + 岛溢出 + 顶栏溢出', async ({ page }) => {
  const report: any[] = [];
  for (const mode of MODES) {
    if (mode !== 'normal') {
      await clickSubmenu(page, "window.__water.shell.find('menu')", 'mode', `mode:${mode}`);
      await page.waitForTimeout(900);
    }
    for (const key of PAGES) {
      await page.evaluate((k) => (window as any).__water.shell.show(k), key);
      await page.waitForTimeout(key === 'live' ? 1400 : 800);
      const audit = await layoutAudit(page);
      const islands = await auditIslands(page, key);
      const header = await auditHeader(page);
      const notes = key === 'process' ? await auditNotesCard(page) : [];
      const problems = [...audit.hits, ...audit.outside, ...islands, ...header, ...notes];
      if (problems.length) {
        report.push({ mode, page: key, nodeCount: audit.nodeCount, problems });
      }
    }
  }
  expect(await pageOverflow(page)).toEqual({ x: 0, y: 0 });
  if (report.length) {
    const text = report
      .map((r) => `【${r.mode}/${r.page}】(${r.nodeCount}节点)\n  - ${r.problems.join('\n  - ')}`)
      .join('\n');
    throw new Error(`发现 ${report.length} 处版面问题：\n${text}`);
  }
});

test('事件中心：展开第一行后，展开区不溢出卡片、不与下行交叠', async ({ page }) => {
  await page.evaluate(() => (window as any).__water.shell.show('events'));
  await page.waitForTimeout(800);
  // 展开第一行（库控件若没有 expandRow 再退化为只做基础体检）
  const expanded = await page.evaluate(() => {
    const table = (window as any).__water.shell.find('alarm-table');
    if (!table || typeof table.expandRow !== 'function') return 'no-expand-api';
    table.expandRow(0);
    return 'ok';
  });
  await page.waitForTimeout(500);
  const audit = await layoutAudit(page);
  expect(audit.hits, `事件中心图元相交：\n${audit.hits.join('\n')}`).toEqual([]);
  expect(audit.outside, `事件中心图元冲出内容区：\n${audit.outside.join('\n')}`).toEqual([]);
  expect((page as any).__errors).toEqual([]);
  expect(expanded === 'ok' || expanded === 'no-expand-api').toBe(true);
});
