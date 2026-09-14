# AGENTS.md — ice-smart-water

## 项目定位

ICE 家族的**应用侧样板**：把 `ice-render` / `ice-entity-designer` / `ice-web-components` / `ice-chart`
四件套按同一个业务（10 万 m³/d AAO 市政污水厂）拼成一个能用的应用。
**本仓只写水务业务**，渲染、图表、控件、领域设计器一律取自家族。

**整个系统只有一个 HTML**（`index.html`）：版面是**整页画布化的 admin console**
（对齐 `ice-web-components/examples/admin.html`）—— 侧栏 `ICEMenu` + 顶栏 + 卡片栅格
全画在一张外壳画布上；工艺流程图 / 运行数据 / 符号库是**壳里的三个页签**（`display` 切换）。
只有工艺图、24h 看板、符号图例是"岛"（各自独立画布 + 独立 `ICE` 实例）。
再外面盖一层**登录门**（`view/login.ts`，不透明覆盖画布，不校验账号，输入任意内容即可）。

唯一入口：`src/entries/app.ts`；**六个页签**：工艺流程图 / 运行数据 / 实时监视 / 工艺试算 / 事件中心 / 符号库。

⚠️ **缺图元就回上游封装，别在下游画**：水工艺域的一切（符号、介质、线型、图纸校验规则）都在
`ice-entity-designer/src/water/`。本仓只消费、不复制。已经这样补过两轮：
① 缺 10 个图元（调节池 / 料仓 / 除臭 / 潜污泵 / 螺杆泵 / 电动阀 / 止回阀 / 液位计 / 压力表 / 变频器）；
② 缺两种介质（仪表信号 / 动力回路）与点划线支持。

## 分支与推送（家族铁律，2026-09-10 确立）

- **开发一律在 `dev`**（或从它切出来的临时分支）；**推送前先合并到 `master`**，然后推。
- 双远端：`origin`（Gitee）+ `origin-github`（GitHub），两处都要推。
- GitHub 推送必须走 Clash 代理：`git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push origin-github <branch>`。
- 禁止直接在 `master` 上写实现。若 `master` 反而领先 `dev`，用 `git checkout dev && git merge --ff-only master` 对齐。

## 门禁

`npm run verify` = `types:check` + `jest` + `build`；`npm run test:e2e` 另跑两个入口页的 Playwright 回归（先自动 build）。
**改业务规则必须补/改单测；改页面交互必须补/改 e2e，且 e2e 全程 console error 必须为 0。**

## 分层铁律

1. **`src/domain` 不许 import 任何兄弟包的运行时导出**（只能 `import type`）。
   这一层要能脱离浏览器单测 —— 一旦引了引擎产物，`npm test` 就得先有兄弟仓库的构建结果。
   需要新的业务计算，写在这里；需要引擎能力，说明它属于 `view`。
2. **`view/adapter.ts` 是引擎数据结构与业务数据结构之间唯一的接触点。**
   引擎改了 `state` 结构只改这里；业务模型永远只看 `PlantGraph`。
3. **`entries` 只做装配与状态编排**，不写业务规则、不写绘制代码。
4. **全工程一套坐标系 = 画布绝对坐标**。外壳、卡片、岛用同一套数；页面节点直接挂在画布根上。
   放进一个 content 容器会让卡片再叠一次容器偏移（症状：卡片偏 264px、岛的"洞"对不上）。
   注意区分「加进卡片之后是**卡片内相对坐标**」—— 卡片已经在自己的绝对位置上了。
5. **要独立 ICE 实例的东西一律做成「岛」**（工艺图 / `ice-chart` 看板）：
   DOM 里 `<div class="island">` + `<canvas>`，按外壳坐标绝对定位，由 `onIslands` 负责摆位与显隐。
   岛不在引擎显示树里，**必须自己管显隐**，否则切页后还"飘"在画面上。
   岛的画布尺寸依赖它的容器，所以**要先把岛摆到位，再 `new ICE().init()` / `createChart()`**；
   懒显示的岛（看板）第一次显示时要补一次 `resize()` + `refresh()`。
6. **覆盖层（登录门）也是一个独立 ICE 实例**：不透明整页画布、`z-index` 高于岛，
   登录成功整层 `display:none` 让应用露出来。所以应用可以**先建好再被盖住**，
   不需要"登录后才初始化"那套懒加载（少一堆时序坑）。退出登录时记得清 `sessionStorage`。
7. **一切都在一个 HTML 里，页签靠 `display` 切换**：不要为了"多一个功能模块"再开一个 HTML ——
   那样会多出整页初始化、跨页状态丢失（工况、筛选、编辑都带不过去）与重复加载四件套。
   新功能＝壳里加一个页签 + 按需在 `PageHandle` 里声明 `islands` / `actions` / `statusTags`。
8. **`__water` 这类调试句柄只建一次，业务字段用 getter**：在 `recompute()` 里反复重建它，
   会互相覆盖成"上一帧的快照"（踩过）。

## 三个新增业务模块的口径（改之前先看）

- **`live-signal.ts`**：实时点位用**确定性随机游走**（同种子同序列）—— 现场数据是活的，
  但演示与端到端断言需要可复现。采样循环在**入口**（`setInterval`），页面只负责显示。
  量纲：`DayPoint.inflow` 与实时点位都是 **m³/h**（日水量 / 24），设计规模是 m³/d，别混。
- **`sizing.ts`**：参数化试算，口径必须与图纸模型一致 —— 单测里有一条**交叉校验**：
  默认参数下算出的泥龄 / 需氧 / 污泥 / 电耗必须落回 `computeKpi` 的设计工况（偏差 < 2~5%）。
  改 `UNIT_REMOVAL` 或厂站参数会同时影响两边，跑一下 `tests/domain/sizing.test.ts` 就知道有没有跑偏。
- **`alarm-log.ts`**：报警 = **历史存量 + 现场报警**（审计条目 / 24h 越限小时 / 工况事件）。
  处置是**不可变**的（`ackAlarm` / `closeAlarm` 返回新数组），轨迹只追加。

## 踩过的坑（改之前先看）

- **多份 `ice-render`**：每个兄弟包的 `node_modules` 里都有一份自己装的 `ice-render`（版本可能不同）。
  `webpack.config.js` 用 `resolve.alias` 把四个包钉到同级仓库目录，否则会出现多份引擎实例，
  `typeId` 注册与 `instanceof` 全错位。**别删那段 alias，也别改成裸包名。**
- **`ICESegmented` 与 `ICERadioGroup` 的回调口径不同**：前者走**构造参数** `onChange`（不抛 `change` 事件），
  后者走**事件** `change`。用错的表现是"点了没反应，且不报错"。
- **画布控件的可点区域是它的子项**（每一档/每个选项），父容器只负责布局；
  点在档与档之间的缝隙上命中到容器本身（没有 click 处理）→ 表现为"点上去没反应"。
  e2e 用 `clickWidget()` 点子项中心，不要背坐标。
- **`ICEMenu` 的二级项在父项展开之前不存在**：`getItemNode('mode:rain')` 会返回 `null`。
  测试要按真实交互顺序来（先点父项，见 e2e 的 `clickSubmenu()`），这不是缺陷。
- **`page.mouse.wheel` 在当前指针位置派发**：不先 `page.mouse.move` 到画布上，滚轮事件落在 (0,0)，
  看起来像"缩放失灵"。`canvasPoint()` 已经代劳。
- **画布背景是透明的**（底色由页面 CSS 给）：用像素判定"画出来没有"时必须排除 alpha≈0 的像素，
  否则"非白像素占比"恒为 1，断言形同虚设。
- **页面必须自带 favicon**：不写内联 `<link rel="icon">`，浏览器会请求 `/favicon.ico` 得到 404，
  控制台留一条 error，e2e 的"零报错"就废了。
- **画布尺寸要扣掉 body 的 padding**：`window.innerWidth` 不扣，加上 24px 内边距就是一条永远消不掉的
  横向滚动条。见 `measureCanvas()`。
- **`ICELabel` + `style.wrap`** 才能换行；构造期的高度来自 DOM 兜底测量（长中文会偏大），
  所以"卡要留多高"用 `estimateTextHeight()` 估，别信构造期实测。
- **画布文本控件聚焦时会挂一个原生 `<input>` 替身**盖在自己身上（键盘输入走它）：
  - 断言"鼠标落在某个画布上"时要允许 `INPUT`/`TEXTAREA`，否则一聚焦就误判；
  - e2e 想验真实输入就得"先点输入框再 `page.keyboard.type()`"，直接 `setValue()` 等于跳过整条链路；
  - 读文字/数值用组件自己的 `getText()` / `getValue()`，别读 `state.text`（`ICEAvatar` 这类把文字放在内部 `textNode` 上）。
- **业务规则要自洽**：改 `UNIT_REMOVAL` 之前先看 `plant-case.ts` 的注释 ——
  脱氮率受回流比上界约束、二沉池不接内回流，这两条错一个，全套数字跟着错。
- **图上分叉会被"最短路径"抄近道**：上游图纸校验用的是**无向**走线。事故支路原先接在
  出水计量点之后 → 从生物池经事故池到出水反而更短，于是"出水路径"绕开了在线监测，
  校验报 `outlet-without-analyzer`。**分叉点要在在线监测之前**（本案例接在消毒池后）。
- **仪表/变频器必须画连线**：上游校验把"没有任何管线"判成 `isolated-symbol`。
  仪表走 `signal` 介质、变频器走 `power` 介质（点划线、无管径）。
- **`ICEPolyLine` 只认 `lineType: 'solid' | 'dashed'`**：点划线要靠 `lineDash` 表达
  （上游 `dashPatternOf()` 已经封好），把 `'dashdot'` 塞进 `lineType` 会被静默当实线。
- **构建可能静默失败**：`npm run build >/dev/null 2>&1 && …` 之后看到的现象是"改动没生效"。
  排查时**先看构建输出**，别怀疑代码。

## 上游关系

`ice-entity-designer/examples/water-editor.html` 与 `water-symbols.html` 仍然存在（上游 e2e 依赖它们），
本仓的入口是**重写过的工程版**，不是那两个文件的镜像。上游改了示例页，本仓不需要跟着改。
