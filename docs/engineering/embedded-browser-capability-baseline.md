# 内置浏览器能力基线（迁移目标）

> 本文是内核迁移的**需求基线**：把内置浏览器必须具备的能力逐项列清，作为「迁移后
> 必须有哪些能力」的清单，以及「当前差距在哪」的对照表。只记录能力与结论。

## 0. 结论：载体用 renderer `<webview>` + CDP-on-guest

内置浏览器的页面宿主从 main 进程的 `WebContentsView` 改为 renderer DOM 里的 `<webview>`，
main 经 `will-attach-webview` / `did-attach-webview` 拿到 guest `webContents` 后
`debugger.attach("1.3")` 执行既有 CDP 命令。executor 层作用于「`webContents` + CDP send」
抽象，接口同构、零改复用。

原因是 `WebContentsView` 的 native 层缺陷：它永远合成在 renderer DOM 之上，菜单、下拉、
tooltip 碰到页面区域就被遮，z-index 无法修复；配套的 `setBounds`/`setVisible` 定位与 DPR
换算又带出一串 bug。`<webview>` 在 DOM 内合成，浮层天然可以盖在页面上方。

**安全边界不由载体决定，由硬化规则决定**：每身份独立 `persist:<identityId>` 分区、
`nodeIntegration: false` / `contextIsolation: true` / `sandbox: true`、不挂带权限的 preload、
URL 白名单、popup 一律 deny 后自行路由。载体切换不改变这些约束，重新论证见
[ADR 0011](../architecture/adr/0011-webview-cdp-on-guest-pivot.md)。

ADR 0010 是把迁移**暂缓**（2026-10-28 裁决），并列了三条重启条件。本次迁移等于正式重启，
需要新写一份 ADR 取代 0010 的「暂缓」结论，而不是绕过它。

## 1. 人类可用能力（内置浏览器的「像浏览器」部分）

| 能力 | 说明 | 当前状态 |
| --- | --- | --- |
| 标签条占满标题栏 | 隐藏系统标题栏，用 `titleBarOverlay` 的原生窗口按钮 | 已有（自绘标题栏） |
| 标签分组 | 彩色竖条 + 组名，点击折叠 | **缺**（现有视图分组语义是账号场景，不是浏览器的标签组） |
| 前进 / 后退 / 刷新 | 标准导航 | 已有 |
| omnibox | 地址 + 搜索合一 | 已有（含引擎选择） |
| 收藏（星标） | 当前页收藏 / 取消 | 已有（书签体系更完整：文件夹、导入） |
| 收藏夹面板 | 右侧停靠列表面板 | 已有（书签页 + 新标签页磁贴） |
| 历史记录 | 访问记录、标题与 favicon 回填、去重更新 | **缺**（2.0 阶段 c 未开始） |
| 新标签页磁贴 | 新标签页的收藏磁贴 | 已有（独立的 NewTabPage 组件） |
| 下载 | 页内点击下载；agent 标签自动落盘免「另存为」 | 部分（有下载面板，无 agent 自动落盘策略） |
| 保存的登录凭据 | 登录表单提交时捕获，`safeStorage` 加密落盘，回访自动填充 | 已有且更强（站点/身份两级，加密凭据库） |
| JS 弹窗 | `alert/confirm/prompt/beforeunload`，可查询、可接受/取消、超时自动关闭 | **缺**（完全没有处理） |
| 页面右键菜单 | 上下文菜单 | 部分 |

## 2. Agent 可驱动能力（MCP 工具面）

按能力归类如下，并标注当前状态：

### 导航与状态

| 工具 | 现有对应 | 状态 |
| --- | --- | --- |
| `navigate` | `navigate_browser_tab` | 有 |
| `back` / `forward` / `reload` | 无独立工具（走 `evaluate_browser_page` 绕） | **缺** |
| `get_state`（url/title/canGoBack/canGoForward/scroll） | `read_browser_page` 部分覆盖 | 部分 |
| `wait_for_load_state`（`load`/`domcontentloaded`/`networkidle`） | `wait_browser` 只有 visible/hidden/text/url/value | **缺** |
| `wait_for`（selector / text / textGone，带超时） | `wait_browser` 覆盖 text/url/visible | 部分 |
| `wait_for_url` | **缺** | **缺** |
| `wait`（固定毫秒） | **缺** | **缺** |

### 读取与观察

| 工具 | 现有对应 | 状态 |
| --- | --- | --- |
| `snapshot`（可交互元素树 + 稳定 ref `e1..eN`） | `read_browser_page`（语义快照，但**无 ref**） | **部分，关键差异** |
| `dom_snapshot`（纯 ARIA 文本大纲） | 无 | **缺** |
| `element_info`（由坐标反查元素） | 无 | **缺** |
| `evaluate`（单表达式，支持 await） | `evaluate_browser_page` | 有 |
| `take_screenshot`（fullPage / clip / ref / scale） | `screenshot_browser_tab` | 部分（无 clip、无 ref、无 scale） |

**`ref` 是最大的可用性差距。** 现有快照给出「语义选择器 + 坐标」，调用方每次都要自己
拼选择器；按 DOM 序分配稳定句柄 `e1..eN`、后续动作直接用 ref，才不存在选择器漂移问题。
这是工具面好不好用的核心。

### 交互

| 工具 | 现有对应 | 状态 |
| --- | --- | --- |
| `click`（ref 或坐标，支持双击/右键/修饰键） | `click_browser_element`（text/label/role/selector） | 部分（无坐标、无双击、无修饰键） |
| `type`（逐字，触发真实输入事件） | `type_browser_text` | 有 |
| `fill`（整段赋值） | `fill_browser_form` | 有 |
| `press`（按键 + 修饰键） | 无独立工具 | **缺** |
| `keypress`（组合键，保序 down/up） | 无 | **缺** |
| `hover` | 无 | **缺** |
| `select_option` | `fill_browser_form` 内的 select 动作 | 部分 |
| `check`（checkbox/radio） | 无 | **缺** |
| `drag`（ref↔ref 或坐标↔坐标） | 无 | **缺** |
| `scroll`（元素滚动 / 视口滚动 / 带 modifier） | 无 | **缺** |

### 标签与会话

| 工具 | 现有对应 | 状态 |
| --- | --- | --- |
| `tabs`（list/create/close/activate/claim） | `list_browser_tabs` / `open_browser_tab` / `close_browser_tab` / `set_tab_page` | 有，但语义不同 |
| `scope`（子任务临时控制域，with barrier） | 无 | **缺**（可用 `launch_clean_session` 覆盖部分场景） |
| `set_visible` | 内部有（离台页面停到窗口外），无工具 | 部分 |
| `resize` / `viewport_reset` | `set_browser_viewport` / `reset_browser_viewport` | 有 |

### 其他

| 工具 | 现有对应 | 状态 |
| --- | --- | --- |
| `download`（用页面 cookie 下载到指定路径） | 无 | **缺** |
| `credentials`（list/save/delete，不返回密码） | `set_password` 等写接口 | 部分（本产品更严格，永不返回密码） |
| `get_dialog` / `handle_dialog` | 无 | **缺** |
| `locator`（Playwright 选择器逃生口） | 无 | **缺**（刻意不用 Playwright 驱动人工窗口） |

## 3. 已经核实、迁移时必须内建的结论

以下与载体无关，直接按结论实现：

1. **CDP 挂载会被风控探测。** Google 登录页会检测 CDP 会话并拒绝登录，所以不能常驻
   attach。正确做法是命令空闲约 1.5 秒即主动 `detach`，命令到来时恢复式 re-attach；密集
   命令流间隔远小于阈值，不会被打断。
2. **re-attach 时 session 态要重放。** detach 后 Chromium 会清空 session 态，裸 attach
   得到的是干净 session，`Page.enable` 丢失会让 `Page.javascriptDialogOpening` 事件黑洞，
   弹窗永远不触发。必须显式重放并设串行屏障，业务命令等它完成。
3. **弹窗无人处理会挂死页面。** 必须设置超时自动 dismiss（建议 60 秒）。
4. **最小化窗口时 CDP Input 会被静默丢弃。** 用户最小化后 agent 的点击无效，且不报错。
5. **`Page.captureScreenshot` 在页面不在屏上时会挂住而不是失败。** 已有同样的结论
   与双路径回退（见 `EmbeddedCdp.screenshot` 的矩阵），迁移时这张矩阵要整表重测。
6. **新窗口请求必须 deny 并自行路由。** 默认的裸窗口会脱离会话隔离；popup 的 URL 可能
   是 `javascript:` / `data:`，必须过滤，否则等于给页面开了任意导航口。
7. **`allowpopups` 必须在创建节点时声明**，事后补无效（这一点在 `<webview>` 载体下尤其
   关键，而它正是我们要迁去的载体）。
8. **下载要区分 agent 标签与用户标签。** agent 点不了原生「另存为」对话框，会一直悬着；
   agent 标签的下载应自动落盘并处理重名。

## 4. 迁移的必修项优先级

按「迁移后能力不倒退」与「补齐最影响可用性的差距」排：

**P0 — 迁移本身必须保住**
- 身份隔离（每身份独立 `persist:` 分区与 profile）——这是产品立身之本，不接受共用分区
- `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`，不挂带权限的 preload
- 截图矩阵整表重测（停放 / 最小化 / 全隐藏）
- 舞台几何契约（`composables/stageGeometry.ts` 不变）

**P1 — 补齐后才有完整工具面**
- JS 弹窗（`get_dialog` / `handle_dialog` + 超时）
- `ref` 稳定句柄（快照产出 `e1..eN`，动作按 ref 定位）
- `press` / `hover` / `scroll` / `check` / `drag`
- `wait_for_load_state` / `wait_for_url`
- CDP 空闲释放（否则 Google 登录会一直失败）

**P2 — 完整体验**
- 历史记录
- `download` 工具 + agent 自动落盘
- `element_info`（坐标反查）
- 截图 `clip` / `ref` / `scale`
- 标签分组（浏览器语义，与现有「视图」并存但不混为一谈）

## 5. 明确不做

- **Playwright 接管人工窗口**：AGENTS.md 强制约束 8 禁止。Playwright 风格的 `locator`
  逃生口不引入，等价能力用 `evaluate` + ref 覆盖。
- **单一共用分区**：与身份隔离冲突。
- **页面之外的系统级键鼠控制（CUA）**：不在本次范围。

## 6. 待办

- [x] 写 ADR 0011：内置浏览器迁移到 renderer `<webview>` + CDP-on-guest（取代 0010 的
      「暂缓」结论，并重新论证隔离边界）
- [x] 整表重测截图/几何矩阵（迁移前后各一份，作为回归基线）
- [x] 拆阶段：P1 guest 底座 → P2 renderer webview 组件 → P3 握手 → P4 删定位资产 → P5 回归
      （P5 补上了此前从未执行过的最小化场景，见 ADR 0011 的 P4/P5 落地记录）
