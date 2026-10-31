# 架构

## 分层

```
┌──────────────────────────── Electron 主进程 ────────────────────────────┐
│  src/main/index.ts                                                      │
│  窗口 · IPC 校验 · safeStorage · 剪贴板 · screen 工作区 · 生命周期       │
└───────────────┬─────────────────────────────────────────────────────────┘
                │ IPC（白名单 + Zod 校验）
┌───────────────▼───────────────┐        ┌──────────────────────────────────┐
│  src/preload/index.ts         │        │  src/renderer（Vue 3）           │
│  contextBridge 暴露 API       │        │  管理台界面，不触碰 Node/浏览器   │
└───────────────────────────────┘        └──────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────────────────────────────┐
│  src/core（纯 Node，不 import electron）                                │
│  engines/      Windows 注册表 + 标准目录 / macOS bundle / Linux PATH、    │
│                Flatpak、Snap 探测                                        │
│  cdp/          DevToolsActivePort、目标发现、Runtime.evaluate、窗口定位   │
│  launch/       参数构造、spawn、CDP 连接、停止与回收                     │
│  credentials/  safeStorage 抽象、凭据库、继承解析                        │
│  layout/       预设解析与窗口矩形计算                                     │
│  processes/    自有 profile 进程发现与清理、workspace 数据结构            │
│  service.ts    编排：站点 / 身份 / 视图 / 登录态 / 导入导出                │
└─────────────────────────────────────────────────────────────────────────┘
```

主进程内还托管两个与 UI 无关的服务：

- `src/main/mcp/server.ts`：本机 MCP 端点（AI 接入），只依赖 `WorkspaceService`；
- `src/main/embedded/`：内置浏览器表面（见下节）；
- `src/shared/transfer.ts`：导入导出文件的格式校验，纯数据、无 IO。

界面有三个窗口，共用同一份构建产物与同一个 preload：

- 控制台（默认路由）：浏览器 / 站点 / 账号 / 视图 / 设置，默认停在浏览器；
- 运行实例悬浮条：`index.html#overlay` 挂载 `overlay/OverlayApp.vue`，无边框、置顶、
  跳过任务栏。它不持有多余状态，只订阅同一份 `WorkspaceSnapshot`，点一下通过
  `Page.bringToFront` 把对应浏览器窗口提到最前（最小化则先恢复）；
- 内置浏览器**不再有独立窗口**：它画在主窗口的「浏览器」页里。`BrowserPage.vue` 只画
  工具条、格位标题与查找栏，页面本身由主进程的 `WebContentsView` 覆盖在舞台区域上。
  之前那个独立外壳（`#embedded`）已删除——两个窗口各有一份标签状态，切来切去只是负担。

悬浮条的位置保存在 `userData/overlay.json`（纯窗口偏好，不进入可导出的工作区文件）；
显示开关是 `settings.overlayEnabled`。

`src/core` 不依赖 Electron，所以能在纯 Node 下跑单元测试，也能被未来的 CLI 或 CI
直接复用。外部浏览器窗口不是 Electron 的 `BrowserWindow`，而是由 `spawn` 启动的独立
系统浏览器进程；内置浏览器则是主进程里的 `WebContentsView`，两者的取舍见下文。

### 渲染层的共享控件

按钮与表单字段只有一套实现，放在 `src/renderer/src/components/ui/`（按钮）与
`src/renderer/src/styles/base.css`（`.field` / `.check` / `.hint` / `.spacer` 等词汇表）：

- `AppButton`：文字/图标按钮，`variant`（default / primary / ghost / danger）+ `size`。
- `IconButton`：纯图标按钮，`ariaLabel` 是**必填**属性（没有可访问名的图标按钮在测试里
  也找不到）；`title` 默认取同一个字符串。

这条规则是踩出来的：以前每个页面把 `.btn` 的样式复制进自己的 `scoped` 块，新页面只要
「用了类名但没复制样式」，按钮就以裸文字渲染——流程页和它的新建弹窗就是这样上线的。
组件同时拥有结构与样式，这种漏法在结构上就不可能发生。页面特有样式仍可以通过 `class`
透传到根元素，但基础的形状、间距、悬停态不再由各页各自定义。

表单字段的词汇表同理留在全局：`.field` 只定义「标题在上的一个控件」，输入框尺寸由它统一，
避免每个对话框各自写 1px 边框与 6/7/9px 混用的内边距。


## 两种浏览器表面

两种表面共用同一套身份、凭据、视图与布局模型，区别只在承载方式（决策记录见
[ADR 0006](./architecture/adr/0006-embedded-browser-first.md)）：

| | 内置（`WebContentsView`） | 外部（系统浏览器） |
| --- | --- | --- |
| 可控性：截图、接管、录制、并排、布局 | 完整 | 受限 |
| 保真度：真实版本、扩展、DRM、企业策略 | 较弱 | 最强 |
| 默认用途 | AI 驱动、静默运行、日常操作 | 确认「真实用户环境里也一样」 |

两边的入口不分家：`settings.launchTarget`（标题栏右上角的下拉）决定账号页、批量启动、
重新登录与视图页的启动落到哪一边，默认 `embedded`。运行栏「添加标签页」固定建内置标签，
运行实例悬浮条固定只列外置窗口——这两个入口各自只服务一种表面，不需要切换。

内置侧的落点固定：账号页点一张卡片就是在默认（扁平）标签组新建一个页面，单账号已经在跑
也是这样，不会切进已有视图或占用视图空位；批量启动则新建一个视图，把选中的账号按默认
布局铺开——整个批量（建页、落格、回收）由主进程一个 IPC 承担（`IPC.embeddedLaunchBatch`），
页内并发建页（并发度 3）、落格时实时读槽数，任一失败整批连同容器一起回收。要把页面放进
视图，路径是拖拽或在视图里用「+」。`openEmbeddedView` 给每个新建的
页面排一次自动填充，所以「启动视图」与「点账号」在填写凭据上表现一致。

缩放走 `webContents.setZoomFactor`，因此天然是**每页一份**：页面各有自己的 `WebContentsView`，
没有共享的缩放状态。`settings.browserZoom` 只是「没被手动调过的页面的默认值」，
`zoomBy` 在页面上按 Ctrl +/-/0 时写入 `zoomOverride`（仅内存，随标签页消失），并在
`before-input-event` 里拦截——网页自己会吞掉这些按键。

内置表面在 `src/main/embedded/`：

- `browser.ts` 管理主窗口里的**浏览器实例**、页面与**视图容器**。一个视图是一块共享
  屏幕区域：每个格位放一个实例（一套 session 分区），实例里可以有多个页面。
  容器记住自己的布局、格位与选中页面，同一时刻只有一个视图在台上，其余视图的页面
  继续在窗口外运行。页面按身份使用独立 `persist:` 分区（`embeddedPartition`），
  **与外部浏览器的 profile 目录分开**：两者由不同 Chromium 版本写，让 Electron 直接
  打开新版 Chrome 写过的 profile 会有降级迁移的风险，分开也避免内置侧污染正在用的
  外部登录态。
- 没有身份的页面分两种世界（[ADR 0009](./architecture/adr/0009-daily-profile-and-bookmarks.md)）：
  **日常档案**是一个固定的 `persist:` 分区，新标签页、书签与地址栏输入的地址都落在那里，
  登录一次长期有效；**干净打开**是每个实例一个不带 `persist:` 前缀的内存会话
  （`embeddedCleanPartition`），退出即消失。日常档案沿用旧字符串 `persist:embedded-clean`
  是为了接住用户升级前已有的登录。
- 页面自己开的弹窗（`setWindowOpenHandler`）继承所在实例的 `instanceId` 与分区，
  只改变该实例当前显示的页面，不会成为新的格位候选——这和外部模式里「一个窗口自带
  标签页」是同一个语义。`clean` 也随实例继承：干净会话里打开的登录弹窗不会掉进日常档案。
- `cdp.ts` 通过 `webContents.debugger` 说 CDP，**不开放任何调试端口**。调试端口无鉴权，
  本机任意进程都能驱动浏览器；进程内通道的唯一入口是已鉴权的 IPC 与 MCP。
- 视图的 `setBounds` 坐标是窗口内容区 DIP，`shared/embedded.ts` 的网格计算直接复用
  比例槽位，不需要处理窗口边框、阴影或前台抢占。**不在台上的页面移到窗口内容区右缘之外**
  （`parkedViewBounds`），而不是 `setVisible(false)`：后者会让 CDP 截图超时，见
  [浏览器表面设计](./design/browser-surface.md#管理页面如何盖住浏览器)。

由此带来的几条约束：

- 内置模式与外部模式各自维护登录态，切换表面要重新登录一次；切换必须由用户显式触发。
- 扩展、DRM 内容、企业证书策略在内置模式下不可用，需要保真结论时用外部模式复核。
- 截图优先走 `Page.captureScreenshot`；窗口最小化时它会停摆，此时退到
  `webContents.capturePage()`；窗口完全隐藏两者都不行。

### AI 驱动内置表面

MCP 暴露 18 个浏览器工具：列标签、开视图、开标签（按身份分区）、导航、读页面、查可见性、
点击、输入、批量填表、等待条件、填充登录、截图、执行表达式、切布局、固定格位、
调整标签页顺序 / 归属视图、切换实例当前页、关标签。页面读取返回可见元素的角色、
可访问名称、稳定选择器与**表单项旁边的标签文字**，隐藏元素不出现——这正是「这个账号
实际能看到什么」。

**AI 开页面不抢前台。** `open_browser_tab` 与 `open_browser_view` 都不调用
`focusPage()`：不抬窗口、不把界面切到浏览器页。UI 入口（工具栏「+」、账号卡、视图启动）
仍然抬窗口——那是用户刚刚点了一下，想看到结果；AI 是把页面当工作区在用，往往在用户读
文档或改设置时开页，每开一个页就把窗口顶到最前面会让这个端点没法用。

- 不抬窗口也照样能工作：`createTab` 先给新视图一个窗口内的真实矩形再停放，所以截图与
  DOM 读取在后台照常可用；`viewId` 指定的视图仍然被激活，用户切回去时就是那一屏。
- 输入类工具开启 `Emulation.setFocusEmulationEnabled`，窗口不在前台也能派发事件。
- `openEmbeddedView(viewId, { reveal })` 用同一个函数服务两边，差别只有这一个参数。

**定位元素用语义目标，不是位置选择器。** 每个交互工具都接受 `label`（表单项旁的标签）、
`text`（按钮上的文字）、`role`，`selector` 仍然保留。原因是实测出来的：组件库的表单里
label 与 input 分属不同子树，快照只能表达成长串 `:nth-of-type`，多一个条件字段整条链就断；
而人从来不读这种路径，人读的是「用户名」。解析器按三种形状找控件：`<label for>`、
包住控件的 `<label>`、以及「wrapper 里同时有 label 与控件」（Naive UI / Ant Design /
Element Plus）。从 label 向上找作用域时，只有当该作用域里**恰好一个**可见控件才认，
多个控件时要求作用域自身的文字仍提到这个标签——否则整个表单会把所有字段都抢走。

- 点击与输入走 `Input.dispatch*` 真实输入事件，不是脚本 `click()`，否则框架不会响应。
- 输入类操作前会开启 `Emulation.setFocusEmulationEnabled`：窗口在后台时渲染进程报告
  `document.hasFocus() === false`，Chromium 会直接丢弃输入事件，而 `Runtime.evaluate`
  仍然工作——不开启时表现为"选择器明明对，点击却没反应"。
- **`wait_browser` 在页面内轮询。** 菜单、抽屉、toast 都是异步渲染的，没有等待语义时
  AI 只能 `sleep → read → sleep → read`，每一轮都是一次 MCP 往返，而两次调用之间页面
  还会自己变（菜单失焦自关、选项晚一帧出现）。条件有 `visible` / `hidden` / `text` /
  `url` / `value`，一次调用等到条件成立或超时。导航会销毁执行上下文，所以 `wait()` 在
  上下文被销毁时用剩余时间重试——否则「点登录、等控制台」永远报错。
  `hidden` 把「元素已从 DOM 移除」也算成立：toast 消失常常是移除而不是淡出。
- **`fill_browser_form` 一次填完整个表单。** 逐字段调用不只是往返多，中途一次超时还会让
  页面停在半填状态。返回里每个字段单独标记是否密码，审计日志只打码那几个——把整条调用
  打码会让日志失去价值，不打码则密码必然落盘。
- 填充登录的密码只存在于主进程，工具返回值只有摘要；跨域页面拒绝填充。
- **自动填充也按标签找字段**：`buildFillExpression` 的 `labelText` 除了 `labels` /
  `aria-labelledby` / 包住的 `<label>`，还会向上找「唯一一个 label 元素」的作用域。
  缺这一步，组件库后台的额外字段（租户名）永远填不上——这是真实环境里先踩到的。
- **输入到密码框的值会被审计日志打码**：`type()` 从页面读回输入框自身的 `type`，是密码就回
  `secret: true`，MCP 层据此把参数 `text` 换成 `[redacted]`。靠参数名匹配不够——创建租户时
  密码也是走 `type_browser_text`，那个参数叫 `text`。
- 布局与格位工具作用于「台上的视图」：AI 不需要先知道视图 id，全是扁平标签时切布局会
  先把它们组成视图——这是 AI 侧的一次调用便利，界面上没有对应的自动建组行为。
- 开标签会自动把主窗口切到浏览器页，否则标签建在窗口外，用户看不到 AI 在做什么。
- `move_browser_tab` 与界面拖拽是同一套落点：相对某页之前 / 之后、加入某个视图、或移出视图。
  `set_tab_page` 切换的是「一个实例当前显示哪一页」——一个格位是一个实例，实例里的弹出页
  不占新格位。
- 内置表面是懒创建的可选依赖：测试里可以注入假实现，未打开过内置浏览器时工具会给出
  明确错误而不是崩溃。
- **离开舞台的页面停在窗口内容区右缘之外，既不是负数坐标，也不是舞台宽度。**
  Electron 44 / Chromium 152 上实测出两条各自独立的坑：
  1. `x = -100000` 会让渲染器把视口算成 0×0：脚本照跑，但整页按零宽度布局，`innerWidth`
     是 0，块级元素宽度也是 0。凡是依赖渲染几何的判断（这段文字可见吗、按钮在哪）都会
     得到「页面上什么都没有」的假结论——AI 在流程页 / 设置页调用浏览器工具时就会撞上。
  2. `x = stage.width` 仍然落在窗口内部：舞台在导航栏右侧，按舞台宽度停放等于把页面画在
     账号页/设置页上面（实际发生过，右侧栏被一整页后台盖住）。
  正确做法是 `parkedViewBounds(窗口内容区尺寸)`，即 `x = content.width`，保持原来的宽高。
- **新建的视图必须先有过真实尺寸再停放。** 一个刚创建、第一次 `setBounds` 就在窗口外的
  视图会被渲染器判定为不可见，视口固定成 0×0 且之后不再恢复；`createTab` 因此先把它按
  窗口内容区铺一次，再由 `applyLayout` 决定放哪。这是第 1 条那个 0×0 现象的另一半原因，
  只改停放坐标不够。
- 窗口 resize 时重新跑 `applyLayout`：停放位置跟着内容区宽度走，否则缩小窗口会把页面
  拉回可见区域。
- **舞台尺寸要经过响应式状态，不能直接读 `clientWidth`。** 格位头的几何由渲染层按舞台矩形
  算出来（`slotChrome`），原生页面按 `setStage` 上报的矩形铺，两者必须同源。早先 `slotChrome`
  直接读 `stage.clientWidth`，computed 不会因为布局变化重算，于是收起运行栏后原生页面已经
  变宽、格位头还停在旧宽度，右边留出一条死带。现在 `reportStage` 把 `clientWidth` 写进
  `stageBox` 这个 ref，`slotChrome` 依赖它，ResizeObserver 触发的重报就同时更新两边。
- **站点图标在主进程内联。** `EmbeddedTab.favicon` 是一个 `data:` URL，渲染层只负责画。
  渲染层 CSP 是 `img-src 'self' data:`，不加载远程图片；更重要的是图标要用页面自己的会话去取
  （登录态、区域、Cookie 都跟着走），只有主进程做得到。`inlineFavicon` 把类型与大小规则抽成
  纯函数，避免为了测它而启动 Electron。
- **停放页空闲后睡眠（`aiIdleFreeze`，headless 关闭）。** 页面挪出窗口只是看不见，Chromium
  仍视其为「可见」，原生后台节流永不触发——应用窗口在屏上时，每个停放页（包括 3D 首页）都会
  满速渲染。实测 `setVisible(false)` 连 `visibilityState` 都不变（JS/rAF 照跑），CPU 节流拖不
  动 compositor 驱动的帧循环；真正生效的是 CDP `Page.setWebLifecycleState: "frozen"`——页面
  JavaScript 整体挂起（冻结页上 evaluate 永不返回），3D 场景随之停。停放页闲置 60 秒（窗口期
  内无任何 CDP 流量）后由 10 秒一轮的扫描冻结，**扫描在浏览器构造时无条件启动**（曾惰性启动
  于首次 CDP 命令，纯手工会话里从未运行过）；AI 的每条命令经 `EmbeddedCdp.send` 前都会
  **await** 一次唤醒，回台与导航也会唤醒，所以截图、点击永远落在活页面上。扫描刻意保守：台上、
  加载中、崩溃、空白、有声、开着 DevTools 的页面一律不动。另注意窗口级遮挡：整个应用被盖住
  或移出屏幕时，Chromium 原生节流本就会把所有页压停，无需任何额外机制。

### 流程：把走通的操作存成资产

MCP 另外暴露 4 个流程工具：`list_flows` / `save_flow` / `run_flow` / `delete_flow`，
界面上对应左侧导航的**流程**页（`FlowsPage.vue`）。数据模型见
`src/shared/flows.ts`，动作只有 8 种：`navigate` / `fill` / `click` / `select` / `press` /
`login` / `wait` / `read`。

**流程是步骤清单，不是脚本。** 三个理由写在 `flows.ts` 的文件头里：脚本只能派发合成事件，
而其余动作都走 `Input.dispatch*`，会变成第二条更弱的执行路径；共享工作区里的任意 JS 需要
一份永久的逐客户端代码审查门；而步骤清单人能读、能改、能调顺序。`read` 动作把页面文字
收进 `{{变量}}` 供后续步骤使用，覆盖了脚本本来能换来的主要能力。

- **参数与变量在保存时校验**：未定义的 `{{name}}`、缺 `value` 的 `fill`、不认识的键名都在
  `saveFlow` 拒绝，消息点名第几步——这些字符串直接给到要改它的 AI。校验放在
  `service.saveFlow` 里，界面、IPC、MCP 三条入口共用同一套规则。
- **失败即停**：某一步失败返回 `failedAt` 与原因，后面的步骤不跑，避免写进半套数据；
  标了 `optional` 的步骤例外。
- **打开标签页只有一条实现**（`openFlowTab`）：IPC 与 MCP 都调它，否则会出现
  「应用里能跑、AI 跑不通」的漂移。
- 流程按站点归属；删站点时级联删除它的流程，导入时站点不在就跳过并计入 `skipped`。
- `run_flow` 的 `read` 目标可以指向非交互元素（订单号在 `<p>` 里），因此解析器多一条
  「按可见文字找最深的元素」的回退路径——常规解析器只搜可交互元素，对 `read` 够不着。

## 为什么用 CDP 而不是 Playwright

Playwright 是自动化测试库，它默认会接管对话框、下载和文件选择：

- 没有注册 `dialog` 监听时，`alert` / `confirm` / `prompt` 会被自动 dismiss。
- 下载落到临时目录，context 关闭即删除。

人手操作浏览器时，这些行为会让测试结论失真。所以外部模式直接用系统浏览器 +
`--remote-debugging-port=0`，内置模式用进程内 `webContents.debugger`，两条路径都用同一套
CDP 方法，只做这几件事：

1. 导航（`Page.navigate` 或重定向）
2. 登录表单填充（`Runtime.evaluate` + 原生 value setter + `input` / `change` 事件，
   支持账号密码之外按标签匹配的额外字段）
3. 登录态检测（页面内 `fetch` 携带 Cookie）、窗口定位
   （`Browser.getWindowForTarget` + `Browser.setWindowBounds`）与窗口切换
   （`Page.bringToFront`，最小化的先恢复）
4. 内置模式下的读页面、点击、输入、截图与页面内查找

Playwright 只通过显式开启的调试端口接管内置表面（`connectOverCDP`），或者用于管理台
自身的 E2E 测试，不进入主链路。

批量登录态检测（`checkAllAuth`）对每个身份执行同一段检测，最多 3 个并发——不同身份
是独立浏览器与独立 CDP 连接，唯一共享的是被测站点本身——并在整批结束后只写一次
`workspace.json`、广播一次快照。判定与启动自动登录共用同一段探测逻辑：HTTP 状态之外，
站点的 `authCheckSignedOut` 标记命中响应 body 时按未登录计。

对话框、下载、上传、扩展、原生密码管理器、Google SSO 全部保持浏览器原生行为。

## 启动链路

```
resolveEngine(identity, environment)
  → profileDir = <profileRoot>/<envId>/<identityId>
  → 清除残留 DevToolsActivePort
  → spawn(exe, [
      --user-data-dir=<profileDir>,
      --remote-debugging-port=0,
      --no-first-run,
      --no-default-browser-check,
      --window-position=…, --window-size=…,
      <startUrl>
    ])
  → 轮询 <profileDir>/DevToolsActivePort（必须同时端口可响应）
  → GET /json/version 拿浏览器级 WebSocket
  → GET /json/list 找目标页（优先非 about:blank）
  → 连接页面级 WebSocket，登记到 cdpRegistry
```

Firefox 走外部模式：`-profile <dir> -no-remote -new-instance <url>`，不做 CDP，
因此不提供自动填充与登录态检测。

## 数据模型

模型已经落地：站点 / 身份 / 视图 / 全局标签 / 流程，见
[ADR 0007](./architecture/adr/0007-site-and-view-model.md) 与
[ADR 0008](./architecture/adr/0008-sites-as-login-recipes.md)（站点降级为登录配方、标签升为全局）。
浏览器表面的交互设计见 [浏览器表面：视图与标签页](./design/browser-surface.md)。

```
Site     1 ── N Identity
Site     1 ── N View（定义）
Site     1 ── N Flow（可重跑的步骤序列）
View     N ── N Identity（只引用，不复制）
View     N ── 1 LayoutPreset（内置或用户自定义）
Site     N ── N Tag（多对多，用于查找与分组）
Identity N ── N Tag（同上；筛选时合并所属站点的标签）
View     N ── N Tag（同上；筛选时合并成员及其站点的标签）
```

- **视图 = 一份保存的定义 + 至多一个打开的容器。** 容器在浏览器页里活着，记住自己的
  布局、格位与选中标签；定义是启动时的模板。重复打开同一个定义会复用容器、补齐缺少的
  成员标签，登录态保住。
- 身份只属于一个站点。同一账号要测两个站点时创建两个身份，因为不同主机名的
  Cookie 域不同，复用 profile 会串站点。要在两个站点间共享账号资料，用
  `passwordMode: "reference"` 指向另一个身份；登录态与 profile 仍各自独立。
- 站点没有「类型」字段，也没有隐式的生产/非生产区分。启动一个窗口只是打开一个
  登录页，真正的破坏性动作发生在被测系统里，靠站点名字猜风险既会漏判也会误判；
  权限边界由 MCP 的 run 档和用户自己开的窗口负责。
- **站点不是全局作用域。** 没有「当前站点」；`settings.lastSiteId` 只是新建账号时的
  默认值。账号页按站点分组展示全部账号，视图可跨站点。
- 标签是一套命名空间，站点、身份、视图共用；删除标签只解除关联。管理入口是左侧导航的
  **标签**页（`TagsPage.vue`），因为标签不属于站点作用域，也不是一年改一次的设置项。
- 凭据：身份存自定义密码，站点存默认密码，身份还可以引用另一个身份。
  解析顺序是引用目标 → 身份自定义 → 站点默认 → 报错；引用只允许一层。
- **账号密码之外的登录字段只存在身份上。** 租户名、公司码这类值是「谁登录谁提供」，
  所以站点不再带 `extraFields`；站点是登录配方，没有自己的账号。旧文件在
  `sanitizeWorkspace` 里把站点字段复制到其下每个账号。
- **`Identity.siteId` 可以为空**，表示账号的站点归属丢了（1.0 迁移曾把 v1/v2 混写文件
  读成已当前格式，导致站点列表变空、账号全部失联）。账号页把它们放在「未关联站点」
  分组下，批量选择后可一次关联到站点；`profileDirFor` 对这种账号返回 `undefined`，
  不会拼出 `<root>/undefined/<id>` 这种假目录。
- 站点记录 `lastOrigin`：填充前发现当前页面 origin 与它不同就暂停，要求用户显式确认，
  确认后更新（SSH `known_hosts` 的做法）。
- Profile 目录用 UUID，显示名可随时改；引擎绑定在身份上，换引擎是复制身份
  生成新 profile，而不是迁移目录。

## 窗口布局

内置预设定义在 `src/shared/layouts.ts`，槽位坐标是相对工作区的比例（0–1），
与显示器分辨率解耦：

| 预设 | 说明 |
| --- | --- |
| `free` | 无布局。每个窗口都铺满工作区，互相重叠，用任务栏 / Alt+Tab 切换 |
| `1x1` / `2x1` / `1x2` / `2x2` / `3x1` | 等分网格，边到边，无外边距 |

内置浏览器里 `1x1` 与 `free` 是同一件事（一张页面铺满舞台），下拉里只保留 `free`，
旧数据读出来按 `free` 处理；外置窗口仍保留 `1x1`，那里的「无布局」是互相重叠的多窗口。

- 预设是**铺满的**：`computeSlots` 直接用比例乘工作区，不加 padding 与 gap。
  旧实现的 8px 外边距在小屏幕上正好是浪费掉的可视面积。
- 用户可以保存自己的预设（`LayoutPreset`，坐标经 `clampSlot` 收敛），
  视图按 id 引用；删除预设时引用它的视图回落到 `2x2`。
- 编辑器里的拖动与缩放会吸附到舞台边缘和相邻槽位的四条边（`snapSlotMove` /
  `snapSlotResize`，阈值按舞台像素换算成比例，与窗口宽度无关），吸附时显示参考线；
  正在编辑的槽位始终置顶，避免缩放手柄被相邻槽位盖住。
- 视图可以把成员拖到指定槽位（`View.slotAssignments: identityId → slotIndex`），
  未指定的成员按成员顺序补空槽位（`resolveSlotAssignments`）。启动、单独重开、
  拖拽换位都按这份映射排窗口。
- 实例在内存里记录 `layoutId` 与 `slotIndex`，后续重排只影响同一预设的窗口，
  单独启动一个身份不会打乱已经排好的视图。
- 单个身份单独启动（当前没有任何窗口）仍居中放大打开，而不是塞进第一个槽位。

### 内置表面的页面、实例与视图

三个概念必须分清，它们的 id 关系是最容易踩的地方：

- **页面**（`EmbeddedTab`）：一个 `WebContentsView`，等同于浏览器的一张标签页。
- **实例**（browser instance）：一个共享会话的浏览器窗口。实例 id 是它的**根页面 id**。
  页面自己 `window.open` / `target="_blank"` 出来的页面加入同一个实例，共享 cookie，
  不占新格位。
- **视图**（`EmbeddedView`）：一块舞台区域，`slotTabs` 每格存一个**实例 id**。

两条由此推出的硬约束：

1. `createTab` 给新页面写的 `instanceId` 必须是**父页面的 `instanceId`**，不能是父页面的
   `id`。把根页面当成实例 id 用，一开始不出错（两者相等），但关掉根页面后剩下页面的
   `instanceId` 会指向一个已经不存在的页面，此后往这个实例里开页就会被判成新实例。
2. `closeTab` 关掉**根页面**时必须把格位改指向活下来的最早一页。格位表里存的还是根页面 id，
   根页面一没，`resolveSlotTabs` 就把那一格判成空——页面还在跑，舞台却空了。

格位显示的是实例的「当前页」（`instanceActive`），切页不改变布局；一个格位恒为一个实例。
空白页（`about:blank`）不上屏，格位让给渲染层画的「新标签页」（搜索框 + 引擎选择）——
空白页如果只是原生视图的一块空白，点「+」就得不到任何反馈。

## 存储

| 文件 | 内容 | 位置 |
| --- | --- | --- |
| `workspace.json` | 站点、标签、身份、视图、布局预设、书签、手动引擎路径 | Electron `userData` |
| `settings.json` | 主题、语言（含「跟随系统」）、布局、上次视图 | Electron `userData` |
| `vault.json` | 加密后的凭据 | Electron `userData` |
| `mcp.json` | AI 接入开关、端口、Token、权限开关 | Electron `userData` |
| `mcp-audit.log` | MCP 调用审计（参数已脱敏） | Electron `userData` |
| `profiles/` | 每个身份的浏览器 profile（外部模式） | Electron `userData` |
| `screenshots/` | 内置浏览器与 AI 工具截的图 | Electron `userData` |

内置表面的会话分区由 Chromium 自己管理，位置在 `userData/Partitions/`，
与 `profiles/` 互不相干。其中**日常档案**是持久目录，**干净会话**（不带 `persist:` 前缀）
只在内存里，不产生目录。

所有写入使用「临时文件 + rename」保证原子性，`vault.json`、`mcp.json`、导出文件以 0600 权限写入。

## 界面语言

`settings.locale` 是三值：`"system"`（默认）/ `"zh"` / `"en"`。**默认值不写死任何一种语言**——
硬编码的默认语言等于替用户做决定，而应用没有依据判断用户读哪种语言。

解析规则在 `shared/locale.ts`（纯函数，不依赖 Electron）：

- `resolveLocale(setting, systemLocale)`：显式值优先，`"system"` 回落到系统语言。
- 系统语言 tag 由主进程通过 `app.getPreferredSystemLanguages()[0]` 取，随
  `WorkspaceSnapshot.systemLocale` 下发。**不能用 `navigator.language`**：它跟着应用自己设的
  `--lang` 走，问它只会读回应用的选择。
- `--lang` 启动开关用同一个解析结果，所以被测页里的 `navigator.language` 与应用语言一致
  （站点若按浏览器语言本地化，看到的就是用户读的那一种）。
- core 层拿到的是**解析后的** `"zh" | "en"`，不是三值。三值只在设置与渲染层存在。

**DevTools 前端不受这条链路控制**：它的 UI 语言要加载语言包，而语言包在自建 DevTools 视图里
取不到（详见 `docs/design/browser-surface.md`）。它固定英文，这是已知边界，不是遗漏。

DevTools 内部的设置项触发前端 reload 时，主进程会整套重建前端以保住面板（Electron 从不
重新绑定 `InspectorFrontendHost`，只有换掉前端视图才能恢复）。用户可见的效果是面板闪一下
然后继续可用，而不是留下一个空壳。

## 进程生命周期

- 应用是浏览器实例的唯一所有者，`workspace.json` 里不持久化运行中实例。
- **单实例锁**：`app.requestSingleInstanceLock()`。第二个实例直接退出并唤起已有窗口，
  避免两个进程各自启动浏览器、争抢 MCP 端口、并发写 `workspace.json`。
- **托盘模式**（默认开）：窗口关闭只 `hide()`，进程、浏览器、MCP 端点继续运行。
  托盘菜单提供「打开」与「退出」；设置页也有「彻底退出」。
- 所有退出路径（托盘菜单、设置页按钮、系统关机、`app.quit()`）都收敛到
  `shutdownAndQuit()`：先 `mcpServer.stop()`，再 `tray.destroy()`，最后
  `service.shutdown()` 回收浏览器。顺序不能反——否则 AI 可能在浏览器回收途中发起新启动。
- `window-all-closed` 在托盘模式下直接返回，不触发退出；关闭托盘模式后恢复原有行为。
- 干净会话的 profile 放在 `profiles/<siteId>/clean-*`；不属于任何站点的空白会话放在
  `profiles/clean/clean-*`，独立分段，删除站点不会误停它们，启动清扫仍会覆盖。
- 启动时清理 `--user-data-dir` 指向自有 `profiles/` 根目录的残留进程。
- 停止单个实例：CDP `Browser.close` → 等待 → 按 PID 兜底。
- 视图启动（外部表面）是原子的：中途失败会回收本次已拉起的窗口，不留下半套。
- 退出应用时先优雅关闭全部实例，再退出主进程。

## AI 接入（MCP）

```
AI 客户端 ──HTTP POST /mcp──▶ McpServer ──▶ WorkspaceService ──▶ 浏览器
              Bearer Token        tools/call      同一套业务方法
                                            └─▶ EmbeddedBrowser（内置表面）
```

- 传输：回环 HTTP，路径 `/mcp`，固定端口（`mcp.json`，默认 47821）。无状态，
  只处理 POST；`GET`/`DELETE` 返回 405。
- 协议：MCP JSON-RPC 子集（`initialize`、`ping`、`tools/list`、`tools/call`、
  `resources/list`、`prompts/list`）。不引入官方 SDK，避免为几十行协议给安装包加依赖。
- 鉴权：`Authorization: Bearer <token>`，`timingSafeEqual` 比较；`Host` 必须是
  `127.0.0.1:<port>` 或 `localhost:<port>`，`Origin` 必须是回环——两层分别挡 DNS 重绑定
  与浏览器跨源请求。
- 权限门：工具分 read / write / run / danger 四档，后三档由设置页开关控制。
  删除类还要 `confirm: true`。
- 必填校验：`inputSchema.required` 在执行前统一检查（`confirm` 除外，它由工具自己给出
  更有指向性的提示）。少了这个检查，一个空选择器会让点击落到页面第一个元素上。
- 凭据：工具可以写密码，但**没有任何读密码的工具**，返回值里也没有明文。
- 审计：每次调用追加一行 JSON 到 `mcp-audit.log`，`password|passphrase|token|secret`
  字段递归替换为 `[redacted]`。`type_browser_text` 的参数叫 `text`，名字上看不出秘密；
  它聚焦目标后会回读 `input[type=password]`，是密码框就在结果里置 `secret: true`，
  MCP 层据此把这条 `text` 也换成 `[redacted]`。不做这一步，AI 给新建租户设置初始密码时
  明文就必然落进审计日志。**碰到页面的调用还记一个 `origin` 字段**，回答「AI 在这个站点上
  做了什么」不需要再按时间窗去 Join；同一事件也推给渲染层，运行栏在对应那一行显示本次会话
  的操作次数。
- 浏览器工具与账号工具同权：`run` 档同时覆盖「启动窗口」和「操作内置页面」，因为两者
  都是对现场的改动而不是对数据的改动。`open_browser_tab` 带 `identityId` 时与手动入口
  一样走 `scheduleEmbeddedFill`，AI 不必额外记得调 `fill_browser_login`。
- **按来源只读**（`shared/ai-policy.ts`）：日常档案是真实登录态，所以 AI 在那里的页面默认
  只读——读页面、截图、切标签、等待都放行，点击 / 输入 / 填表 / 填登录 / 执行表达式 / 跑流程
  一律拦在 `tool.run` 之前。账号页与干净会话不受限制，那本来就是给 AI 驱动的。
  授权按 **origin** 给（`mcp.json` 的 `aiOrigins`），默认空；工具栏的盾牌按钮与设置页都能
  授予或撤销。实现上靠 `ToolDefinition.inputTarget` 声明「这个工具碰到哪一页」，闸门在
  `tools/call` 里统一执行一次——新加一个输入类工具只要声明它，不会忘记过闸。
  一个尚未授权的来源会被拒，但**读仍然可用**，这样 AI 至少能看清页面再向用户要授权。
- **导航目标必须来自用户或工作区**：`navigate_browser_tab` 只允许空白页的首次导航、
  同源链接、或工作区里已有的站点 / 书签地址。这条防的是提示注入——页面正文里的文字不能被
  AI 当成下一步要去的地方。
- **AI 自己开的无身份标签是干净会话**：`open_browser_tab` 不带 `identityId` 时显式传
  `clean: true`。否则 AI 能自己造一个落在日常档案里的标签，等于绕过上面那道闸门。
- 生命周期：与主进程同生共死。`stop()` 先 `closeAllConnections()` 再 `close()`，
  保证客户端保持长连接时也能立即释放端口。

## 导入导出

两种格式，用途不同，不要混用。

**配置导出**（`shared/transfer.ts`，`format: "ensemble.workspace"`）是整机迁移：把站点、账号、
视图、标签、布局预设全部带走，**按 id 合并**。`WorkspaceService.exportWorkspace / importWorkspace`
负责组装与合并。

- 导出不含运行实例、Profile、登录态。
- 密码可选：给定口令时用 `createKdfParams` + `seal` 把 `{environment, identity}` 密码表
  加密成 `secrets.payload`，与 vault 同一套 scrypt + AES-256-GCM。
- 导入按 id 合并，缺失所属站点的条目跳过并计数；有加密段但口令错误时整体抛错，
  不写入任何数据。

**账号包**（`shared/accounts-transfer.ts`，`format: "ensemble.accounts"`）是把登录交给别处：
只挑几个站点、几个账号，不带走你的视图与布局。

- 匹配键里**没有 id**：站点按 `baseUrl`、账号按 `baseUrl` + 小写 username。接收方的
  workspace 有自己的 id，用发送方的 id 去合并只会覆盖无关账号或造出重复项。
- 密码同样用口令密封；`secrets` 里的键就是 `accountSecretKey(baseUrl, username)`，接收方
  可以自己重算，所以解密后的密码能准确落到对应账号上。密码可选，不带口令时只导资料。
- 文件里每个站点 / 账号带 `hasPassword`，接收方据此知道「这个账号本来有密码但没解开」，
  不会保存一个永远登不进去的账号却什么都不说。
- 导出路径：界面走保存对话框；MCP 没有可以应答对话框的人，固定写到
  `userData/accounts-export/`，文件路径作为返回值给 AI。

## 版本检查

纯检查，不自动更新。`shared/update.ts` 负责解析 GitHub Releases API 的返回并比较版本，
`src/main/index.ts` 的 `app:check-update` 在 8 秒超时内请求
`api.github.com/repos/OneFanki/ensemble/releases/latest`，把结果交给关于页展示。

- 不做内置下载或自动安装：发布产物未签名，macOS 会拒绝未签名更新包，Windows 仍会
  过 SmartScreen，自动更新换不来更好的体验，只会多一条无法验证的代码路径。
- 版本号比较按点分段数值比较，不是字符串比较（`0.10.0` 比 `0.9.0` 新）。
- 返回体不符合预期（代理错误页、tag 名不是版本号）一律按「检查失败」处理，不猜版本。
- 用户点「打开 Releases」时由主进程用 `shell.openExternal` 打开，渲染层只能传
  `http(s)` 地址。

## 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`，
  导航与 `window.open` 一律拦截，外链交给系统浏览器。
- 内置浏览器的页面是远程内容：`nodeIntegration: false`、`contextIsolation: true`、
  `sandbox: true`，不挂任何 preload；权限请求（摄像头、麦克风、定位、通知）默认全部拒绝，
  需要时在 `configureSession` 里逐项放开。
- 内置表面只允许 `http(s)` 与 `about:blank`；`file:`、`javascript:`、`data:` 一律拒绝，
  页面不能借内置浏览器访问本地文件。
- IPC 入参全部经过 Zod 校验；密码不在任何 IPC 返回值中出现。
- 密码只存在于主进程内存与加密后的 `vault.json`。
- 自动填充前校验当前页面 origin 属于目标站点，且与站点记住的 `lastOrigin` 一致，否则拒绝或要求确认。
- **启动自动登录例程**：站点配了 `authCheckPath` 时，内置表面的每次账号启动都会先在页内
  fetch 检查路径判定登录态（结果只留在主进程），未登录则导航到 `site.loginPath` 填充凭据；
  是否替用户点提交由 `site.autoSubmit ?? settings.autoSubmitLogin` 决定（站点可选覆盖，全局
  默认开启），这个开关的语义就是「授权自动提交」，提交动作是点登录按钮本身而不是提交表单。
  登录确认后页面回到账号 `startPath`。**接口信封式后端**（200 也表示未登录、结果在 body 里）
  会在站点上配 `authCheckSignedOut`：探测对响应 body（前 4 KiB）做子串匹配，命中即按未登录
  处理，HTTP 状态不再单独定案。凭据的读取与填充全程在主进程，渲染层只收到不含
  密码的 `AutoFillReport`。没配检查路径的站点维持旧行为（等密码框出现就填，仅此而已）。
- MCP 端点只绑回环、必须带 Token、校验 Host/Origin；工具永远不返回明文密码。

## 自动化运行（headless）

所有端到端脚本与截图脚本都启动一个真实的应用进程，并用 CDP 驱动它。这些进程设
`ENSEMBLE_HEADLESS=1`，含义是**不出现在桌面上**：主窗口被移到所有显示器之外、不进任务栏、
不抢焦点，托盘图标、运行实例悬浮条、切换回执都不创建，`focusPage()` 只通知渲染层换页而不抬窗口。

两个实现细节值得记住，两者都只有实际跑过才能发现：

- **窗口必须 `show()`，不能只创建不显示。** 从未显示过的窗口不产生合成帧，
  `Page.captureScreenshot` 会一直挂着而不是返回图片——冻结舞台与全部截图直接失效（实测从
  ~100ms 变永不完成）。所以是「显示到屏幕外」，不是「隐藏」。
- **`focusPage()` 的两半要拆开。** 它同时做「抬窗口」和「通知渲染层切到浏览器页」；
  headless 模式下跳过前者、保留后者，否则脚本驱动的页面在界面上根本不会被切过去。

`tests/headless-runs.test.ts` 静态守着这条契约：开关存在、窗口是被移走而不是隐藏、
四个会出现在桌面上的表面（悬浮条、回执、托盘、`showMainWindow`）都尊重开关，
以及每个脚本都真的传了环境变量。
