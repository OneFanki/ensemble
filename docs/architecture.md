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
│  layout/       网格布局计算                                              │
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
```

- 身份只属于一个环境。同一账号要测两个环境时创建两个身份，因为不同主机名的
  Cookie 域不同，复用 profile 会串环境。
- 凭据：身份存自定义密码，环境存默认密码，应用层不维护「账号库」。
  解析顺序是身份自定义 → 环境默认 → 报错。
- Profile 目录用 UUID，显示名可随时改；引擎绑定在身份上，换引擎是复制身份
  生成新 profile，而不是迁移目录。

## 存储

| 文件 | 内容 | 位置 |
| --- | --- | --- |
| `workspace.json` | 环境、身份、场景、手动引擎路径 | Electron `userData` |
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
