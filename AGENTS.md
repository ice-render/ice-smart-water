# AGENTS.md — ice-smart-water

## 项目定位

ICE 家族的**应用侧样板**：把 `ice-render` / `ice-entity-designer` / `ice-web-components` / `ice-chart`
四件套按同一个业务（10 万 m³/d AAO 市政污水厂）拼成一个能用的应用。
**本仓只写水务业务**，渲染、图表、控件、领域设计器一律取自家族。

**整个系统只有一个 HTML**（`index.html`）：版面是**整页画布化的 admin console**
（对齐 `ice-web-components/examples/admin.html`）—— 侧栏 `ICEMenu` + 顶栏 + 卡片栅格
全画在一张外壳画布上，页面靠 `display` 切换；需要独立视口的图/图表是"岛"（独立画布 + 独立 `ICE` 实例）。
再外面盖一层**登录门**（`view/login.ts`，不透明覆盖画布，不校验账号，输入任意内容即可）。

**导航是两级**：**侧栏列「域」，顶栏的 `ICESegmented`（id `page-tabs`）列该域的「页签」**。
域定义在 `app.ts` 的 `NAV_DOMAINS`（外壳据此**自动生成侧栏域项**与页签）；`shell.show(pageKey)` 会自动
定位到所属域并高亮页签 —— 所以切页只认 pageKey，不用关心域。

**新增一个业务场景 = 往某个域里加一页 + 注册进 `pages`**（有岛再动 `index.html` / `app.ts` 的岛表），
**侧栏不用动**。为什么非分两级不可：页签一多侧栏放不下（`ICEMenu` 没有滚动，高度 = 行数 × 40，一屏约 17 行）。
切页后要做的收尾（重算、某页的一次性动作）挂 `ShellOptions.onPageShow` —— **页签是外壳内部直接调
`show()` 的，不经过 `onMenuSelect`**。

唯一入口：`src/entries/app.ts`；当前 **3 个域 / 9 页**：工艺（工艺流程图 / 符号库 / 工艺试算）、
运行（运行数据 / 实时监视）、运营（事件中心 / 污泥产运 / 设备资产 / 巡检管理）。

**表格列宽必须算够**：`ICETable` 不裁剪列，列宽之和超过表格宽度会把列**静默挤出卡片**。
`e2e/ops-pages.spec.ts` 的 `expectTableFits()` 专门守这条（版面体检抓不到：表格是库控件，体检到它就停止下探）。

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

## 新增业务模块的口径（改之前先看）

- **`live-signal.ts`**：实时点位用**确定性随机游走**（同种子同序列）—— 现场数据是活的，
  但演示与端到端断言需要可复现。采样循环在**入口**（`setInterval`），页面只负责显示。
  量纲：`DayPoint.inflow` 与实时点位都是 **m³/h**（日水量 / 24），设计规模是 m³/d，别混。
- **`sizing.ts`**：参数化试算，口径必须与图纸模型一致 —— 单测里有一条**交叉校验**：
  默认参数下算出的泥龄 / 需氧 / 污泥 / 电耗必须落回 `computeKpi` 的设计工况（偏差 < 2~5%）。
  改 `UNIT_REMOVAL` 或厂站参数会同时影响两边，跑一下 `tests/domain/sizing.test.ts` 就知道有没有跑偏。
- **`alarm-log.ts`**：报警 = **历史存量 + 现场报警**（审计条目 / 24h 越限小时 / 工况事件）。
  处置是**不可变**的（`ackAlarm` / `closeAlarm` 返回新数组），轨迹只追加。
- **`energy-meter.ts`**：分项日耗电 = 装机 × 负载系数 × 24，**分项之和必须等于全厂日耗电**
  （单测钉死守恒）；峰谷三档按**价格升序**（谷 → 平 → 峰）声明，图表直接照数组顺序画。
- **`pump-station.ts`**：泵工况由业务流量**按相似定律反推**（`Q ∝ n`、`H ∝ n²`、`P ∝ n³`），
  不查特性表 —— 这样"图上流量一变，转速 / 效率 / 单位电耗全跟着变"是算出来的。
  人工启停用 `overrides`（泵 id → 是否运行），空对象 = 按铭牌角色（工作泵转、备用泵停）。
  相似定律的断言要**放宽精度**：转速会四舍五入到 2 位小数，别按等式死比。
- **`drill-plan.ts`**：预案**复用 `sizing.evaluateScenario`**，不另造模型 —— 页面上的每个数字
  都要能在「工艺试算」页用同一套参数复现。`switchMinutes` 是**调度属性**（经验值），
  页面上必须标注它不是模型输出，别混进 `evaluateScenario` 的结果里。
  另外注意：雨季预案的**电耗变化是负的**（流量大、单位电耗反而降），"达标项数"的分值上限是 100
  （不是 100%），写断言时别按直觉来。

## 版面：位置别手算，也别信"看着没重叠"

- **卡片正文一律用 `stackColumn()` 流式排**（`view/shell.ts`）。手算 `y += 20` 这种写法
  一定会压字：`ICELabel` 的实测高度是 **19**（12px 字号 + 行距），我按 16 留位就 3px 相交。
  另外**正文的起点不能是 `CARD_INSET`(16)** —— 卡片标题带占了 0~44，从标题带下方（52）起排。
- **卡片标题不能太长**：右上角放了 `extra`（按钮组）时，标题可用宽度 =
  卡宽 − 内边距 − extra 宽。实时趋势卡的 extra 有 470 宽，标题超过约 350px 就会压上去。
- **正文容器要落在卡片正文区**（`left: CARD_INSET` / `top: CARD_TITLE_BAND`）。
  `extra` 与标题同在 12~44 这条带里（实测：标题 top=12 h=16、分段控件 top=12 h=32），
  所以正文从 44 起正好贴住、不会压上去；**放在 (0,0) 就一定会压标题与 extra**
  （工况预案卡的预演步骤正文踩过）。
- **统计卡列宽按实际张数算**：符号库页有 5 张卡（总数 + 4 个分类），按 4 列算宽会让第 5 张
  **冲出画布右边**（超出之后直接被裁掉，看起来像"少了一块"）。
- **`e2e/layout.spec.ts` 是这类问题的护栏**：跑 `npm run test:e2e` 会逐页体检。
  两条实现口径写在那里：祖先判定按**对象身份**（按类名会误判成父子而漏报）、
  控件内部不往下审（滑块的轨道与滑块头本来就有意叠着；也**不能拿 `getFormValue` 判控件**，
  基类上就有它）。

## 侧栏菜单：父项也要有反馈

点「运行工况 / 符号分类」这类**父项**在上游只触发"展开"（设计如此），界面上什么都不变
—— 用户会以为菜单坏了。上游为此补了 `ICEMenu.onExpand(key, expanded)` 回调
（2026-09-14，已双推），应用侧在 `ShellOptions.onMenuExpand` 里接住：
点父项就跳到该组最相关的那一页并给提示；切工况后跳到工艺流程图（阀位与指标在那里最直观）。

## 启动遮罩（2026-09-15 确立）

**"加载中"这件事只能由 HTML/CSS 表达，不能画在画布上** —— 首屏要下载 + 解析 + 执行约 1.4MB 的包
（四个家族包内联，见 webpack 输出），**包跑起来之前画布上一个像素也画不出来**。

没有遮罩时用户先看到的是 `canvas` 的默认尺寸 **300×150**（`index.html` 里的 canvas 既没写
`width/height` 属性、也没给 CSS 尺寸）—— 也就是左上角那个突兀的白色圆角矩形。
实测（1.6Mbps + 4× CPU 降速）：**7.5 秒**才出登录门，期间一直是那个矩形。

三条口径：

1. 遮罩本体在 `public/index.html`（纯 HTML/CSS + 一行内联脚本），**不依赖 bundle**；
   `body.is-booting` 期间连 `.app` 一起 `visibility: hidden`（否则遮罩没盖上时仍会露出那个矩形）。
2. 撤下时机：**等"接下来会露出来的那一层"真正画完一帧**——`hideBootOverlayWhenPainted(ice)`
   （`src/view/boot-overlay.ts`）以 `ice.dirty === false` 为信号（渲染器每跑完一轮都会清它），
   登录态决定等登录门的 ICE 还是外壳的 ICE，60 帧兜底。
   **不要用"第 N 帧之后"这种固定时机**：启动段里 `recompute()`（建 12 个页签内容）会占住主线程几百毫秒，
   而登录门/外壳各有独立画布、并不需要等它 —— 固定早撤会露出白页，固定晚撤会白等（本地实测多等 0.7s）。
3. 遮罩 **`pointer-events: none`**：加载期间本来没有可点的东西，而拦点击会让 e2e 的画布坐标点击
   与 `elementFromPoint` 命中断言全部落空（"遮罩盖住登录画布"这类断言会假红）。

回归：`e2e/boot-overlay.spec.ts`（加载期间必须看到遮罩 + 裸 canvas 必须不可见；就绪后遮罩必须撤下并摘出 DOM）。
加载明显偏慢（>6s）时文案会换成"首次加载需要解析约 1.4MB 引擎与组件库…"，这句也在这条口径里。

## 踩过的坑（改之前先看）

### 代码分割：首屏只留登录门（2026-09-15 确立，先看这条）

- **入口是 `src/entries/boot.ts`**：只 `import './login-boot'`（挂登录门 + 撤启动遮罩），
  控制台（`src/entries/app.ts`：外壳 + 12 个页签 + 设计器 + 图表 + 案例数据）用 `import()` **异步**加载。
- **为什么**：控制台那堆模块（实体设计器 194KB + 图表 281KB + 各页面）在用户登录之前**一个都用不上**，
  却会占住首屏的下载、解析与执行。实测（1.6Mbps + 4× CPU 限速，gzip）：
  **登录门 2.68s → 1.48s**（-45%），首屏 JS **1364KB → 771KB**，控制台 3.38s → 2.93s。
- **接缝只有一个：登录提交**。用户在控制台就绪前点"登录"时，`login-boot` 先排队，
  `setEnterApp()` 一注册就补进应用 —— **不要让用户再点一次**。
- **约束**：入口 chunk 里**不许**出现设计器 / 图表 / `view/pages/*` 的静态 import（一出现就被拖回首屏）。
  判据：`dist/` 下应有 `boot.*.js` + `console.*.js` 两个产物，且 boot 明显小于 console。
- **回归**：`e2e/boot-overlay.spec.ts`（4 例）——启动遮罩两条 + **"控制台 chunk 加载不出来时登录门照样能起来"**
  （钉住"首屏不依赖控制台"）+ **"弱网下先点登录、到货后自动进入"**（钉住排队那条路径）。

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
- **`ICELabel` + `style.wrap`** 才能换行；**`ICELabel` 构造后 `state.height` 只等于单行高**，
  即使文本实际渲染成两行，它也只认 18px。所以用 `paragraph()` 这类辅助函数时，
  必须**把 `estimateTextHeight()` 的结果显式设到 `height` 上**，否则 `stackColumn()` 会按单行高排，
  文本第二行直接糊到下一个节点上（工艺流程图页「雨季超越」的审计条目以前就是这样压字的）。
- **ASCII 词组（数字 + 单位 + 标点）别太乐观地按 0.55em 估**：`m³/(m²·h)` 这类串实际占宽比想象大，
  `estimateTextHeight()` 里按 0.7em 估 + `perLine` 打 9 折，才稳。
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

## 布局机制与依赖（2026-09-15 确立）

- **统计卡一行用引擎的等分网格**：`createStatRow()`（`src/view/shell.ts`）返回一个持有
  `ICEGridLayout({ cols, cellSizing: 'equal' })` 的行容器，卡片加进去即可 —— 不要再在页面里写
  `statWidth = floor((inner.width - gap*(n-1))/n)` 与 `left = x0 + index*(statWidth+gap)`。
  卡片的宽度与位置由布局算，卡片**内部**由 `ICEStatCard` 自持策略跟随（`ice-web-components` 1.9.2 起）。
- **精确构图（卡片 rect / 岛）继续用坐标**：`computeLayout()` 给的设计矩形是仪表盘构图语义，
  不要硬套布局器。
- **第二轮回核（2026-09-15）**：逐页看过手工 `left/top` 之后，结论与上一条一致 ——
  本仓手写坐标分三类，都不该改：① `computeLayout()` 的设计矩形（仪表盘构图）；
  ② 卡片正文里的 `top: y0 + STAT_HEIGHT + PAGE_GAP` 这类**卡片版式推算**（卡片是画布上的绝对矩形，
  正文跟着卡片走，属于构图）；③ `symbol-legend.ts` 的**图纸网格**（版面本身就是内容，
  而且同一份 `legendLayout()` 还要给命中 `cellAt()` 用 —— 迁移只会多一层映射）。
  真正该用机制的是"同一组东西等距排"的场景，已经改完了：统计卡一行（`createStatRow()`）、
  `ICERadioGroup` / `ICECheckboxGroup`（组件内部，见组件库 1.10.1）。
- **不要 `file:` 链接组件库**：`ice-web-components` 自带 peer 解析，`file:` 链接会让
  `node_modules/ice-web-components/node_modules/ice-render` 出现**第二份引擎实例** ——
  类型上 `ICEGridLayout` 与库的 `ICELayoutManager` 互不兼容（`Types have separate declarations
  of a private property`）。做法：**依赖已发布版本**（`"ice-web-components": "^1.9.2"`），
  引擎仍可用 `file:../ice-render`（它是 peer，会解析到应用这一份）；若安装后又出现嵌套副本，
  跑一次 `npm dedupe`。
