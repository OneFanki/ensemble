# AI 操作页面的技术选型边界：CDP 与 Playwright 的分工

> 本文回答一个反复被提出的问题：**AI 操作浏览器到底该用 CDP 还是 Playwright？两者能否共存？边界在哪？**
>
> 全部结论来自代码事实与实测，不依赖印象。文末列出待办与决策缺口。

## 0. 结论速览

| 层 | 场景 | 技术选型 | 状态 |
| --- | --- | --- | --- |
| **A. 产品主链路** | AI 在用户正在使用的浏览器里帮忙，人可随时介入 | **裸 CDP**（`Input.dispatch*` 真实事件） | 已建成；动作缺口见 coverage 清单 |
| **B. AI 跑自定义脚本** | 无人值守的批量任务 | **决定不做**，由流程承担 | 见 §4-B |
| **C. 应用自身 E2E** | 测 Ensemble 自己的 UI | 裸 CDP（客户端已抽成一份） | 保持，不迁 Playwright |
| **D. 非 CDP 浏览器** | 系统 Firefox / Safari 保真验证 | **无自动化方案**，人手动测 | 明确不做 |

**结论：主链路与 E2E 都用裸 CDP。Playwright 既不进产品运行时，也不进 E2E。**

## 1. 当前实现走什么

**产品主链路是纯 CDP，仓库里没有任何 Playwright 依赖。**

调用链（`src/main/mcp/server.ts` → `src/main/embedded/browser.ts` → `src/main/embedded/cdp.ts`）：

```
AI → MCP tool（click_browser_element）
   → surface().click(tabId, target)
   → ① cdp.evaluate(buildElementPointExpression)   用 JS 算出元素中心坐标
   → ② cdp.clickAt(x, y)                           真实鼠标事件
   → webContents.debugger.sendCommand("Input.dispatchMouseEvent", ...)
```

关键事实：

- **不是 TCP 端口**，而是 Electron 的进程内 `webContents.debugger.attach("1.3")`。
  原因见 `cdp.ts:77-88`：`--remote-debugging-port` 无鉴权，本机任意进程都能驱动浏览器。
- **`src/core/cdp/` 共 2560 行自研代码**，`inspect.ts` 单文件 827 行，全是「元素 → 坐标」
  这类表达式构造器（`buildElementPointExpression` / `buildVisibilityExpression` /
  `buildStabilityExpression` 等）。定位层这个「CDP 用起来麻烦」的部分已经付过成本。
- **`click_browser_element` 返回 `hit.onTarget`**，能诊断「点到了但被遮罩挡住」——
  这是 Playwright 给不了的。

## 2. CDP 能覆盖全部操作吗

**能。下表逐项对应，没有一行是 Playwright 独有的。**

| 能力 | CDP 命令 | 状态 |
| --- | --- | --- |
| 点击 / 输入 / 按键 | `Input.dispatchMouseEvent` / `insertText` / `dispatchKeyEvent` | 已有 |
| 文件上传 | `DOM.setFileInputFiles` | **待补**（已实测可用） |
| 拖拽 | `Input.dispatchDragEvent` | **待补** |
| 悬停 / 滚轮 | `Input.dispatchMouseEvent{ mouseMoved / mouseWheel }` | **待补** |
| JS 弹窗 | `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog` | **待补** |
| 下载 | `Browser.setDownloadBehavior` | **待补** |
| 网络拦截 | `Fetch.enable` / `Network.*` | 存在但未用 |
| 读 DOM / 快照 | `Runtime.evaluate` + `DOM.getDocument` | 已有 |
| 多标签 / iframe | `Target.*` | 部分 |
| 性能指标 | `Performance.getMetrics` | 已有 |
| 设备模拟 | `Emulation.setDeviceMetricsOverride` | 已有 |

Playwright 在 Chromium 上做的每件事，最终都落到这些命令上——它就是封装这一层。
（补充：Firefox / WebKit 走的是它自研的 juggler / WebKit Inspector 协议，不是 CDP。）

## 3. Playwright 的真实价值与代价

### 只有三样东西是 CDP 给不了的

| 价值 | 说明 | Ensemble 是否需要 |
| --- | --- | --- |
| **自动等待** | actionability 轮询（visible / stable / receives events / enabled / editable） | 已有自研版（`buildStabilityExpression`） |
| **跨浏览器** | Chromium / Firefox / WebKit 三家 | 不需要（内置浏览器只面向 Chromium） |
| **Trace / 录制** | `trace.zip` 可回放每步截图、DOM 快照、网络 | 可自己补，成本不低 |

### 代价：它会接管浏览器

`docs/architecture/adr/0001-cdp-over-playwright.md` 论证的是 `launchPersistentContext`：

- 未注册 `dialog` 监听时，`alert / confirm / prompt` **自动 dismiss**，删除确认直接返回 `false`
- 下载默认落到临时目录，context 关闭即删除
- 默认带 `--disable-extensions` / `--disable-sync`
- 文件选择器需要额外接管

**重要修正：`connectOverCDP` 同样会接管，并非只影响 `launch`。**

Playwright 官方文档对 `connectOverCDP` 的原文：

> Connecting over the Chrome DevTools Protocol... **This connection is significantly lower
> fidelity** than the Playwright protocol connection.

GitHub issue **microsoft/playwright#40158** 的实证（用户用自己的日常浏览器连接）：

> Playwright's `Browser.setDownloadBehavior` call **silently reconfigures the entire browser
> context** — including tabs the human opened manually, hours after the automation session
> ended. Downloads land in `/tmp/playwright-artifacts-XXXXX/` instead of `~/Downloads`...
> **The human has no idea anything is wrong.**

这直接否决了「用 `connectOverCDP` 把 Playwright 接进主链路」这条路径：接管是**全局的、
静默的、影响人工标签页的**。

Playwright 后来加了 `noDefaults` 选项避免部分覆盖（`acceptDownloads`、focus emulation
等），但那是**逐项 opt-out**，不是干净的「只当客户端」模式，官方自己也标注为低保真。

## 4. 各层方案细节

### A. 产品主链路：裸 CDP（已采用，不换）

**必须使用真实输入事件**，因为被测页面会检查 `event.isTrusted`，框架依赖真实的
`pointerdown → mousedown → focus → mouseup → click` 序列：

```ts
// ❌ 合成事件：isTrusted = false，很多框架拦
element.click()
element.dispatchEvent(new MouseEvent('click'))

// ✅ CDP：浏览器内部生成，isTrusted = true，与真人操作在渲染器眼里等价
Input.dispatchMouseEvent({ type: 'mousePressed', x, y })
```

待补动作全部在 `docs/engineering/embedded-browser-capability-baseline.md` 的 P1 清单里，
每项都是几十行量级：

| 缺口 | 解法 | 工作量 |
| --- | --- | --- |
| `setFiles` | `DOM.setFileInputFiles` | 小 |
| `hover` | `Input.dispatchMouseEvent{ type: 'mouseMoved' }` | 极小 |
| `scroll` | `Input.dispatchMouseEvent{ type: 'mouseWheel' }` | 极小 |
| `drag` | `mousePressed` → 多次 `mouseMoved` → `mouseReleased` | 小 |
| `dialog` | `Page.javascriptDialogOpening` + `handleJavaScriptDialog` + 超时兜底 | 小 |
| `download` | `Browser.setDownloadBehavior`，区分 agent 标签与用户标签 | 中 |
| `ref` 稳定句柄 | 快照时给元素打标记（`e1..eN`），动作按 ref 定位 | 中 |

**结论：补的是动作覆盖面，不是换引擎。**

### B. AI 跑自定义脚本：决定不做

早先设想过「脚本用 Playwright 起一个独立 profile」，作为无人值守批量任务的出口。
**这个方案已被否决**，理由与主链路那条同源：

- 它必然是**另一个浏览器实例**，与用户正在用的那套账号、凭据、分区毫无关系。
  一个跑在旁路实例里的脚本，看不到用户在 Ensemble 里登录的那个会话，于是「批量
  在我的账号里做点什么」这件事根本做不到。
- 要让脚本进到同一个实例，就只剩 `connectOverCDP`，而它会接管整个浏览器上下文
  （官方标注 *significantly lower fidelity*，`setDownloadBehavior` 会静默改写所有
  标签页的下载路径）。这正是 ADR 0001 否决的那条路。

所以「脚本式编排」的需求由**流程**承担：声明式步骤 + `cdp` 逃生口，跑在用户自己的
页面上，能力边界等于工具集合边界。见
[`browser-action-coverage.md`](./browser-action-coverage.md) §2.1。

### C. 应用自身 E2E：保持裸 CDP，已去重

**现状：60+ 个 `scripts/e2e-*.mjs` 全部使用裸 CDP，零 Playwright 依赖。**

```js
spawn(electron, [".", "--user-data-dir=...", "--remote-debugging-port=0"])
→ 读 <profile>/DevToolsActivePort 拿实际端口
→ new WebSocket(renderer.webSocketDebuggerUrl)
→ send("Runtime.evaluate", { expression, ... })
```

**客户端已经抽成一份**：`scripts/lib/e2e-cdp.mjs` 提供 `connectToWindow` 与
`waitForWindow`。抽取前是 43 个脚本各自内联一份约 27 行的 WebSocket 客户端——
哈希比对的结果是 29 份字节级相同、5 份只差变量名、8 份分属三个近似小组，也就是
**一份实现写成了十个近似副本**。现在改「怎么找目标」「怎么等窗口」只动那一个文件。

**不迁 Playwright**，原因不是「现在也能用」：

1. Playwright 只能连它的启动参数或 `connectOverCDP`，而 E2E 要测的是**已经跑起来的
   这个窗口**里的 Vue 组件；接管它会改变被测环境（对话框、下载、焦点模拟）。
2. 这些脚本断言的多数是内部状态与几何（标签条宽度、toast 位置、stage 矩形），
   Playwright 的定位器抽象帮不上忙，反而是多一层。
3. 引入它意味着一个新的、随版本升级的浏览器依赖，而 ADR 0007 明确不打包浏览器。

注意 E2E 与主链路的**事件语义不同**：

```js
// E2E 用合成事件——它测的是 Ensemble 自己的 Vue 组件，不检查 isTrusted
document.querySelector('[data-nav="browser"]')?.click()
```

这个分工是合理的：主链路测第三方站点必须真实事件，E2E 测自家 UI 合成事件更快更稳。

**迁移收益最大**：E2E 是纯无人值守场景，正好是 Playwright 的舒适区，ADR 0001 也留了口子
（「Playwright 仍可用于管理台自身的无头 E2E 测试，但不进入产品运行时」）。

### D. 非 CDP 浏览器：明确不做

**「用 Playwright 作为非 CDP 浏览器的降级方案」这条不成立，不要写进设计。**

Playwright 只驱动**它自己下载的浏览器版本**，不是系统已装的那份：

| 浏览器 | Playwright 支持 | 说明 |
| --- | --- | --- |
| Chromium / Edge | ✅ | 走 CDP |
| Firefox | ✅ | **它下载的定制版**，自研 juggler 协议 |
| WebKit | ✅ | **它编译的版本**，不是 macOS 的 Safari |
| 系统已装的 Chrome/Firefox/Safari | ❌ | 不驱动 |
| IE / 旧 Edge | ❌ | 不支持 |

也就是说，Playwright 的连接方式**本身就是 CDP 或私有协议**，它救不了「连不上 CDP」这个
场景。真正的保真验证只能人手动测，这是明确的能力边界。

## 5. 待办与决策缺口

### 待办

| 优先级 | 事项 | 影响 |
| --- | --- | --- |
| **P0** | `run_flow` 的 120 秒超时改为可配 | 见下方决策缺口 1 |
| **P1** | 补 6 个动作：`setFiles` / `hover` / `scroll` / `drag` / `dialog` / `download` | AI 无法覆盖全部操作 |
| **P1** | `ref` 稳定句柄（快照产出 `e1..eN`） | 定位稳定性 |
| **P2** | 编排层放开：加 `loop` / `if`，或允许「脚本只做编排、动作仍调工具原语」 | 见下方决策缺口 2 |
| **P2** | E2E 迁 Playwright（消除 60 份内联 CDP 客户端） | 维护成本 |

### 决策缺口 1：流程的 120 秒硬编码

- `src/shared/flows.ts:317` → `export const FLOW_TIMEOUT_MS = 120_000`
- `src/main/mcp/server.ts:2385` → `timeoutMs: 120_000`（MCP 侧写死，schema 里未暴露）

任何「慢操作」类流程（上传大文件、批量导入、长轮询）都必然失败，且上传其实仍在后台跑。
这个值必须进 `run_flow` 的 inputSchema，由调用方指定。

### 决策缺口 2：编排层锁死

`src/shared/flows.ts:35` 的 `FLOW_ACTIONS` 只有 8 个动作：

```
navigate / fill / click / select / press / login / wait / read
```

对比「写脚本」，缺的是：

| 能力 | 现状 |
| --- | --- |
| 循环 | 无。N 个文件要么写 N 组步骤，要么 N 个参数 |
| 条件分支 | 无。只有 `optional: true` 硬闯 |
| 计算 | 无。`{{变量}}` 只做字符串替换 |
| HTTP 断言 | 无。`wait` 只能等 `network-idle`，拿不到状态码 |
| 文件输入 | 无（见 P1） |

`flows.ts` 头部记录了拒绝脚本的三条理由，逐条评估：

| 作者的理由 | 评估 |
| --- | --- |
| 脚本只能派发合成事件，本应用其他动作都走 `Input.dispatch*` | **成立且最重要**，不能为脚本放弃真实事件 |
| 共享工作区里的任意 JS 需要代码审查闸门 | 部分成立，但工具本身已分层（`kind: read/write/run/danger`） |
| 人能读懂、能修、能重排步骤 | **与主要用法冲突**：AI 是主要作者，用户要的是「一句话执行」而非编辑 |

**核心判断：问题不在「声明式」，而在于用声明式的动作层去承担编排层的职责。**
正确的切法是：

```
编排层（循环、条件、计算）  → 应该放开
动作层（真实输入）          → 必须坚持 Input.dispatch*
```

现有设计为守住动作层，把编排层一起锁死了。两种解法：

- **方案 A：加 `loop` / `if` 步骤类型**（声明式编排，流程仍可读可审）
- **方案 B：脚本只做编排，动作仍调工具原语**（脚本能力边界 = 工具集合边界，不比现在宽）

方案 B 更彻底也更容易实现——工具原语已存在，只是把「AI 直接调工具」变成
「AI 写一段调工具的脚本」：

```js
for (const file of files) {
  await tools.setFiles({ tabId, selector: 'input[type=file]', files: [file] })
}
await tools.click({ tabId, text: '确定' })
```

### 决策缺口 3：ADR 0001 需要补充论证

ADR 0001（2026-10-19）只论证了 `launchPersistentContext`，而 ADR 0006（10-22）之后
内置模式已改为 `<webview>` + 进程内 CDP，且 ADR 0006 明确写了「Playwright
`connectOverCDP` 可以直接接管」。

现状是：**ADR 0001 的否决理由对「外部模式」成立，但对「内置模式」的论证不充分**，
这个缺口会被反复问到。

建议补一段，纳入 `connectOverCDP` 的论证：

- 官方文档标注「significantly lower fidelity」
- issue #40158 证明 `setDownloadBehavior` 会静默改写整个浏览器上下文的下载路径
- `noDefaults` 是逐项 opt-out，不是干净的客户端模式

结论不变（主链路不用 Playwright），但理由要更新到覆盖 `connectOverCDP`。

## 6. 本次调研的实测记录

| 事项 | 结果 |
| --- | --- |
| `DOM.setFileInputFiles` 塞入 5 个 4GB 文件 | ✅ 成功，前端读到正确文件名与大小 |
| 假 4GB mp4（追加 `free` box + NTFS 稀疏文件） | ✅ 浏览器读出 `duration = 63.669s`，耗时 15ms，物理占用 3.8MB |
| 硬链接共享同一稀疏文件 | ✅ 5 个「4GB 文件」物理合计 3.8MB |
| 服务端收到上传后是否转码 | ❌ 不转码（被测服务端无转码调用） |

这些实测支撑了「`setFiles` 能解决文件上传场景」的判断，也说明 P1 的 `setFiles` 值得做。

## 7. 相关文件

| 关注点 | 位置 |
| --- | --- |
| CDP 执行器 | `src/main/embedded/cdp.ts` |
| 元素定位与表达式构造 | `src/core/cdp/inspect.ts`（827 行） |
| MCP 工具定义 | `src/main/mcp/server.ts` |
| 流程 schema 与校验 | `src/shared/flows.ts` |
| 流程执行器 | `src/main/embedded/browser.ts` `runFlow()` |
| 能力基线与 P0/P1/P2 清单 | `docs/engineering/embedded-browser-capability-baseline.md` |
| ADR：CDP over Playwright | `docs/architecture/adr/0001-cdp-over-playwright.md` |
| ADR：内置浏览器优先 | `docs/architecture/adr/0006-embedded-browser-first.md` |
| E2E 脚本（60+） | `scripts/e2e-*.mjs`、`scripts/lib/e2e-nav.mjs` |
