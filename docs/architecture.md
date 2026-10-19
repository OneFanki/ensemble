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
│  service.ts    用例编排：环境 / 身份 / 场景 / 登录态                      │
└─────────────────────────────────────────────────────────────────────────┘
```

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
3. 登录态检测（页面内 `fetch` 携带 Cookie）与窗口定位
   （`Browser.getWindowForTarget` + `Browser.setWindowBounds`）

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
- 环境没有单独的「类型」字段：生产环境靠名称识别（`isProductionName`），
  命中才在启动前二次确认。少一个字段就少一次填写和一次维护。
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
| `profiles/` | 每个身份的浏览器 profile | Electron `userData` |

所有写入使用「临时文件 + rename」保证原子性，`vault.json` 以 0600 权限写入。

## 进程生命周期

- 应用是浏览器实例的唯一所有者，`workspace.json` 里不持久化运行中实例。
- 启动时清理 `--user-data-dir` 指向自有 `profiles/` 根目录的残留进程。
- 停止单个实例：CDP `Browser.close` → 等待 → 按 PID 兜底。
- 场景启动是原子的：中途失败会回收本次已拉起的窗口，不留下半套。
- 退出应用时先优雅关闭全部实例，再退出主进程。

## 安全边界

- 渲染进程：`contextIsolation: true`、`nodeIntegration: false`、`webviewTag: false`，
  导航与 `window.open` 一律拦截，外链交给系统浏览器。
- IPC 入参全部经过 Zod 校验；密码不在任何 IPC 返回值中出现。
- 密码只存在于主进程内存与加密后的 `vault.json`。
- 自动填充前校验当前页面 origin 属于目标环境，跨域拒绝执行。
- 生产环境身份在启动前二次确认。
