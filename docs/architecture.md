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
│  service.ts    用例编排：环境 / 身份 / 场景 / 登录态 / 导入导出            │
└─────────────────────────────────────────────────────────────────────────┘
```

主进程内还托管两个与 UI 无关的服务：

- `src/main/mcp/server.ts`：本机 MCP 端点（AI 接入），只依赖 `WorkspaceService`；
- `src/shared/transfer.ts`：导入导出文件的格式校验，纯数据、无 IO。

界面有两个窗口，共用同一份构建产物与同一个 preload：

- 控制台（默认路由）：环境 / 身份 / 场景 / 设置；
- 运行实例悬浮条：`index.html#overlay` 挂载 `overlay/OverlayApp.vue`，无边框、置顶、
  跳过任务栏。它不持有多余状态，只订阅同一份 `WorkspaceSnapshot`，点一下通过
  `Page.bringToFront` 把对应浏览器窗口提到最前（最小化则先恢复）。

悬浮条的位置保存在 `userData/overlay.json`（纯窗口偏好，不进入可导出的工作区文件）；
显示开关是 `settings.overlayEnabled`。

`src/core` 不依赖 Electron，所以能在纯 Node 下跑单元测试，也能被未来的 CLI 或 CI
直接复用。浏览器窗口不是 Electron 的 `BrowserWindow`，而是由 `spawn` 启动的独立
系统浏览器进程。

## 为什么用 CDP 而不是 Playwright

Playwright 是自动化测试库，它默认会接管对话框、下载和文件选择：

- 没有注册 `dialog` 监听时，`alert` / `confirm` / `prompt` 会被自动 dismiss。
- 下载落到临时目录，context 关闭即删除。

人手操作浏览器时，这些行为会让测试结论失真。所以主链路直接用系统浏览器 +
`--remote-debugging-port=0`，只通过 CDP 做三件事：

1. 导航（`Page.navigate` 或重定向）
2. 登录表单填充（`Runtime.evaluate` + 原生 value setter + `input` / `change` 事件，
   支持账号密码之外按标签匹配的额外字段）
3. 登录态检测（页面内 `fetch` 携带 Cookie）、窗口定位
   （`Browser.getWindowForTarget` + `Browser.setWindowBounds`）与窗口切换
   （`Page.bringToFront`，最小化的先恢复）

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

```
Environment  1 ── N Identity
Environment  1 ── N Scene
Scene        N ── N Identity（只引用，不复制）
Scene        N ── 1 LayoutPreset（内置或用户自定义）
```

- 身份只属于一个环境。同一账号要测两个环境时创建两个身份，因为不同主机名的
  Cookie 域不同，复用 profile 会串环境。
- 环境没有「类型」字段，也没有隐式的生产/非生产区分。启动一个窗口只是打开一个
  登录页，真正的破坏性动作发生在被测系统里，靠环境名字猜风险既会漏判也会误判；
  权限边界由 MCP 的 run 档和用户自己开的窗口负责。
- 凭据：身份存自定义密码，环境存默认密码，应用层不维护「账号库」。
  解析顺序是身份自定义 → 环境默认 → 报错。
- Profile 目录用 UUID，显示名可随时改；引擎绑定在身份上，换引擎是复制身份
  生成新 profile，而不是迁移目录。

## 窗口布局

内置预设定义在 `src/shared/layouts.ts`，槽位坐标是相对工作区的比例（0–1），
与显示器分辨率解耦：

| 预设 | 说明 |
| --- | --- |
| `free` | 无布局。每个窗口都铺满工作区，互相重叠，用任务栏 / Alt+Tab 切换 |
| `1x1` / `2x1` / `1x2` / `2x2` / `3x1` | 等分网格，边到边，无外边距 |

- 预设是**铺满的**：`computeSlots` 直接用比例乘工作区，不加 padding 与 gap。
  旧实现的 8px 外边距在小屏幕上正好是浪费掉的可视面积。
- 用户可以保存自己的预设（`LayoutPreset`，坐标经 `clampSlot` 收敛），
  场景按 id 引用；删除预设时引用它的场景回落到 `2x2`。
- 编辑器里的拖动与缩放会吸附到舞台边缘和相邻槽位的四条边（`snapSlotMove` /
  `snapSlotResize`，阈值按舞台像素换算成比例，与窗口宽度无关），吸附时显示参考线；
  正在编辑的槽位始终置顶，避免缩放手柄被相邻槽位盖住。
- 场景可以把成员拖到指定槽位（`Scene.slotAssignments: identityId → slotIndex`），
  未指定的成员按成员顺序补空槽位（`resolveSlotAssignments`）。启动、单独重开、
  拖拽换位都按这份映射排窗口。
- 实例在内存里记录 `layoutId` 与 `slotIndex`，后续重排只影响同一预设的窗口，
  单独启动一个身份不会打乱已经排好的场景。
- 单个身份单独启动（当前没有任何窗口）仍居中放大打开，而不是塞进第一个槽位。

## 存储

| 文件 | 内容 | 位置 |
| --- | --- | --- |
| `workspace.json` | 环境、身份、场景、布局预设、手动引擎路径 | Electron `userData` |
| `settings.json` | 主题、语言、布局、上次视图 | Electron `userData` |
| `vault.json` | 加密后的凭据 | Electron `userData` |
| `mcp.json` | AI 接入开关、端口、Token、权限开关 | Electron `userData` |
| `mcp-audit.log` | MCP 调用审计（参数已脱敏） | Electron `userData` |
| `profiles/` | 每个身份的浏览器 profile | Electron `userData` |

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
- 干净会话的 profile 放在 `profiles/<envId>/clean-*`；不属于任何环境的空白会话放在
  `profiles/clean/clean-*`，独立分段，删除环境不会误停它们，启动清扫仍会覆盖。
- 启动时清理 `--user-data-dir` 指向自有 `profiles/` 根目录的残留进程。
- 停止单个实例：CDP `Browser.close` → 等待 → 按 PID 兜底。
- 场景启动是原子的：中途失败会回收本次已拉起的窗口，不留下半套。
- 退出应用时先优雅关闭全部实例，再退出主进程。

## AI 接入（MCP）

```
AI 客户端 ──HTTP POST /mcp──▶ McpServer ──▶ WorkspaceService ──▶ 浏览器
              Bearer Token        tools/call      同一套业务方法
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
- 导入按 id 合并，缺失所属环境的条目跳过并计数；有加密段但口令错误时整体抛错，
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
- IPC 入参全部经过 Zod 校验；密码不在任何 IPC 返回值中出现。
- 密码只存在于主进程内存与加密后的 `vault.json`。
- 自动填充前校验当前页面 origin 属于目标环境，跨域拒绝执行。
- MCP 端点只绑回环、必须带 Token、校验 Host/Origin；工具永远不返回明文密码。
