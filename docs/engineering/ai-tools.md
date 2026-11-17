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

**`pageTarget` 不是闸门。** 读页面、截图、等待、性能读取和切换页面也会声明它，用途只有两个：
在 AI 操作前把页面静音，以及决定活动记录归属哪个标签页。它不会让一个只读工具获得写权限。

**`hidden: true`** 是旧名字的兼容别名，不广播给客户端，只在直接调用时生效。新代码不要再用。

**时限。** 没有特别说明的工具沿用 CDP 单命令 30 秒上限（`DEFAULT_COMMAND_TIMEOUT_MS`）。
需要更长的工具接受 `timeoutMs`，取值范围由工具自己夹紧。

**参数校验。** 除 `update_settings`（开放键集、自带白名单）外，所有工具在入口拒绝
schema 未声明的参数，报错列出字段名；`hasText` / `hasNotText` / `visible` 是 find
专属收窄字段，传给动作工具会被点名去处。

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
| `list_browser_tabs` | read | — | 无。不返回存储分区；`clean: true` 才是干净会话，`profileId: "default"` 是默认档案 | 标签 id、所属身份、档案、标题、地址、布局、静音/有声 |
| `open_browser_tab` / `open_browser_view` | run | — | 不抬窗口、不切界面；`open_browser_view` 复用已打开的标签页 | `tabId`（或视图容器） |
| `navigate_browser_tab` | run | 是 | 等加载完成。目标须是用户给的地址、已有站点/书签，或当前页的同站链接。被 beforeunload 拦下时快速返回 `cancelled: "beforeunload"`（页面留在原地且可继续操作），用 `handle_browser_dialog` 决定去留 | `{ tab }`；被拦时另有 `cancelled` 与 `note` |
| `close_browser_tab` / `move_browser_tab` / `set_tab_page` | run | — | 只动界面，不影响登录态 | 更新后的浏览器状态 |
| `set_browser_layout` / `pin_browser_tab` / `compose_view` | run / run / write | — | 省略 `viewId` 时作用于台上的视图 | 布局或容器 |
| `set_browser_viewport` / `reset_browser_viewport` | run | 是 | 宽 320–3840、高 320–2160 | 生效后的尺寸 |
| `set_browser_muted` | run | — | 只切换 Ensemble 的输出；页面自己的媒体与 Web Audio 照常运行。不受来源闸门限制，AI 自动静音不会覆盖用户手动取消的静音 | `{ tabId, muted }` |
| `set_browser_emulation` | write | 是 | 每个传入的键独立生效：`timezone`（IANA 名）/ `mediaType`（CSS 媒体类型）/ `offline` / `geolocation`，传 `null` 清除该项。模拟只作用于这一个页面，随标签页关闭丢弃；状态存在 CDP 会话里，与设备模拟同一套会话钉住规则。不授予权限——页面没被用户授权时拿不到地理坐标 | 当前生效的全部模拟项 |

### 内置浏览器 · 观察

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `read_browser_page` | read | — | 只返回可见元素，且只有页面当前渲染出来的那些。读取前先探测页面事件循环：循环已停摆（脚本卡死）时立即报错说明原因，不等到命令上限 | 角色、可访问名称、稳定选择器、位置、表单标签 |
| `read_browser_console` | read | — | **读完即清空**，回答「上次读取之后发生了什么」；看不到跨域 iframe 的请求 | 报错、console 行、失败请求 |
| `read_browser_requests` | read | — | **只读不清空**：读收集器的滚动窗口（最近 50 条已完成的 fetch/XHR），`read_browser_console` 之后仍能读到同一批。可按 `url`（子串）、`method`、`status` 过滤，`limit` 控制条数。看不到跨域 iframe 的请求 | `{ requests: [{at, method, url, status, ms, failed}], inflight, installed }` |
| `read_browser_capabilities` | read | — | 纯查询，不触页面。给 `tabId` 时 `capabilities` 逐项实测表面可选方法（`false` ＝ 宿主未实现，对应工具会报「不支持」），`surface` 是表面标识（内置为 `embedded`）；省略 `tabId` 只返回枚举部分 | `surface` + `capabilities` + `waitConditions` / `flowActions` / `flowCdpStep`；省略 `tabId` 时只有枚举 |
| `wait_browser` | read | — | 条件：`visible` / `hidden` / `text` / `url` / `value` / `network-idle` / `load`（readyState complete）/ `response`（URL 含 `expect` 的响应，可配 `status` 精确匹配；基于滚动窗口 peek，不清空）。`visible` / `hidden` / `value` 可用句柄（`handle`，与定位字段互斥，可配 `nth`；句柄解析一次进轮询，元素被移出 DOM 时报找不到）。`timeoutMs` 默认 5000、上限 60000。超时时 `timedOutAt` 区分 `page`（条件确实没满足）与 `bridge`（页面没按时答复） | `{ ok, waitedMs, timedOut, timedOutAt, reason, matched }` |
| `check_element_visible` | read | — | 可用句柄（`handle`，与定位字段互斥，可配 `nth`；元素被移出 DOM 时报找不到，用 selector 则返回 `exists: false`） | `{ exists, visible, bounds, selector, name }` |
| `find_browser_element` | read | — | 定位给 selector / label / text / role 之一，收窄字段可选：`hasText` / `hasNotText`（元素自身文本包含/不包含）、`visible`、`nth`（0 起，负数从尾数）。text / role 匹配可交互元素与有自身文字的可见元素（纯容器不算）。`timeoutMs` 默认 5000、上限 60000，一个匹配都没等到就报错。登记允许多个匹配（count 如实返回）；选择器无效或 nth 越界立即报错 | `{ handleId, count, index, resolved, matches: [{tag, text, visible, rect}] }`；之后 click / hover / type / `set_browser_checkbox` / `read_browser_element` / `wait_browser` / `check_element_visible` 可用 `handle` 复用 |
| `read_browser_performance` | read | — | 起一个 15 秒后自停的采样器；区间与间隔取自设置 | 逐点样本，`t` 为毫秒偏移 |
| `measure_browser_performance` | read | — | `durationMs` + `idleMs`；连续读取会继续而非重启 | 每项 `{ avg, max, maxAt, last, samples }` |
| `list_browser_init_scripts` | read | — | 只给 id、注册时间与前 120 字预览，不回源码 | `{ scripts: [...] }` |
| `read_browser_element` | read | — | 一个元素的全貌：角色、名称、文字、选择器、位置、可见/可用/聚焦状态、`attributes` 与 `value`。可用句柄（`handle`，与定位字段互斥，可配 `nth`） | 元素信息对象 |
| `read_browser_attribute` | read | — | 给 `names` 读指定属性（不存在返回 `null`）；不给则读文字或当前值。轮询状态变化用它，比整份元素信息便宜 | `{ ok, selector, attributes }` 或 `{ ok, selector, value/text }` |

### 内置浏览器 · 操作

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
<<<<<<< HEAD
| `click_browser_element` | run | 是 | 真实鼠标事件；先滚动到可见；返回 `hit` 说明事件实际落点。点击触发 alert/confirm 时命令在弹窗打开瞬间提前返回，`dialog` 带类型与内容、`hint` 指引先答弹窗（页面与弹窗保持原样，不重试点击）。直连定位命中多个时仍点第一个，`warning` 写明匹配数（句柄与显式 `nth` 不产生）。可用句柄（`handle`，与定位字段互斥，可配 `nth`；命中多个且无法归属时报「匹配 N 个」） | `{ ok, tag, text, selector, warning?, hit }`；触发弹窗时另有 `dialog` 与 `hint`（hover / scroll / type / press / upload / drag / checkbox 同） |
| `hover_browser_element` | run | 是 | 真实鼠标移动（不发按下），打开只在悬停时出现的菜单与 tooltip。直连多匹配同 click（`warning`）。可用句柄（同上） | `{ ok, tag, text, selector, warning? }` |
| `scroll_browser_page` | run | 是 | 给 target 时滚轮落在该元素中心，可滚嵌套容器；`deltaY` 正数向下。target 多匹配时滚轮仍落第一个（`warning`） | `{ ok, scrolled, moved, warning? }`，`moved: false` 表示已到边界 |
| `press_browser_keys` | run | 是 | 组合键写作 `Control+a`；修饰键先按下、再主键、逆序抬起 | `{ ok, keys, modifiers }` |
| `read_browser_dialog` | read | — | 从主进程的事件记录读，**不走页面脚本**——弹窗打开时页面是阻塞的，任何页内查询都会超时。`pageBlocked: false` 表示 beforeunload 拦截：页面活着，只缺一个去留决定 | `{ dialog: { type, message, defaultPrompt?, url?, msOpen, pageBlocked, hint } }` 或 `{ dialog: null }` |
| `handle_browser_dialog` | run | 是 | `accept: false` 为取消；prompt 用 `promptText` 填值。beforeunload 拦截也在这里答：`accept: true` 重发被拦的导航并等它完成，`false` 留下。没有弹窗时报 `handled: false` 而不是错。无人应答的弹窗超预算后自动取消（唯一会自动应答弹窗的路径；工具超时一律不动弹窗）；挂起期间 CDP 会话保持附加，不会分离 | `{ ok, handled, type? }` |
=======
| `click_browser_element` | run | 是 | 真实鼠标事件；先滚动到可见；`hit` 以按下瞬间为准（onTarget 只在按下与回读都 miss 才 false），`hitAfter` 是松开后的回读，页面在点击处理里替换 DOM 时两者不同。直连定位命中多个时仍点第一个，`warning` 写明匹配数（句柄与显式 `nth` 不产生）。可用句柄（`handle`，与定位字段互斥，可配 `nth`；命中多个且无法归属时报「匹配 N 个」） | `{ ok, tag, text, selector, warning?, hit, hitAfter? }` |
| `hover_browser_element` | run | 是 | 真实鼠标移动（不发按下），打开只在悬停时出现的菜单与 tooltip。直连多匹配同 click（`warning`）。可用句柄（同上） | `{ ok, tag, text, selector, warning? }` |
| `scroll_browser_page` | run | 是 | 给 target 时滚轮落在该元素中心，可滚嵌套容器；`deltaY` 正数向下。target 多匹配时滚轮仍落第一个（`warning`）。`scrolled` 是动作后回读容器位置得到的真实位移差值，等待滚动稳定后才读 | `{ ok, scrolled, moved, warning? }`，`moved: false` 表示没滚（含已到边界） |
| `press_browser_keys` | run | 是 | 组合键写作 `Control+a`；修饰键先按下、再主键、逆序抬起。常见编辑组合（Ctrl+a/c/x/v/z、Ctrl+Shift+z）随 keyDown 派发 Chromium 编辑命令，效果对后续输入可见 | `{ ok, keys, modifiers }` |
| `read_browser_dialog` | read | — | 从主进程的事件记录读，**不走页面脚本**——弹窗打开时页面是阻塞的，任何页内查询都会超时 | `{ dialog: { type, message, defaultPrompt?, url?, msOpen } }` 或 `{ dialog: null }` |
| `handle_browser_dialog` | run | 是 | `accept: false` 为取消；prompt 用 `promptText` 填值。没有弹窗时报 `handled: false` 而不是错。弹窗挡路超过 30 秒会被自动取消 | `{ ok, handled, type? }` |
>>>>>>> wt/action-truth
| `upload_browser_files` | run | 是 | 绝对路径；多个文件必须一次给（每次调用替换输入框内容）。单文件框给多个会报错而不是截断。定位多匹配同 click（`warning`） | `{ ok, count, multiple, selector?, warning? }` |
| `drag_browser_element` | run | 是 | `from` / `to` 各自 `fromSelector`·`fromText`、`toSelector`·`toText`。真实按下 + 六次中间移动 + 松开。动作后回读页面：`dropped` 说明页内是否收到 drop（`dropAt` 坐标、`droppedAtTarget` 是否落在终点附近、`reordered` 起点元素位置是否变化），缺失或坐标异常时 `warning` 说明，不算成功。任一端多匹配时仍取第一个，`warning` 写明 | `{ ok, fromTag, toTag, fromText, toText, dropped, dropAt?, droppedAtTarget, reordered?, warning? }` |
| `set_browser_checkbox` | run | 是 | 幂等：已在目标状态就不点。`stuckAt` 表示点了但状态没变（禁用或有处理器拦默认行为）。直连多匹配同 click（`warning`）。可用句柄（同 click） | `{ ok, checked, changed, selector?, stuckAt?, warning? }` |
| `go_back_browser_tab` | run | 是 | 无可后退历史时什么也不发生 | `{ ok }` |
| `go_forward_browser_tab` | run | 是 | 无可前进历史时什么也不发生 | `{ ok }` |
| `reload_browser_tab` | run | 是 | `ignoreCache: true` 等价 Ctrl+Shift+R，绕过 HTTP 缓存 | `{ ok }` |
| `type_browser_text` | run | 是 | 先聚焦、清空再逐字输入；密码框返回 `secret: true`。目标是 select 时直接报错，select 用 fill_browser_form。直连多匹配同 click（`warning`）。可用句柄（同 click） | `{ ok, selector, secret?, warning? }` |
| `fill_browser_form` | run | 是 | 逐字段真实输入；select 字段按 option 文字或值精确匹配（trim 后全等，无子串），匹配不到进 `failed` 带原因与可选项；两个不同定位解析到同一控件时第二个进 `failed`，不串写。其余字段继续填。某字段定位多匹配时仍填第一个，该字段条目带 `warning` | `{ ok, filled: [{field, selector?, secret?, warning?}], failed: [{field, reason}] }` |
| `fill_browser_login` | run | 是 | 密码留在主进程，跨域页面拒绝 | 填充结果 |
| `run_flow` | run | 是 | 步骤失败即停并说明原因。`timeoutMs` 默认 120000、上限 600000，由调用方指定——慢操作必须显式给大一点。`wait` 步骤会被流程剩余预算截断，超时时报的是「流程超过 N 秒」而不是「条件没满足」。`script` 步骤在 vm 里编排动作原语（不含 login/cdp），整段受同一个预算约束，到点报「脚本超时」 | 每步结果与变量；用了原始 CDP 时多一个 `rawCdp` 列表，超过两次附带 `note` |
| `screenshot_browser_tab` | run | — | `timeoutMs` 默认 15000、上限 60000。超时返回 `reason: "page-busy"` 而不是报错。给 `selector`/`elementText`/`role` 时只截该元素（裁剪到元素范围；元素在视口外直接报错，不回退成整页图） | `{ path, bytes, data? }` 或 `{ ok: false, timedOut, reason }` |
| `evaluate_browser_page` | run | 是 | `timeoutMs` 默认 30000、上限 300000。超时返回 `{ timedOut: true, stillRunning: true }`，不是 `isError` | 表达式的值，或超时结构 |
| `cancel_browser_script` | run | 是 | 发 `Runtime.terminateExecution`。只能打断正在执行的代码；停在 Promise 上的脚本之后仍会继续 | `{ ok, note }` |
| `add_browser_init_script` | run | 是 | **对当前文档不生效**，从下一次导航起生效。脚本随标签页存在 | `{ ok, scriptId, affects: "next-navigation" }` |
| `remove_browser_init_script` | run | 是 | 下一次导航起不再执行；当前文档里已跑过的不受影响 | `{ ok: true }` |

**元素句柄。** `find_browser_element` 返回的 `handleId` 只在本标签页内有效。它是
定位描述符的持久化，不是节点身份：每次使用都在当前文档里重新解析定位，页面重渲染
后仍指向同一逻辑元素——定位命中多个时，按登记（或上次成功命中）那一项的文本特征
对齐，对不齐就报「匹配 N 个，给 nth 或加收窄」，不猜。标签页发生跨文档导航（含
刷新）后句柄整体失效，再用报「页面已导航，句柄失效，请重新 find」；SPA 的页内
路由不换文档，句柄继续有效。

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
