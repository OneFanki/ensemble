# AI 工具能力矩阵

> MCP 端点上每个工具的档位、闸门、时限与返回形状。改工具前先读这张表；改完工具必须同步
> 这张表——`tests/contracts/ai-tools-doc.test.ts` 会检查两边的工具集合完全一致，
> `tests/contracts/tool-surface.test.ts` 检查命名与入参约定。

## 0. 怎么读这张表

**档位（`kind`）决定默认权限。** 用户在设置页可以为每一档单独开关，四档是累加的底线，
不是互斥等级：

| 档位 | 含义 | 典型工具 |
| --- | --- | --- |
| `read` | 只读。不改工作区、不动页面。观察类工具都在这一档，包括截图。 | `list_*`、`read_browser_page`、`wait_browser_condition`、`screenshot_browser_tab` |
| `write` | 改工作区数据（站点、账号、视图、流程与书签的定义、设置）。 | `create_*`、`update_*`、`save_*`、`compose_view` |
| `run` | 驱动浏览器：开关页面与窗口、操作内置页面、跑流程、改页面所处的环境。 | `open_browser_*`、`launch_external_browser`、`click_browser_element`、`set_browser_emulation` |
| `danger` | 删除工作区数据且不可撤销。一律要求 `confirm: true`，也只有这一档叫 `delete_*`。 | `delete_*` |

`run` 同时覆盖「开窗口」与「操作内置页面」，因为两者在用户眼里是同一件事：让 AI 去操作
浏览器。页面所处的环境（视口、时区、断网、设备模拟）与视口是同族，都归 `run`；它们不碰
工作区数据。`remove_browser_init_script`、`detach_identity_credentials` 撤销的是页面级或
可重建的东西，不是工作区数据，所以不叫 `delete_*`、也不进 `danger` 档。

**闸门（`inputTarget`）。** 声明了这个字段的工具会先经过 AI 来源策略：只有页面所在站点在
允许名单里（或本次已授权）才会执行。判定只看站点 origin，身份与账号只作为记录里的上下文。
凡是会丢弃页面状态或往页面里输入的工具都过这道闸：点击、输入、前进后退、**刷新**、执行
脚本。未声明闸门的 `run` 工具不接触被测页面内容——它们操作的是窗口、布局或标签条。

**`pageTarget` 不是闸门。** 读页面、截图、等待、性能读取和切换页面也会声明它，用途只有两个：
在 AI 操作前把页面静音，以及决定活动记录归属哪个标签页。它不会让一个只读工具获得写权限。

**内置与外部是两族工具。** 页面工作全部在内置浏览器里：`open_browser_*` 与 `*_browser_*`
只管内置，AI 读得到、点得动。外部系统浏览器只由 `launch_external_browser` 一族负责，
窗口给人看或用来确认页面在真实浏览器里表现一致，AI 驱动不了。

**省略 `tabId` 的含义。** AI 开的页面不上台、不认领「激活页」（后台开页不能抢走用户正在看
的内容），所以省略 `tabId` 不表示「激活页」，而是 **AI 最近打开且仍开着的那个页面**；AI 没有
自己的页面时才是用户正在看的页面，之后依次是台上视图第一格、页面列表第一个。规则在
`resolveDefaultTabId`（`src/shared/embedded.ts`）。要操作用户正在看的页面必须点名它的 id
（`list_browser_tabs` 里 `active: true`）。

**带账号开页时的登录。** `open_browser_tab` 带账号打开时，未登录的页面会先被带到登录页，
所以返回值里有 `login`：`signed-in`（页面就在要求的地址上）、`signing-in`（正在填表并提交，
之后回到要求的地址）、`login-form`（表单填好但不提交，站点关着自动提交）、`unknown`
（站点没配登录检测）。登录完成后页面回到**调用方点名的地址**，不是账号起始页。

**`viewId` 接受两种 id。** 要 `viewId` 的工具（`set_browser_layout` / `pin_browser_tab` /
`move_browser_tab` / `close_browser_view`）既认 `list_browser_tabs` 的 `views` 里已打开视图的
容器 id，也认 `list_views` 里保存的视图定义 id；同一个定义只开一个容器，多个时台上的优先
（`findViewContainer`）。

**入参名把对象写在名字里。** 调用方手里同时有几种 id，所以入参一律是 `identityId` /
`siteId` / `viewId` / `flowId` / `bookmarkId` / `tabId`，没有裸 `id`，页面也不叫 `pageId`；
`set_password` 用 `siteId` 或 `identityId` 点名密码属于谁。旧名字作为别名仍然接受
（见下面的对照表），别名与规范名同给且都有值时在入口拒绝。

**返回形状只有三种。** 列表类一律返回以集合名包装的对象（`{ sites }`、`{ identities }`、
`{ views }`…），不返回裸数组；动作类返回 `{ ok: true, …事实 }`，没做成时 `{ ok: false, reason,
note }` 而不是报错（重复关闭、超时）；查询与读写对象类直接返回对象。页面摘要里以页面为主的
结果在顶层带 `tabId`。

**名字猜错了有指路。** 工具名对不上时，报错里给出最相近的几个名字（`unknown tool: close_tab
。没有这个名字的工具；你是不是想调用：close_browser_tab`）；参数名对不上时点名该工具真正的
字段（`name（该工具没有这个参数；你是不是想传 names）`）。

**旧名字对照。** 改过名的工具保留旧名字作为兼容别名：不再出现在 `tools/list` 里，直接调用
照常可用，档位与闸门跟着规范名字走。

| 旧名字 | 现在的名字 | 变化 |
| --- | --- | --- |
| `launch_view` / `launch_identity` / `launch_clean_session` | 内置：`open_browser_view` / `open_browser_tab`；外部：`launch_external_browser` | 旧名字不传 `external` 时行为不变；传 `external: true` 转交给 `launch_external_browser`，返回形状随它 |
| `stop_instance` / `stop_all` | `stop_external_browser` / `stop_all_external_browsers` | 返回改为 `{ ok, … }` |
| `check_auth` | `check_identity_auth` | 先看内置页面 |
| `set_tab_page` | `activate_browser_tab` | 入参 `pageId` 改为 `tabId` |
| `wait_browser` | `wait_browser_condition` | — |
| `check_element_visible` | `check_browser_element_visible` | — |
| `export_accounts` / `import_accounts` / `preview_accounts` | `export_identities` / `import_identities` / `preview_identities` | — |
| `detach_identity_reference` | `detach_identity_credentials` | — |
| `set_view_layout` | `update_view`（传 `viewId` 与 `layoutId`） | 两者本来改的就是同一份视图定义 |
| `update_site.id` / `update_identity.id` / `update_view.id` / 各 `delete_*.id` / `save_flow.id` / `save_bookmark.id` / `run_flow.id` | `siteId` / `identityId` / `viewId` / `flowId` / `bookmarkId` | `id` 仍接受 |
| `set_password` 的 `ownerKind` + `ownerId` | `siteId` 或 `identityId` | 旧写法仍接受 |
| `move_browser_tab` 的 `beforeOrAfter` | `anchorTabId` | 两者装的都是参照标签页的 id；旧名字不再需要一句「字段名沿用旧版」来解释 |

`create_*` 与 `update_*` 分开的是有必填字段的对象；流程与书签没有必填的创建字段，所以是
`save_*` 一步到位（省略 id 新建，给 id 则更新）。

**时限。** 没有特别说明的工具沿用 CDP 单命令 30 秒上限（`DEFAULT_COMMAND_TIMEOUT_MS`）。
需要更长的工具接受 `timeoutMs`，取值范围由工具自己夹紧，并在参数说明里写明上限。

**参数校验。** 除 `update_settings`（开放键集、自带白名单）外，所有工具在入口拒绝
schema 未声明的参数，报错列出字段名；`hasText` / `hasNotText` / `visible` 是 find
专属收窄字段，传给动作工具会被点名去处。

**用词。** 与界面一致：站点下的条目叫**账号**（工具名里的 `identity`）；没有账号的页面所在
的隔离容器叫**身份**——默认身份、一次性干净身份、自建身份；登录与否叫**登录状态**。

## 1. 总表

### 工作区（不接触页面）

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `get_workspace_summary` | read | — | 无 | `sites`（每个站点带 `identities`：仅 id、name、username，不含密码；单站点超过 20 个账号只带前 20 个并标 `identitiesTruncated`）、`views`（数量）、`running`（外部浏览器窗口）、`browser`（内置浏览器：`available`、`activeTabId`、`tabs` [id、title、url、identityId?、viewId?、active]，超过 30 个只带前 30 个并标 `tabsTruncated`；`views` [id、name、layoutId]）、`layoutPresets`。没有内置浏览器的宿主 `browser.available` 为 false |
| `update_settings` | write | — | 无。凭据、密钥库、MCP 端口与令牌不接受修改。枚举类设置项的取值写在参数说明里（布局、默认引擎、搜索引擎、新标签页背景） | `{ updated }`：被改动的键及其新值 |
| `list_sites` / `list_identities` / `list_views` | read | — | 无。`list_identities` 永远不含密码 | `{ sites }` / `{ identities }` / `{ views }` |
| `list_flows` / `list_bookmarks` / `list_layouts` / `list_browser_engines` | read | — | 无。`list_flows`：流程多于 50 条时返回前 50 条并标 `truncated`，步骤值截断到前 200 字符、步骤多于 60 条截到 60 并标 `stepsTruncated`（`run_flow` 用完整定义，不受预览截断影响）。`list_bookmarks` 不回传图标内容，只有 `hasFavicon` 标记。`list_layouts` 只列 `free`（与 `1x1` 等价，两个 id 都接受）。`list_browser_engines`：`status` 为 `ready` 的才能用来启动，`blocked` 的看 `blockReason`；引擎还在探测时带 `note` | `{ flows, total }` / `{ bookmarks, folders }` / `{ builtin, custom }` / `{ engines, note? }` |
| `resolve_browser_target` | read | — | 无 | 给定 `url` 返回该用哪个账号打开：`matched`、匹配的 `site`（id/name/baseUrl）、该站点账号列表（仅 id/name/username/role/startPath，不含密码）、`recommendedIdentityId`（传入的 `identityId` 属于该站点时回显它，否则取该站点第一个）、可执行的 `nextStep`；传入的 `identityId` 不属于匹配站点时带 `warning`，且 `nextStep` 把两条路都列出（换用该站点的账号，或坚持用点名的那个），无匹配站点时不带 `site` |
| `create_site` / `update_site` / `create_identity` / `create_identities` / `update_identity` / `link_identities_to_site` | write | — | 无。`update_identity` 只传要改的字段，`extraFields` 传数组即替换（`[]` 清空）。密码只写不读，返回值里没有明文字段 | 新建或更新后的对象；`create_identities` 另带 `failures`；`link_identities_to_site` 返回 `{ ok, siteId, linked, requested }` |
| `set_password` | write | — | 无。传 `siteId` 写站点默认密码，传 `identityId` 写账号自己的密码，两者给且只给一个。账号原本「继承站点密码」或「引用别的账号的密码」时，写完后改为使用自己的密码 | `{ ok, siteId }` 或 `{ ok, identityId, passwordMode?, note? }` |
| `detach_identity_credentials` | write | — | 无。已经是独立账号时无变化 | 解除引用后的账号 |
| `create_view` / `update_view` / `create_layout_preset` / `copy_view_to_site` | write | — | 无。`update_view` 改名称、成员、布局或槽位分配，只传要改的字段 | 视图或预设 |
| `save_flow` / `save_bookmark` | write | — | 无。`save_flow` 的步骤值截断（同 `list_flows`）、超 60 步截到 60 并标 `stepsTruncated`；`save_bookmark` 的 `url` 必填（改名时也带当前地址），返回 `hasFavicon` 而非图标内容 | 保存后的对象 |
| `export_identities` / `import_identities` / `preview_identities` | write / write / read | — | `export_identities` 只有传 `passphrase` 才带密码；返回值永不含明文 | 文件路径与数量 / 合并结果 / 预演结果 |
| `delete_flow` / `delete_bookmark` / `delete_identity` / `delete_view` / `delete_site` | danger | — | 必须 `confirm: true`。`delete_site` 连带其下全部账号、视图与凭据 | `{ ok: true, deleted: id }` |

### 外部浏览器（给人看 / 保真校验）

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `launch_external_browser` | run | — | 在用户的系统浏览器里开窗口，三选一：`identityId` 为这个账号开一个窗口；`viewId` 让视图的每个成员各开一个窗口；都不传则开一个一次性干净窗口（给 `siteId` 时打开该站点登录页）；同给多个会被拒绝，不会静默取其中一个。`engineId` 选引擎，必须是 `list_browser_engines` 里的 id：不存在的 id 会被拒绝，不会换成默认引擎。启动即返回，不等登录完成。这些窗口 AI 读不到也操作不了 | `{ instances: [{ instanceId, identityId?, name?, label?, siteId? }] }`，每个窗口一项 |
| `stop_external_browser` | run | — | 关闭一个外部浏览器窗口（`instanceId` 来自 `launch_external_browser` 的返回或 `get_workspace_summary` 的 `running`）。窗口已不在、或传的是内置标签页的 `instanceId` 时不动任何东西。只按自有 profile 路径归属清理，不按进程名批量杀 | `{ ok: true, instanceId }`；没关成时 `{ ok: false, instanceId, reason: "not-running", note }` |
| `stop_all_external_browsers` | run | — | 关闭全部外部浏览器窗口；内置浏览器的标签页不受影响 | `{ ok: true, stopped }`：关掉的数量 |
| `check_identity_auth` | run | — | 检测账号是否仍处于登录状态。账号在内置浏览器里开着页面时就在那个页面里检测；没有打开页面时才检测外部系统浏览器里的登录状态（有外部窗口就读它，否则临时起一个不显示窗口的浏览器去验）。内置页面开着但不在站点自己的域名上时如实回 `unknown`，不换另一套登录状态作答。站点要配置登录检测路径 | `{ identityId, status: "signed-in" / "expired" / "unknown", checkedAt, surface?: "embedded" / "external", detail? }` |

### 内置浏览器 · 标签与布局

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `list_browser_tabs` | read | — | 无。不返回存储分区；`clean: true` 的页面在一次性干净身份里，没有 `identityId` 的页面在默认身份或自建身份里（`profileId` 省略即默认身份）；`active: true` 是用户正在看的页面。`sleeping: true` 的页面已被冻结（操作会先自动唤醒）；醒着但闲置的页面带 `sleepExempt` 说明没冻的原因（`on-stage-visible` / `audible` / `ai-active` / `policy` 等），两者都没有的下一轮扫描即冻结——判断哪个页在占资源并自行 close 用它 | `tabs`（标签 id、所属账号、身份、标题、地址、布局、静音/有声、休眠状态与豁免原因）、`views`（`id` 为容器 id，`viewDefinitionId` 为保存的视图定义 id，两者都能传给要 `viewId` 的工具）、`activeTabId?`、`activeViewId?` |
| `open_browser_tab` | run | — | 不抬窗口、不切界面；页面落自己的实例、不占台上格位（台外照常可读，闲置后休眠，操作前自动唤醒）。用哪个账号按 identityId → 地址同源站点 → siteId 顺序解析，都匹配不到落在一次性干净身份里；传 `clean: true` 跳过账号解析（不能与 `identityId` 同给），用来看已录入站点未登录的样子 | 标签页摘要，顶层带 `tabId`（与 `id` 同值）；自动归类到账号时另带 `identityName` / `resolvedBy`；带账号时带 `login: { state, note }` |
| `open_browser_view` | run | — | 不抬窗口、不切界面；每个成员一个标签页，按视图布局摆好格位，复用已打开的标签页，登录状态保留 | 打开后的标签页与视图状态 |
| `close_browser_view` | run | — | 关闭一个视图并移除容器。默认（`mode: "ai"`）只关 AI 侧打开的页面（视图成员与用 `open_browser_tab` 开的页面），用户自己打开的页面保留成不属于任何视图的独立页面；`mode: "all"` 连它们一起关。用保存的视图 id 时只关台上的容器，视图定义不动 | 关闭后的标签页与视图状态 |
| `navigate_browser_tab` | run | 导航白名单 | 等加载完成。目标须是用户给的地址、已有站点/书签，或当前页的同站链接——这一条由工具自己的导航策略判定，不是来源闸门。被 beforeunload 拦下时快速返回 `cancelled: "beforeunload"`（页面留在原地且可继续操作），用 `handle_browser_dialog` 决定去留 | `{ tabId, tab }`；被拦时另有 `cancelled` 与 `note` |
| `close_browser_tab` / `activate_browser_tab` / `move_browser_tab` | run | — | 只动界面，不影响登录状态。`activate_browser_tab` 相当于在标签条上点一下：切换该浏览器当前显示的页面；点在一个浏览器的根页上时它会上台，成为用户正在看的。`move_browser_tab` 的目的地三选一：`viewId`（放进视图）、`loose: true`（移出视图）、`anchorTabId` + `edge`（相对参照标签页排位） | 更新后的浏览器状态摘要 |
| `pop_out_browser_tab` / `dock_browser_tab` | run | — | 拆出与收回是两个动作，不是开关：对已拆出的页面再调 `pop_out_browser_tab` 返回 `alreadyPoppedOut: true`，不会收回去；`dock_browser_tab` 对没拆出的页面返回 `docked: false`。两步都会把页面重新挂载一遍（等于刷新）：SPA 内存态不保留，所属身份与登录状态不受影响。同一实例同时只允许一个拆出窗口；空白页不能拆出 | `{ windowId }` 或 `{ alreadyPoppedOut: true }` / `{ docked: true }` 或 `{ docked: false, reason }` |
| `set_browser_layout` / `pin_browser_tab` | run | — | 省略 `viewId` 时作用于台上的视图。`set_browser_layout` 在没有台上视图时，把 **AI 自己打开的**、不在任何视图里的页面收进一个新视图并摆上台——用户自己开的页面不会被收进来 | 布局或容器 |
| `compose_view` | write | — | 新建视图定义并把给定的标签页按顺序摆进去（至少两个，都要已绑定账号）。失败时回滚页面与定义 | `{ viewId, name, siteId, layoutId, slots, note? }` |
| `set_browser_viewport` / `reset_browser_viewport` | run | 是 | 宽 320–3840、高 320–2160 | 生效后的尺寸 |
| `set_browser_muted` | run | — | 只切换 Ensemble 的输出；页面自己的媒体与 Web Audio 照常运行。不受来源闸门限制，AI 自动静音不会覆盖用户手动取消的静音 | `{ tabId, muted }` |
| `set_browser_emulation` | run | 是 | 每个传入的键独立生效：`timezone`（IANA 名）/ `mediaType`（CSS 媒体类型）/ `offline` / `geolocation`，传 `null` 清除该项。模拟只作用于这一个页面，随标签页关闭丢弃；状态存在 CDP 会话里，与设备模拟同一套会话钉住规则。不授予权限——页面没被用户授权时拿不到地理坐标 | 当前生效的全部模拟项 |

**浏览器状态返回的投影。** 所有返回标签页或布局状态的工具（`list_browser_tabs`、
`open_browser_tab`、`navigate_browser_tab`、`close_browser_tab`、`close_browser_view`、
`set_browser_layout`、`pin_browser_tab`、`move_browser_tab`、`activate_browser_tab`、
`open_browser_view`）在 MCP 出口只保留决策字段：id、label、url、title、归属
（identityId / siteId / instanceId / viewId / clean / profileId）、声音与加载状态。渲染层用的
图标 data: URL、窗口几何、缩放、分区、DevTools 宽度一律不出走——每个标签页少几 KB，图标
内容从不进上下文。

### 内置浏览器 · 观察

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `read_browser_page` | read | — | 只返回可见元素，且只有页面当前渲染出来的那些。读取前先探测页面事件循环：循环已停摆（脚本卡死）时立即报错说明原因，不等到命令上限 | `nodes`：角色 role、可访问名称 name、稳定选择器 selector、位置、表单控件的 field（旁边那行标签文字）。回传定位：`field` 给 `label`，按钮链接的 `name` 给 `text`，最稳是原样回传 `selector` |
| `read_browser_console` | read | — | **读完即清空**，回答「上次读取之后发生了什么」；宿主自身的开发警告（Electron 安全提示等）默认不收录，`includeHost: true` 才返回（`hostHidden` 报本次排除的条数）；看不到跨域 iframe 的请求 | 报错、console 行、失败请求 |
| `read_browser_requests` | read | — | **只读不清空**：读收集器的滚动窗口（最近 50 条已完成的 fetch/XHR），`read_browser_console` 之后仍能读到同一批。可按 `url`（子串）、`method`、`status` 过滤，`limit` 控制条数。看不到跨域 iframe 的请求 | `{ requests: [{at, method, url, status, ms, failed}], inflight, installed }` |
| `read_browser_capabilities` | read | — | 纯查询，不触页面。给 `tabId` 时 `capabilities` 逐项实测表面可选方法（`false` ＝ 宿主未实现，对应工具会报「不支持」），`surface` 是表面标识（内置为 `embedded`）；省略 `tabId` 只返回枚举部分 | `surface` + `capabilities` + `waitConditions` / `flowActions` / `flowCdpStep`；省略 `tabId` 时只有枚举 |
| `wait_browser_condition` | read | — | 条件：`visible` / `hidden` / `text` / `url` / `value` / `network-idle` / `load`（readyState complete）/ `response`（URL 含 `expect` 的响应，可配 `status` 精确匹配；基于滚动窗口 peek，不清空）。要比对的文字传 `expect`，或直接传 `text`；`visible` / `hidden` 用 selector / label / elementText / role 定位元素（`text` 是 `elementText` 的简写），`value` 用它们定位输入框、要比对的值传 `expect` 或 `text`；简写与对应的完整字段同给会报错。`visible` / `hidden` / `value` 可用句柄（`handle`，与定位字段互斥，可配 `nth`；句柄解析一次进轮询，元素被移出 DOM 时报找不到）。`timeoutMs` 默认 5000、上限 60000。超时时 `timedOutAt` 区分 `page`（条件确实没满足）与 `bridge`（页面没按时答复） | `{ ok, waitedMs, timedOut, timedOutAt, reason, matched }` |
| `check_browser_element_visible` | read | — | 可用句柄（`handle`，与定位字段互斥，可配 `nth`；元素被移出 DOM 时报找不到，用 selector 则返回 `exists: false`） | `{ exists, visible, bounds, selector, name }` |
| `find_browser_element` | read | — | 定位给 selector / label / text / role 之一，收窄字段可选：`hasText` / `hasNotText`（元素自身文本包含/不包含）、`visible`、`nth`（0 起，负数从尾数）。text / role 匹配可交互元素与有自身文字的可见元素（纯容器不算）；同分时可交互元素排在纯展示元素前面。`timeoutMs` 默认 5000、上限 60000，一个匹配都没等到就报错。登记允许多个匹配（count 如实返回）；选择器无效或 nth 越界立即报错 | `{ handleId, count, index, resolved, matches: [{tag, text, visible, rect}] }`；之后 `click_browser_element` / `hover_browser_element` / `type_browser_text` / `set_browser_checkbox` / `read_browser_element` / `check_browser_element_visible` / `wait_browser_condition` 可用 `handle` 复用，其余工具不接受 `handle` |
| `read_browser_performance` | read | — | 采样窗口的真实语义：AI 活动（任何作用于该页的工具调用）期间及结束后 15 秒内持续累积，缓冲区保留最近 20 秒、间隔取自设置；更早或无人活动期间没有数据。任何 AI 页面操作都会续期采样器 | 逐点样本，`t` 为毫秒偏移 |
| `measure_browser_performance` | read | — | `durationMs` + `idleMs`。返回双口径：顶层 `metrics`/`samples`/`from`/`to` 只统计本次观察区间；`recent.metrics` 统计缓冲区全窗口（默认约 20 秒）。`maxAt` 相对各自窗口起点 | 顶层每项 `{ avg, max, maxAt, last, samples }` + `recent: { from, to, samples, metrics }` |
| `list_browser_init_scripts` | read | — | 只给 id、注册时间与前 120 字预览，不回源码 | `{ scripts: [...] }` |
| `read_browser_element` | read | — | 一个元素的全貌：角色、名称、文字、选择器、位置、可见/可用/聚焦状态、`attributes` 与 `value`。密码框是例外：只给 `inputType: "password"` 与 `secret: true`，不回传内容（自动填充刚写进去的密码不会经读取类工具回到调用方）。可用句柄（`handle`，与定位字段互斥，可配 `nth`） | 元素信息对象 |
| `read_browser_attribute` | read | — | 给 `names` 读指定属性（不存在返回 `null`）；不给则读文字或当前值，密码框只返回 `secret: true`。轮询状态变化用它，比整份元素信息便宜 | `{ ok, selector, attributes }` 或 `{ ok, selector, value/text }`；密码框为 `{ ok, selector, secret: true }` |
| `screenshot_browser_tab` | read | — | 不需要运行权限：截图是观察，不碰工作区也不动页面。`timeoutMs` 默认 15000、上限 60000。超时返回 `reason: "page-busy"` 而不是报错。给 `selector` / `label` / `elementText`（简写 `text`）/ `role` 时只截该元素（裁剪到元素范围；元素在视口外直接报错，不回退成整页图） | `{ path, bytes, data? }` 或 `{ ok: false, timedOut, reason }` |

### 内置浏览器 · 操作

| 工具 | 档位 | 闸门 | 时限与边界 | 返回 |
| --- | --- | --- | --- | --- |
| `click_browser_element` | run | 是 | 真实鼠标事件；先滚动到可见；`hit` 以按下瞬间为准（onTarget 只在按下与回读都 miss 才 false），`hitAfter` 是松开后的回读，页面在点击处理里替换 DOM 时两者不同——这不代表点击没生效。点击触发 alert/confirm 时命令在弹窗打开瞬间提前返回，`dialog` 带类型与内容、`hint` 指引先答弹窗（页面与弹窗保持原样，不重试点击）。直连定位命中多个时仍点第一个，`warning` 写明匹配数（句柄与显式 `nth` 不产生）。可用句柄（`handle`，与定位字段互斥，可配 `nth`；命中多个且无法归属时报「匹配 N 个」） | `{ ok, tag, text, selector, warning?, hit, hitAfter? }`；触发弹窗时另有 `dialog` 与 `hint`（hover / scroll / type / press / upload / drag / checkbox 同） |
| `hover_browser_element` | run | 是 | 真实鼠标移动（不发按下），打开只在悬停时出现的菜单与 tooltip。直连多匹配同 click（`warning`）。可用句柄（同上） | `{ ok, tag, text, selector, warning? }` |
| `scroll_browser_page` | run | 是 | 给 target 时滚轮落在该元素中心，可滚嵌套容器；`deltaY` 正数向下。target 多匹配时滚轮仍落第一个（`warning`）。`scrolled` 是动作后回读容器位置得到的真实位移差值，等待滚动稳定后才读；滚轮触发弹窗时同 click 提前返回 | `{ ok, scrolled, moved, warning? }`，`moved: false` 表示没滚（含已到边界） |
| `press_browser_keys` | run | 是 | 组合键写作 `Control+a`；修饰键先按下、再主键、逆序抬起。常见编辑组合（Ctrl+a/c/x/v/z、Ctrl+Shift+z）随 keyDown 派发 Chromium 编辑命令，效果对后续输入可见 | `{ ok, keys, modifiers }` |
| `read_browser_dialog` | read | — | 从主进程的事件记录读，**不走页面脚本**——弹窗打开时页面是阻塞的，任何页内查询都会超时。`pageBlocked: false` 表示 beforeunload 拦截：页面活着，只缺一个去留决定 | `{ dialog: { type, message, defaultPrompt?, url?, msOpen, pageBlocked, hint } }` 或 `{ dialog: null }` |
| `handle_browser_dialog` | run | 是 | `accept` **必填**：`true` 为确定，`false` 为取消——省略就是「确定」，对一个 confirm 来说这是最危险的方向，所以没有默认值。prompt 用 `promptText` 填值。beforeunload 拦截也在这里答：`accept: true` 重发被拦的导航并等它完成，`false` 留下。没有弹窗时报 `handled: false` 而不是错。无人应答的弹窗超预算后自动取消（唯一会自动应答弹窗的路径；工具超时一律不动弹窗）；挂起期间 CDP 会话保持附加，不会分离 | `{ ok, handled, type? }` |
| `upload_browser_files` | run | 是 | 绝对路径；多个文件必须一次给（每次调用替换输入框内容）。单文件框给多个会报错而不是截断。定位多匹配同 click（`warning`） | `{ ok, count, multiple, selector?, warning? }` |
| `drag_browser_element` | run | 是 | 起点与终点各用一对参数定位：`fromSelector` + `fromText`、`toSelector` + `toText`，每对里二选一。真实按下 + 六次中间移动 + 松开。动作后回读页面：`dropped` 说明页内是否收到 drop（`dropAt` 坐标、`droppedAtTarget` 是否落在终点附近、`reordered` 起点元素位置是否变化），缺失或坐标异常时 `warning` 说明，不算成功。任一端多匹配时仍取第一个，`warning` 写明 | `{ ok, fromTag, toTag, fromText, toText, dropped, dropAt?, droppedAtTarget, reordered?, warning? }` |
| `set_browser_checkbox` | run | 是 | 幂等：已在目标状态就不点。`stuckAt` 表示点了但状态没变（禁用或有处理器拦默认行为）。直连多匹配同 click（`warning`）。可用句柄（同 click） | `{ ok, checked, changed, selector?, stuckAt?, warning? }` |
| `go_back_browser_tab` / `go_forward_browser_tab` | run | 是 | 无可后退 / 前进历史时什么也不发生 | `{ ok }` |
| `reload_browser_tab` | run | 是 | 刷新会丢掉页面上没保存的输入，也可能重发一次表单，所以与前进后退一样过来源闸门。`ignoreCache: true` 等价 Ctrl+Shift+R，绕过 HTTP 缓存 | `{ ok }` |
| `type_browser_text` | run | 是 | 先聚焦、清空再逐字输入；密码框返回 `secret: true`。目标是 select 时直接报错，select 用 fill_browser_form。直连多匹配同 click（`warning`）。可用句柄（同 click） | `{ ok, selector, secret?, warning? }` |
| `fill_browser_form` | run | 是 | 逐字段真实输入；select 字段按 option 文字或值精确匹配（trim 后全等，无子串），匹配不到进 `failed` 带原因与可选项；两个不同定位解析到同一控件时第二个进 `failed`，不串写。其余字段继续填。某字段定位多匹配时仍填第一个，该字段条目带 `warning` | `{ ok, filled: [{field, selector?, secret?, warning?}], failed: [{field, reason}] }` |
| `fill_browser_login` | run | 是 | 密码留在主进程，跨域页面拒绝。失败不报错：`reason` 是原因码，`note` 用一句话说明原因与下一步 | `{ ok, submitted, missingFields }` 或 `{ ok: false, reason, note }` |
| `run_flow` | run | 是 | 给 `tabId` 就在那个页面里跑；否则新开一个标签页（默认用该站点第一个账号，登录表单会自动填充）并在返回里给出它的 `tabId`。步骤失败即停并说明原因；`read` 步骤遇到密码框直接失败，凭据不进流程变量（变量会随返回带出）。`timeoutMs` 默认 120000、上限 600000，由调用方指定——慢操作必须显式给大一点。`wait` 步骤会被流程剩余预算截断，超时时报的是「流程超过 N 秒」而不是「条件没满足」。`script` 步骤在 vm 里编排动作原语（不含 login/cdp），整段受同一个预算约束，到点报「脚本超时」 | `{ flowId, tabId, identityId?, run }`；`run` 是每步结果与变量，用了原始 CDP 时多一个 `rawCdp` 列表，超过两次附带 `note` |
| `evaluate_browser_page` | run | 是 | `timeoutMs` 默认 30000、上限 300000。超时返回 `{ timedOut: true, stillRunning: true }`，不是 `isError`。返回值超过 64KB 时拒绝返回（`isError` 说明缩法）——先在表达式里聚合或分页，再取小结果 | 表达式的值，或超时结构 |
| `cancel_browser_script` | run | 是 | 发 `Runtime.terminateExecution`。只能打断正在执行的代码；停在 Promise 上的脚本之后仍会继续 | `{ ok, note }` |
| `add_browser_init_script` | run | 是 | **对当前文档不生效**，从下一次导航起生效。脚本随标签页存在 | `{ ok, scriptId, affects: "next-navigation" }` |
| `remove_browser_init_script` | run | 是 | 下一次导航起不再执行；当前文档里已经跑过的那次不受影响。撤销的是页面级的注册，不是工作区数据，所以不叫 `delete_*` | `{ ok: true }` |

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
| `evaluate_browser_page` 返回 `timedOut` + `stillRunning` | 我们停止等待了，页面里的脚本可能还在跑 | 用 `wait_browser_condition` 观察结果出现，或 `cancel_browser_script` 尝试中止，或直接接着做别的事 |
| 工具抛错（`isError`） | 页面真的抛了异常或能力不存在 | 读错误信息，通常该改写脚本或换工具 |
| `wait_browser_condition` 的 `timedOutAt: "page"` | 页内轮询跑满了预算，条件确实没成立 | 看 `reason`（`url-mismatch` / `text-absent` / `still-visible` …）判断是等错东西还是时限太短 |
| `wait_browser_condition` 的 `timedOutAt: "bridge"` | 页面根本没按时答复，页内循环连一轮都没回来 | 页面被节流、冻结或卡住；重试同样的条件通常还是一样，应该先确认页面是否活着 |
| `screenshot_browser_tab` 的 `reason: "page-busy"` | 时限内没有产出画面 | 稍后重试，或先 `wait_browser_condition` 等页面安静 |

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
