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

## 两种浏览器表面

两种表面共用同一套身份、凭据、视图与布局模型，区别只在承载方式（决策记录见
[ADR 0006](./architecture/adr/0006-embedded-browser-first.md)）：

| | 内置（`WebContentsView`） | 外部（系统浏览器） |
| --- | --- | --- |
| 可控性：截图、接管、录制、并排、布局 | 完整 | 受限 |
| 保真度：真实版本、扩展、DRM、企业策略 | 较弱 | 最强 |
| 默认用途 | AI 驱动、静默运行、日常操作 | 确认「真实用户环境里也一样」 |

内置表面在 `src/main/embedded/`：

- `browser.ts` 管理主窗口里的**浏览器实例**、页面与**视图容器**。一个视图是一块共享
  屏幕区域：每个格位放一个实例（一套 session 分区），实例里可以有多个页面。
  容器记住自己的布局、格位与聚焦页面，同一时刻只有一个视图在台上，其余视图的页面
  继续在窗口外运行。页面按身份使用独立 `persist:` 分区（`embeddedPartition`），
  **与外部浏览器的 profile 目录分开**：两者由不同 Chromium 版本写，让 Electron 直接
  打开新版 Chrome 写过的 profile 会有降级迁移的风险，分开也避免内置侧污染正在用的
  外部登录态。
- 页面自己开的弹窗（`setWindowOpenHandler`）继承所在实例的 `instanceId` 与分区，
  只改变该实例当前显示的页面，不会成为新的格位候选——这和外部模式里「一个窗口自带
  标签页」是同一个语义。
- `cdp.ts` 通过 `webContents.debugger` 说 CDP，**不开放任何调试端口**。调试端口无鉴权，
  本机任意进程都能驱动浏览器；进程内通道的唯一入口是已鉴权的 IPC 与 MCP。
- 视图的 `setBounds` 坐标是窗口内容区 DIP，`shared/embedded.ts` 的网格计算直接复用
  比例槽位，不需要处理窗口边框、阴影或前台抢占。**不在台上的页面移到窗口外**
  （负坐标），而不是 `setVisible(false)`：后者会让 CDP 截图超时，见
  [浏览器表面设计](./design/browser-surface.md#管理页面如何盖住浏览器)。

由此带来的几条约束：

- 内置模式与外部模式各自维护登录态，切换表面要重新登录一次；切换必须由用户显式触发。
- 扩展、DRM 内容、企业证书策略在内置模式下不可用，需要保真结论时用外部模式复核。
- 截图优先走 `Page.captureScreenshot`；窗口最小化时它会停摆，此时退到
  `webContents.capturePage()`；窗口完全隐藏两者都不行。

### AI 驱动内置表面

MCP 暴露 14 个浏览器工具：列标签、开视图、开标签（按身份分区）、导航、读页面、查可见性、
点击、输入、填充登录、截图、执行表达式、切布局、固定格位、关标签。页面读取返回
可见元素的角色、可访问名称与稳定选择器，隐藏元素不出现——这正是「这个账号实际能看到
什么」。

- 点击与输入走 `Input.dispatch*` 真实输入事件，不是脚本 `click()`，否则框架不会响应。
- 输入类操作前会开启 `Emulation.setFocusEmulationEnabled`：窗口在后台时渲染进程报告
  `document.hasFocus() === false`，Chromium 会直接丢弃输入事件，而 `Runtime.evaluate`
  仍然工作——不开启时表现为"选择器明明对，点击却没反应"。
- 填充登录的密码只存在于主进程，工具返回值只有摘要；跨域页面拒绝填充。
- 布局与格位工具作用于「台上的视图」：AI 不需要先知道视图 id，全是扁平标签时切布局会
  先把它们组成视图——这是 AI 侧的一次调用便利，界面上没有对应的自动建组行为。
- 开标签会自动把主窗口切到浏览器页，否则标签建在窗口外，用户看不到 AI 在做什么。
- 内置表面是懒创建的可选依赖：测试里可以注入假实现，未打开过内置浏览器时工具会给出
  明确错误而不是崩溃。

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
`workspace.json`、广播一次快照。

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

模型已经落地：站点 / 身份 / 视图 / 站点标签，见
[ADR 0007](./architecture/adr/0007-site-and-view-model.md)。浏览器表面的交互设计见
[浏览器表面：视图与标签页](./design/browser-surface.md)。

```
Site     1 ── N Identity
Site     1 ── N View（定义）
View     N ── N Identity（只引用，不复制）
View     N ── 1 LayoutPreset（内置或用户自定义）
Identity N ── N SiteTag（多对多，只用于分组）
```

- **视图 = 一份保存的定义 + 至多一个打开的容器。** 容器在浏览器页里活着，记住自己的
  布局、格位与聚焦标签；定义是启动时的模板。重复打开同一个定义会复用容器、补齐缺少的
  成员标签，登录态保住。
- 身份只属于一个站点。同一账号要测两个站点时创建两个身份，因为不同主机名的
  Cookie 域不同，复用 profile 会串站点。要在两个站点间共享账号资料，用
  `passwordMode: "reference"` 指向另一个身份；登录态与 profile 仍各自独立。
- 站点没有「类型」字段，也没有隐式的生产/非生产区分。启动一个窗口只是打开一个
  登录页，真正的破坏性动作发生在被测系统里，靠站点名字猜风险既会漏判也会误判；
  权限边界由 MCP 的 run 档和用户自己开的窗口负责。
- 凭据：身份存自定义密码，站点存默认密码，身份还可以引用另一个身份。
  解析顺序是引用目标 → 身份自定义 → 站点默认 → 报错；引用只允许一层。
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

## 存储

| 文件 | 内容 | 位置 |
| --- | --- | --- |
| `workspace.json` | 站点、站点标签、身份、视图、布局预设、手动引擎路径 | Electron `userData` |
| `settings.json` | 主题、语言、布局、上次视图 | Electron `userData` |
| `vault.json` | 加密后的凭据 | Electron `userData` |
| `mcp.json` | AI 接入开关、端口、Token、权限开关 | Electron `userData` |
| `mcp-audit.log` | MCP 调用审计（参数已脱敏） | Electron `userData` |
| `profiles/` | 每个身份的浏览器 profile（外部模式） | Electron `userData` |
| `screenshots/` | 内置浏览器与 AI 工具截的图 | Electron `userData` |

内置表面的会话分区由 Chromium 自己管理，位置在 `userData/Partitions/`，
与 `profiles/` 互不相干。

所有写入使用「临时文件 + rename」保证原子性，`vault.json`、`mcp.json`、导出文件以 0600 权限写入。

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
  字段递归替换为 `[redacted]`。
- 生命周期：与主进程同生共死。`stop()` 先 `closeAllConnections()` 再 `close()`，
  保证客户端保持长连接时也能立即释放端口。

## 导入导出

`shared/transfer.ts` 定义文件格式并做严格校验（拒绝陌生 format、未来版本、缺字段），
`WorkspaceService.exportWorkspace / importWorkspace` 负责组装与合并。

- 导出不含运行实例、Profile、登录态。
- 密码可选：给定口令时用 `createKdfParams` + `seal` 把 `{environment, identity}` 密码表
  加密成 `secrets.payload`，与 vault 同一套 scrypt + AES-256-GCM。
- 导入按 id 合并，缺失所属站点的条目跳过并计数；有加密段但口令错误时整体抛错，
  不写入任何数据。

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
- MCP 端点只绑回环、必须带 Token、校验 Host/Origin；工具永远不返回明文密码。
