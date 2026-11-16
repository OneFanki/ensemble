# 浏览器动作能力改造计划

> **状态（2026-11-16）**：①–⑤、⑦ 已完成并有 e2e 覆盖；② 第四批（网络观察与环境
> 模拟）与 ③（Tab API 句柄形状）未做，⑥ 仍待定。未做的三项都在下面的总表里标着。

> 这份是给人看的：要改什么、为什么改、按什么顺序、哪些不做。
> 具体到函数与参数形状的设计另见 [`../engineering/browser-action-coverage.md`](../engineering/browser-action-coverage.md)。
>
> 触发原因：接入 Ensemble 的 AI 在驱动页面时反复遇到「人能做到、AI 做不到」的操作。
> 当前用户只有两人，改造窗口期合适；使用者增多后，工具形状、流程格式、e2e 断言的
> 变更成本会随调用面一起增长。

## 一、现状：三条并存的路

AI 驱动页面有三条独立路径，**它们互不调用**，各自实现同一批 CDP 命令。

| 路径 | 入口 | 实现在哪 | 现有工具数 |
| --- | --- | --- | --- |
| 单个动作 | MCP 工具（`click_browser_element` 等） | `BrowserManager` | 全部 73 个工具里 31 个与浏览器相关 |
| 流程 | `run_flow` | `runFlow()` 自己重写了一遍 | 8 个动作枚举 |
| 页面脚本 | `evaluate_browser_page` | `Runtime.evaluate` | 1 个 |

三条路里，单个动作与流程**是同一件事的两份实现**。以 `click` 为例：

```
BrowserManager.click()          （browser.ts:3611）
  定位 → clickAt → 读回 hit → 返回 hit 诊断

runFlow 的 click 分支            （browser.ts:3927）
  定位 → clickAt → 读回 hit（.catch 吞掉）→ 丢弃结果
```

几乎逐行相同。差别是流程那份**丢掉了 hit 诊断**，而且没有注释解释为什么吞错误。

这个结构的历史成因：最早（2026-10-22）的第一批 e2e 走的是 MCP 工具，说明当时的
设计是「一个动作一个工具」。流程是后来独立加的，那时没有复用已有实现的约束。

## 二、要改的六件事

### 1. 合并两条路径（前提，纯重构）

`runFlow` 的 `click` / `fill` / `select` 改为调用 `BrowserManager` 已有的方法。
行为不变，流程自动继承 `hit` 诊断、guest 指针前置、导航销毁 context 的处理。

**为什么排第一**：不合并的话，后面每加一个动作都要写两份，且流程那份会持续落后。

### 2. 补齐动作缺口

现在 AI 做不到、但人能做到的动作。完整清单见
[`../engineering/browser-action-coverage.md`](../engineering/browser-action-coverage.md) §3，
按「AI 卡住时最常缺的」分成四批：

| 批次 | 动作 | 缺了会怎样 |
| --- | --- | --- |
| 一 | `hover` | 下拉菜单、tooltip、hover 态菜单打不开 |
| 一 | `scroll` | 长页面、虚拟列表够不到 |
| 一 | `keypress`（组合键） | Ctrl+A、Ctrl+Enter 这类做不了 |
| 一 | `back` / `forward` / `reload` | 只能靠 evaluate 绕 |
| 一 | `dialog` 全套 | 一次 `confirm` 就把页面挂死 |
| 二 | `setFiles` | 上传做不了（CDP 已实测可用） |
| 二 | `drag` | 拖拽排序、看板做不了 |
| 二 | `check` / `uncheck` | 只能靠点击猜 |
| 三 | `elementInfo` / `getAttribute` / `getValue` | 读不了元素细节 |
| 三 | 截图 `clip` / 元素截图 | 只能截整页 |
| 四 | `waitForLoadState` / `waitForResponse` / `getNetwork` | 等不准，拿不到状态码 |
| 四 | 地理位置 / 时区 / 媒体偏好 / 离线 | 环境模拟做不了 |

**不做**：`dispatchEvent`（合成事件）、`Tracing.*`（录制）、
`Browser.*` / `Target.*` / `Storage.*`（破坏隔离）。理由见 coverage §4。

### 3. 定位与动作合一的 Tab API

这是外部借鉴带来的结构改动，也是最大的一项。

**现在的形状**：每次动作都重新定位

```
click_browser_element({ tabId, text: "创建租户" })
  内部：算坐标 → 点击 → 读回
```

问题：两步之间页面重渲染，第二次可能定位到不同元素；观察（`check_element_visible`）
与动作（`click_browser_element`）各写一套定位，无法共享。

**要变成的形状**：先解析成可复用的句柄，再对句柄操作

```
find_element({ tabId, role: "button", name: "创建租户" })  →  句柄 id + 定位信息
click_element({ handle })                                  →  点击
read_element({ handle, what: "text" })                     →  读文本
wait_element({ handle, state: "hidden" })                  →  等状态
```

**借鉴来源**：ZCode 内置浏览器插件的接口设计（调研记录见 §六）。它的
`PlaywrightLocator` 有 32 个方法，其中我们完全没有的是：

- 收窄链：`filter({ has, hasNot, hasText, hasNotText, visible })` + `and` / `or` / `nth` / `first` / `last`
- 同层观察：`innerText` / `textContent` / `getAttribute` / `isVisible` / `isEnabled` / `count`
- `expectNavigation(action, { url })`：把「点完必须发生导航」变成原子断言

**我们的定位形状表达不了**「这个容器里、文字匹配、但排除那个的按钮」，现在只能让 AI
自己写 CSS——而那正是最容易失效的部分。

**不借鉴的**：`playwright` 这个命名（会让人以为用了 Playwright 库）、
它「无差别页面」的模型（我们不区分用户正在看与 AI 开的页面）。

**代价**：这是破坏性变更。31 个浏览器工具里涉及定位的部分形状会变，
`docs/engineering/ai-tools.md` 的契约测试、依赖这些选择器的 e2e 断言都要改。

### 4. 流程里加裸 CDP 步骤（逃生口）

封装不可能覆盖全部。流程要能表达「用协议层命令做一件事」。

**必须做成的样子**：

- 参数是 CDP 方法名 + 参数，在流程 UI 上标为「原始 CDP」
- 命令名走**三档白名单**：
  - 可用：`Input.*`、`DOM.setFileInputFiles`、`Page.handleJavaScriptDialog`
  - 可选（设置项显式开启）：`Network.*`、`Fetch.*`、`Emulation.*`、`Performance.*`
  - 禁止：`Browser.*`、`Target.*`、`Storage.*`、`Page.setWebLifecycleState`
- 一趟流程里出现超过两次时给提示——两次以上通常说明漏了一个该封装的动作

**为什么必须有白名单**：`Target.*` 能附加到任意 target，等价于跨 profile 读数据；
`Browser.setDownloadBehavior` 会改写整个浏览器的下载路径（这正是 ADR 0001 否决
Playwright 的那个行为）。这不是「为了审计而限制」，是必须不可达。

### 5. 流程的编排能力（放开）

现在 `FLOW_ACTIONS` 只有 8 个动作，且没有循环、条件、计算。这属于**编排层**，
跟动作层是两件事。

**动作层锁住是对的**（必须走 `Input.dispatch*`，不能用脚本派发合成事件）。
但现有设计为守住动作层，把编排层一起锁死了。

**两个方案**：

- A：加 `loop` / `if` 步骤类型（声明式，流程仍可读可审）
- B：脚本只做编排，动作仍调工具原语（脚本能力边界 = 工具集合边界）

倾向 B：工具原语已存在，只是把「AI 直接调工具」变成「AI 写一段调工具的脚本」。
A 会让流程格式变复杂，且 `{{变量}}` 的字符串替换要升级成表达式求值。

**另需修**：`run_flow` 的 120 秒超时写死（`shared/flows.ts:317`、
`server.ts:2385`），必须进 inputSchema 由调用方指定。慢操作（上传大文件、
批量导入）现在必然失败且上传仍在后台跑。

### 6. 能力可查询（可选，优先级低）

ZCode 的 `Tab` 对象带 `capabilities` 属性，API 清单里每项标注
`unsupportedByDefaultIn: ["iab"]`。**能力是查询出来的，不是试出来的。**

我们现在把能力写在工具描述的中文长句里。加一个「查询这个标签页支持什么」的工具
可以减少试错，但也多一层间接。**待定**，看前三项做完后 AI 实际的试错率。

### 7. e2e 的 CDP 客户端去重

**这是独立的债，但它卡在 ③ 前面。**

52 个 e2e 脚本里有 45 个各自内联一份约 27 行的 WebSocket CDP 客户端。做了哈希比对：

| 情况 | 脚本数 |
| --- | --- |
| 字节级完全相同 | 29 |
| 只差变量名与一层缩进 | 5 |
| 其余 3 个小组 | 8 |
| 无此函数（走 MCP 或别的方式） | 7 |

也就是说：**不是 45 份不同的实现，是 1 份实现了 10 个近似副本。**

历史上这不是「一开始就没抽」——2026-10-22 的第一批 e2e 走的是 MCP 工具，
后来（2026-11-05）出现了一批要测管理台自身 DOM 的脚本（标签条几何、拖拽、
toast 位置），那些事 MCP 工具做不到，于是从外面连渲染进程直接跑 JS，
然后这份客户端被复制了 45 次。

**为什么必须排在 ③ 之前**：③ 会改掉 60+ 处 e2e 断言里的选择器与调用方式。
如果那时还散着 45 份客户端，改一处要改 45 处；抽成一份之后，改形状只动那一个地方。

**做法**：抽 `scripts/lib/e2e-cdp.mjs`，配一组 `waitFor` / `click` / `type` /
`assertVisible` 辅助，一次性消掉 45 份重复。不引入新依赖。

### 8. 文档合并与整理

浏览器这块现在有 6 份文档在讲同一件事的不同侧面，其中若干结论已经互相冲突：

| 文档 | 现在的问题 |
| --- | --- |
| `engineering/cdp-vs-playwright-boundary.md` | 「B 层：AI 跑自定义脚本用 Playwright 独立 profile（待建）」与现行判断冲突——我们已决定不做。缺 ZCode 调研结论 |
| `engineering/embedded-browser-capability-baseline.md` | 是「迁移到 `<webview>`」的需求基线，迁移已完成；P1/P2 清单已并入 coverage，剩下的历史价值要甄别 |
| `engineering/browser-action-coverage.md` | 与 plan 有重复段落（`isTrusted` 说明、安全分档、四批动作） |
| `engineering/ai-tools.md` | 工具矩阵，③ 改形状后必须同步 |
| `engineering/cdp-playbook.md` | 操作手册，基本无冲突 |
| `plans/browser-action-plan.md` | 本文 |

**目标结构**（每份只答一件事）：

```
coverage   具体哪个 CDP 命令、参数形状、哪些不做      ← 写代码时查
plan       要改什么、为什么、顺序、验收               ← 推进时看
playbook   怎么启动、怎么连、有哪些坑                 ← 操作时查
ai-tools   MCP 工具的档位/闸门/时限/返回形状          ← 加工具时查
```

**要做的**：

- 删掉 `cdp-vs-playwright-boundary.md` 的「B 层待建」，补 ZCode 调研结论与「Ensemble 永远不需要 Playwright」的论证
- `capability-baseline.md` 里已并入 coverage 的清单删掉，只保留仍有效的历史结论（截图矩阵、CDP 风控探测、re-attach 重放、弹窗超时必须）
- 把 coverage 与 plan 的重复段落合并——`isTrusted` 与安全分档只在 coverage 留一份，plan 引用
- 三份文档的交叉引用改成相对链接并逐一验证

**时机**：④ 做完后统一整理一次。现在整理会白做——④ 会新增「裸 CDP 步骤」的说明，那时才定稿。

## 三、顺序与依赖

```
⓪ 抽 e2e 的 CDP 客户端（消掉 45 份重复，约 1 小时）
     ↓
① 合并两条路径（纯重构，零新增能力）
     ↓
② 补齐动作缺口（第一批 → 第四批）
     ↓
③ Tab API 形状改造（破坏性，需要单独一批并同步 ai-tools.md）
     ↓
④ 流程的裸 CDP 步骤 + 白名单
     ↓
⑤ 流程编排能力（方案 B）
     ↓
⑥ 能力可查询（视情况）
     ↓
⑦ 文档合并与整理
```

**⓪ 排在最先**：它是纯机械劳动、零行为变化，但它是 ③ 的前置——见上节。

②③ 的先后可以换。先 ② 的好处是立刻能用；先 ③ 的好处是新增动作直接按新形状做，
不用做两次。**倾向先 ②**：用现有形状把能力补上，让 AI 先用起来，
再根据真实使用反馈确认 ③ 的形状该长什么样。

④ 必须在 ③ 之后：只有先把动作补全，才知道逃生口到底该留多宽。

## 四、每步的验收

| 步骤 | 验收标准 |
| --- | --- |
| ⓪ | 45 份内联客户端归零；`pnpm e2e:all` 结果与改造前一致（同样 50 套全绿） |
| ① | `e2e-flows` 全绿；流程的 click 返回 hit 诊断 |
| ② | 每个新动作有一个 e2e 断言真实生效（不是「工具返回 ok」）；`hover` 要证明菜单真的展开 |
| ③ | `ai-tools.md` 工具清单同步；契约测试更新；60+ e2e 断言迁移完成 |
| ④ | 白名单外的命令被拒；禁止档没有任何入口；两次以上的裸 CDP 给出提示 |
| ⑤ | 一个真实的多文件上传流程能跑完 |
| ⑥ | — |
| ⑦ | 浏览器相关文档不再互相矛盾；同一结论只有一份详细版本；相对链接全部有效 |

## 五、这次改造不动的东西

- **身份隔离**：`persist:embedded-id-<identityId>` 分区、`sandbox` / `contextIsolation` / `nodeIntegration` 三件套
- **AI 权限闸门**：`allowlist` / `denylist` / `allow-all` / `deny-all` 四档，档案页只读
- **凭据不进渲染层**：填充在主进程完成，MCP 永不返回明文密码
- **不打包浏览器**：引擎来自系统安装
- **不引入 Playwright 运行时依赖**：它的浏览器是自下载的定制构建，进不了 `<webview>`，也不带身份隔离

## 六、附：ZCode 的调研结论

调研对象：`%LOCALAPPDATA%/Programs/ZCode/resources/glm/packages/browser-use-plugin`（0.5.1，
可读源码目录，未打进 asar）。

**它的分层**：三个后端（`iab` / `extension` / `cdp`）+ 一层调用面（`Tab`）。
官方文档原话：**"Playwright is a `Tab` API surface, not a backend."**

**它确实没有用 Playwright 库**：

- `playwright-core` 在 `devDependencies`（仅用于测 ZCode 自己的 UI），不在 `dependencies`
- 插件 `node_modules/` 里没有 `playwright-core`
- 编译产物 `browser-client.mjs`（2233 行）零引用

也就是说：**它借用了 Playwright 的 API 词汇，自己实现了那 32 个方法。** 这印证了
「Playwright 适合做产品自身的 E2E，不适合做产品运行时」。

**可直接借鉴的接口形状**（不引入依赖，只学设计）：

| 对象 | 成员数 | 值得抄的 |
| --- | --- | --- |
| `PlaywrightAPI` | 16 | `domSnapshot`、`elementInfo`、`expectNavigation`、`waitForEvent` |
| `PlaywrightLocator` | 32 | 收窄链、同层观察、`setChecked`、`waitFor` |
| `CUAAPI` | 8 | 坐标级兜底：`click` / `double_click` / `move` / `drag` / `scroll` / `keypress` |
| `DomCUAAPI` | 7 | 同上，DOM 粒度 |

**不借鉴**：`playwright` 命名、「无差别页面」的模型。

## 七、待办总表

- [x] ⓪ 抽 `scripts/lib/e2e-cdp.mjs`，消掉 43 份内联 CDP 客户端
- [x] ① 合并 `runFlow` 与 `BrowserManager` 的 `click` / `fill` / `select`
- [x] ② 第一批动作：`hover` / `scroll` / `keypress` / `back`·`forward`·`reload` / `dialog`（`e2e-browser-actions` 11/11、`e2e-browser-dialog` 19/19）
- [x] ② 第二批动作：`setFiles` / `drag` / `check`·`uncheck`（`e2e-browser-form` 17/17）
- [x] ② 第三批动作：`elementInfo` / `getAttribute` / `getValue` / 元素裁剪截图（`e2e-browser-element` 14/14）
- [ ] ② 第四批动作：`waitForLoadState` / `waitForResponse` / `getNetwork` / 环境模拟
- [ ] ③ Tab API 形状改造（句柄 + 收窄链），同步 `ai-tools.md` 与 e2e
- [x] ④ 流程的 `cdp` 步骤类型 + 三档白名单（`flow-whitelist.test.ts` 6/6、`e2e-flow-cdp` 11/11）
- [ ] ⑤ 流程编排能力（方案 B：脚本只做编排）
- [x] ⑤ 修 `run_flow` 的 120 秒写死超时（`timeoutMs` 进 schema，默认 120s、上限 600s；`wait` 步骤受流程剩余预算截断）
- [ ] ⑥ 能力可查询（待定）
- [x] ⑦ 文档合并与整理（`cdp-vs-playwright-boundary` 的 B 层改为「决定不做」、E2E 去重已生效、coverage 状态全部校正）
- [ ] 全程：每个新动作补 e2e，验证真实生效而非「返回 ok」
