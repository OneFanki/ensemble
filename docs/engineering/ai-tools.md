# AI 工具能力矩阵

> MCP 端点上每个工具的档位、闸门、时限与返回形状。改工具前先读这张表；改完工具必须同步
> 这张表——`tests/contracts/ai-tools-doc.test.ts` 会检查两边的工具集合完全一致。

## 0. 怎么读这张表

**档位（`kind`）决定默认权限。** 用户在设置页可以为每一档单独开关，四档是累加的底线，
不是互斥等级：

| 档位 | 含义 | 典型工具 |
| --- | --- | --- |
| `read` | 只读。不改工作区、不动页面。 | `list_*`、`read_browser_page`、`wait_browser` |
| `write` | 改工作区数据（站点、身份、视图、书签、设置）。 | `create_*`、`update_*`、`save_*` |
| `run` | 驱动浏览器：启动窗口、操作内置页面、跑流程。 | `launch_*`、`open_browser_*`、`click_browser_element` |
| `danger` | 删除且不可撤销。一律要求 `confirm: true`。 | `delete_*` |

`run` 同时覆盖「启动窗口」与「操作内置页面」，因为两者在用户眼里是同一件事：让 AI 去
操作浏览器。把它们拆成两档会让权限面板出现一个没人能解释的选项。

**闸门（`inputTarget`）。** 声明了这个字段的工具会先经过 AI 来源策略：只有页面所在站点在
允许名单里（或本次已授权）才会执行。判定只看站点 origin，档案与账号只作为记录里的上下文。
未声明闸门的 `run` 工具不接触被测页面内容——它们操作的是窗口、布局或标签条。

**`hidden: true`** 是旧名字的兼容别名，不广播给客户端，只在直接调用时生效。新代码不要再用。

**时限。** 没有特别说明的工具沿用 CDP 单命令 30 秒上限（`DEFAULT_COMMAND_TIMEOUT_MS`）。
需要更长的工具接受 `timeoutMs`，取值范围由工具自己夹紧。

## 1. 总表

### 工作区（不接触页面）

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `get_workspace_summary` | read | — | 无 | 站点 / 身份 / 视图 / 运行中实例的数量与名称 |
| `update_settings` | write | — | 无。凭据、密钥库、MCP 端口与令牌不接受修改 | 改动后的键值 |
| `list_sites` / `list_site_tags` / `list_identities` / `list_views` / `list_flows` / `list_layouts` / `list_bookmarks` | read | — | 无 | 对应集合；`list_identities` 永远不含密码 |
| `create_site` / `update_site` / `create_identity` / `create_identities` / `update_identity` / `link_identities_to_site` / `set_password` | write | — | 无。密码只写不读，返回值里没有明文字段 | 新建或更新后的对象，`create_identities` 额外带 `failures` |
| `detach_identity_reference` | write | — | 无。已经是独立身份时无变化 | 断开后的身份 |
| `create_view` / `update_view` / `set_view_layout` / `create_layout_preset` / `copy_view_to_site` | write | — | 无 | 视图或预设 |
| `save_flow` / `save_tag` / `save_bookmark` | write | — | 无 | 保存后的对象 |
| `save_site_tag` | write | — | `save_tag` 的旧名称，行为相同；不广播给客户端 | 同 `save_tag` |
| `delete_site_tag` | danger | — | `delete_tag` 的旧名称，同样要求 `confirm: true`；不广播给客户端 | `{ ok: true }` |
| `export_accounts` / `import_accounts` / `preview_accounts` | write / write / read | — | `export_accounts` 只有传 `passphrase` 才带密码；返回值永不含明文 | 文件路径与数量 / 合并结果 / 预演结果 |
| `delete_tag` / `delete_flow` / `delete_bookmark` / `delete_identity` / `delete_view` / `delete_site` | danger | — | 必须 `confirm: true` | `{ ok: true }` |

### 外部浏览器（保真校验路径）

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `launch_view` / `launch_identity` / `launch_clean_session` | run | — | 启动即返回，不等登录完成 | 实例 id 与启动结果 |
| `stop_all` / `stop_instance` | run | — | 只按自有 profile 路径归属清理，不按进程名批量杀 | `{ ok: true }` |
| `check_auth` | run | — | 无 | 是否仍登录、原因 |

### 内置浏览器 · 标签与布局

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `list_browser_tabs` | read | — | 无 | 标签 id、所属身份、标题、地址、布局 |
| `open_browser_tab` / `open_browser_view` | run | — | 不抬窗口、不切界面；`open_browser_view` 复用已打开的标签页 | `tabId`（或视图容器） |
| `navigate_browser_tab` | run | 是 | 等加载完成。目标须是用户给的地址、已有站点/书签，或当前页的同站链接 | 导航后的地址与标题 |
| `close_browser_tab` / `move_browser_tab` / `set_tab_page` | run | — | 只动界面，不影响登录态 | `{ ok: true }` |
| `set_browser_layout` / `pin_browser_tab` / `compose_view` | run / run / write | — | 省略 `viewId` 时作用于台上的视图 | 布局或容器 |
| `set_browser_viewport` / `reset_browser_viewport` | run | 是 | 宽 320–3840、高 320–2160 | 生效后的尺寸 |

### 内置浏览器 · 观察

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `read_browser_page` | read | — | 只返回可见元素，且只有页面当前渲染出来的那些 | 角色、可访问名称、稳定选择器、位置、表单标签 |
| `read_browser_console` | read | — | **读完即清空**，回答「上次读取之后发生了什么」；看不到跨域 iframe 的请求 | 报错、console 行、失败请求 |
| `wait_browser` | read | — | `timeoutMs` 默认 5000、上限 60000。超时时 `timedOutAt` 区分 `page`（条件确实没满足）与 `bridge`（页面没按时答复） | `{ ok, waitedMs, timedOut, timedOutAt, reason, matched }` |
| `check_element_visible` | read | — | 无 | `{ exists, visible, bounds, selector, name }` |
| `read_browser_performance` | read | — | 起一个 15 秒后自停的采样器；区间与间隔取自设置 | 逐点样本，`t` 为毫秒偏移 |
| `measure_browser_performance` | read | — | `durationMs` + `idleMs`；连续读取会继续而非重启 | 每项 `{ avg, max, maxAt, last, samples }` |
| `list_browser_init_scripts` | read | — | 只给 id、注册时间与前 120 字预览，不回源码 | `{ scripts: [...] }` |

### 内置浏览器 · 操作

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `click_browser_element` | run | 是 | 真实鼠标事件；先滚动到可见；返回 `hit` 说明事件实际落点 | `{ ok, tag, text, selector, hit }` |
| `type_browser_text` | run | 是 | 先聚焦、清空再逐字输入；密码框返回 `secret: true` | `{ ok, selector, secret? }` |
| `fill_browser_form` | run | 是 | 逐字段真实输入；某字段失败即停，不留半填表单 | `{ ok, filled }` |
| `fill_browser_login` | run | 是 | 密码留在主进程，跨域页面拒绝 | 填充结果 |
| `run_flow` | run | 是 | 步骤失败即停并说明原因；`timeoutMs` 由流程自带 | 每步结果与变量 |
| `screenshot_browser_tab` | run | — | `timeoutMs` 默认 15000、上限 60000。超时返回 `reason: "page-busy"` 而不是报错 | `{ path, bytes, data? }` 或 `{ ok: false, timedOut, reason }` |
| `evaluate_browser_page` | run | 是 | `timeoutMs` 默认 30000、上限 300000。超时返回 `{ timedOut: true, stillRunning: true }`，不是 `isError` | 表达式的值，或超时结构 |
| `cancel_browser_script` | run | 是 | 发 `Runtime.terminateExecution`。只能打断正在执行的代码；停在 Promise 上的脚本之后仍会继续 | `{ ok, note }` |
| `add_browser_init_script` | run | 是 | **对当前文档不生效**，从下一次导航起生效。脚本随标签页存在 | `{ ok, scriptId, affects: "next-navigation" }` |
| `remove_browser_init_script` | run | 是 | 下一次导航起不再执行；当前文档里已跑过的不受影响 | `{ ok: true }` |

## 2. 超时与中止

**同一个「超时」曾经混着三种意思**，这是这份文档存在的主要原因之一。

| 现象 | 真正的含义 | 调用方该做什么 |
| --- | --- | --- |
| `evaluate_browser_page` 返回 `timedOut` + `stillRunning` | 我们停止等待了，页面里的脚本可能还在跑 | 用 `wait_browser` 观察结果出现，或 `cancel_browser_script` 尝试中止，或直接接着做别的事 |
| 工具抛错（`isError`） | 页面真的抛了异常或能力不存在 | 读错误信息，通常该改写脚本或换工具 |
| `wait_browser` 的 `timedOutAt: "page"` | 页内轮询跑满了预算，条件确实没成立 | 看 `reason`（`url-mismatch` / `text-absent` / `still-visible` …）判断是等错东西还是时限太短 |
| `wait_browser` 的 `timedOutAt: "bridge"` | 页面根本没按时答复，页内循环连一轮都没回来 | 页面被节流、冻结或卡住；重试同样的条件通常还是一样，应该先确认页面是否活着 |
| `screenshot_browser_tab` 的 `reason: "page-busy"` | 时限内没有产出画面 | 稍后重试，或先 `wait_browser` 等页面安静 |

**为什么超时不算失败。** `withDeadline`（`src/shared/async.ts`）只负责停止等待，不取消
原 promise——取消不了。所以「超时」这件事的事实是「我们不再等了」，不是「它失败了」。
把它报成 `isError` 会让客户端重试一个仍在运行的脚本，或者以为工具坏了。

**`cancel_browser_script` 的边界。** `Runtime.terminateExecution` 展开当前调用栈，能救出
死循环；但脚本停在 `await` 上时那一刻并没有执行，Promise 一解决它照样继续。这是设计上
的尽力而为，不是缺陷。

**CDP 单命令 30 秒上限与工具时限的关系。** `evaluate_browser_page` 的 `timeoutMs` 会一路
传到 `EmbeddedCdp.send`，覆盖默认的 30 秒，而不是在它之上再套一层。反过来，在 guest
路由外面再包一层 deadline 会让 `GuestSessions` 的 in-flight 计数提前归零——会话在命令
还在飞的时候被释放，`guest-sessions.ts` 记录了这会段错误。

## 3. 文档级脚本注入

**为什么需要它。** `evaluate_browser_page` 是在页面自己的 JS 已经跑完之后才执行。要在页面
的代码之前安装钩子——包装 `VideoDecoder`、改写一个模块作用域里读取的 `window` 属性、装一个
加载时立即启动的定时器——只能靠 `Page.addScriptToEvaluateOnNewDocument`。

**生效时机。** 注册之后，**下一次导航**开始生效；当前文档不受影响。返回值里的
`affects: "next-navigation"` 就是这个事实，不是保留字段。

**会话钉住的代价。** 注册活在 CDP 会话里，而 guest 会话空闲 1.5 秒就 detach（反自动化
检测会把长命会话当成可疑）。所以只要一个标签页上有脚本注册，它的会话就被钉住不再释放，
可探测性也随之上升。这与设备模拟、性能采样是同一类代价，三者共用
`EmbeddedBrowser.syncSessionHold` 这一个判据。

**节点重建。** 渲染层可能替换一个标签页的节点（布局变更、embedder 重载），新 guest 没有
任何注册。`BrowserGuestManager` 的 `onSessionOpen` 会按 tab 重放脚本列表，`createdAt` 保持
原值，只有 id 会变——所以列表读出来的时间不会假装是刚加的。

**边界。** 脚本不跨标签页、不跨重启；标签页关闭即消失。它执行在不挂 preload、开启
sandbox 的被测页面里，因此拿不到任何主进程能力——和 `evaluate` 是同等的权限，不是更高。

## 4. 没有提供的能力

`docs/engineering/embedded-browser-capability-baseline.md` 列着与 Playwright 系工具面的
对照，以及每一项当前是「有 / 部分 / 缺」。那份文档是需求基线，这里不重复维护同一份清单。
