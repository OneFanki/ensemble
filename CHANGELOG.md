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

- 新增日常档案：不带身份的标签（新标签页、书签、地址栏输入）登录一次长期有效，可以直接拿它当日常浏览器，也让 AI 在已登录的页面上帮忙做事
- 新增书签：新标签页上一排图标，只有名字和地址，双击改名、右键删除、拖拽排序；地址栏的星标一键收藏当前页
- 「从站点打开」多了「日常打开」，与「干净打开」并列；干净打开现在是真正的临时会话，退出即消失

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

**交互与措辞**

- 关闭视图这类确认弹窗重做成独立的警示样式：图标 + 问题 + 两个按钮，不再是一个中间空着的表单框。
- 干净会话的入口统一到顶栏的浏览器选择菜单里，跟随全局选择决定用内置还是外部浏览器；各页面里散落的「干净会话」按钮已移除。

### English

- New daily profile: tabs with no identity (new tabs, bookmarks, typed addresses) stay signed in across restarts, so the built-in browser works as an everyday browser and an AI can act on pages you are already signed in to
- New bookmarks: a row of icons on the new tab — a name and an address, double-click to rename, right-click to remove, drag to reorder — plus a star in the address bar
- "Open from site" gained "Open daily" next to "Open clean"; a clean open is now a real throwaway session that ends with the process

#### Full changes

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
