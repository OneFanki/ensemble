# 更新日志 / Changelog

每个版本的更新内容写在这里，GitHub Release 的正文由 `.github/workflows/release.yml`
按版本号从这个文件抽取，所以发版时只需要改 `package.json` 和这里。

- 准备发版时，把 `## [未发布]` 改成 `## [<版本号>] - <日期>`，再在顶部加一个新的「未发布」小节。
- 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。
- 只写**用户能感知的改动**：新功能、行为变化、修复、升级注意事项。内部重构、CI、依赖更新可以合并成一条。
- 中英文都要有：仓库和展示页面向中英两种读者，Release 也一样。
- 缺少对应版本的小节时，发布流程会直接失败——不会发出没有说明的版本。

### 两个层级，别写混

在 `### 中文` / `### English` 下：

1. **摘要**（必须，2–5 条）：每行一条、每条一句，写"用户这次能得到什么"。应用内更新弹窗
   **只显示这一段**，所以它必须能独立读懂，不引用内部代号、不带链接、不列每个小修复。
2. **`#### 完整变更`**（可选）：详细的逐条变更，给 Release 页面和需要追溯的人看。
   更新弹窗会在这一行截断，永远不会显示它。

## [未发布]

### 中文

<!-- 摘要（2–5 条）写在这里，应用内更新弹窗只显示这一段。 -->

#### 完整变更

### English

<!-- Summary (2–5 lines); the in-app updater shows only this part. -->

#### Full changes


## [1.1.3] - 2026-10-27

### 中文

- **修复切走的页面截图要等 4 秒**：AI 操作的那页被你切到后台、或窗口最小化时，截图会先等满 4 秒超时才回退；现在直接走渲染器，同样的图 40ms 出来
- 运行栏里「AI 操作次数」徽标的说明改成应用自己画的提示：悬停即可看到完整说法，跟着主题走，不再是一秒后才冒出来的系统原生提示框
- README 新增「AI 操作时，你可以继续做你的事」一节：页面没有独立窗口可弹、切走不打断 AI、AI 不抢前台、测试全静默、AI 干了多少一眼能看到

#### 完整变更

- **截图路径按页面是否在屏幕上选择**：合成分器对被移出窗口的视图不产帧，`Page.captureScreenshot` 在那里不会报错、而是永不返回，于是离台页面的每次截图都先付满 4 秒超时。实测：在台上 CDP 约 40ms，离台 4023ms，最小化 4023ms；改后离台 37ms、最小化 40ms，图像字节数一致
- 判定抽成 `shared/embedded.ts` 的纯函数 `viewIsOnScreen(rect, content, host)`，三个输入都是调用方直接可读的；判定错只会让截图走较慢的路，不影响像素结果
- `CdpClient.screenshot` 新增 `preferRenderer` 参数，`EmbeddedBrowser.screenshot` 依据 `viewIsOnScreen` 传入；`capturePage` 回退保留，覆盖无法预判的状态
- `tests/embedded.test.ts` 新增 6 条覆盖判定本身（在台上、已停放、最小化、隐藏、零尺寸、恰好贴边），已用「恒为真」验证会失败
- `e2e-embedded` 新增一条：后台页面截图必须在 1.5s 内返回且有内容。注意无头模式下所有页面都离台，这条在无头里没有鉴别力，真正守住逻辑的是上面的单元测试
- **AI 次数徽标的提示由原生 `title` 改为自绘**：原生提示不能改样式、要等一秒、还会以系统窗口的形式盖在应用之上；自绘的提示挂在徽标内部向左展开，始终留在停靠栏内。原因是停靠栏和各视图块都裁切溢出，而停在舞台上的被测页面是原生视图、永远画在应用 HTML 之上，所以提示不能往右或往舞台方向溢出
- `e2e-ai-policy` 的徽标断言重写：除了次数正确，还断言徽标没有原生 `title`、悬停后出现自绘提示、移开后消失，并把停靠栏拖到最窄（240px）后量出提示相对每一层裁切祖先的位置，要求完全在内；同一处还会把提示换成英文再量一次宽度，确认两种语言都放得下。已把提示改成向右展开验证会失败（`.dock` 等四层都报出界），确认这条断言有鉴别力
- 提示文案收敛为「本次会话在本站的操作次数」：数字已经在徽标上，再抄一遍既啰嗦又会让计数涨到三位数后撑破停靠栏；含中文的句子改用正文字体栈，不走等宽（等宽栈会让中文回退成宋体）
- README 中英双版新增「AI 操作时，你可以继续做你的事」：说明页面没有独立窗口、切走不打断、AI 不抢前台、20 套测试全部离屏运行；并写明 AI 操作次数徽标按**来源**计数，同一站点的两个标签显示同一个数字是设计如此

### English

- **Fixed screenshots of a switched-away page taking 4 seconds**: when the page the AI was driving moved to the background or the window was minimised, a screenshot waited out a full 4s timeout before falling back; it now reads from the renderer directly and returns the same image in ~40ms
- The tooltip on the dock's AI action count is now drawn by the app: it appears at once, follows the theme, and no longer waits a second for the OS to show its own hint
- README gains "The AI works; you keep working": pages have no separate window to pop up, switching away does not interrupt the AI, the AI never raises your window, the test suites run silently, and the AI's work is visible at a glance

#### Full changes

- **The screenshot path now follows whether the page is on screen**: the compositor produces no frames for a view moved off-window, and `Page.captureScreenshot` there does not fail — it never returns, so every screenshot of a parked page paid the full 4s timeout first. Measured: on stage ~40ms via CDP, parked 4023ms, minimised 4023ms; after the change 37ms and 40ms with identical bytes
- The decision is a pure function, `viewIsOnScreen(rect, content, host)` in `shared/embedded.ts`; a wrong answer only routes the screenshot down the slower path, never a wrong pixel
- `CdpClient.screenshot` gains a `preferRenderer` flag that `EmbeddedBrowser.screenshot` sets from `viewIsOnScreen`; the `capturePage` fallback stays for states this cannot predict
- `tests/embedded.test.ts` gains 6 cases covering the decision itself (on stage, parked, minimised, hidden, zero-sized, exactly at the edge), verified to fail when the predicate is forced to true
- `e2e-embedded` gains one check: a backgrounded page must screenshot within 1.5s with real content. Note it has no discriminating power headless — every page is parked there — so the unit tests are what actually pin the logic
- **The AI-count tooltip is drawn by the app instead of a native `title`**: a native hint cannot be styled, waits a second, and paints as an OS window above the app; the drawn one sits inside the badge and opens leftwards, staying within the dock. It has to: the dock and every view block clip their overflow, and the pages parked on the stage are native views that always paint above app HTML, so the hint cannot spill rightwards or towards the stage
- `e2e-ai-policy`'s badge check is rewritten: besides the count, it asserts there is no native `title`, that hovering opens a drawn hint and leaving closes it, and — after dragging the dock to its narrowest (240px) — that the hint sits inside every clipping ancestor; it then swaps in the English text and measures again, so neither language can ship wider than the panel. Verified to fail when the hint is flipped to open rightwards (`.dock` and three other ancestors reported it out of bounds)
- The hint text is "AI operations on this site so far": the number already sits in the badge, and repeating it made the sentence grow with the count until it no longer fit at three digits. The sentence also uses the body font stack — the badge is mono because it holds a number, and a mono stack falls back to a serif for Chinese
- README (both languages) gains "The AI works; you keep working": no separate window, switching away is safe, the AI never steals focus, all 20 test suites run off-screen, and the AI-count badge is documented as counting **per origin** — two tabs of the same site showing one number is by design


## [1.1.2] - 2026-10-27

### 中文

- **修复浏览器右侧出现一条被放大的页面内容**：窗口短暂测量不到尺寸时（例如最小化到托盘），离台页面会退到用「舞台宽度」当窗口宽度，结果停在了运行栏所在的位置，露出一条约 98px 的页面残影
- 该兜底改为记住上一次真实的窗口尺寸，从未测量过时用足够大的默认值——离台页面必须停在窗口之外，这一点此前有注释却没被代码守住
- 舞台容器补上裁剪：冻结快照按捕获时的矩形贴图，舞台变窄后不会再溢出到运行栏上

#### 完整变更

- **离台停放坐标的兜底值取错了维度**：`hostContentSize()` 在 `getContentBounds()` 不可用时会回退到 `stage.width`，而它自己的注释明确要求「必须停到窗口右缘之外，不能停到舞台宽度」——舞台比窗口窄（左侧还有导航栏），于是页面落到 `x = stage.width`，正好压在运行栏上。这是 1.0.0 起就存在的潜伏缺陷
- 兜底改为记住最后一次可读的窗口尺寸（`lastContentSize`），从未测量过时返回足够大的默认值；新增 `tests/contracts/parking-uses-window-size.test.ts` 静态守住「兜底路径不得出现 stage」，已用改回旧实现验证会失败
- `.stage` 增加 `overflow: hidden`：冻结快照是绝对定位的 `<img>`，尺寸取自捕获时的矩形且用 `object-fit: fill`，舞台变窄后既溢出边缘、又被拉伸，看起来像一条放大的页面条带
- 冻结快照的监听条件加入舞台宽高：覆盖期间改变舞台尺寸（折叠/展开运行栏）会重新捕获，而不是沿用过期矩形
- `e2e-ui-regressions` 新增两条：快照矩形不得越出舞台（含折叠/展开运行栏的复现路径）、舞台必须裁剪子元素

### English

- **Fixed a magnified band of page content down the right edge**: when the window briefly could not be measured (minimised to the tray, for instance), a parked page fell back to the stage width as the window width, so it stopped exactly where the run dock sits and left a ~98px ghost of page content
- That fallback now remembers the last real window size, with a generous default before anything has been measured — off-stage pages must clear the window edge, which the comment required but the code did not enforce
- The stage now clips its children, so a frozen snapshot can no longer spill over the dock when the stage gets narrower

#### Full changes

- **The off-stage parking fallback used the wrong dimension**: `hostContentSize()` fell back to `stage.width` whenever `getContentBounds()` was unavailable, while its own comment requires parking past the *window's* right edge — the stage is narrower than the window (the navigation rail sits to its left), so the page landed at `x = stage.width`, right on top of the run dock. This has been latent since 1.0.0
- The fallback now remembers the last readable window size (`lastContentSize`) and returns a generous default before anything is measured; `tests/contracts/parking-uses-window-size.test.ts` pins the shape so the fallback path cannot mention the stage, verified by restoring the old implementation and watching it fail
- `.stage` gains `overflow: hidden`: the `frozen` snapshot is an absolutely positioned `<img>` sized from the capture-time rect with `object-fit: fill`, so a narrower stage made it both overflow the edge and stretch, reading as a magnified band of the page
- The frozen-snapshot watcher now includes the stage size, so changing it mid-overlay (collapsing or expanding the dock) re-captures instead of reusing a stale rect
- `e2e-ui-regressions` gains two checks: a frozen frame must not exceed the stage (including the collapse/expand reproduction) and the stage must clip its children


## [1.1.1] - 2026-10-27

### 中文

- **修复 AI 接入设置页显示英文键名**：「复制配置」按钮和配置区标题曾直接显示成 `app.copyToken`、`app.mcpConfigTitle`，现在都是正常文案
- **修复 AI 接入配置项被折叠**：客户端连接信息完整展示（地址、鉴权、Token 状态），不需要点开；Token 仍然只显示掩码，「复制配置」按钮一次带走全部内容
- **修复流程页运行失败无提示**：请求异常时弹出的是一串英文键名，现在是正常文案
- 新增文案护栏：代码里引用的每条文案 key 必须真实存在，缺一条测试直接失败（这类问题此前整套测试都发现不了）

#### 完整变更

- **AI 接入面板**：按钮上的 `app.copyToken` 与展开标题 `app.mcpConfigTitle` 是缺失文案被 vue-i18n 原样渲染的结果；面板重写为配置项常驻展示（地址 / 鉴权 / Token 掩码），「复制配置」作为主按钮，一并移除残留的详情折叠与「显示 Token」开关
- 缺失文案补齐：`app.copyToken`、`app.mcpConfigTitle`（随旧控件一起移除）、`app.mcpConnTitle`（新标题），以及流程页历史遗留的 `app.toastRequestFailed`
- `tests/i18n.test.ts` 新增「代码引用的 key 必须已定义」：扫描渲染层所有 `.vue` / `.ts` 里的字面量 key 与文案表比对。原有断言全部以文案表为起点，只能发现「已定义但写坏了」，发现不了「代码要的 key 不存在」
- `e2e-ui-regressions` 新增两条实机断言：设置页正文不得出现裸 `app.*` 键名、AI 接入区不得残留折叠容器

### English

- **Fixed English key names on the AI access panel**: the "Copy config" button and the block title used to render as `app.copyToken` and `app.mcpConfigTitle`; both now read as normal text
- **Fixed the folding of the AI access settings**: the client connection facts (URL, auth scheme, token state) are fully visible without opening anything, while the token stays masked and "Copy config" carries the real value
- **Fixed a missing message on the flow page**: a failed run used to show a raw English key instead of a message
- New copy guard: every message key the code references must exist in the table, so a missing one fails the test suite (this class of bug was invisible to every existing check)

#### Full changes

- **AI access panel**: the `app.copyToken` label on a button and the `app.mcpConfigTitle` disclosure title were missing messages rendered verbatim by vue-i18n. The panel now lists the connection facts inline (URL / auth / masked token) with "Copy config" as the primary action; the leftover disclosure and the "Show token" toggle are gone
- Missing messages added: `app.copyToken` and `app.mcpConfigTitle` (removed together with the old controls), `app.mcpConnTitle` (the new heading), and the long-standing `app.toastRequestFailed` on the flow page
- `tests/i18n.test.ts` gains "defines every key the renderer asks for": it scans every literal key in the renderer's `.vue` / `.ts` files and compares against the message table. All previous assertions started from the table, so they could only catch a defined-but-broken message, never a key the code asks for that no longer exists
- `e2e-ui-regressions` gains two runtime assertions: the settings page must show no raw `app.*` key names, and the AI access block must contain no leftover disclosure

## [1.1.0] - 2026-10-27

### 中文

- **账号能重新关联到站点了**：1.0.0 迁移曾把站点列表读空、让账号全部丢失归属，现在可以把选中的账号一次关联到同一个站点，选完确认才生效
- **站点不再带多余的登录字段**：租户名这类值只属于账号，旧数据自动搬到各账号，账号页可以一次看到更多账号
- **界面语言跟随系统**：新增「跟随系统」并作为默认，也可以显式指定中文或英文
- **AI 接入更好用**：设置页直接列出地址与鉴权方式，点「复制配置」一次带走全部（含 Token，但不显示明文）
- **开发者工具修好了**：F12 能正常开关；在里面改设置要求重新加载时，面板会自己恢复，不再变成空白

#### 完整变更

- **账号与站点重新关联**：修复 1.0.0 迁移把站点列表读空、账号全部丢失站点归属的问题；账号页可以用「关联到站点」一次把选中的账号挂到同一站点，选完还要确认才生效
- **站点不再带额外登录字段**：租户名这类值只属于账号，站点对话框里那一块已移除，旧数据自动搬到各账号
- **账号卡片固定三行**：身份 / 事实 / 操作常驻显示，悬停不再改变高度、不会让整片网格跳动
- **界面语言跟随系统**：语言设置新增「跟随系统」并作为默认，不再写死中文；也可显式选中文或英文
- **AI 接入重排**：底栏入口常驻「AI 接入」标签；设置页把地址、鉴权、Token 状态直接列出来，「复制配置」是主按钮，Token 本身不显示、只随复制带出
- **修复改站点无效**：编辑已有账号时选另一个站点保存，现在会真的迁移过去
- **修复 DevTools 面板全空**：定位到「前端 reload 后 Electron 不会重新绑定 `InspectorFrontendHost`」，退化成空转 stub；提示条只点不触发的「不再显示」，面板里的 F5 改为刷新被测页。DevTools 界面保持英文（中文语言包取不到，要中文得另做一套）
- **修复 F12 打开 DevTools 后瞬间自关**：`before-input-event` 对一次按键触发两次，keyDown 开面板后焦点转到面板，同一按键的 keyUp 落到面板 handler 上又被当成切换；现在所有快捷键只认 keyDown，切换类忽略自动重复。工具栏按钮没有配对的 keyUp，所以此前只有 F12 出问题
- **DevTools 改设置要求 reload 后面板不再变空壳**：reload 后 Electron 不会重新绑定 `InspectorFrontendHost`（退化成空转 stub），现在改为拦下前端 reload 并整套重建前端视图，面板闪一下后继续可用；顺带把「reload 即永久损坏、只能禁止」的旧结论纠正为「换掉前端视图即可恢复」（实测 4/4）
- 工作区迁移：同时存在空的 `sites` 与有内容的 `environments` 时按旧格式合并升级；账号 `siteId` 缺失不再被当成 `{}` 重新写入
- 站点额外字段移除：`Site.extraFields` 从类型、schema、服务、MCP、账号包中移除；读取旧工作区时把站点字段下沉到其下每个账号（同名不覆盖），账号包导入同样处理
- 账号 `siteId` 改为可选：孤儿账号在账号页有独立分组，`profileDirFor` 返回 `undefined` 而不是拼出假目录
- 新增 `linkIdentitiesToSite`（core + IPC + MCP `link_identities_to_site`），账号页选择模式里加「关联到站点」按钮 + 确认弹窗（弹窗只预选站点，不写入，按「确认关联」才生效）
- `update_identity` 支持传 `siteId` 改挂站点
- 账号卡片：合并角色/密码/引擎/额外字段为一行标签，去掉密码圆点装饰行；操作行常驻（悬停不再改变卡片高度）；列宽自适应窗口
- 界面语言：`AppSettings.locale` 扩展为 `"system" | "zh" | "en"`，默认 `"system"`；新增 `shared/locale.ts`（`resolveLocale` / `localeTag`）与 `WorkspaceSnapshot.systemLocale`；系统语言由 `app.getPreferredSystemLanguages()` 取，不用 `navigator.language`（后者跟随 `--lang`）；设置页语言段加「跟随系统」；`--lang` 与 core 文案都走同一解析结果
- AI 接入：底栏入口常驻「AI 接入」标签（不再只在运行时才显示文字）；设置页改成常驻连接信息（地址 / 鉴权 / Token 掩码）+ 主按钮「复制配置」，移除 `<details>` 折叠与 Token 明文显示/复制按钮

### English

- **Accounts can be linked to sites again**: the 1.0.0 migration emptied the site list and left every account without one; a whole selection can now be linked to a site in one go, with an explicit confirm
- **Sites no longer carry stray login fields**: values such as a tenant name belong to the account, existing data moves onto the accounts, and the accounts page fits more cards per screen
- **UI language follows the system**: a new System option is the default; Chinese or English can still be pinned explicitly
- **AI access is easier to wire up**: settings list the URL and auth scheme in the open, and Copy config takes everything including the token without ever showing it
- **DevTools is fixed**: F12 toggles it properly, and a settings change that reloads it now rebuilds the panel instead of leaving it blank

#### Full changes

- **Accounts and sites can be re-linked**: fixed the 1.0.0 migration that emptied the site list and left every account with no site; the accounts page can now link a whole selection to one site, with the target chosen and confirmed in a dialog
- **Sites no longer carry extra login fields**: values such as a tenant name belong to the account; that block is gone from the site dialog, and existing data moves onto the accounts
- **Account cards keep a fixed three rows**: identity, facts and actions are always visible, so hovering no longer changes the card height or reflows the grid
- **UI language follows the system**: a new "System" option is the default instead of a hardcoded Chinese; Chinese or English can still be pinned explicitly
- **AI access panel reworked**: the status-bar entry is labelled at all times, and settings now show the URL, the auth header and the token state in the open, with "Copy config" as the primary action — the token itself is never printed, only copied
- **Changing an account's site now works**: picking another site for an existing account really moves it
- **DevTools panels are no longer empty**: the cause was that a single front-end reload permanently loses the host binding, so the app now intercepts a front-end reload and rebuilds the whole front-end view — the panel blinks and carries on instead of sitting there empty. It also corrects the earlier "a reload is permanent, so forbid it" conclusion: discarding and re-mounting the front-end does recover it (measured 4/4)
- **F12 no longer opens DevTools only to have them close instantly**: `before-input-event` fires twice per physical press, so the keyDown opened the panel, the panel took focus, and the keyUp of that same press reached the panel's own handler and toggled it shut; every shortcut now acts on keyDown only, and toggles ignore auto-repeat. The toolbar button has no paired keyUp, which is why only F12 was affected
- Workspace migration: a file carrying an empty `sites` array next to a populated `environments` key is merged as the old schema; a missing identity `siteId` is no longer rewritten as `{}`
- Site extra fields removed from the type, schema, service, MCP tools and account bundles; reading an old workspace copies each site field onto that site's accounts (an account's own label wins), and bundle import does the same
- `Identity.siteId` is optional: unlinked accounts get their own group on the accounts page, and `profileDirFor` returns `undefined` instead of inventing a directory
- New `linkIdentitiesToSite` (core + IPC + MCP `link_identities_to_site`), plus a "link to site" button and confirm dialog in the accounts page selection bar (the dialog preselects a site but writes nothing until "Link accounts" is pressed)
- `update_identity` accepts `siteId` to move an account
- Account cards merge role/password/engine/extra-field into one tag row, drop the password-dots row, and keep their action row visible (no height change on hover); column count follows the window width
- UI language: `AppSettings.locale` widened to `"system" | "zh" | "en"`, default `"system"`; new `shared/locale.ts` (`resolveLocale` / `localeTag`) and `WorkspaceSnapshot.systemLocale`; the system tag comes from `app.getPreferredSystemLanguages()` rather than `navigator.language` (which follows `--lang`); the language segment gains a "System" option; both `--lang` and the core-layer strings use the same resolution
- AI access: the status-bar entry is permanently labelled; settings shows the connection facts inline (URL / auth / masked token) with "Copy config" as the primary action, replacing the `<details>` disclosure and the token reveal/copy controls

## [1.0.0] - 2026-10-26

### 中文

- **内置浏览器**：多账号一屏并行，不依赖外部浏览器；页面/实例/视图三层模型，布局、多标签、缩放、开发者工具停靠齐备
- **站点模型定稿**：站点是登录配方，一套全局标签贯穿站点/账号/视图；流程沉淀可重跑的重复操作，账号包加密分享
- **AI 全链路**：语义定位与页面内等待，建号场景端到端可跑；未授权的站点对 AI 默认只读
- **界面重构**：全新浏览器舞台与运行栏，分组折叠、视图排序、书签与日常档案
- 自动填充后自动登录：账号进站即登录，不用补点一次按钮
- 开发者工具：F12 快捷开关、停靠面板可拖宽、语言跟随应用设置

#### 完整变更

**内置浏览器表面**

- 浏览器页面不再依赖外部浏览器：页面直接承载在主窗口里，每个账号一个隔离会话，一屏并行；
  外部浏览器模式保留，由顶栏的启动目标决定去向。
- 三层模型：**页面**（一个标签）、**实例**（共享登录会话的一组页面）、**视图**（一屏内的格位
  编排）。页面里点开的弹窗属于同一实例，不会多占格位；离台的页面继续运行，点一下即换进
  选中格位。
- 多标签：每个实例自带页面标签条（图标、关闭、右键菜单、「＋」），不建视图的默认标签组
  同样有；运行栏「标签页」组头选一个布局，可把扁平实例一键收成视图。
- 布局与缩放：2×1、1×2、2×2、3×1 与自由布局，分界线可拖；缩放分全局默认与单页覆盖两级，
  档位沿用 Chrome。
- 开发者工具默认停靠在格位内，可拆出独立窗口；支持 F12 快捷开关与拖宽。
- 新标签页是搜索落地页：地址或搜索词、引擎选择与自定义引擎、内置背景预设；冷启动直接落在
  搜索框。

**站点模型与资产定稿**

- **站点降级为登录配方**：只描述「怎么登录」（地址、登录入口、凭据配方、额外字段），不再
  承载环境概念；原有的环境/场景并入站点。
- **一套全局标签**：站点、账号、视图共用同一套标签，筛选按成员关系派生。
- **流程**：可重跑的步骤清单（导航/填写/点击/选择/按键/登录/等待/读取八种动作），保存时
  校验、按站点归属、失败即停（可标记跳过）。
- **账号包**：把勾选的账号连同站点配方导出为一个文件，导入方按地址+用户名合并；密码可选
  口令加密，不落明文。
- 账号引用与站点地址变更检测：站点地址改了，引用它的账号下次登录前会先确认。
- 视图可跨站点复制。

**AI 与 MCP**

- 浏览器工具面向语义而非坐标：按标签文字、占位符、角色定位元素；等待条件（可见/消失/文本/
  地址/值）在页面内轮询；批量填表逐项标注密文。
- 建号全链路：给一个测试环境地址和超管账号，AI 可以存站点、登录、批量建租户账号并存成
  身份、按视图一起打开。
- **AI 来源只读闸门**：未授权的站点默认只读（可看可读、不可交互），已授权来源的操作按来源
  计数显示在运行栏；导航目标只接受用户或工作区数据，不采纳页面内容里的链接。
- 书签与流程均有对应的 MCP 工具。

**界面重构**

- 浏览器舞台与运行栏重做：展开态一行一个实例（页面缩进在下面），折叠态一个实例一个站点
  图标，同视图的实例分组相邻；在任何页面点击运行栏都会切到浏览器页。
- 全部按钮收敛为共享组件；应用内确认弹窗独立成警示样式；中英双语与文案编译护栏。
- 底栏常驻 AI 接入入口：端点状态一目了然，点击直达设置。

**自动化与质量**

- 自动化运行不弹窗：端到端脚本与截图全部在无头模式运行，不再打扰正在使用的桌面。
- 20 套端到端脚本、近 500 条单元测试；打包产物有独立冒烟检查（含凭据不外泄）。

**日常档案与书签**

- 新增日常档案：不带身份的标签（新标签页、书签、地址栏输入）登录一次长期有效，可以直接拿它当日常浏览器，也让 AI 在已登录的页面上帮忙做事
- 新增书签：新标签页上一排图标，只有名字和地址，双击改名、右键删除、拖拽排序；地址栏的星标一键收藏当前页
- 「从站点打开」多了「日常打开」，与「干净打开」并列；干净打开现在是真正的临时会话，退出即消失
- 自动填充后可以真的登录进去了：默认会点登录按钮本身，不再只填账号密码等人手点一下
- 视图列表可以拖动排序，顺序会被记住；筛选状态下拖动也落在你看到的位置
- 开发者工具支持 F12 快捷开关、拖动分隔条调宽度，且不再每次弹出语言设置提示

#### 完整变更

**日常档案与书签**

- 无身份页面从「所有标签共用一个叫 clean 的持久分区」改为落在一个明确的**日常档案**上。旧名沿用是为了接住升级前已有的登录，不会把人一次性登出。
- **干净打开**改为每个实例一个内存级会话（不带 `persist:` 前缀）：退出即消失，两次干净打开之间也互相看不到。同一实例里页面打开的登录弹窗继承该会话，不会掉进日常档案。
- **书签**成为独立对象：只有名字、地址、图标与顺序，没有凭据、登录路径或站点归属。点书签直接打开地址（用日常档案已有的登录），点站点/账号才是打开登录页并自动填充。
- 新标签页的书签网格：图标 + 标题，双击或右键改名、右键删除、拖拽排序；没有图标时按域名生成稳定的颜色与首字母。设置里可以关掉网格。
- 地址栏星标收藏/取消当前页，图标直接复用标签页已经抓到的那个，不额外发请求。
- 书签随工作区导出导入；导入时重新编号并排在已有书签之后。MCP 新增 `list_bookmarks` / `save_bookmark` / `delete_bookmark`。
- 运行栏里无身份标签的标注从「干净会话」改为「日常档案」，只有真正 clean 打开的才是「干净会话」。

**界面与运行栏**

- 在站点页、账号页等任何非浏览器页面，点击右侧运行栏的一行或某个子标签页，现在会切到浏览器页并显示那个页面；此前只切换了后台标签，看上去像点空了。
- 运行栏折叠后的图标列改用网站自己的图标，取不到时显示统一的占位图标；「文字首字母」的旧回退去掉了。
- 一个实例有多个页面时，折叠图标列显示当前选中页的图标；实例展开后每个子标签页行也带上了图标，跑测试时能直接按网站认页面。
- 流程页在没有流程时，空状态居中显示。
- 全局默认浏览器：站点不再各带一个默认引擎，统一跟随顶栏的浏览器选择；账号仍可单独指定，作为例外。
- 账号导入导出的说明里去掉了「同事」这类限定场景的措辞；「批量启动」改名为「选择账号」，导出就在那里面。
- 浅色主题下的浮层、菜单与确认弹窗改用暖色投影，不再是发灰的黑色光晕。

**默认标签页补齐同一套能力**

- 扁平（默认标签组）舞台现在也有页面标签条：标签、图标、关闭、右键菜单、「＋」全都有，
  和视图里的某一格完全一致。此前默认标签组里的浏览器没有标签条，同一实例放进视图反倒有，
  读起来像两个不同的东西。
- 扁平舞台的头带只占一条 26px 的横条，原生页面从它下面开始，尺寸规则与格位共用同一套。
- 扁平列表也能选布局了：运行栏「标签页」组头的布局选择器选中一个网格，就把当前所有扁平
  实例收成一个新视图并铺开，结果与手动把行拖到一起一致。

**分组折叠与批量建视图**

- 站点（按标签）、账号（按站点）、流程（按站点）三个列表的分组都能折叠了：点分组头整行收起，
  组名与计数留在原处；页头多了一个「全部折叠 / 全部展开」开关，一次处理整页。
- 折叠状态按页面分别记住，重启后还在；按标签筛掉一些组再清空筛选，之前折叠过的组不会自己弹开。
- 账号页的「全选可见」只选展开着的组——折叠起来的卡片看不见，不该被「可见」算进去。
- 批量选账号现在除了「启动所选」，还能「创建视图」：同一批勾选的账号直接进新建视图表单，
  取名、选布局、挂标签后保存成视图，下次按同一布局重新打开。

**自动登录与视图排序**

- 自动填充之后现在会真的提交登录：设置 → 常规 里的「填完后自动登录」默认打开，账号进站即登录，
  不用再补点一次按钮。
- 提交方式从「提交表单」改为**点登录按钮本身**。此前只调 `requestSubmit()`，遇到按钮是
  `type="button"`、提交逻辑写在脚本里的登录页就完全没反应——表单上看不出问题，页面上却
  什么也没发生。现在先在表单与页面里找登录按钮并点它，找不到才退回提交表单。按钮筛选会
  排除「忘记密码」「显示密码」「注册」这类陷阱，优先认「登录 / 登入 / 提交 / Sign in」等文字
  或表单内的 `type=submit`。
- 自动提交改成分层开关，与「默认浏览器」同一套逻辑：全局默认在设置里，站点可以单独覆盖成
  「总是」或「从不」，默认那一档显示当前全局实际生效的值，一眼能看出这个站点会不会提交。
  旧版本给每个新建站点都写过 `false` 的记录原样保留，不猜哪些是「当时没人表态」。
- 站点对话框里的自动提交从勾选框换成三态选择；账号包导出导入也带上这个可选字段。
- 视图列表支持拖动排序：列表顺序就是显示顺序，拖到哪一行就落到那一行之后，重启后仍在。
  按站点或标签筛选时拖拽同样准确——落点按视图 id 反查完整列表，不会因为隐藏了几行而错位。
- MCP 的站点摘要新增 `autoSubmitEffective`，AI 能看到某个站点当前实际会不会自动提交。

**开发者工具**

- F12 与 Ctrl+Shift+I 现在能开关开发者工具——页面上按、工具面板里按都行；此前只有工具栏按钮一个入口。
- 停靠的开发者工具可以拖动分隔条调宽度（20%–70% 钳制），方向键也能微调；此前固定 42%。
- 打开开发者工具时不再每次弹「切换界面语言」的提示条，语言自动跟随应用设置。
  说明：这条提示的选择在 Electron 里根本不会被记住（点过、重启后照样弹），应用改为
  每次打开时代答，语言跟随应用界面语言。

**交互与措辞**

- 关闭视图这类确认弹窗重做成独立的警示样式：图标 + 问题 + 两个按钮，不再是一个中间空着的表单框。
- 干净会话的入口统一到顶栏的浏览器选择菜单里，跟随全局选择决定用内置还是外部浏览器；各页面里散落的「干净会话」按钮已移除。

### English

- **The built-in browser**: many accounts side by side on one screen, no external browser needed; a page/instance/view model with layouts, tabs, zoom and docked developer tools
- **The site model is settled**: a site is a login recipe, one global set of tags runs across sites, identities and views; flows capture repeatable steps and account bundles share them encrypted
- **AI end to end**: semantic targeting and in-page waits, the account-provisioning scenario runs start to finish; sites the user has not authorized are read-only to the AI
- **A rebuilt interface**: a new browser stage and running dock, folded groups, view ordering, bookmarks and the daily profile
- Auto-fill signs you in: it clicks the login button itself, so an account opens already signed in
- Developer tools: F12, a draggable docked panel, and a language that follows the app

#### Full changes

**The embedded browser surface**

- Browser pages no longer depend on an external browser: pages live inside the main window, one isolated session per account, all on one screen. The external browser mode remains, chosen by the title-bar launch target.
- Three layers: a **page** (one tab), an **instance** (the set of pages sharing one login session), and a **view** (the grid arranging instances on screen). Popups a page opens belong to the same instance and never take extra cells; off-stage pages keep running and rejoin the selected cell on one click.
- Tabs: every instance carries its own page strip (icons, close, context menu, "+"), and so does the default tab group when no view exists; picking a layout on the dock's "tabs" block folds loose instances into a view in one step.
- Layouts and zoom: 2×1, 1×2, 2×2, 3×1 and free layout with draggable dividers; zoom has a global default plus per-page override on Chrome's steps.
- Developer tools dock inside the cell by default and can detach into their own window; F12 toggles them and the docked panel is resizable.
- The new tab is a search landing page: address or query, engine choice with custom engines, built-in backdrops; a cold start lands in the search box.

**The site model and assets**

- **Sites are login recipes**: only "how to sign in" (address, login path, credential recipe, extra fields), no environment concept; environments and scenes merged into sites.
- **One global set of tags** runs across sites, identities and views, with filters derived from membership.
- **Flows**: re-runnable step lists (navigate / fill / click / select / press / login / wait / read), validated on save, owned by a site, stopping on failure unless a step is marked optional.
- **Account bundles**: export the selected accounts with their site recipes to one file; import merges by address plus username, passwords optionally sealed under a passphrase.
- Account references and site-address change detection: when a site's address changes, accounts referencing it confirm before the next login.
- Views can be copied across sites.

**AI and MCP**

- Browser tools target semantics, not coordinates: elements are found by label text, placeholder or role; wait conditions (visible / hidden / text / URL / value) poll inside the page; batch form fills mark each secret per field.
- The provisioning scenario works end to end: given a test environment address and an admin login, the AI can store the site, sign in, create tenant accounts in bulk, save them as identities and open them in a view.
- **A per-origin read-only gate for the AI**: unauthorized sites are read-only (visible and readable, not interactive), actions are counted per origin in the dock, and navigation targets must come from the user or workspace data — never from page content.
- Bookmarks and flows have their own MCP tools.

**A rebuilt interface**

- A new browser stage and running dock: expanded, one row per instance with its pages indented; collapsed, one site icon per instance, grouped by view; clicking the dock from anywhere brings the browser forward.
- All buttons converge on shared components; in-app confirmations have their own warning layout; Chinese and English with a compile-time message guard.
- A persistent AI entry in the status bar: endpoint state at a glance, one click to settings.

**Automation and quality**

- Automated runs no longer pop windows: end-to-end scripts and screenshots run headless and leave the desktop alone.
- 20 end-to-end suites, close to 500 unit tests, and a separate smoke check for packaged builds (including credential-leak checks).

**Daily profile and bookmarks**

- Identity-less pages moved from one shared persistent partition (misleadingly named "clean") to an explicit **daily profile**. The old partition string is reused on purpose so existing logins survive the upgrade.
- A **clean open** is now one in-memory session per instance (no `persist:` prefix): gone when the process exits, invisible to other clean opens. A login popup opened by a page inherits that session and cannot leak into the daily profile.
- **Bookmarks** are a first-class object: a name, an address, an icon and an order — no credentials, no login path, no site. Clicking a bookmark opens the address with the daily profile's login; clicking a site or account opens the login page and fills it.
- Bookmark grid on the new tab: icon plus title, rename on double-click or from the context menu, remove from the context menu, drag to reorder; an iconless bookmark gets a stable colour and initial derived from its host. The grid can be turned off in Settings.
- The address-bar star bookmarks and unbookmarks the current page, reusing the icon the tab already fetched.
- Bookmarks travel with the workspace export; on import their order is reassigned and they append after the ones already present. New MCP tools: `list_bookmarks`, `save_bookmark`, `delete_bookmark`.
- The dock now labels an identity-less tab "daily profile" instead of "clean session"; only an actual clean open says clean session.

**Interface and dock**

- Clicking a row or a page in the running dock from any other page now brings the browser page forward and shows that page; before, only the background tab changed and the click read as a no-op.
- The collapsed dock's icon strip uses the site's own icon, falling back to one neutral placeholder; the old "first letter of the name" fallback is gone.
- With several pages in one instance the collapsed strip shows the icon of the current page, and each page row under an instance carries its icon too, so a test run can be read by site.
- The flows page centres its empty state instead of hugging the header.
- One global default browser: sites no longer carry a default engine each and follow the title-bar choice; an account may still override it.
- Account import/export wording no longer assumes a "colleague" scenario, and "批量启动" is now "选择账号" — where the export lives.
- Floating surfaces, menus and confirmation dialogs use a warm shadow in the light theme instead of a grey halo.

**The default tab group gets the same controls**

- The flat stage — the default tab group — now has a page strip too: tabs, icons, close, right-click menu and "+", exactly like a cell of a view. It previously had none, so the same browser instance gained a strip only once it was put into a view, which read like two different features.
- The flat stage's header is a single 26px band; native pages start below it, using the same arithmetic as a view cell.
- The flat list can take a layout: picking a grid from the layout picker on the dock's "tabs" block groups every loose instance into a new view and lays it out, which is what dragging the rows together does by hand.

**Folded groups and batch-to-view**

- All three grouped lists fold now — sites by tag, accounts by site, flows by site: clicking the header row collapses it, and the name plus count stay where they were. A header switch folds or opens every group at once.
- The folded state is remembered per page across restarts, and a group you collapsed stays collapsed after filtering the list and clearing the filter again.
- "Select visible" on the accounts page only reaches groups that are open; cards behind a folded header are not on screen and should not count as visible.
- Picking accounts now also has "create view": the same selection goes straight into the new-view form, where it gets a name, a layout and tags, and is saved as a view you can reopen with that layout later.

**Automatic sign-in and view ordering**

- Auto-fill now actually submits the login. "Sign in automatically after filling", under Settings → General, is on by default, so opening an account lands you signed in instead of waiting for one more click.
- Submitting now **clicks the login button itself** rather than only submitting the form. The old code called `requestSubmit()`, which does nothing at all on pages whose button is `type="button"` with the submit logic in a script — the form looked fine and the page simply never moved. It now finds a login button in the form (then on the page) and clicks it, falling back to submitting the form only when there is no button. Button matching skips decoys such as "forgot password", "show password" and "register", and prefers "login / sign in / submit" text or a `type=submit` inside the form.
- Automatic submission is a layered switch, the same shape as "default browser": a global default in Settings, with a per-site override of "always" or "never". The "follow global" choice shows the value currently in effect, so a site's real behaviour is visible without reading two screens. Existing sites that were written with `false` by older versions keep that value — guessing which ones were never actually chosen would be worse than leaving them alone.
- The site form's submit checkbox became a three-way choice, and the account-bundle export/import carries the optional field.
- The view list can be dragged into any order: the list order is the display order, a row dropped onto another lands after it, and the order survives a restart. Dragging also works with a site or tag filter on, because the drop target is looked up by view id in the full list instead of trusting an index into the visible subset.
- The MCP site summary gained `autoSubmitEffective`, so an AI can tell whether a site will currently submit on its own.

**Developer tools**

- F12 and Ctrl+Shift+I now toggle the developer tools, from the page and from inside the panel; the toolbar button used to be the only way in.
- The docked panel can be resized by dragging its divider (clamped to 20–70% of the cell), with arrow keys for small steps; it used to be fixed at 42%.
- The "switch interface language" prompt no longer appears on every open; the language follows the app's setting. Note that Electron never remembers that choice — clicking it never survived a restart — so the app now answers the prompt itself on each open.

**Interaction and wording**

- Confirmations such as closing a view are their own warning layout — a mark, the question, two buttons — instead of a form shell with an empty middle.
- The clean-session entry moved into the title bar's browser menu and follows the global browser choice; the per-page clean-session buttons were removed.

## [0.4.0] - 2026-10-20

### 中文

- 新增运行实例悬浮条：始终置顶列出所有运行中的身份，点一下切过去，实时高亮真正在前台的那个窗口；切换后目标窗口上方会短暂显示账号名，也可以收成只占一点地方的小方块
- 账户页支持多选批量启动，不必逐个点击、被新窗口反复遮挡
- 新增会话健康中心：一屏看清谁正常、谁过期，没开窗口的身份也能在后台检测并批量重新登录
- 场景的「停止」改为只关闭该场景的窗口，其他场景和手动开的窗口不受影响；托盘菜单也能一次关闭全部实例
- 支持应用内自动更新：后台检查新版本，弹窗提示并可直接下载、校验和安装，不用再去 GitHub 手动下载

#### 完整变更

**悬浮条与窗口切换**

- **运行实例悬浮条**：桌面上的始终置顶小条，按环境分组列出所有运行中的身份。点一下就把对应的浏览器窗口提到最前，最小化会先恢复，**不重启、不重载页面**；可折叠、可隐藏、记住位置。
- 悬浮条实时高亮当前前台窗口：哪个窗口真正在前台，悬浮条里对应的那一行就高亮。读的是系统前台窗口，所以用任务栏或 Alt+Tab 切换也会跟着走，不是你点了哪一行才亮。
- **切换回执**：从悬浮条切过去后，目标窗口上方会短暂浮出半透明的账号名（约 2 秒后淡出），页面看起来都一样时也能确认切到了谁。浮层不挡鼠标、不抢焦点、不注入被测页面；设置里可关闭。
- 悬浮条可以收成一个**小方块**：只剩运行窗口数量，不占桌面、不压住页面，按住可拖动，松手自动贴到最近的屏幕边缘，点一下再展开。收起状态下没有标题和按钮，也不会出现系统窗口的缩放手柄。
- 修复悬浮条圆角处出现矩形黑边：窗口现在为阴影预留了绘制空间，圆角是真的透明，而不是把阴影裁成方形。
- 修复拖拽悬浮条时窗口被一点点撑大：改用固定尺寸移动，收起态不再变形。
- 悬浮条不设独立关闭按钮（和收起按钮相邻，容易误点）：改为右键菜单收起/隐藏，或在设置里重新开启。
- 修复悬浮条点击无法把失焦窗口提到最前：改用系统级窗口激活，不再只依赖 CDP 的标签页激活。
- 身份页与运行栏里，点击一个正在运行的身份现在是「切换到该窗口」（此前是直接关掉），停止改为独立按钮；外部模式（Firefox）的窗口也能从悬浮条切换。

**批量与关闭**

- **账户页批量启动**：进入多选模式勾选多个身份，一次按默认布局平铺打开，不必逐个点击、被新窗口反复遮挡；已在运行的身份会自动跳过。
- **场景级关闭**：场景详情里的按钮从「停止」明确为「关闭本场景窗口」，成员集合即场景当前的身份列表，单独重开过的窗口也会关掉；其他场景的窗口不受影响。此前这个按钮会关掉所有实例。
- 托盘菜单新增「关闭所有实例」，有窗口运行时才出现；悬浮条底部也有同一入口。

**会话健康**

- **会话健康中心**：身份页新增入口，一屏按「正常 / 已过期 / 未确认」分类。窗口开着就在窗口里检测；窗口关掉的身份会用一个不显示窗口的后台浏览器读取该 Profile 的 Cookie 后立即关闭，不占悬浮条、不需要手动启动。支持「检测全部」和「重新登录过期项」（自动打开登录页并填入已保存的凭据）。检测只在点击时发生，不会在后台定时访问被测系统。
- 设置里新增「后台检测的 UA」，默认把无窗口检测上报的 User-Agent 换成正常桌面浏览器的值（避免被测系统把检测当成爬虫），也可以选择如实上报无头 UA。
- 修复停止窗口后登录态丢失：关闭浏览器后会等它把 Profile 写完再回收进程，不再直接强杀，下次无窗口检测或重开窗口都能读到原来的登录态。

**场景与启动**

- **恢复上次场景**：设置里新增开关（默认关闭）。开启后冷启动会按原布局自动拉起上次使用的场景。
- 场景编辑对话框支持拖拽调整成员顺序，也可以把成员直接拖进布局格子指定位置；顺序即启动顺序。
- 新增「场景启动间隔」设置，默认 0ms，需要给被测系统留缓冲时可调大。
- 修复首次启动可能出现两个相同标签页：启动时固定 profile 的启动模式，并对同一 profile 的并发启动去重。
- 修复打开新窗口会重置用户手动调整过的窗口位置和尺寸：只有在所有窗口都仍在布局位置上时才会重新平铺。

**界面与体积**

- 身份与环境对话框的引擎、布局、职责等下拉框改为自定义面板；职责改为常用选项，且仍可自由输入。
- 环境切换下拉框现在点击标题栏任意空白处即可收起。
- 密码设置去掉重复输入：继承模式只显示当前来源和「修改默认密码」入口，自定义模式才出现输入框。
- 额外字段的说明改为按页面上的标签、占位符、name/id、aria-label 匹配，避免误解为代码变量名。
- 包体积：安装包从 116MB 降到约 99MB——只保留中英两个语言包，运行时依赖全部打进代码，不再附带 node_modules。
- README 与展示页补充五类典型使用场景：角色权限、租户隔离、功能开关与灰度、套餐差异、跨账号协作；首屏改用一张 SVG 总览图，中英各一版。

**自动更新**

- **应用内更新**：启动后几秒在后台检查一次，之后每 6 小时一次；发现新版本弹窗显示本版本的简短摘要，可一键下载、校验（SHA-256）并安装，安装完自动重启。设置里可以关闭自动检查；对某版本点「稍后」后，下一个版本发布前不再提示。
- **更新摘要与完整变更分开**：更新弹窗只显示摘要（本文件每个版本顶部的几条），完整变更保留在 Release 页面。

### English

- New running-instances overlay: an always-on-top strip listing every running identity. One click switches to that window, the window actually in front is highlighted live, and the account name briefly appears over the window you switched to. It can also collapse into a tiny square
- Batch launch on the identities page opens several accounts at once in the default layout
- New session health panel: see who is signed in and who expired on one screen, check identities whose window is closed in the background, and sign expired ones back in in a batch
- Stopping a scene now closes only that scene's windows, leaving other scenes and hand-launched windows alone; the tray menu can also close every instance at once
- In-app automatic updates: the app checks in the background, offers the new version in a dialog, and downloads, verifies and installs it without a manual GitHub download

#### Full changes

**Overlay and switching**

- **Running-instances overlay**: an always-on-top strip that lists every running identity, grouped by environment. One click raises that browser window — restoring it if minimized, without a relaunch or reload. It can be collapsed, hidden, and remembers its position.
- **The overlay highlights the window in front**: whichever window actually owns the OS foreground is highlighted, so raising one from the taskbar or with Alt+Tab moves the highlight too — not only clicks inside the strip.
- **Switch receipt**: after switching from the overlay, the account name briefly floats over the target window (~2 s, then fades), so you can tell which account you landed on even when every page looks the same. The pill is click-through, never takes focus, injects nothing into the page, and can be turned off in settings.
- The overlay can collapse into a **small square**: only the running-window count, no desktop space and no panel covering a page. Drag it anywhere and it snaps to the nearest screen edge; click to expand again. Collapsed, it has no title or buttons and the native window resize border is removed.
- Fixed a rectangular black fringe at the collapsed square's rounded corners: the window now reserves room for its shadow instead of clipping it at the frame.
- Fixed the overlay growing a little taller on every drag: it now moves at a fixed size, so the collapsed square keeps its shape.
- The strip has no close button of its own (too easy to hit next to collapse): hide it from the right-click menu, or turn it back on in Settings.
- Fixed the overlay failing to raise a background window: activation now goes through the OS instead of relying on CDP's tab activation alone.
- Clicking a running identity on the identities page or in the run dock now switches to that window (it used to stop it); stopping has its own button. External-mode windows (Firefox) can be raised from the overlay too.

**Batch actions and closing**

- **Batch launch on the identities page**: a selection mode picks several identities and opens them all at once in the default layout, instead of clicking one by one while every new window covers the next card. Identities already running are skipped.
- **Scene-level close**: the scene detail button now says "Close scene windows". Membership is the scene's current identity list, so a member reopened on its own is closed too, while other scenes are untouched. The button used to close every instance.
- New "Close all instances" entry in the tray menu, shown only while windows are running; the overlay has the same action at the bottom of its list.

**Session health**

- **Session health**: a new entry on the identities page groups the current environment into signed in / expired / unconfirmed. An open window is checked in place; an identity whose window is closed is checked in a hidden browser that reads that profile's own cookies and closes again, so it never shows up in the switcher and never needs a manual launch. Check everyone at once, or sign in every expired identity by opening its login page and filling the saved credentials. Checks run only when you click, never in the background.
- New "background check user agent" setting: hidden checks report a normal desktop UA by default so the site under test does not treat them as a crawler; the true headless UA can be selected instead.
- Fixed login state being lost after stopping a window: the browser now gets to finish writing its profile before the process is reclaimed, so the next hidden check or reopen still finds the session.

**Scenes and launching**

- **Restore last scene**: a new setting (off by default). When enabled, a cold start reopens the last used scene in its saved layout.
- Scene editing now supports drag-and-drop reordering, and members can be dragged straight into a layout cell; the order is the launch order.
- New "launch interval" setting, 0ms by default, for systems that need breathing room between windows.
- Fixed two identical tabs appearing on first launch: the profile's startup mode is pinned and concurrent launches of the same profile are de-duplicated.
- Fixed opening a new window resetting positions and sizes the user had adjusted by hand: windows are only re-tiled while every window still sits where the layout put it.

**Interface and size**

- Engine, layout and role pickers in the identity and environment dialogs are now custom panels; role suggestions cover everyday cases while free text still works.
- The environment switcher now closes when you click anywhere else on the title bar.
- Password setup no longer asks twice: inherit mode shows where the password comes from plus an "edit default" action, and only custom mode shows an input.
- The extra-fields hint now explains matching by on-page label, placeholder, name/id and aria-label, so it is not mistaken for code-level variable names.
- Package size: the installer dropped from 116MB to about 99MB by shipping only Chinese and English locale files and bundling runtime dependencies instead of shipping node_modules.
- README and the landing page now describe five typical scenarios: roles and permissions, tenant isolation, feature flags and rollouts, plan differences, and multi-account collaboration, and open with a single SVG overview (Chinese and English generated from one source).

**Automatic updates**

- **In-app updates**: a background check runs a few seconds after launch and then every 6 hours. A new version opens a dialog with that release's short summary and can be downloaded, verified (SHA-256) and installed in one flow, restarting the app on its own. Automatic checks can be turned off in Settings; choosing "Later" for a version keeps it quiet until the next release.
- **Update summaries are separate from full changes**: the dialog shows only the summary at the top of each version section here; the full change list stays on the release page.

## [0.3.0] - 2026-10-20

### 中文

- 新增 7 步聚光灯新手引导，首次打开自动播放，可在设置里随时重播。
- 新增展示页 <https://onefanki.github.io/ensemble/>，中英双语，版本徽标随发布自动更新。
- 主题「跟随系统」现在会立即生效，并在系统切换深浅色时实时跟随。
- 新 logo：深色底板上的窗口叠放；应用图标、标题栏、托盘图标同步更新。
- macOS 菜单栏图标改用模板图像，正确适配浅色/深色菜单栏。
- 文档：新增产品路线图，明确「多身份并行验证」的定位与不做指纹伪造的边界。

### English

- Added a 7-step spotlight onboarding tour, shown on first launch and replayable from Settings.
- Added the landing page <https://onefanki.github.io/ensemble/>, bilingual, with a version badge that follows releases.
- The "System" theme now applies immediately and follows OS appearance changes live.
- New logo: stacked windows on a dark plate; app icon, title bar and tray icon updated together.
- The macOS menu bar icon is now a template image, so it adapts to light and dark menu bars.
- Docs: added the product roadmap, stating the multi-identity positioning and the no-fingerprint-spoofing boundary.

## [0.2.0] - 2026-10-20

### 中文

- 关于页新增「检查更新」：对比 GitHub 最新 Release，可直接打开下载页。只做检查，不会自动下载或安装。
- 关于页新增 GitHub 仓库入口。
- 构建：升级 GitHub Actions 到当前大版本，并合并依赖机器人提交。

### English

- The About tab can now check for updates against the latest GitHub release and open the download page. It only checks — nothing is downloaded or installed automatically.
- Added a GitHub repository entry to the About tab.
- Build: upgraded GitHub Actions to their current major versions and merged the dependency bot updates.

## [0.1.0] - 2026-10-20

### 中文

首个版本。

- 环境 / 身份 / 场景三层模型：一个身份一个独立浏览器 Profile，登录态与 Cookie 完全隔离。
- 驱动系统里真实的 Chrome / Edge / Brave / Vivaldi / Firefox，不内置、不打包浏览器。
- 启动自动填充账号密码，支持租户名等额外登录字段（环境级下发、身份级覆盖）。
- 场景一键拉起一组身份，按布局边到边平铺；槽位可拖拽指定，成员可单独重开。
- 内置无布局 / 1×1 / 2×1 / 1×2 / 2×2 / 3×1 布局，也可拖动画出并保存自定义预设，带吸附与对齐参考线。
- 凭据保护：系统密钥环（DPAPI / Keychain / keyring）加密，可再加应用主密码。
- 干净会话：不登录、关闭即删除的临时窗口，也可开一个不属于任何环境的空白会话。
- 内置 MCP 端点，AI 客户端可直接录入环境、身份与场景。
- 配置导入导出（密码可选口令加密）、关闭进托盘、按 Profile 路径精确回收浏览器进程。
- 发布 Windows / macOS / Linux 三平台安装包，均为未签名产物，安装时需按文档放行。

### English

First release.

- Environment / identity / scene model: one dedicated browser profile per identity, so sessions and cookies never mix.
- Drives the real Chrome / Edge / Brave / Vivaldi / Firefox installed on your machine — no bundled browser.
- Fills credentials on launch, including extra login fields such as tenant codes (set per environment, overridable per identity).
- Launches a group of identities as a scene, tiled edge to edge; drag members onto slots and reopen a single member.
- Built-in no-layout / 1×1 / 2×1 / 1×2 / 2×2 / 3×1 layouts, plus a drag-and-drop editor for saved presets with snapping and guides.
- Credential protection through the OS keychain (DPAPI / Keychain / keyring), optionally hardened with an app master password.
- Clean sessions: throwaway windows deleted on close, including a blank one that belongs to no environment.
- A built-in MCP endpoint lets an AI client record environments, identities and scenes.
- Workspace import/export (optional passphrase-encrypted passwords), close to tray, and precise process reclamation by profile path.
- Windows / macOS / Linux installers, all unsigned; the docs explain the one-time OS prompts.
