# 浏览器动作封装清单

> 本文是「AI 能做人能做的操作」的**覆盖清单**：浏览器上一个真人能做出的动作，
> 逐项对应到要封装的函数、底层 CDP 命令、以及当前的实现状态。
>
> 目的有两个：一是把「还没封装的」从印象变成可勾选的表，二是给「为什么这一项
> 不封装」留下明确理由，避免同一件事被反复问起。
>
> 相关文档：能力基线（[`embedded-browser-capability-baseline.md`](./embedded-browser-capability-baseline.md)）、
> 技术选型边界（[`cdp-vs-playwright-boundary.md`](./cdp-vs-playwright-boundary.md)）。

## 0. 先说清楚三层是什么关系

AI 驱动页面有三条路径，表达力递增、安全性递减。它们不是冗余，各有不可替代的位置：

| 层 | 是什么 | 用在哪 | 事件语义 |
| --- | --- | --- | --- |
| **① 封装动作** | 本清单要建的东西。一个函数 = 一次可复用的交互事务 | AI 的日常操作；流程的每一步 | 真实输入（`isTrusted: true`） |
| **② 裸 CDP 步骤** | 流程里的一种步骤类型，参数是 CDP 方法名 + 参数 | ① 覆盖不到、但确实是协议层操作的场合 | 取决于命令 |
| **③ 页面脚本** | `evaluate_browser_page` / 流程的 `read` | 读数据、做快照、一次性计算 | 页面内 JS（合成事件） |

**为什么 ① 必须先做，且要尽可能全**：②③ 都绕开了封装里的判定（命中读回、
指针前置、导航销毁 context 的处理、密码字段脱敏），用一次就少一层保障。
②③ 是逃生口，不是日常路径——**只有当 ① 真的做不到时才用**。

判断标准（写进代码评审）：

> 一个动作被 AI 用 ② 或 ③ 完成超过两次，就说明 ① 缺了它。

## 1. `isTrusted` 与合成事件

**`isTrusted` 是浏览器给每个事件打的标记**：由浏览器内部（真实用户输入，或
CDP 的 `Input.*`）产生的事件为 `true`；由页面脚本调用
`new MouseEvent(...)` / `el.click()` / `el.dispatchEvent(...)` 产生的事件为
`false`，且这个值**不可伪造**（只读，脚本改不了）。

**合成事件就是后一种**：`el.click()` 看起来点了，但它不经过浏览器的事件管线——
没有真实的 `pointerdown → mousedown → focus → mouseup → click` 序列，没有命中
测试，没有默认行为的完整链路。

**为什么它不够用**（三种实际翻车）：

1. **框架拦**。React / Vue 的合成事件层在部分版本里会忽略 `isTrusted: false`
   的事件，尤其是点击和键盘。
2. **密码管理器、浏览器扩展、企业安全策略**只认可信事件——用合成事件填的登录
   表单，真实站点会当成脚本在捣鬼。
3. **默认行为缺失**。合成 `click()` 在 `<a>` 上不触发导航、在 `<input type=file>`
   上不会打开选择器、在 checkbox 上状态可能与预期不一致。

所以 `clickAt()` 走的是：

```
Input.dispatchMouseEvent{mouseMoved}   ← 先移动，让命中测试有落点
Input.dispatchMouseEvent{mousePressed, buttons:1, clickCount:1}
Input.dispatchMouseEvent{mouseReleased, buttons:0, clickCount:1}
```

这三条由浏览器内部产生，因此页面看到的是 `isTrusted: true`，与真人点击在渲染器
眼里等价。**这是本清单所有「动作」类封装的共同前提**。

代码位置：`src/main/embedded/cdp.ts` 的 `clickAt`；合成事件为何不可用的说明见
`src/core/cdp/inspect.ts:532`。

### 1.1 JS 弹窗的三条实测事实

这三条决定了 `dialog` 那组动作为什么必须存在，也决定了它们的形状。全部在
Electron 45.2.1 上用真实页面测过：

1. **弹窗打开时页面完全阻塞。** 触发它的 `Input.dispatchMouseEvent` **永远不
   返回**，之后的 `Runtime.evaluate` 也一样。默认 30 秒单命令上限把它变成一次
   超时，调用方看到的是「点了没反应」，而不是「有个弹窗在等你回答」。
2. **`Page.handleJavaScriptDialog` 在弹窗期间仍能应答。** 这是唯一的解锁路径，
   而且它不依赖你是否收到过 `Page.javascriptDialogOpening`——事件可能在会话空闲
   释放期间发出，而事件不重放。
3. **被挂起的命令不会消失，弹窗一关它就落地。** 所以「点一次 confirm → 回答 →
   又冒出一个 confirm」是正常时序：第一个点击只是在队列里等着。

因此页面动作在**发命令之前**就查主进程记录的弹窗状态，直接报错而不是白等 30 秒。
错误文案点名弹窗类型与内容，并给出下一步（读它、回答它）。

**`prompt()` 在 Electron 里不存在。** 页面调用得到 `prompt() is not supported.`
并抛出异常，它后面的 DOM 写入不会执行。这是引擎边界而不是本应用的缺陷；
`handle_browser_dialog` 的 `promptText` 因此暂时没有可测路径，保留是为了 Electron
支持之后不必改接口。

## 2. 安全边界：为什么某些 CDP 域必须限制

隔离模型是这样的（`src/shared/embedded.ts:1740`）：

```
有身份   → persist:embedded-id-<identityId>     每身份独立 cookie / storage
干净会话 → persist:embedded-clean-<instanceId>   退出即弃
档案     → persist:embedded-profile-<profileId>  用户日常登录
```

分区是**存储隔离**，由 Chromium 保证，HTML/JS 侧无法穿越。但这是**在同一个
浏览器进程里**的隔离——下面这些 CDP 命令可以直接作用于整个进程：

| 命令 | 后果 |
| --- | --- |
| `Target.setAutoAttach` / `Target.attachToTarget` | 附加到**任意** target，包括别的分区的页面 |
| `Target.createBrowserContext` | 造一个新的 browser context，绕过应用的分区命名规则 |
| `Browser.setDownloadBehavior` | 改写**整个浏览器**的下载路径（ADR 里 Playwright 被否决的正是这个行为） |
| `Storage.*` / `Network.setCookie` | 直接读写指定分区的 cookie |
| `Page.setWebLifecycleState` | 冻结/唤醒页面，会干扰休眠策略与正在跑的脚本 |

也就是说：**能调 `Target.*` 的 AI，等价于能跨 profile 读数据**。这不是「踩坑」，
是把产品立身之本拆掉。所以这些域不是「为了审计而限制」，是**必须不可达**。

安全分档：

| 档 | 域 | 处置 |
| --- | --- | --- |
| **可用** | `Input.*`、`DOM.setFileInputFiles`、`Page.handleJavaScriptDialog`、`Page.captureScreenshot` | 等价于真人操作或一次只读采集，默认开放 |
| **可选** | `Network.*`、`Fetch.*`、`Emulation.*`、`Performance.*`、`Security.*`、`DOMStorage.*`、`IndexedDB.*`、`CacheStorage.*` | 只影响单个页面，但会改变页面行为或读取其流量；设置项「流程可用网络与设备命令」显式开启 |
| **禁止** | `Browser.*`、`Target.*`、`Storage.*`、`Page.setWebLifecycleState`、`Page.close`、`Page.crash`、`Network.setCookie*`、`Runtime.addBinding` | 跨分区或影响整个进程，**设置项也不能解锁** |

## 2.1 流程里的原始 CDP 步骤

封装不可能覆盖全部，所以流程有一个 `cdp` 步骤可以跑协议层命令。它不是后门，是
**登记在案的例外**：命令必须先过 `core/cdp/flow-whitelist.ts` 的三档判定，被拒时
错误信息里写明属于哪一档、以及为什么。

| 档 | 判据 | 典型命令 |
| --- | --- | --- |
| 可用 | 只作用于当前页面，等价于真人操作或一次只读采集 | `Input.*`、`DOM.setFileInputFiles`、`Page.handleJavaScriptDialog`、`Page.captureScreenshot` |
| 可选 | 改变页面行为或读取其流量，需要设置项「流程可用网络与设备命令」 | `Network.*`、`Fetch.*`、`Emulation.*`、`Performance.*` |
| 禁止 | 能触达其它 target、其它分区或整个进程 | `Target.*`、`Browser.*`、`Storage.*`、`Page.setWebLifecycleState`、`Network.setCookie*` |

**没登记的域一律拒绝**，不是默认放行——"allow by default" 意味着每加一个新域都要
先想到它可能做什么，而那正是容易漏的方向。

**为什么设置项不能解锁禁止档。** 用户在设置里开启网络观察，并没有同意跨身份读数据。
把这件事做成一个开关，等于把「隔离」变成一个偏好项。

**超过两次会提示。** 一趟流程里出现三次以上原始命令，通常说明缺一个封装动作；
`run_flow` 的返回里会带一条 `note` 这么说，而不是等评审时才发现。

**流程超时是调用方给的。** `run_flow` 的 `timeoutMs` 默认 120 秒、上限 10 分钟，
且 `wait` 步骤会被流程剩余预算截断——否则一个 30 秒的等待能吃掉一个只给 1 秒的
流程，然后把错误报成「条件没满足」。

## 2.2 流程里的 script 步骤

循环、条件、「读到的值决定下一步」属于编排层，与动作层是两件事。`script` 步骤
（方案 B）在 `node:vm` 的新 context 里跑一段 JS（≤10000 字符），脚本里能调用的
**只有动作原语**：`navigate` / `click` / `fill` / `select` / `press` / `hover` /
`scroll` / `check` / `setFiles` / `drag` / `wait` / `read`——**能力边界 = 工具集合**。
脚本没有第二套动作实现：每个原语都构造回 `runFlow` 的单步执行器
（`browser.ts` 的 `runStepAction`），所以 wait 的预算截断、read 的 vars 写入与
直接排步骤完全一致；`hover` / `scroll` / `check` / `setFiles` / `drag` 还不是
流程步骤，原语直接调 BrowserManager 上的同名方法（工具的唯一实现）。

刻意不暴露的两个：`login`（走凭据路径，编排脚本不得触碰）与 `cdp`（协议逃生口
有自己的三档白名单与闸门，不经过脚本）。

**vm 的真实强度（诚实版）。** `node:vm` 不是对抗恶意代码的硬沙箱——这是 Node
官方立场，而且实测成立：`globalThis.constructor.constructor("return process")`
在当前 Node 上能摸回宿主 process，注入的原语函数（`fill.constructor`）是同一条
路。所以 script 步骤的安全叙事分两层：

- 对**正常作者**（写循环与条件的人）：context 里没有 `require` / `process` /
  `Buffer` / `setTimeout` / `fetch`，只有动作原语、vars/params 和无能力面的内置
  （JSON、Math、Error 等），碰不到文件系统、宿主网络与凭据。
- 对**决心逃逸的作者**：vm 挡不住，防线在 MCP 权限档位。且持有 `run_flow` 权限
  的调用方本来就有 `evaluate_browser_page` 与 `cdp` 工具——逃逸并没有放大他
  已有的能力面。

**超时与错误。** 整段脚本吃 `min(步骤 timeoutMs, 流程剩余)`：到点中断报
「脚本超时」，中断后脚本里挂着的下一次原语调用直接失败（页面不再被动）。
同步死循环由 vm 的执行超时打断。语法与运行时错误都带脚本本体的行号
（`flow-script.js:N`，包装前缀不换行所以行号不用换算）。

**vars 往返。** 此前 `read` 步骤的变量、流程参数（`params`）都在脚本可见；
`read(target, as)` 的 `as` 写穿到流程 vars；步骤的 `as` 字段把脚本 `return`
值落进 vars，后续步骤可 `{{引用}}`。脚本 console 输出按行收进该步的 detail。
`tests/flow-script.test.ts` 钉住封闭面与超时行为，`scripts/e2e-flow-script.mjs`
验证页面真的变了。

## 3. 封装动作清单

状态说明：**已有** = 已实现且有工具；**部分** = 命令在但能力不全；
**待做** = 还没做，按 §5 的顺序排；**不做** = 见第 4 节理由。

### 3.1 指针（`Input.dispatchMouseEvent`）

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `click` | 左键单击（真实三连事件 + 命中读回） | `mouseMoved`→`mousePressed`→`mouseReleased` | 已有 |
| `doubleClick` | 双击 | 同上，`clickCount: 2` | **待做** |
| `rightClick` | 右键（触发 contextmenu） | `mousePressed/Released{button:"right"}` | **待做** |
| `middleClick` | 中键（新标签 / 自动滚动） | `mousePressed/Released{button:"middle"}` | **待做** |
| `clickAt` | 按坐标点击（无选择器可用时） | 同上 | **待做** |
| `hover` | 悬停（展开菜单、tooltip、hover 态） | `mouseMoved`（只发移动） | 已有（`hover_browser_element`） |
| `moveMouse` | 移动到相对位置（拖拽的中间步） | `mouseMoved` | 已有（drag 内部六步移动） |
| `holdModifier` | 按住修饰键再点击（Ctrl+click 多选等） | `mousePressed{modifiers}` | **待做** |
| `scroll` | 滚轮滚动（页面或元素） | `mouseWheel{deltaX,deltaY}` | 已有（`scroll_browser_page`，读回 `moved`） |
| `scrollIntoView` | 把元素滚到可见区（不滚页面本身） | `element.scrollIntoView()` | 已有（内建于定位） |
| `drag` | 从 A 拖到 B | `mousePressed`→六次`mouseMoved`→`mouseReleased` | 已有（`drag_browser_element`；两端在同一次页面调用里解析，避免重渲染错位） |
| `dragAndDropFiles` | 拖文件进页面 | `Input.dispatchDragEvent` | **待做** |

### 3.2 键盘（`Input.dispatchKeyEvent`）

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `type` | 逐字输入（真实输入事件） | `Input.insertText` | 已有 |
| `fill` | 整段替换（先 selectAll） | `selectAll` + `insertText` | 已有 |
| `press` | 单个按键（Enter/Esc/Tab/方向键/空格） | `dispatchKeyEvent` keyDown+keyUp | 已有（10 个键） |
| `keypress` | 组合键（Ctrl+A、Cmd+Shift+S） | `dispatchKeyEvent{modifiers}` | 已有（`press_browser_keys`，修饰键先按下、逆序抬起） |
| `pressWithDelay` | 长按（触发长按菜单） | keyDown…keyUp 之间等待 | **待做** |
| `clear` | 清空输入框 | `selectAll` + `Delete` | **待做**（`fill` 内已隐含） |

`modifiers` 位值：Alt=1、Ctrl=2、Meta=4、Shift=8（可组合相加）。

### 3.3 表单与文件

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `check` / `uncheck` | 勾选/取消勾选（不是点击，而是设状态后派发 change） | `Runtime.evaluate` 读状态 + 仅在必要时点击 | 已有（`set_browser_checkbox`，幂等；`stuckAt` 报告点不动的框） |
| `selectOption` | 下拉选择（按文本或 value） | 设 `value` + 派发 `change` | 已有（`select` 动作） |
| `setFiles` | 选择文件（不打开原生选择器） | `DOM.setFileInputFiles`（`backendNodeId`，非 `nodeId`） | 已有（`upload_browser_files`；单文件框给多个会报错而不截断） |
| `submitForm` | 直接提交表单（绕过提交按钮被遮挡） | `form.requestSubmit()` | **待做**（谨慎，见 §4） |

### 3.4 导航与等待

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `navigate` | 打开地址 | `Page.navigate` | 已有 |
| `back` / `forward` | 前进后退 | `webContents.navigationHistory` | 已有（`go_back_browser_tab` / `go_forward_browser_tab`） |
| `reload` | 刷新（含忽略缓存） | `Page.reload` | 已有（`reload_browser_tab`，`ignoreCache` 等价 Ctrl+Shift+R） |
| `waitForVisible` | 等元素可见 | 轮询求值 | 已有 |
| `waitForHidden` | 等元素消失 | 轮询求值 | 已有 |
| `waitForText` | 等页面出现文本 | 轮询求值 | 已有 |
| `waitForUrl` | 等地址匹配 | 轮询求值 | **待做**（当前 `wait` 有 url 条件，无独立工具） |
| `waitForLoadState` | 等 `load` / `domcontentloaded` / `networkidle` | `Page.loadEventFired` 等事件 | 已有（`load` 形态：`wait_browser_condition` 的 `load` 条件，页内轮询 readyState） |
| `waitForNetworkIdle` | 等网络静默 | `Network.requestWillBeSent`/`loadingFinished` | 部分（有 `wait_browser_condition` 条件） |
| `waitForResponse` | 等某个请求返回（含状态码） | 页面收集器（`fetch`/XHR 包装） | 已有（`wait_browser_condition` 的 `response` 条件，配 `status` 精确匹配） |
| `wait` | 固定等待 | 定时器 | 已有 |

### 3.5 读取与观察

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `snapshot` | 语义快照（可读文本树） | `Runtime.evaluate` | 已有（`read_browser_page`） |
| `snapshotWithRefs` | 快照 + 稳定句柄 `e1..eN` | 遍历 + 标记属性 | 已有（定位句柄形态：`find_browser_element` 返回 `handleId` + 全部匹配预览；**叠加式，旧定位参数不变**，快照不再内嵌 `e1..eN` 引用） |
| `find` | 收窄定位：`hasText` / `hasNotText` / `visible` / `nth`，返回句柄与匹配预览 | `Runtime.evaluate` | 已有（`find_browser_element`，read 档；`timeoutMs` 内轮询等第一个匹配） |
| `withHandle` | 动作复用句柄，跨重渲染指向同一逻辑元素 | 同上（句柄是定位描述符：每次使用重跑定位，多命中按登记文本特征对齐；导航即失效） | 已有（click / hover / type / `set_browser_checkbox` / `read_browser_element` 的 `handle` 参数；叠加式，旧定位参数不变） |
| `getState` | url/title/可前进后退/滚动位置 | `Runtime.evaluate` | 部分 |
| `elementInfo` | 元素的全貌（角色/名称/状态/属性/值） | `Runtime.evaluate`（复用定位辅助） | 已有（`read_browser_element`） |
| `getText` | 取元素文本 | `Runtime.evaluate` | 已有（`read`） |
| `getAttribute` | 取属性值；缺失返回 `null` | `Runtime.evaluate` | 已有（`read_browser_attribute`） |
| `getValue` | 取输入框当前值 | `Runtime.evaluate` | 已有（不给 `names` 时返回 `value`） |
| `screenshot` | 截图（全页/裁剪/元素/缩放） | `Page.captureScreenshot` | 已有元素裁剪（`clip` + `scale = 1/DPR`）；整页截图仍需滚动拼接 |
| `getConsole` | 读控制台 | `Runtime.consoleAPICalled` | 已有 |
| `getNetwork` | 读请求列表（含状态码） | 页面收集器（`fetch`/XHR 包装） | 已有（`read_browser_requests`，只读不清空；`read_browser_console` 附带同一批数据） |

### 3.6 弹窗、下载、上传

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `getDialog` | 读当前 JS 弹窗（类型、消息、默认值） | `Page.javascriptDialogOpening` | 已有（`read_browser_dialog`，从主进程事件记录读，弹窗期间仍可用） |
| `handleDialog` | 接受/取消，prompt 可填值 | `Page.handleJavaScriptDialog` | 已有（`handle_browser_dialog`；`accept: false` 为取消） |
| `dialogAutoDismiss` | 无人处理时超时自动关 | 计时器 | 已有（默认 30 秒，`ENSEMBLE_DIALOG_AUTO_DISMISS_MS` 可为 e2e 压缩） |
| `download` | 用页面 cookie 下载到指定路径 | `Browser.setDownloadBehavior` | **待做**（需 per-tab 策略，见 §4） |
| `waitForDownload` | 等下载完成 | `Browser.downloadProgress` | **待做** |
| `uploadFiles` | 同 `setFiles` | `DOM.setFileInputFiles` | 同 3.3（已有） |

### 3.7 标签、视口、设备

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `listTabs` / `openTab` / `closeTab` / `activateTab` | 标签管理 | 应用层 | 已有 |
| `setViewport` | 固定 CSS 视口 | `Emulation.setDeviceMetricsOverride` | 已有 |
| `resetViewport` | 恢复自适应 | `Emulation.clearDeviceMetricsOverride` | 已有 |
| `setDevice` | 预设设备（含 UA/touch/pixelRatio） | `Emulation.*` | 已有 |
| `setGeolocation` | 地理位置 | `Emulation.setGeolocationOverride` | 已有（`set_browser_emulation` 的 `geolocation` 键；不授予权限，页面没被授权时拿不到坐标） |
| `setTimezone` | 时区 | `Emulation.setTimezoneOverride` | 已有（`set_browser_emulation` 的 `timezone` 键） |
| `setMedia` | 配色偏好 / 打印 / 减少动效 | `Emulation.setEmulatedMedia` | 已有（打印形态：`set_browser_emulation` 的 `mediaType` 键） |
| `setOffline` | 离线模式 | `Network.emulateNetworkConditions` | 已有（`set_browser_emulation` 的 `offline` 键） |
| `setNetworkConditions` | 限速 / 高延迟 | `Network.emulateNetworkConditions` | **待做**（offline 已随 `set_browser_emulation` 落地，限速曲线仍是独立条目） |
| `setLocale` | 语言 | `Emulation.setLocaleOverride` | **待做** |
| `setPermissions` | 授予/拒绝权限（地理位置、通知等） | `Browser.grantPermissions` | **禁止**（见 §2，需评审后变更） |

### 3.8 脚本执行与事件

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `evaluate` | 执行 JS 表达式 | `Runtime.evaluate` | 已有 |
| `evaluateAwait` | 执行并等待 Promise | 同上 + `awaitPromise` | 已有 |
| `addInitScript` | 注入初始化脚本（每次加载前） | `Page.addScriptToEvaluateOnNewDocument` | 已有 |
| `listInitScripts` / `removeInitScript` | 管理注入脚本 | 同上 | 已有 |
| `dispatchEvent` | 派发一个指定事件（合成，慎用） | `Runtime.evaluate` | **不做**（见 §4） |
| `waitForFunction` | 等某个 JS 条件为真 | 轮询 `Runtime.evaluate` | **待做** |
| `waitForRequest` | 等某个请求发出 | `Network.requestWillBeSent` | **待做** |

### 3.9 页面生命周期

| 动作 | 语义 | CDP | 状态 |
| --- | --- | --- | --- |
| `freeze` / `unfreeze` | 挂起/恢复页面 JS | `Page.setWebLifecycleState` | 内部已有，**不开放给 AI**（见 §2） |
| `getPerformanceMetrics` | 性能指标 | `Performance.getMetrics` | 已有（性能面板） |
| `startPerfRecording` | 开始录制追踪 | `Tracing.start` | **不做**（见 §4） |

## 4. 明确不做，以及为什么

| 项 | 决定 | 理由 |
| --- | --- | --- |
| `dispatchEvent`（任意合成事件） | 不做 | 这就是「用页面脚本假装操作」。`isTrusted: false`，且它让上面所有真实事件的封装失去意义。要派发事件说明封装缺了对应动作，去补那个动作。 |
| `Browser.*` / `Target.*` / `Storage.*` | 禁止 | 跨分区或影响整个进程，破坏身份隔离（§2）。 |
| `Tracing.*`（录制 trace） | 不做 | 产出是给开发者看的 trace 文件，不是「操作页面」。需要时人手动开 DevTools。 |
| `submitForm` | 谨慎做 | `form.requestSubmit()` 会绕过「提交按钮是否可用」这类校验，可能提交一个界面本不允许提交的表单。只在目标按钮被遮挡时作为显式降级。 |
| `setDownloadBehavior` | 有条件做 | 必须 per-tab（`BrowserContext` 级别），绝不改全局；理由见 ADR 0001 对 Playwright 的否决。 |
| `loop` / `if`（流程编排） | 已做 | 方案 B：`script` 步骤在 vm 里编排动作原语，能力边界 = 工具集合（§2.2）。声明式的 `loop` / `if` 步骤类型不再需要。 |

## 5. 实现顺序

按「AI 卡住时最常缺的」排，不按表面大小：

**第一批（阻塞最常见操作）**
1. `hover` —— 下拉菜单、tooltip、hover 态。没它，一半的菜单打不开。
2. `scroll` —— 长页面、虚拟列表。
3. `keypress`（组合键）—— Ctrl+A / Ctrl+Enter 这类。
4. `back` / `forward` / `reload` —— 导航三件套。
5. `dialog` 全套 —— 没有它，一次 `confirm` 就挂死页面。

**第二批（文件与拖拽）**
6. `setFiles` —— 上传是高频且 CDP 已实测可用。
7. `drag` —— 拖拽排序、看板。
8. `check` / `uncheck`。

**第三批（观察能力）**
9. `snapshotWithRefs` —— 已由 `find_browser_element`（定位句柄 + 收窄字段）覆盖；**叠加式：旧定位参数不变**，快照本身不再内嵌 `e1..eN` 引用。
10. `elementInfo`、`getAttribute`、`getValue`。
11. 截图 `clip` / `ref` / `scale`。

**第四批（环境模拟）**
12. `waitForLoadState` / `waitForResponse` / `getNetwork`。
13. `setGeolocation` / `setTimezone` / `setMedia` / `setOffline`。

## 6. 落地约定

**每条动作只实现一次。** 这条以前有过例外：MCP 工具走
`BrowserManager.click()`，而流程的 `click` 步骤自己重写了一遍，逐行相同、少了
`hit` 诊断。两条路已经合并，流程现在调用同一个方法——新动作必须照这个来，否则流程
那份会持续落后。

**合并后的分层**：

```
MCP 工具（click_browser_element …）  ─┐
                                     ├→ BrowserManager.click / hover / scroll …
流程步骤（{action:"click"} …）        ─┘        ↓
                                          CdpExecutor.clickAt / dispatchWheel …
                                                ↓
                                          webContents.debugger.sendCommand
```

**流程里的裸 CDP 步骤**（逃生口）必须：命令名在白名单内、在 UI 上标为「原始 CDP」、
且在一趟流程里出现超过两次时给出提示——两次以上的裸命令通常说明漏了一个该封装的
动作。

## 7. 待办

- [x] 合并 `runFlow` 的 `click`/`fill`/`select` 与 `BrowserManager` 的实现（第 0 步，纯重构）
- [x] 第一批动作（`hover` / `scroll` / `keypress` / `back`·`forward`·`reload` / `dialog`）
- [x] 第二批动作（`setFiles` / `drag` / `check`）
- [x] 第三批动作（`elementInfo` / `getAttribute` / `getValue` / 元素裁剪截图）
- [x] 第四批动作（网络与环境模拟：`read_browser_requests` / `wait_browser_condition` 的 `load`·`response` 条件 / `set_browser_emulation` 的时区·媒体·离线·地理）
- [x] 流程的 `cdp` 步骤类型 + 三档白名单（`core/cdp/flow-whitelist.ts`，`tests/flow-whitelist.test.ts` + `scripts/e2e-flow-cdp.mjs`）
- [x] 流程的 `script` 步骤（编排层，方案 B；`main/embedded/flow-script.ts`，`tests/flow-script.test.ts` + `scripts/e2e-flow-script.mjs`）
