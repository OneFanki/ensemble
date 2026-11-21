# 更新日志 / Changelog

每个版本的更新内容写在这里，GitHub Release 的正文由 `.github/workflows/release.yml`
按版本号从这个文件抽取，所以发版时只需要改 `package.json` 和这里。

- 准备发版时，把 `package.json` 的 `version` 改掉，并在本文件顶部加一节 `## [x.y.z] - YYYY-MM-DD`；`scripts/release-notes.mjs` 会按版本号抽出这一节当作 Release 正文。

## [未发布]

补齐 AI 操作页面的能力：动作缺口、网络观察、环境模拟、元素句柄、流程编排脚本与
能力查询；修掉几处会让页面「看起来死了」的阻塞，并把流程的原始 CDP 步骤做成有
档位判定的逃生口。同一波把浏览器界面收成单舞台加左栏账号列：标签行回到窗口首行，
账号按站点分组集中在左栏一个入口里，页面可拆出到独立窗口，冻结与更新提示也换上
新的规则。

### 中文

#### 新增

- **顶层两行定形：账号与标签同排，地址行整宽在下。** 窗口首行左半是账号条、右半是页面标签，地址行整宽占第二行，舞台拿到下面的整幅宽度。账号条按内容撑开、上限半窗、超出横向滚动；页面标签按标题撑开（上限 184px），放不下时整行横向滚动，而不是把每个标签一起压到只剩三个字。左栏与它的折叠开关一并撤除——它既长期占着页面一条像素，又只够显示十个字左右的名字。
- **账号条目改右键关闭**。常驻的小叉在条目宽度下要占掉一段名字，而且很容易误点；关闭一个会话本来也不是随手动作，现在放在条目的右键菜单里，和浏览器里关标签同一个手势。系统浏览器实例的菜单项叫「停止」。
- **AI 状态点扩到页面标签，并改成「有动才显示」**。账号条回答「AI 在不在这份账号上」，标签要回答「在不在这一个页面上」——一个账号可以开三页而只有一页在被驱动，所以状态按页记录（日志本来就带 tabId）。标签静止时不画任何点：一个常亮的灰点等于让每个标签多长一颗天天要读的图标，却什么也没说。
- **状态点的悬停说明挂在整条上**。角标只有 6px，要求指针停在角上才能知道它什么意思，等于没解释。现在悬停给一层：同色小点、一句状态（「AI 正在操作」/「AI 最近操作 · 时间」）、完整账号名，以及冻结说明。标签的悬停同理由原生 `title` 换成应用自己的层，因为它要带那颗点、还要给出页面标题与地址。
- **账号面板的模式开关加回文字**。只有两个图标时，网格与铅笔都是猜——铅笔可能是「编辑这个账号」也可能是「编辑这份清单」。现在写「启动视图」「编辑视图」，图标留作前导标记。
- **词表统一为身份与账号**。隔离容器（一个独立 cookie 罐子）在界面上叫**身份**：默认身份、干净身份、自建身份；站点下的条目仍叫**账号**。原来的「会话」「档案」两个词都退役，包括工具栏与面板标题、服务端报错、MCP 工具描述。存储字段与 id 不变——那是磁盘上已有数据的键，改词不改数据。
- **身份管理并入账号面板的编辑态**。设置页的独立「会话管理」页撤除：创建、重命名、设为默认、删除都在编辑视图左栏的「全局」组里，加号在组标题右侧，每行的写操作悬停才出现（一行常驻三颗图标会把 200px 的列压得只剩四个字）。设置页是改应用行为的地方，不是一个挑「以谁的身份上网」的地方。
- **左栏分成「全局」与「站点」两组**。全局身份在站点之上：它不属于任何站点，所以放在站点列表外面而不是里面。启动全局身份开一张空白页（它没有可导航的入口），启动站点账号导航到该站点的登录入口并自动填充——两种落点共用同一条打开路径，由主进程按传参决定。
- **地址栏的新建按钮撤除**。工具栏原有一个「+ ▾」两半按钮（主半开空白页、箭头半开账号选择窗）。页面、身份、站点账号是同一个问题的三个答案，而它们都住在首栏那条清单里：空白页走标签条自己的「+」，身份走账号条左侧的加号，站点与账号走账号面板。`OpenSiteButton` 与 `SiteOpenMenu` 随之退役。
- **单舞台与左栏账号列**。主界面收成一个舞台：标签行在窗口首行，地址栏整宽占第二行，左栏是竖向账号列（站点图标 + 账号名），点谁谁上台，其余实例在后台保持登录运行、AI 照常驱动。左栏顶部是「多账号」入口——它叫多账号而不是账号，因为这里管的是多个账号的清单，叫账号会读成「我自己登录的那个账号」。视图页与分组、布局编排入口撤除，工作区数据里的 `views` 字段原样保留、读写不丢。AI 状态与冻结状态是头像两个角上的小圆点——正在操作时呼吸、30 分钟内动过常亮，冻结一个灰点；挂在角上而不是插在名字旁边，因为它们是这个头像代表的东西的状态，插在行里等于每个名字都短两个字的宽度（栏因此从 148px 收到 132px，反而能放下完整的「管理员 · 主账号」）。
- **点击浮层外任何位置都能关闭**。遮罩原本只盖页面区域，左栏与地址栏留了活口，想着能一边开浮层一边切账号；实际上浮层占 60% 宽，用户想关它时瞄的是「不在浮层上」，那两条边正好是点空失败最多的地方。现在遮罩铺满整窗。
- **账号页的搜索同时匹配站点**。账号名在不同站点上高度重复（每个系统都有一个「管理员」），只按名字搜等于问「这十二个管理员是哪个」。现在搜站点名或地址也会命中该站点下的账号，两件事一起做，用户不必先想「我在搜哪种东西」。
- **账号页分启动与编辑两张脸**。打开账号浮层看到的是启动视图：站点是分组标签，账号是瓦片（头像 + 名字 + 状态点），点一张就打开那个账号——这是打开这个浮层几乎每次的目的。左上角的开关切到编辑视图，那里才是行列表：角色、密码状态、运行状态、每行操作、筛选、批量选择、会话健康，以及新建账号与新建站点的入口。所有写操作都留在编辑视图，因为一张既能启动又能编辑的瓦片，一半的点击会做错事。左栏不再有单独的打开发起入口：启动面板原本和账号页是同一份数据的两种画法。
- **账号页改成主从两栏（级联面板）**。左栏是「会话 + 站点」列表，右栏是选中站点的账号：启动视图里是瓦片，编辑视图里是表格。一个站点在左栏只占一行，与它有几个账号无关，所以站点变多只是列表变长，不会把整页推下去；两栏各自滚动。
- **搜索挪到左栏顶部，并且能搜站点**。它原来在右栏、压在账号列表上方，位置本身就在说「这里搜账号」，而实际最常搜的是站点。现在它在被过滤的那份列表正上方，占位文案写明「搜索站点或账号」：按站点名过滤站点，按账号名保留该账号所属的站点，两个方向同一个输入框。
- **浮层头部不再画自己的底**。原来标题栏有一层抬高底色加一条分割线，在毛玻璃表面上读起来像两个窗口叠在一起；现在标题和控件直接坐在同一张面上。
- **多选条不再是卡片**。它原来有边框、底色和圆角，像往页面里插了一个面板；现在和启动面的操作条一个样子，靠「已选 N」和强调色的启动按钮和列表区分。
- **打开页面即收起浮层**。点账号、点会话、批量启动之后浮层自动关闭，内置与外置两种表面一致——打开浮层是为了开一个页面，页面出来了就不该再多点一次关它。
- **批量启动两张脸都有**。启动视图右栏控制行最右是勾选入口，进入后原地换成操作条；勾选只属于当前站点与当前那张脸，切站点或切面时清空。
- **会话启动行回到账号浮层顶部**。默认会话、干净会话与自建的会话各占一枚 chip，点一下就在该会话里开一个空白页；干净会话排在最后、用虚线画，因为它是一次性的那个。会话的写操作（新建、改名、删除、设为默认）在设置页「会话管理」里，界面上原来叫「档案」的地方统一叫「会话」。
- **多选条去掉了强调色底**。它原来是强调色的淡底加同色描边，一个模式提示读起来像警告，而且条里的「⋯」与取消图标都沉进那层色里看不见了。现在只靠高度区分：底色与边框回到中性灰，强调色只留在「启动所选」这一个按钮上。
- **浮层标题栏真正成了标题栏**。它原来只有一个「×」贴在右上角，整条带子空着——用户看不出这个浮层叫什么、为什么在那里结束。现在左侧是标题「多账号」，右侧依次是视图开关、编辑视图下的新建账号与新建站点、以及关闭。视图开关也移了进来：它选的是「浮层的哪一面」，那是关于浮层本身的事实，放在正文里会把正文顶下去。
- **账号栏默认收起，开关在标签行最左端**。开窗时没有任何账号在运行，而这一栏是「切换正在跑的账号」用的，所以它默认不占位置，窗口就是一个干净的浏览器。开关放在每款浏览器都放侧栏按钮的地方——标签行最左端；展开状态记住，常用的人不必每次重开。浮层的左偏移跟着一起变：栏收起时它从窗口左缘开始。
- **浮层里的版式按浮层重排**。这个浮层原来套用的是整页的管理台版式，几处都站不住：标题「账号」和副标题「4 个账号」在打开它的按钮已经写明名称、筛选标签已经带着数字的情况下，只是每次多读两行字，现在不再单独占一行（名称进了浮层标题栏）；筛选、搜索与列表级操作收进一行，搜索框吸收多余宽度，不再换行把某个按钮挤到第二排；站点分组之间改用留白分层——组头之上 28px、之下 6px——不再是一条下划线紧贴着下一张表的表头。分组筛选条只在一个以上分组时出现，一个分组不构成选择。
- **站点按名称排序**。站点曾经靠拖拽手柄排顺序，那是「两个站点谁在上」这种没人能预测的记忆负担；现在一律按名称排，重命名后立刻重排，列表对每个人都是同一个顺序。底层 `moveSite` 通道保留，不再有界面入口。
- **新建会话直达空白**。主按钮点开就是一张空白页：不预选站点、不弹账号面板；要按站点或账号开页时，再从选择面板走明确的一步。
- **站点成为账号的分组，站点页退役**。站点不再是独立的页面，而是账号页上的分组头：组头显示站点名、地址与所属分组，展开就是它的账号；「新建站点」按钮就在账号页上，站点与分组的编辑也在原地完成。账号归属于唯一的站点，不再需要先理解「站点」和「账号」两个并列概念。
- **标签改称站点分组，只作用于站点**。原来的标签现在叫站点分组，只用来给站点归类；账号与视图上的标签在读入时丢弃——它们本来就跟着站点走，账号页的分组也一直按站点划分。
- **更多退出舞台，内容页收进设置**。左栏不再有「更多」入口；书签、消息、流程与站点分组都搬进设置页，设置页的 tab 分成「偏好」（通用、引擎、凭据、数据、MCP、关于）与「内容」两组。AI 记录留在地址栏旁的按钮里：面板只列最近几条，「查看全部」把同一份日志摊开在浮层里，看的地方还是浏览器上方。
- **账号自带独立登录态，会话单独管理**。每个账号的登录数据（Cookie、会话）各自独立保存，新建账号不再问隔离：说明与「清除会话数据」收进账号表单的高级折叠项，默认收起。没有账号的页面——新标签页、书签、地址栏输入——统一落在默认会话。会话本身仍是可管理的对象，入口在设置页「会话管理」（新建、改名、删除、设为默认），启动入口在账号浮层顶部的一行会话 chip 上。检测到存量的自建档案时，设置页会出现一次性迁移向导：可合并（磁盘数据保留，已登录页面需重新登录），也可选择保留并不再提示。
- **实例拆出到独立窗口**。页面可从标签右键菜单拆到独立的 OS 窗口，配合系统分屏与多显示器并排观察；再点一次收回主舞台，同一实例同时只允许一个拆出窗口。空白页没有内容可搬，不提供拆出。拆出即页面重载：SPA 内存态不保留，登录态与存储随会话分区保留。MCP 侧新增 `pop_out_browser_tab`（run 档）。
- **冻结按「用户可见」判定**。窗口最小化或隐藏到托盘时，台上页面照常冻结；批量启动落在后台的实例与 AI 开出的页面闲置后同样入冻。豁免原因随页面状态可见（`sleepExempt`：台上可见 / 有声 / AI 在操作 / 策略等），AI 据此判断谁在占资源；左栏条目带冻结标识（全部页冻结灰标、部分冻结半标），退出时打点记录冻结状态。
- **更新提示汇总区间版本**。更新弹窗把当前版本到最新版本之间的每个 release 各展示一节，升序排列，最多 10 节，更早的折叠为一句计数；单个版本没有说明时显示占位文案。
- **补齐动作缺口**：悬停、滚动、组合键、前进/后退/刷新、JS 弹窗的读与答、文件上传、拖拽、复选框设值、元素信息读取、元素裁剪截图。每一项都配了 e2e，断言的是「页面真的变了」而不是「工具返回了 ok」。
- **流程的原始 CDP 步骤**：`cdp` 步骤可以跑协议层命令，但要先过三档白名单——只作用于当前页面的默认开放，改网络与设备模拟的需要在设置里开启，跨身份与影响整个进程的一律拒绝且不可解锁。一趟流程用超过两次会提示可能缺一个封装动作。
- **`run_flow` 的 `timeoutMs`**：默认 120 秒、上限 10 分钟，由调用方指定。
- **网络观察**：`read_browser_requests` 读回页面已收集的 fetch / XHR（地址、方法、状态码、耗时），只读不清空，可按 URL 子串、方法、状态码过滤，并带出已发出还未返回的请求；`wait_browser` 与流程的 `wait` 步骤多了 `load`（文档加载完成）与 `response`（某个请求返回且状态码匹配）两个等待条件。
- **环境模拟**：`set_browser_emulation` 按键设置或清除时区、CSS 媒体类型、断网与地理位置，四项互相独立，返回当前生效的全部模拟项，标签页关闭即全部丢弃。geolocation 只提供坐标，不授予权限——页面没被用户授权时它的定位 API 仍会被权限检查拦下。
- **元素句柄**：`find_browser_element` 按语义条件（文字包含 / 文字排除 / 可见 / 第 N 个）定位并返回句柄，点击、悬停、输入等动作工具可以用句柄代替定位字段。页面重渲染后句柄经文本特征对齐仍指向同一元素，导航即失效；既有工具的定位方式保持不变。
- **流程的 `script` 步骤**：一段 JS 跑在 `node:vm` 里做循环、条件与计算，能调用的原语就是流程动作集（`login` 与原始 `cdp` 不在其中）。vm 是能力边界而非硬沙箱——构造器逃逸实测可达，这条边界写进了工具描述与文档，真正的防线在 MCP 权限档位。
- **能力查询**：`read_browser_capabilities`（read 档）一次读出当前标签页支持哪些动作，表面的可选能力是实测检查的结果。

#### 修复

- **一次 `confirm()` 让页面「死了」30 秒**。JS 弹窗打开期间页面完全阻塞，触发它的那条输入命令永远不会返回，之后的读页面全部超时——调用方看到的是「点了没反应、选择器写错了」。现在弹窗一出现就被记账，页面动作在发命令前就报错并点名弹窗类型与内容；无人回答时 30 秒自动取消。
- **流程超时被写死**。`run_flow` 之前无论调用方怎么给都用两分钟，慢操作必然失败而工作仍在后台跑；`wait` 步骤还会用一个 30 秒的等待吃掉整个流程预算，然后把错误报成「条件没满足」。
- **元素截图按设备像素而不是 CSS 像素输出**。1.5 倍屏上 200×80 的元素截出来是 300×120。
- **`wait_browser` 与 `check_element_visible` 可用元素句柄，失效的定位不再被静默吞掉**。之前观察类工具走的是与动作工具不同的定位路径：传进来的 `handle` 字段被当普通字段忽略，句柄在页面重渲染后失效会被降级成 `exists: false`、或被当成「条件未满足」磨到超时。现在两者与动作工具共用同一条句柄解析路径，句柄失效照常报错并点名原因。
- **定位命中多个时如实告警、未知参数在入口拒绝、`text` 定位覆盖有自身文字的非交互元素**。之前直连定位命中多个会静默点第一个，调用方无从知道页面里还有别的同款；schema 没声明的字段被静默忽略，写错字段名（例如把 `hasText` 传给动作工具）等于什么都没传，可能点错目标；`text` / `role` 只匹配可交互元素，文字写在容器上的按钮与可点击区块定位不到。现在多匹配仍点第一个但返回 `warning` 写明匹配数；未知字段报错并列出字段名，`find` 专属的收窄字段传错工具会被点名去处；`text` / `role` 同时匹配可交互元素与有自身文字的可见元素（纯容器不算）。
- **`select` 按 option 精确匹配且失败必报，label 绑定不再把值写进相邻字段**。之前 option 匹配是子串式的模糊命中，选错也不报错；裸表单里 label 按文档序取第一个控件，账号、密码、备注连排时值常被填串。现在 option 按文本精确匹配（折叠空白，不再子串），匹配不到报错并给出可选列表；label 绑定取离标签最近的控件而不是文档序第一个。
- **动作返回与页面真相对齐**。之前点击的 `hit` 在松开后回读，页面在点击处理里替换 DOM 时会误报 miss；`scrolled` 回报的是发出去的位移而不是容器实际滚动的差值；拖拽只说「做过了」，页内有没有收到 drop 无从知道；`Ctrl+A` 这类编辑组合键只派发了键盘事件，页面没有全选。现在 `hit` 以按下瞬间为准、另给松开后的 `hitAfter`；`scrolled` 等滚动稳定后回读容器位置取真实差值；拖拽返回 `dropped` / `dropAt` / `droppedAtTarget` / `reordered`，页内没收到 drop 或坐标异常时 `warning` 说明且不算成功；常见编辑组合（Ctrl+A/C/X/V/Z、Ctrl+Shift+Z）随 keyDown 派发 Chromium 编辑命令，效果对后续输入可见。
- **动作触发弹窗时毫秒级返回，无人再替调用方抢答**。之前一条输入命令触发 alert / confirm 会挂到命令上限才超时，超时与流程预算的清理路径还会顺手把弹窗答掉；被 beforeunload 拦下的导航让页面看起来卡死；弹窗挂起时 CDP 会话分离，弹窗以原生对话框漏到桌面。现在触发弹窗的动作在弹窗打开瞬间返回，`dialog` 带类型与内容、`hint` 指引先答；工具超时一律不动弹窗，自动取消只剩「超预算无人应答」一条路；被 beforeunload 拦下的导航快速返回 `cancelled: "beforeunload"`，页面留在原地可继续操作，`read_browser_dialog` 标出 `pageBlocked: false`，`handle_browser_dialog` 可答去留（接受即重发导航并等它完成）；弹窗挂起期间会话保持附加。
- **截图文字可读、元素裁剪不再出黑图**。headless 透明窗口下无背景页面的整页截图是垫黑的透明图，页面上的 label 与标题读不出来；fit 缩放页面的合成器只覆盖布局视口大小，元素截图底部落在透明带里直接出黑图；页面 zoom 不为 1 时裁剪范围还会把 zoom 烘进换算，截到的区域整体偏移。现在带 alpha 的 PNG 落盘前合成到白底（等价浏览器对无背景页面的呈现），zoom 不为 1 的裁剪在布局锁定期内测量并截图，fit 页面强制重光栅化后再读像素。
- **流程步骤的地址按站点根拼接、`login` 步骤报告做了什么、步骤枚举报错带步骤序号**。之前步骤里 `/list` 这样的路径按 URL 标准语义盖掉站点的路径前缀（baseUrl 是 `…/app` 时落到 `…/list` 而不是 `…/app/list`）；`login` 只返回 ok，填了有没有提交要自己猜；`action` 写错时 zod 原文既不指出第几步也不是业务语言。现在 `/` 开头的路径拼在站点根上，`login` 返回「已填入并提交，等待跳转」或「站点未开自动提交，需自行点击」这样的一行结果，枚举报错写成「第 N 步（action）只支持 …，收到 …」。
- **`read_browser_console` 的对象参数可读、宿主自身的警告默认不收录、性能统计不再被空闲稀释**。之前 console 打出来的对象永远是 `[object Object]`；Electron 未打包时的安全警告混进页面日志分不清来源；`measure_browser_performance` 的统计窗口在没人观察时也一直往前滚，一次短暂的满载被长段空闲摊平。现在对象参数在页内序列化成单行（一到两层属性、数组列元素、循环引用与超长截断标注）；宿主输出默认排除并报 `hostHidden` 计数（`includeHost: true` 可收回）；采样窗口随 AI 活动续期，返回本次观察区间与缓冲区全窗口两套统计。
- **实例锁在崩溃 / 强杀后自愈，被活进程持有时明确报因**。之前锁文件残留会让下一次启动反复失败，报错也不说锁在谁手里。现在锁文件独占打开，读到死进程的残留直接清掉再启动；锁被活进程持有时报出 PID，说明已有实例在跑并给出锁文件路径。
- **静音图标只在出过声的页面显示，AI 不再静音从未出声的页面**。之前标签条的声音图标只看当前的 `audible` 标志，页面一停声图标就消失——静音着的页面反而看不见图标；AI 操作页面会顺手静音，包括那些从来没出过声的页面。现在「出过声」作为页面一生的状态被记住并决定图标（静音与否都显示）；AI 的自动静音只落在正在出声的页面上。
- **登录捕获判定收紧，非登录表单不再提示保存账号**。之前页面上有一个密码框就可能触发保存提示，注册（双密码框确认）、改密、确认框旁重输密码这类形态都会弹出来，攒下半成品的账号。现在只有密码框自己的表单里带着账号字段、提交意图也来自同一表单时才捕获；空账号或空密码、金额确认框旁的密码框都被排除。

#### 优化

- **地址栏与搜索框的聚焦效果改为一笔画到底**。原来是描边绕外框跑一整圈（500ms）、再等 350ms 才淡入稳定态，点进去将近一秒才「亮好」。现在改成上下两条边同时从左端向右铺开，170ms 到位，铺满即是终态，没有第二段。竖边不再绘制——输入框本来就嵌在一行里，四面封口会读成第二个边框。
- **界面与工具说明统一改称「账号」**。同一个东西原来在界面里叫「身份」、在数据里叫 identity、在工具说明里又是另一个说法；现在界面、错误提示与 MCP 工具描述一律叫账号，只有存储字段仍是 `identity`，不影响已有数据。
- **MCP 返回体瘦身**。列表返回封顶：`list_flows` 流程多于 50 条时返回前 50 条并标 `truncated`，步骤值截到前 200 字符、超 60 步截到 60（`run_flow` 用完整定义，不受预览截断影响）；书签只回 `hasFavicon` 标记，图标内容不再进上下文；浏览器状态类返回只保留决策字段，图标 data: URL、窗口几何、缩放等渲染层数据不出走；`evaluate_browser_page` 返回值超过 64KB 时拒绝返回并说明，先在表达式里聚合或分页再取小结果。
- **`run_flow` 的 `click` / `fill` 改为调用与工具相同的实现**。两份逐行相同的代码合并成一份，流程自动继承「点击落点」诊断。
- **e2e 的 CDP 客户端抽成一份**。43 个脚本曾各自内联一份约 27 行的 WebSocket 客户端，29 份字节级相同——现在统一在 `scripts/lib/e2e-cdp.mjs`。
- **e2e 的内联 CDP 客户端归零**。截图、DOM 解析与代理脚本里剩下的 3 份内联客户端也改用 `scripts/lib/e2e-cdp.mjs`，脚本目录里的 WebSocket 连接代码只剩公共客户端这一份。
- **README 截图重出，设备度量覆盖首次真正生效**。截图脚本的 `Emulation.setDeviceMetricsOverride` 把参数名写成了 `deviceScale`（正确名是 `deviceScaleFactor`），这条命令一直被协议拒绝；旧内联客户端把协议错误吞成 `undefined`，脚本对失败毫无察觉。换用公共客户端后错误直接报出，修正参数名后全量重出 45 张，两张清单早有而文件缺失的引导页图一并补齐。
- **账号页收成一套表格，分组头与表头不再叠两层线，操作列也不再又宽又乱**。
  - **「列表 / 表格」两态合并为表格**。两者共用同一份行标记、同一条网格线，差别只有 6px 行距和一行列头——不是两种视图，是同一个表格少画一行字。切换按钮与两项设置随之删除；页面现在无条件按表格排：每组的列头是顶盖，组内最后一行是桌脚，中间的行只保留侧边与下边框。
  - **站点作为分组头，不再另起一页**。原先站点页与账号页各自画一遍表头，站点分组的分割线又叠在表头上；现在站点就是账号页上的分组头，一行承担站点名、地址、所属分组与「新建账号」入口，下面直接排它的账号，只有一层列头。
  - **操作列不再又宽又乱**。账号行的三个文字动作与站点行上的新建入口都改成了图标按钮，同一簇里不再混两种宽度和两种字号；紧凑启动控件从 22px 提到 24px，与 `IconButton` 等高，整簇贴齐列尾。原先账号行的操作组会吸收列内所有空余宽度，于是三个动作贴左、铅笔孤零零贴右——现在整簇是一个右对齐的簇。腾出来的宽度还给了地址、角色与状态这些要读的列。

### English

Fills in what an AI can do to a page — the missing actions, network observation,
environment emulation, element handles, flow scripting and capability queries —
fixes several ways a page could look dead, and turns a flow's raw CDP step into a
tiered escape hatch. The same wave collapses the browser surface into a single
stage with an account column on the left: the tab strip returns to the window's
top row, accounts sit under one entry grouped by site, pages pop out to their own
window, and new rules for freezing and update notes.

#### Added

- **One stage, an account column on the left.** The main window is a single stage: the tab strip owns the window's top row, the address row spans the second, and the left column lists running accounts (site icon, account name). Click an entry to bring it on stage; the rest keep running signed-in in the background, still drivable by AI. The column's entry at the top says "Accounts" rather than "Account" because it is the list of all of them — the singular reads as "the one I am signed in as". The views page and its grouping and layout choreography are gone (the `views` field in workspace data is kept untouched, and read-write round-trips lose nothing). AI and freeze state are small dots on the avatar's corners — breathing while operating, steady when active within 30 minutes, grey when the pages are asleep — because they describe the thing the avatar stands for; inline they cost every name two characters of width (the column went from 148px to 132px and still fits "管理员 · 主账号" whole).
- **Clicking anywhere outside the pane closes it.** The scrim used to cover the page area only, leaving the account column and the address row live in the hope that a pane and a page could be used side by side. In practice the pane is 60% of the window, so dismissal aims at "not the pane", and those two strips were exactly where a click landed and did nothing. The scrim covers the whole window now.
- **The accounts search matches sites too.** Account names repeat across sites — every system has an "admin" — so a name-only search answered "which of these twelve admins". Searching a site's name or address now matches its accounts as well; both are tried together, so no one has to decide which kind of search they are doing.
- **The accounts pane has a launch face and an edit face.** It opens on the launch face: sites are group labels, accounts are tiles (avatar, name, one status dot), and clicking a tile opens that account — which is what the pane is for almost every time. A switch at the top left turns it into the edit face: rows with role, password state, running state, per-row actions, filters, batch selection, the session health check, and the entries for creating an account or a site. Every write lives on the edit face, because a tile that both launches and edits does the wrong thing half the time. The rail no longer carries a launch button of its own: that panel and this page were two drawings of the same data.
- **The pane's head is finally a header.** It held a lone "×" in the top corner with the rest of the band empty, so the pane never said what it was or why it ended there. The title now sits on the left — "多账号" — and the right side carries, in order, the face switch, the edit face's new-account and new-site entries, and close. The face switch moved into the head because it chooses which face of the *pane* is showing: that is a fact about the pane, and in the body it pushed the content down when it appeared.
- **The account rail starts collapsed, and its switch is the tab strip's leftmost control.** A fresh window has no running accounts, and the rail exists to switch between them — so by default it takes no room and the window is just a browser. The switch sits where every browser puts a sidebar toggle. The open state is remembered, so anyone who works with the rail does not reopen it every launch. The floating pane's left offset follows: with the rail hidden the pane starts at the window's left edge.
- **The pane's layout is laid out for a pane.** It had been wearing the full-page admin layout and it showed. A title saying "Accounts" over a subtitle counting them restated what the button that opened the pane says and what the filter tabs already carry — the name lives in the pane's head now, and the body starts with filtering. Filter, search and list-wide actions share one row, with the search field absorbing the slack instead of letting an icon drop to a second line. Site groups are separated by air — 28px above a heading, 6px under it — instead of a rule that sat against the next table's cap. The site-group filter only appears from two groups up: one group is not a choice.
- **Site reordering is reachable again.** When a site became a group heading, `moveSite` briefly had no entry point at all; each site heading on the edit face now carries a drag handle, and dropping it on another heading swaps their places. The handle is drawn on the edit face only.
- **New sessions start blank.** The primary button opens a blank page directly: no site preselected, no account panel; picking a site or account is an explicit step from the chooser when wanted.
- **A site is an account's group, and the sites page retires.** A site is no longer a page of its own but a group heading on the accounts page: the heading carries the site name, its address and its group, and expands to its accounts. "New site" sits on the accounts page too, and site and group editing happen in place. An account belongs to exactly one site, so there are no longer two parallel concepts to learn.
- **Tags become site groups and apply to sites only.** What used to be tags are now site groups, purely for sorting sites into groups; tags on accounts and views are dropped at read time — they follow the site anyway, and the accounts page has always grouped by site.
- **More leaves the stage and content pages move into settings.** The column has no More entry any more; bookmarks, messages, flows and site groups all live in the settings page, whose tabs split into two groups, Preferences (general, engines, vault, data, MCP, about) and Content. AI activity stays on the button beside the address bar: the panel lists the newest entries, and "show all" lays the same log out in a layer above the browser.
- **Profiles fold into accounts.** Every account already keeps its own cookies and session data, so creating an account no longer asks about isolation: the note and "clear session data" live in a collapsed advanced fold of the account form. Account-less surfaces — new tabs, bookmarks, typed addresses — all land in the default session. When created profiles exist, Settings offers a one-time merge wizard: merge them (data stays on disk; signed-in pages will need to sign in again), or keep them and never ask again.
- **Pop an instance out to its own window.** A page can move to its own OS window from the tab's context menu for side-by-side comparison via system split screen or multiple monitors; clicking again docks it back, and one popped-out window per instance. A blank page has nothing to move and is not offered. Popping out reloads the page: SPA in-memory state is not kept, but signed-in state and storage stay with the session partition. New MCP tool `pop_out_browser_tab` (run tier).
- **Freezing follows user visibility.** With the window minimized or hidden to the tray, the on-stage page freezes as usual; background members of a batch launch and pages opened by AI freeze after idle like anything else. Exemption reasons are published per page (`sleepExempt`: on-stage visible / audible / AI active / policy …), so AI can tell what is holding resources; the left column carries a freeze badge (grey when every page is frozen, half when some are), and quit-time telemetry records the freeze state.
- **The update dialog summarizes the whole range.** Every release between the installed version and the latest gets its own section, oldest first, up to ten sections with earlier ones folded into a count; a release without notes shows a placeholder.
- **The missing actions**: hover, scroll, key combinations, back/forward/reload, reading and answering JS dialogs, file upload, drag, setting a checkbox, element info, and element-clipped screenshots. Each has an e2e that asserts the *page* changed rather than the tool returning `ok`.
- **A flow's raw CDP step**: a `cdp` step can run protocol commands, but only through a three-tier list — commands that act on the current page are open, network and device emulation need a setting, and anything that crosses identities or affects the whole process is refused and cannot be unlocked. More than two raw commands in one flow produces a note that an action is probably missing.
- **`run_flow`'s `timeoutMs`**: defaults to two minutes, capped at ten, chosen by the caller.
- **Network observation**: `read_browser_requests` returns the page's collected fetch / XHR traffic (URL, method, status, duration) without clearing it — filterable by URL substring, method and status code, and including requests that are still in flight. `wait_browser` and a flow's `wait` step gain two conditions: `load` (the document finished loading) and `response` (a request came back, optionally with a matching status code).
- **Environment emulation**: `set_browser_emulation` sets or clears time zone, CSS media type, offline and geolocation per key, the four independent of each other; it reports everything currently in force, and closing the tab drops all of it. Geolocation supplies coordinates only, not permission — a page the user has not authorized still hits the permission check.
- **Element handles**: `find_browser_element` resolves an element by semantic filters (has text / excludes text / visible / nth) and returns a handle, and the action tools (click, hover, typing and so on) accept a handle in place of the targeting fields. After a re-render the handle follows the same logical element by matching its text; a navigation invalidates it. How the existing tools target elements is unchanged.
- **A flow's `script` step**: a piece of JS runs inside `node:vm` for loops, conditions and arithmetic, and the primitives it can call are exactly the flow actions (`login` and raw `cdp` are not among them). The vm boundary is a capability boundary, not a hard sandbox — the constructor escape is reachable in practice, and that limit is stated in the tool description and the docs; the real line of defence is the MCP permission tier.
- **Capability query**: `read_browser_capabilities` (read tier) reports in one call what the current tab supports; the optional capabilities of a surface come from live checks.

#### Fixed

- **One `confirm()` could freeze a page for 30 seconds.** While a JS dialog is up the page is fully blocked: the input command that opened it never returns, and every later read times out — so the caller saw "the click did nothing, the selector must be wrong". The dialog is now recorded the moment it opens, page actions refuse up front and name its type and message, and an unanswered dialog is dismissed after 30 seconds.
- **The flow timeout was hardcoded.** `run_flow` used two minutes regardless of what the caller asked, so slow operations always failed while the work carried on in the background. A `wait` step could also eat the whole flow budget and then report "the condition never held".
- **Element screenshots came out in device pixels.** A 200×80 element produced a 300×120 image on a 1.5× display.
- **`wait_browser` and `check_element_visible` accept element handles, and a broken targeting input is no longer swallowed.** The observation tools used a different resolution path from the action tools: a `handle` field was ignored as an unknown argument, and a handle a re-render had invalidated came back as `exists: false` or ground out as "the condition never held". Both now share the action tools' handle resolution, and a dead handle errors out with the reason.
- **Multi-match targeting reports a warning, unknown arguments are refused at the entrance, and `text` matching covers non-interactive elements that carry their own text.** A direct selector hitting several elements silently clicked the first, with no word that the page held more; a field the schema never declared was silently dropped, so a mistyped argument (say, `hasText` passed to an action tool) meant nothing was passed at all and the wrong target could take the input; `text` / `role` only ever matched interactive elements, so clickable blocks whose text lives on a wrapper were unreachable. The first match is still taken but a `warning` now names the match count; unknown fields are refused with the field name listed, and `find`-only narrowing fields passed to the wrong tool are pointed to their home; `text` / `role` also match visible elements with text of their own (bare containers excluded).
- **`select` matches options exactly and reports the miss, and label binding no longer writes into the neighbouring field.** Option matching was substring-fuzzy and could silently pick wrong; on bare forms a label took the first control in document order, so values drifted between side-by-side username, password and note fields. Options now match on text exactly (whitespace-folded, no substrings) and a miss errors with the available options listed; a label binds to the control nearest it rather than the first in the document.
- **Action results now agree with what the page actually did.** `hit` was read back after mouse-up, so a page that swapped DOM inside its click handler was misreported as a miss; `scrolled` reported the delta sent rather than what the container actually moved; drag only ever said "done", with no word on whether the page took the drop; and editing combos like Ctrl+A dispatched key events that no editor heeded. `hit` is now taken at the moment of press, with a post-release `hitAfter` alongside; `scrolled` reads the container back once scrolling settles and reports the real delta; drag returns `dropped` / `dropAt` / `droppedAtTarget` / `reordered`, with a `warning` — and no success — when the page never took the drop or the coordinates look wrong; and common editing combos (Ctrl+A/C/X/V/Z, Ctrl+Shift+Z) dispatch Chromium edit commands on keyDown so their effect is visible to later input.
- **An action that opens a dialog returns in milliseconds, and nothing answers the dialog on the caller's behalf any more.** An input command that triggered alert / confirm used to hang until the command ceiling, and the timeout and flow-budget cleanup paths would dismiss the dialog in passing; a navigation blocked by beforeunload made the page look wedged; while a dialog was up the CDP session detached and the dialog leaked to the desktop as a native window. An action that triggers a dialog now returns the instant it opens, with `dialog` carrying its type and message and `hint` pointing at answering it first; tool timeouts never touch the dialog — auto-dismiss has exactly one path left, unanswered past the budget; a beforeunload-blocked navigation returns quickly with `cancelled: "beforeunload"`, leaving the page in place and operable, `read_browser_dialog` marks `pageBlocked: false`, and `handle_browser_dialog` answers keep-or-leave (accepting re-issues the navigation and waits it out); and the CDP session stays attached for as long as the dialog hangs.
- **Screenshots come back readable, and element clips no longer come out black.** On the headless transparent window a full-page shot of a backgroundless page was a transparent image padded with black, its labels and headings unreadable; on a fit-scaled page the compositor surface only covered the layout viewport, so the bottom of an element clip fell into a transparent band and read as black; and with a page zoom other than 1 the clip's scale calculation baked the zoom in, shifting the captured region. PNGs with alpha are now composited onto white before hitting disk (what a browser shows for a backgroundless page), clips with zoom measure and capture inside the layout lock, and fit-scaled pages are forced through a re-rasterization before pixels are read.
- **A flow's addresses resolve against the site root, the `login` step reports what it did, and step-enum errors carry the step number.** A step path like `/list` used to clobber the site's own path prefix by URL-standard semantics (a site at `…/app` landed on `…/list` instead of `…/app/list`); `login` returned only `ok`, leaving "did it submit?" to guesswork; and a mistyped `action` produced zod's raw English with no step number. Paths starting with `/` now join onto the site root, `login` returns one line saying whether it submitted or that the site has no auto-submit, and enum errors read as "step N (action): only … is supported, got …".
- **Objects in `read_browser_console` come back readable, the host's own warnings are excluded by default, and performance stats are no longer diluted by idle time.** A logged object was forever `[object Object]`; Electron's unpacked-run security warnings mixed into the page log with no way to tell them apart; and `measure_browser_performance` kept rolling its window whether anyone was looking or not, so a short burst of load was flattened by long idle. Object arguments are now serialized in the page into one line (two levels of own properties, array elements listed, cycles and overlength marked); host output is excluded by default with a `hostHidden` count (`includeHost: true` takes it back); and the sampling window renews on AI activity, with the result carrying both windows — the observation interval and the full buffer.
- **The instance lock self-heals after a crash or a force-kill, and names its holder when a live process owns it.** A leftover lock file used to fail every subsequent start, without saying who held the lock. The lock is opened exclusively now; a lock naming a dead process is cleared on sight, and a lock held by a running process reports that PID, says an instance is already up, and gives the lock file path.
- **The speaker icon shows only on pages that have made sound, and AI no longer mutes pages that never sang.** The tab strip read only the momentary `audible` flag, so the icon vanished the moment the page went quiet — including while muted, exactly when it was wanted; AI operations muted whatever page they touched, including ones that had never produced audio. "Has produced audio at some point" is now remembered for the life of the page and gates the icon (muted or not), and AI's automatic muting lands only on pages that are currently audible.
- **Login capture is stricter, and forms that are not logins no longer prompt to save an account.** Any visible password box could trigger the save prompt before, so sign-ups (two password boxes for confirmation), password changes, and a confirmation re-asking for a password all offered to save half-made accounts. A capture now requires the identity fields to live in the password's own form, with the submit intent coming from that same form; an empty username or password, and a password box sitting next to an amount field, are excluded.

#### Improved

- **The address bar and search box now light up in one stroke.** The old focus state ran a border dash a full lap around the outline (500ms) and then waited another 350ms for the settled stroke to fade in — nearly a second before a click looked finished. Now the top and bottom edges fill from the left end at the same time, 170ms, and the filled state *is* the settled state: there is no second stage. The vertical edges are no longer drawn — the field already sits inside a row, and closing all four sides read as a second border.
- **The UI and the tool descriptions now say "account" everywhere.** The same thing was called an identity in the UI, `identity` in storage and something else again in tool descriptions; the UI, error messages and MCP tool descriptions all say account now, while the stored field stays `identity`, so existing data is unaffected.
- **Slimmer MCP payloads.** List returns are capped: `list_flows` returns the first 50 flows and marks `truncated` beyond that, with step values clipped to 200 characters and flows to 60 steps (`run_flow` keeps using the full definition, unaffected by the preview clipping); bookmarks come back as a `hasFavicon` flag instead of icon bytes; browser-state returns keep only decision fields — icon data: URLs, window geometry, zoom and other renderer-only data never leave the app; and `evaluate_browser_page` refuses results over 64 KB with a note — aggregate or paginate inside the expression and fetch a small result.
- **`run_flow`'s `click` and `fill` now call the same code as the tools.** Two line-for-line copies became one, and flows inherit the click's hit diagnostic.
- **The e2e CDP client is one file.** 43 scripts each inlined a ~27-line WebSocket client, 29 of them byte-identical; they now share `scripts/lib/e2e-cdp.mjs`.
- **No inline CDP clients are left in e2e.** The last 3 inlined copies — the screenshot, DOM-resolver and proxy scripts — now use `scripts/lib/e2e-cdp.mjs` too; the scripts directory holds exactly one WebSocket client.
- **README screenshots re-shot, and the device-metrics override takes effect for the first time.** The screenshot script spelled `Emulation.setDeviceMetricsOverride`'s parameter `deviceScale` instead of `deviceScaleFactor`, so the protocol refused the command on every run; the old inline client turned protocol errors into `undefined` and the script never noticed. The shared client surfaces the error, and with the name fixed all 45 screenshots were re-shot, including the two guide pages that were listed but whose files were missing.
- **The accounts page becomes one table, its group headings stop doubling the header rule, and the actions column loses its wide gaps and mixed text-plus-icon clutter.**
  - **The list / table toggle is gone; the table stays**. Both modes shared the same row markup and the same grid line — the only differences were a 6px gap and a header row. That is not two views, it is one table with a line of text left out. The toggle and its two settings keys are removed, and the layout is now unconditional: each group's header is the cap, its last row is the foot, and the rows between keep only their side and bottom rules.
  - **A site is a group heading, not a page of its own.** The sites page and the accounts page each drew a header row before, and a site group's rule stacked on top of it; now a site is a heading on the accounts page, carrying its name, address, group and new-account entry on one row, with its accounts directly beneath it and a single header row.
  - **The actions column is no longer wide and ragged**. The three text actions on an account row and the new-account entry on a site heading are icon buttons now, so no cluster mixes two widths and two type sizes. The compact launch control went from 22px to 24px to match `IconButton`, and each cluster is pinned to the right edge of its column. The old session group absorbed every spare pixel of the column, which put three actions at the left and a lone pencil at the right; there is one right-aligned cluster now. The width that freed up went back to the columns people actually read — address, role, status.

## [2.2.1] - 2026-11-16

修掉 2.2.0 的内置更新器：从 2.1.0 升级会卡住，且下载进度一直是 0。**2.2.0 的用户需要手动下载这个版本**，因为卡住的那次升级没有把应用换掉。

### 中文

#### 修复

- **内置更新器的进度条不再一直是 0**。Electron `net.request` 的响应头类型写的是字符串数组，但运行时单值头其实是普通字符串；代码按数组遍历，`content-length` 被拆成了 `"1, 0, 4, 1, 7, …"`，`Number()` 得到 `NaN`，下载器以为服务端没给总大小。下载本身一直在正常进行，所以看起来是「进度不动，然后突然可以安装了」。
- **从 2.1.0 升级不再卡在 cmd 窗口**。安装脚本用 `tasklist … | find "PID"` 判断应用是否退出，这条判断在装了 Git for Windows 的机器上会拿到 MSYS 的 `find`：它把 PID 当文件名，拿不到输入时还会阻塞在读 stdin——那个 cmd 窗口就是这么挂住的。同一段脚本里的 `timeout /t 1` 也被解析成 Unix 的 `timeout`，报参数错误后立即返回，于是循环空转。现在 `tasklist.exe` 与 `timeout.exe` 都用 `%SystemRoot%\System32\` 绝对路径调用，退出判断改为读输出第 2 列与目标 PID 精确比对——不再依赖 PATH，不再依赖系统语言，也不再用 `tasklist` 的退出码（它带 `/Filter` 时无论是否匹配都返回 0）。

### English

Fixes the built-in updater in 2.2.0: upgrading from 2.1.0 stalled, and the download progress never moved. **Anyone on 2.2.0 has to download this release by hand** — the stalled upgrade never replaced the app.

#### Fixed

- **The updater's progress bar no longer sits at 0%**. Electron's `net.request` types its response headers as arrays of strings, but a single-valued header is a plain string at runtime. The code iterated it as an array, so `content-length` became `"1, 0, 4, 1, 7, …"`, `Number()` produced `NaN`, and the downloader concluded the server had sent no total size. The download itself was fine the whole time, which is why it looked like "no progress, then suddenly ready to install".
- **Upgrading from 2.1.0 no longer wedges a cmd window**. The install script decided whether the app had exited with `tasklist … | find "PID"`. On a machine with Git for Windows that resolves to the MSYS `find`, which reads the PID as a file name and blocks on stdin when it gets no input — that is the window that hung. The same script's `timeout /t 1` resolved to the Unix `timeout`, failed on the interval, and returned immediately, spinning the loop. `tasklist.exe` and `timeout.exe` are now called by absolute path under `%SystemRoot%\System32\`, and the check compares the target PID against column 2 of the output — no PATH, no locale, and no reliance on `tasklist`'s exit code, which returns 0 with a filter whether or not anything matched.

## [2.2.0] - 2026-11-16

这个版本的重心是两件事：**档案**与 **AI 权限**。浏览器不再必须先绑一个账号；AI 在真实登录态页面上的操作范围，第一次有了四档可调的边界。另外使用指南整个重做成了八页的引导，浅色主题也重新配色。

### 中文

#### 新增

- **档案：一个浏览器不再必须先绑一个账号**。档案是「一套 Cookie 加一个名字」，存在设置里跟着走。新标签页、书签和地址栏输入的地址默认落在**默认档案**（登录一次长期有效），另有一个**干净会话**，退出即消失。自建档案与默认档案同构，靠分区隔离，不靠界面约定。没有身份的页面从此归档案，书签因此有了真正的去处。
- **AI 权限改成四档，名单可随时维护且切档不丢**。`allowlist`（默认，只在名单内可操作）、`denylist`（名单内只读）、`allow-all`、`deny-all`。档位与地址名单分开存，切到全允许或全拒绝时名单原样保留，切回来继续生效，否则「为了方便放开一小时」就等于把配置删了。档案页面是真实登录态，AI 在那里默认只能读：读页面、截图、切标签、等待放行，点击 / 输入 / 填表 / 填登录 / 执行表达式 / 跑流程一律拦在工具执行之前；账号页与干净会话不受此限。工具栏的面具图标和设置页共用同一个判定函数，图标不会声称一个闸门会拒绝的权限。名单支持手输地址与从书签一键加入。
- **新建面板先问「用哪个账号」，不再猜**。工具条、视图标题、运行栏扁平标签组三处「+」都先弹出同一个选择窗，两个 tab：「账号」（选站点再选人，自动落到起始地址并填充）和「档案」（列全部档案，点一行开一个空白浏览器）。站点自己的两条出口（默认档案、一次性会话）固定在右侧顶部，所以一个站点有三十个账号也压不掉它们。这里不放「新建档案」入口，那属于档案页。
- **AI 记录独立成页**。按站点分组，工具栏按钮里看最近，侧栏「AI 记录」页看全部。它不再占消息中心的名额，也不再点红点，一次自动化跑完不会再挤掉真正的登录问题。
- **标签页会休眠，且每个标签页可单独设**。切到后台的页面闲置 60 秒后挂起 JavaScript，DOM 与登录态不动，定时器、rAF 与 3D 场景随之停；切回、导航或 AI 操作会立刻唤醒。AI 的宽限期从最后一次命令结束算起，正在跑的脚本即使超过宽限期也算活动。右键可设「永不休眠」；休眠中的标签带蓝色雪花、永不休眠的带图钉。扫描间隔与宽限期仅供 e2e 通过 `ENSEMBLE_SLEEP_TEST` 缩短。
- **标签页静音**。页面发声时标签上出现喇叭，点击静音 / 取消，静音在刷新后保留。AI 操作页面默认静音，避免调试声音界面时突然外放；你手动取消静音后，后续 AI 操作不会自动再静音，AI 也可以显式调用 `set_browser_muted`。静音只影响 Ensemble 的输出，页面自己的音频逻辑不变。
- **页面边沿能看出可以拖**。设备或固定尺寸页面的右下角常驻一个斜纹手柄，悬停右、下边沿会亮起强调线，和 Edge 的设备模式一样；页面在格位内让出一点舞台边距，手柄落在页面外的宿主空间。拖动按起始适配比例换算，被拖的边跟指针走；宽高到装不下就停在边缘，不会反过来把页面缩小。拖动时徽标显示目标 `W × H`，松手提交，保留 DPR、触摸与 UA。
- **新增 `add_browser_init_script`**（配 `list` / `remove`）：在页面自己的 JS 之前装钩子，从下一次导航生效，用于包装 `VideoDecoder`、改写模块作用域读取的 `window` 属性这类必须在首行代码之前就位的场景。有注册的标签页会保持调试会话不释放，这是它能生效的前提，也是它的代价。
- **新增 `cancel_browser_script`**：配合新的超时语义，AI 可以主动中止还在跑的页面脚本。
- **站点与账号可以切换列表 / 表格**。两页右上角提供视图切换，默认列表；选择写进设置，重启后保持。列表更紧凑，表格带列头便于横向比较。
- **消息可以直接标已读**，不必先跳过去。

#### 修改

- **使用指南重做成一份八页的引导**。不再是一张滚动到底的长文档，改成一个居中的窗口，一页一件事，左半一张会动的示意图、右半最多三条要点；左右方向键翻页，底部八个圆点可以直接跳页，最后一页的按钮是「开始使用」。顺序按产品的介绍顺序排：先讲它就是个浏览器、特殊之处是每个浏览器各自隔离，再讲档案/书签与站点/账号是两套东西，然后是 AI 接入与 AI 能看能做什么，往后是「界面完全关掉、AI 照样后台干活且不弹窗」和开发者工具。原来首屏先讲「建站点 → 录账号 → 启动」，那是产品的配置成本，不是它是什么。
- **AI 入口回到工具栏**。一个按钮同时说明端点开没开（绿点）、提示还没接入（面板里一键开启）、并给出操作记录。原来的权限盾牌并进这个面板，它只能回答「这一页行不行」，而且自己抄了一份判定逻辑。
- **AI 撞到没授权的站点会先问你**。桌面右下角弹出授权卡片，写明要做什么、哪个站点、在哪个档案里；四个答案：本次允许 / 本次运行都允许 / 始终允许 / 拒绝，倒计时走完算拒绝。被拒绝后 AI 会停下来告诉你缺权限，不会换个工具再试。
- **设备页先分桌面与移动端**。选移动端就点一个机型，视口、像素比、触摸与移动端 UA 一次带上，翻页点链接都不掉；桌面端只钉视口尺寸，页面仍认为自己在桌面。混排的分辨率列表、预览框、预览手柄和独立的 DPR / 触摸 / UA 控件都去掉了。自定义成为列表里的一行，拖页面边沿或输入宽高会自动选中它；切回桌面恢复进入移动端之前的答案，不会把手机尺寸留成自定义桌面视口。
- **AI 调用的超时现在能被读懂**。`evaluate_browser_page` 与 `screenshot_browser_tab` 接受 `timeoutMs`（默认 30 秒 / 15 秒，上限 5 分钟 / 1 分钟）。到点不再当作调用失败，而是返回 `timedOut` 与 `stillRunning`，AI 可以继续观察、中止，或者去做别的。截图超时会明说 `page-busy`。`wait_browser` 的超时分成 `page`（条件没满足，给出原因）与 `bridge`（页面没按时答复）两种。
- **默认档案不再被 AI 当成一次性会话**。MCP 返回的标签列表不再暴露内部存储分区名，并明确给出 `profileId: "default"`。之前的分区名里带着 "clean"，AI 读完后会把长期保存登录的默认档案判断成干净会话。默认档案本身的登录态没有变化。

#### 修复

- **侧栏折叠成一条图标时，底部不再有那条灰带**。导航滚动区只纵向滚。只设了 `overflow-y: auto`，CSS 会把另一轴从 `visible` 提升成 `auto`，于是 46px 宽的折叠栏多出一条横向滚动条；项宽与滚动区内容盒都是 34px，任何一次亚像素舍入都能让内容多出 1px，这 1px 足够在竖排图标底部画出一道滚动条。
- **点地址栏不再把固定尺寸页面挤成左上角一条**。页面固定在 390×844 时，点地址栏会让它按整个分栏宽度重新排版，内容缩在左上角、右边留一大片空白，触摸光标也铺到空白区。停靠面板被浮层挡住时走的是另一条布局分支，那条分支把分栏矩形直接给了页面，绕过了按视口等比适配。现在两条分支共用同一个适配函数。
- **从固定尺寸切回自适应后文字不再变小**。固定视口按舞台等比缩放时会把页面缩放因子改小，离开该模式后这个因子以前会留在页面上，自适应页面于是按缩小的字号铺满格位。现在每次布局都会在无固定视口时把缩放还回去。
- **DevTools 不再询问语言，也不会打开成空壳**。语言与「不再提示」写进 Electron 的 DevTools 偏好，用一块离屏的临时前端写入并读回，再打开真正的面板；不再用预加载可见面板的方式（那会让 Elements 停在空壳上）。此前每次新开都会问一次，选「跟随系统语言」还会让面板白屏。
- **指南里两处指路错误修掉了**。AI 入口从「底栏右下角」改为工具栏右端的星形按钮；「先在工具栏的盾牌按钮里允许该来源」整句删除，那个按钮早已并入 AI 入口，指南在指一个不存在的东西。文案与界面的对应关系现在由契约测试盯着。
- **AI 记录不再失真**。同一页上换了工具会被合并成一行（工具名停在第一次那个），应用收在托盘里时的调用完全不记，这两处都修好了。记录页改成固定页头、历史可滚；每条可展开，看到脱敏后的参数、脚本全文与结果摘要，行摘要直接以脚本首行开头。输入的文字与密码不会写进记录。消息页同样保证长列表可滚。
- **普通落地页不再产生「登录失败」通知**，只有真正的登录表单才会。
- **收藏按钮只点亮星形**，不再连带整个按钮一起变色。
- **启动时不再闪一下错位的布局**。初始化完成前由一层覆盖整个窗口的启动画面占位，界面在背后完成首次排版，随后淡出显示。

#### 优化

- **浅色主题重做配色**。金色降为点缀，选中态转中性，页面不再整片泛黄。
- **性能监视器像 Edge 一样连续滚动**。曲线不再「一顿一顿」地跳格，而是每帧平滑左移。原先横轴的右端被钉在最后一个样本上，两次采样之间整条曲线完全静止，新样本一到就整体跳一格。现在采样与移动分开，路径按固定原点画一次，每帧只改一个位移。八项指标统一用折线画；当前值从最右侧挪到指标名旁边、颜色跟曲线一致；纵轴顶线加亮到能直接对上 100%，也不再随尖峰进出窗口而整体缩放。轮询改为跟随采样间隔。
- **设置页左边那张目录看得清当前停在哪一节了**。分节列改成窗口边框底色，当前行铺一格更亮的表面，左右都有留白。原先列没有自己的底，浅色里选中填充与页面底色都是纯白，当前分节等于一块白方块压在白底上；行又右侧贴死内容区，两块白连成一片。深色下同时把选中的那一格提亮一档。
- **设置页的卡片标题和内容分开了**。分组标题下有了一条分隔线，字号也提高到行标签之上。原先标题架在第一项上方 2px、中间没有线、字号只差一档，眼睛没有理由把它读成标题，于是每张卡片都像一张第一项碰巧加粗的列表。
- **页面标题下面不再有副标题**。AI 记录页那句「AI 在页面上的操作」删掉了，它是标题的另一种说法。`PageHeader` 的 `note` 属性一并移除，页面只能往 `#note` 插槽放数字，身份页的「12 账号 · 3 运行中」是别处没有的实时统计，保留。
- **新标签页与地址栏的观感**。聚焦搜索框和地址栏时，不再有扫过内容区的旋转光斑，改为沿轮廓跑一圈的描边；轮廓改由一层 SVG 从头画到尾，静止细线、聚焦高亮与扫光同宽，整圈用时从 800ms 收到 500ms。搜索框占位文字回到垂直居中；背景壁纸改成一整片连续的渐变；背景选择器的色块换成能看出区别的缩略预览。地址栏旁 AI 入口的悬停提示改为说明这是「AI 接入」。
- **标签页的关闭按钮常驻**。窗口标签条与实例内的页面标签都从「只悬停或当前显示」改为始终显示；静止时淡一点，快速关多个标签不用先逐个悬停。
- **AI 接入页两个小节标题的样子统一了**。「客户端连接信息」原来是段没有样式的段落，按浏览器默认字重渲染，夹在两条小字说明中间显得突兀；现在和「AI 在档案页面上的操作范围」用同一个次级小标题样式。
- **每页的示意图是真会动的**。围栏绕着各自的页面一笔画出、中线从上往下把两套东西分开、MCP 那条线上一直有数据包在跑、窗口向托盘折起时底下的活动曲线还在起伏。动效只在表示「持续发生」时循环，窗口折叠、围栏绘制、菜单展开都是一次性事件，播完停在终态。
- **新增 AI 工具能力矩阵文档**（`docs/engineering/ai-tools.md`）：每个工具的档位、是否过来源闸门、时限与返回形状写在一张表里，并由契约测试与源码比对，避免再出现「文档说 18 个工具、实际 24 个」这种没人发现的情况。

### English

This release is about two things: **profiles** and **AI permissions**. A browser no longer has to start as an account, and AI access to real signed-in pages finally has four adjustable tiers. The guide was rebuilt as an eight-page tour, and the light theme was recoloured.

#### Added

- **Profiles: a browser no longer has to start as an account**. A profile is a set of cookies with a name, stored in settings and carried along. New tabs, bookmarks and typed addresses land in the **default profile**, where a sign-in lasts; a **clean session** is also available and vanishes on exit. Profiles you create are built the same way as the default, isolated by partition rather than by UI convention. A page without an identity now belongs to a profile, which is what gives bookmarks somewhere to actually open.
- **AI permissions became four tiers, and the address list survives switching**. `allowlist` (the default: act only on listed origins), `denylist` (read-only on listed origins), `allow-all`, `deny-all`. The tier and the list are stored separately, so switching to allow-all or deny-all keeps the list intact and it takes effect again on the way back, otherwise "open it up for an hour" would mean deleting the configuration. A profile's real signed-in pages are read-only to the AI by default: reading, screenshots, switching tabs and waiting pass, while click / type / fill / fill-login / evaluate / run-flow are all stopped before the tool executes. Account pages and clean sessions are not restricted. The toolbar's mask icon and the settings page share one decision function, so the icon cannot claim a permission the gate will refuse. The list accepts typed origins and one-click adds from bookmarks.
- **The new-page panel asks which account, instead of guessing**. All three "+" entry points (toolbar, view header, running dock's tab strip) open the same chooser with two tabs. **Accounts** picks a site, then a person, and lands on the start path with the form filled in; **Profiles** lists every profile and opens a blank browser in the one you pick. The site's own two exits (default profile, one-off session) stay pinned at the top right, so a site with thirty accounts cannot push them off. Creating a profile is not offered here; that belongs on the profiles page.
- **AI activity is a page of its own**. Grouped by site, recent calls in the toolbar panel, everything on the sidebar page. It no longer takes a share of the message list or lights its badge, so one automation run cannot push the real sign-in problems out of view.
- **Background tabs sleep, and each tab can opt out**. A parked page suspends its JavaScript after 60 seconds idle (the DOM and session stay intact while timers, rAF loops and 3D scenes stop) and wakes on a tab click, a navigation or an AI command. The AI grace window starts when its last command finishes, and a script still running counts as activity however long it takes. A tab's context menu offers "Never sleep"; a sleeping tab shows a blue snowflake, a never-sleeping one a pin. `ENSEMBLE_SLEEP_TEST` shrinks the timings for e2e.
- **Tab muting**. A speaker appears on a tab that is making sound; click it to mute or unmute, and the mute survives a reload. AI page operations mute by default so debugging a sound UI does not suddenly play audio; once you unmute by hand, later AI operations no longer re-mute it, while the AI can still call `set_browser_muted` explicitly. Muting only affects what Ensemble outputs.
- **The page edge shows that it can be dragged**. Device and fixed-size pages keep a diagonal grip in the bottom-right corner and light up an accent line on the right or bottom edge on hover, the same cue Edge's device mode gives; the page keeps a small stage margin so the handles sit outside it, in host space. The drag is computed from the starting fit scale so the dragged edge follows the pointer, and a size the cell cannot hold stops at the edge instead of shrinking the page. A live `W × H` badge follows the drag and commits on release, keeping DPR, touch and UA.
- **`add_browser_init_script`** (with `list` / `remove`): hooks that run before the page's own JavaScript, effective from the next navigation, for wrapping `VideoDecoder` or rewriting a `window` property that module-scope code reads on its first line. A tab with registrations keeps its debugging session alive, which is what makes it work and also what it costs.
- **`cancel_browser_script`**: pairs with the new timeout semantics so the AI can stop a page script that is still running.
- **Sites and accounts switch between list and table**. Both pages offer the toggle at the top right, defaulting to list, and the choice is saved across restarts. Rows are tighter in list view; table view adds column headers for comparing across entries.
- **Messages can be marked read** without leaving the page.

#### Changed

- **The guide is now an eight-page tour**. Not one document that scrolls to the bottom, but a centred window with one idea per page: a moving diagram on the left, at most three bullets on the right. Left/right arrows turn pages, eight dots along the bottom jump straight to one, and the last page's button reads "Start using it". The order is the product's own order: that it is a browser and every browser is isolated, then that profiles/bookmarks and sites/identities are two separate things, then AI access and what the AI can see and do, then that the window can be closed entirely while the AI keeps working, and finally the developer panels. The old first screen opened on "create a site, add an account, launch", which is the product's setup cost rather than what it is.
- **The AI entry point is back in the toolbar**. One button shows whether the endpoint is running (green dot), offers to turn it on when it is not, and opens the activity history. The old permission shield folded into this panel; it could only answer "is this page allowed", and kept its own copy of the decision logic.
- **An AI reaching an unauthorised site asks first**. A card appears at the bottom right of the desktop naming the action, the site and the profile; four answers (allow once / allow for this run / always allow / deny), with the countdown ending in a denial. After a denial the AI stops and tells you what it lacks instead of retrying with another tool.
- **Device emulation starts with desktop or mobile**. Pick mobile and one preset applies the viewport, pixel ratio, touch and mobile UA together, kept across navigation; pick desktop and only the viewport is pinned. The old mixed resolution list, the preview box and the separate DPR / touch / UA controls are gone. Custom is now a row in the same list; dragging the page edge or typing a width/height selects it, and returning to desktop restores the desktop answer that was there before mobile mode rather than leaving the phone's size behind as a custom desktop viewport.
- **Timeouts in AI calls can now be read**. `evaluate_browser_page` and `screenshot_browser_tab` accept `timeoutMs` (30s / 15s by default, capped at 5min / 1min). Reaching the deadline is no longer reported as a failed call; the result carries `timedOut` and `stillRunning`, so the AI can keep watching, stop it, or move on. A screenshot timeout says `page-busy`. `wait_browser` timeouts split into `page` (the condition was not met, with a reason) and `bridge` (the page never answered in time).
- **The default profile is no longer mistaken for a throwaway session**. The tab list returned over MCP no longer exposes the internal storage partition name and states `profileId: "default"` instead. That legacy name contains "clean", which led an AI reader to conclude that a long-lived signed-in profile was a clean session. Nothing about the default profile's storage changed.

#### Fixed

- **The collapsed sidebar no longer shows a stray horizontal scrollbar along the bottom**. The nav's scroll box now scrolls vertically only. Setting just `overflow-y: auto` makes CSS promote the other axis from `visible` to `auto`, and at that point a 46px-wide icon column grows a horizontal scrollbar: the item width and the scroll box's content box are both 34px, so any sub-pixel rounding can make the content 1px wider, which is enough to draw a bar under the icon stack.
- **Clicking the address bar no longer squeezes a fixed-size page into the top-left**. With the page pinned at 390×844, focusing the address bar made it lay out at the whole split width, so content collapsed into the top-left corner, a large blank area remained, and the touch cursor covered that blank area too. When a floating layer covers the docked panel, a second layout branch gave the raw split rectangle to the page and skipped the viewport fit. Both branches now share the same fitting function.
- **Leaving a fixed viewport no longer shrinks the text**. Fitting a fixed-size page to the stage sets a small page zoom, and that factor used to stay on the page after switching back to adaptive, so the adaptive layout rendered at the tiny scale. Every layout pass now hands the zoom back when no fixed viewport is active.
- **DevTools no longer asks for a language, and no longer opens as an empty shell**. The language and "don't ask again" go into Electron's DevTools preferences, written and read back by an off-screen throwaway front-end before the real panel opens, instead of pre-loading the visible panel (which left Elements an empty shell). It used to ask on every new open, and choosing "match system language" blanked the front-end.
- **Two wrong signposts in the guide are gone**. The AI entry moved from "bottom right of the status bar" to the star at the right end of the toolbar, and the sentence pointing at a shield button in the toolbar is deleted, since that button had long since merged into the AI entry and the guide was pointing at nothing. The mapping between copy and UI is now held by contract tests.
- **The AI record no longer distorts what happened**. Switching tools on the same page used to merge into one row (keeping the first tool's name), and calls made while the app sat in the tray were not recorded at all; both are fixed. The page has a fixed header and a scrolling history; each call expands to show redacted arguments, the full script and a result summary, with the row summary starting from the script's first line. Typed text and passwords are never written to the record. The messages page is held to the same scrolling contract.
- **An ordinary landing page no longer raises a sign-in failure notice**; only a real sign-in form does.
- **The bookmark star lights up on its own** instead of tinting the whole button.
- **The first frame no longer flashes a mislaid layout**. A splash covering the whole window holds the frame until initialization finishes, with the shell laying itself out behind it, then fades away.

#### Improved

- **The light theme was rebuilt**. Gold is now an accent rather than a wash, selection is neutral, and pages no longer take on a yellow cast.
- **The performance monitor scrolls continuously like Edge**. The curve no longer jumps one slot at a time; it slides left every frame. The right edge used to be pinned to the last sample, so the whole curve stood still between samples and then jumped when the next one arrived. Sampling and movement are now separate: the path is drawn once against a fixed origin, and each frame only shifts it. All eight series are straight polylines; the current value sits after the metric's name in the curve's own colour; the top gridline is bright enough to read 100% against and the vertical axis no longer rescales as spikes enter and leave the window. Polling follows the sample interval.
- **The settings section column shows where you are**. The column now has the frame colour behind it and the current row gets a brighter surface with room on both sides. It previously had no background of its own, so in the light theme the selected fill and the page colour were both pure white, and the row ran flush against the content area, joining the two whites into one shape.
- **Settings card headings are separated from their rows**. Each group heading now has a divider under it and is set larger than the row labels. The heading used to sit 2px above the first row with no line and only one type step of difference, so every card looked like a list whose first row happened to be bold.
- **No more subtitles under page titles**. The AI activity page's "what the AI does to pages" is gone, since it restated the title. `PageHeader`'s `note` prop went with it, so pages can only put figures in the `#note` slot; the identities page's "12 accounts · 3 running" is live data found nowhere else and stays.
- **New-tab and address-bar polish**. Focusing the search box or the address bar no longer washes a rotating glow across the content: a stroke runs once around the outline, now drawn entirely in SVG, with the resting hairline, the settled highlight and the sweep all the same 2px line, and the lap takes 500ms instead of 800ms. The search placeholder is vertically centred again; the wallpaper is one continuous gradient; the backdrop picker's swatches are previews you can tell apart. The AI button beside the address bar now says "AI access" on hover.
- **Tab close buttons are always visible**. Both the window strip and a cell's page strip revealed the close button only on hover or on the current tab, which made closing several pages a hover-by-hover chore.
- **The two small headings on the AI access page now match**. "Client connection info" was a bare paragraph rendered at the browser's default weight, sitting between two small-print notes; it now uses the same secondary-heading style as "what the AI may do on profile pages".
- **Every diagram actually moves**. A fence draws itself around each page in turn, a divider draws down the middle between the two things, packets keep running along the MCP wire, and when the window folds toward the tray the activity trace underneath is still going. Motion loops only where it means "still happening"; the fold, the fences and the menu opening are one-off events that play once and hold.
- **New AI tool capability matrix** (`docs/engineering/ai-tools.md`): every tool's permission tier, whether it passes the origin gate, its deadlines and its return shape live in one table, checked against the source by a contract test, so "the docs say 18 tools, the code has 24" cannot go unnoticed again.

## [2.1.0] - 2026-11-11

### 中文

- 修好「保存账号」的三个连带问题：点保存后不再自动打开浏览器，提示条随保存立即消失，账号表单打开期间提示条不再压在遮罩上却点不动。首次启动的指南也不再挡住它。
- 修好启动账号后页面长时间空白、必须手动刷新才显示内容：新标签页自带的空白占位页被当成「正在显示」，盖在了真实页面上面。切页、开关视图时同一处逻辑都会犯。
- 修好启动账号时先闪出一个新建标签页、卡几秒才加载页面：标签一创建就立刻成为前台并带上目标地址，界面从第一帧起显示的就是正在加载的页面，而不是它的前一页。站点越慢，原先这段「卡住」越长。
- 性能监视器重排：指标名、当前值、峰值收成一行，曲线独占下一行并占满整个面板宽度。纵轴三个刻度（顶 / 半 / 底）挪到曲线左侧的窄槽里，不再和曲线抢横向空间；底部零点在窄面板下自动省略。
- 修好性能曲线「自己缩放」：刚打开时一秒的数据被拉满整个宽度，之后每来一批样本又被压窄一次。现在横轴固定为窗口长度、右端恒为当前时刻，曲线从右边缘按真实时间生长，满窗后旧样本从左边滑出，全程比例不变。
- **采集区间与采样间隔都在性能面板表头调**：区间 10 秒–2 分钟、间隔 100ms–1 秒，改完当场生效，不用离开正在测的页面；设置页里那两行已去掉。查一次卡顿用窄窗口配细间隔（每一秒占更多像素），看内存慢涨用长窗口配粗间隔。
- 曲线不再整行 hover 变暗：变暗会让曲线本身看起来在变，而 hover 提示的位置其实是左上角的指标名。
- 修好性能读数的一个系统性偏低：每次开始采样时的第一个读数没有上一个计数可差分，速率其实是「未知」，此前被当成 0 计入统计。窗口短的时候这个假 0 能占掉一半——两个样本的窗口会把繁忙页面的 CPU 报成只有真实值的一半。
- 消息铃铛常驻显示，未读时只标一个红点，不再显示数字——数字会把图标撑变形、和旁边图标错位。保存账号后这条通知同时标记为已读。
- **地址栏旁的消息铃铛改为原地展开浮层**：列出最近几条，点任一条在旁边再浮出一层详情——完整内容、时间，以及它能做的事（保存账号 / 重新登录 / 查看页面）或它为什么失效；底部还有「查看全部消息」进消息中心。两层都是浮层：展开一条不会把下面几条往下推，列表始终停在原处。消息中心页点行同样是浮层，行内不再堆按钮。消息中心与浮层每次呈现都重读历史，失效的行不再显示点了没用的按钮。此前点铃铛直接切到消息页，而消息页没有入口回到刚才那一页——只为瞥一眼消息就要丢掉正在看的页面。
- **管理页的页头按钮与内容重新对齐**：页头曾被多留了一整条窗口按钮的宽度，主按钮比下面的列表/卡片右缘左缩 100 多像素，右侧看上去空了一大块；页面也就显得歪。现在页头动作与内容共用同一条右边缘。
- **空列表只留一个新建按钮**：流程、站点、视图、身份、书签在没有内容时，页头和空状态各有一个同样的按钮。现在空状态下只在说明文字旁边留一个，有内容时回到页头。
- 标签页不再是缩在左上角的窄卡片：创建表单与列表都铺满内容宽度，名称、颜色、创建排成一行，创建按钮落在右缘。
- 性能监视器加上纵轴刻度、网格线与色块填充，指标里一眼能看出「到了百分之多少」而不只是「有波动」。指标顺序改为 Chrome 性能监视器的顺序：CPU → JS 堆 → DOM 节点 / 事件监听器 / 文档 / 文档帧 → 布局/秒 / 样式重算/秒；颜色按类别分组（CPU 暖色、内存紫、结构蓝、抖动粉）。
- **移动端模拟**：停靠面板新增「设备」页，可选 iPhone 15 / iPhone SE / Pixel 8 / Galaxy S24 / iPad mini，一次带上视口尺寸、像素比、触摸与移动端 UA。切换页面、跟随链接时模拟都保持，不会翻一页就变回桌面。
- **拖拽调尺寸**：设备页里有一个预览框，拖右下角直接改宽高，松手即应用。预览框里一格就是一 CSS 像素，数字会跟着指针走，不用猜比例。
- **设备与尺寸分开**：「应用设备」带全套移动端身份；「只改尺寸」只钉住视口大小，页面仍认为自己在桌面（无触摸、桌面 UA），用来验 768px 这类布局。清除设备时保留尺寸，只有「自适应」才回到铺满格位。
- **性能监视器**：新增「性能」页，指标与 Chrome/Edge 的性能监视器一致——CPU 使用率、DOM 节点、JS 事件监听器、文档、文档帧、JS 堆、布局/秒、样式重算/秒，每项配一条走势图；点指标名可以只看关心的几项。采样只在面板停在这一页时进行，切走即停。
- 性能监视器改为每秒采样 5 次，并按「距上一次的间隔」计算速率。原先每秒一次、且用「从开始到现在的总时长」当分母，把每次尖峰都摊平到整段历史里，页面上忙着布局时曲线照样是一条直线。现在 200ms 的卡顿也看得见，曲线按真实时间轴排布。
- 修好拖动面板分栏后原生 DevTools 盖回顶部：切到设备或性能页再拖分栏时，原生前端会被重新放回面板位置，而它是原生视图，必然盖住自绘面板。
- 缩放控件从工具栏移到两处：分辨率菜单与应用菜单，形状仍是 − 数值 +（点数值复位）。用 Ctrl + 加号/减号、Ctrl + 滚轮或 Ctrl + 0 缩放时，页面顶部会浮出当前百分比并自动消失。
- 开发者工具顶部控制条改为三个页签：前端（原生 DevTools）、设备、性能。页签窄到放不下文字时只留图标，悬停给出名称。
- 面板分栏改按格位计算，选手机尺寸后不会再把自己的面板挤成一百多像素宽。
- 书签或地址栏进入的网站登录后，提示「保存账号」会当场建好站点与独立身份，并直接以该身份启动。
- 修好「保存账号」点了报错：在还没建过站点的网站上登录时，点提示条里的保存会校验失败、账号存不进去。现在能正常建站点并打开账号表单；万一保存仍然失败，密码会留在待保存列表里，不会随着一次报错丢掉。
- 首次打开的使用指南重排：先讲这个窗口是什么——左边工作台、右边舞台，配一张结构示意——再说「建站点 → 录账号 → 启动」这条最短路径，最后才是 AI 能代做哪些事。
- 关掉存账号提示不再丢密码：捕获会记进消息中心，随时回去保存，不必退出重登。
- 多租户站点（租户名 + 用户名 + 密码）现在能正确识别账号：租户名随账号一起保存，同一用户名在不同租户下各算一个账号。
- 打开会跳转的站点不再白等 10 秒；普通表单提交、以及提交后清空输入框的登录页，也都能弹出存账号提示。
- 新增**消息中心**：登录捕获、账号问题、AI 操作三类记录统一留档，重启后仍在；每条都能直接处理——保存账号、重新登录、跳到 AI 动过的那一页。侧栏有入口，工具栏铃铛显示未读数。
- 工具栏收窄：开发者工具与 AI 接入移入右上角应用菜单，低频入口不再和常用控件挤在一行；菜单里开发者工具带勾选，AI 接入直接标出是否在跑。
- 页面内查找改为悬浮在页面右上角，不再占一行高度把页面往下压；Ctrl+F 在界面或页面里都能唤出，打开即聚焦并选中上次的查询词。
- 停靠的开发者工具在下拉菜单打开期间会自己让位。这次按「有没有浮层」统一判定，所有菜单都覆盖，嵌套菜单也正确——此前只有标签菜单会这样做，还传错了状态。让位时页面不再跟着长回整格宽度，所以打开下载面板或菜单时，分屏位置停在原处，不会再像是开发者工具消失了。
- 关掉标签页时它的开发者工具会一起关闭。此前面板前端仍在运行，标签条里却已经没有对应的页，也没有入口能关掉它。
- **AI 能看的东西补齐了**：新增 `read_browser_console`，一次读回页面的报错、控制台输出和网络请求，读完即清空，回答「上次读取之后发生了什么」；`wait_browser` 多了 `network-idle`，等页面所有请求发完并安静下来，不用再猜要等哪个元素；读页面时每个节点带上 `parent` 与 `depth`，能看出按钮属于哪个对话框；`screenshot_browser_tab` 加 `inline`，把图像本身随结果返回，供读不到本机路径的 AI 客户端使用。
- **AI 也能测性能了**：新增 `measure_browser_performance`，用与 Chrome 性能监视器同源的 CDP 计数器，给出八项指标在一段观察窗口里的均值、峰值、峰值时刻与最新值——回答「这个页面卡不卡」不再靠猜。连续调用会接着上一次继续、中间空档也在采样，所以「测一次 → 点一下 → 再测一次」能看见那次点击的开销；峰值时刻是相对毫秒，能与控制台日志的时间对上。另有 `read_browser_performance` 给需要逐点数据的调用方。面板正在采样时 AI 读取会接管而不重启，不会把用户正在看的图表清空。
- **修好 macOS 上 Dock 图标消失**：悬浮条和身份标签窗在创建时会把整个进程转成菜单栏型应用（accessory），而代码从不转回，于是 Dock 图标、应用菜单和 Cmd+Tab 一起消失。现在跨 Space 显示保留，进程类型不再被改动。
- **修好 macOS 应用菜单抢走页面快捷键**：Cmd+R / Cmd+Shift+R / Cmd+±/0 之前作用在应用外壳上——重载整个界面、缩放界面而不是当前页面；Cmd+W 更是直接关窗口或退出应用。现在这些都转发到当前页面，Cmd+W 先关标签页，没有标签页时才关窗口，关闭窗口改为 Cmd+Shift+W。
- **修好 macOS 上引擎版本读不到、孤儿浏览器回收失效、后台检测退出时刷错误日志**：`Info.plist` 路径少退了一层导致版本恒为空；`ps` 输出的 profile 路径含空格被截断，导致退出后残留的浏览器进程一个也认不出来；非 Windows 平台仍去调 `taskkill`，每次都会抛一个抓不到的异步错误。

### English

- Three fixes to "save account": saving no longer opens a browser on its own, the prompt disappears with the save, and it no longer sits over the dialog mask where it could be seen but not clicked. The first-run guide no longer hides it either.
- Fixed a launched account sitting on a blank page until a manual refresh: the empty placeholder page every new tab starts with was counted as "on screen" and covered the real page. The same comparison was used when switching pages and views.
- Fixed a launched account flashing a new tab for as long as the site takes to respond: the tab is now the foreground page from the moment it is created and already carries its destination, so the first frame shows a page that is loading rather than the one before it.
- The performance monitor was rearranged: name, current value and peak share one line, and the chart owns the line below at the panel's full width. The three axis labels (top / half / zero) moved into a narrow gutter left of the plot instead of competing with it for horizontal space; the zero label drops out in a narrow panel.
- Fixed the performance curve appearing to zoom by itself: a freshly opened panel stretched one second of data across the whole width and then squeezed it again with every batch of samples. The x axis is now a fixed window whose right edge is always "now" — the curve grows leftwards from the right edge in real time, and once full the oldest samples slide off the left, so the scale never changes.
- **The performance monitor now reads like Edge**: all eight series are straight polylines (the DOM, heap and layout lanes used to be stepped), the current value sits immediately after the metric's name in the curve's own colour instead of at the far right, and the top gridline is bright enough to read CPU's 100% against. The vertical axis still holds steady while spikes enter and leave the window.
- **Both the window and the interval are set in the performance panel's header**: a window of 10s–2min and an interval of 100ms–1s, applied on the spot, so you never leave the page being measured. The two Settings rows are gone. A narrow window with a fine interval is how you chase one stutter (more pixels per second); a long window with a coarse interval is how you watch memory creep.
- Row hover no longer darkens the whole lane: a curve that dims under the pointer reads as the data changing, and the hover hint belongs to the label line, which is the part that is actually a control.
- Fixed a systematic under-report in the performance readings: the first sample of a session has no previous counter to difference against, so its rate is unknown — it was being counted as zero. On a short window that fake zero could be half the answer: a two-sample window reported a busy page at half its real CPU.
- The message bell is always visible and marks unread news with a red dot instead of a number — a number widened the button and pushed it out of line with the icons beside it. Saving an account now also marks that notice read.
- **The bell beside the address bar now opens a popover in place**: it lists the newest few messages, and clicking one floats its detail beside the list — the full text, when it happened, and what it can still do (save the account / sign in again / show the page) or why it no longer has one. The foot of the panel opens the message centre for the full history. Both are layers: opening one message never pushes the others down, so the list stays exactly where it was. Rows on the message page itself work the same way. The bell used to switch straight to the message page, which had no way back — glancing at one message cost the page you were working on.
- **Management pages line up**: the page header reserved a whole caption-button band a second time, after the shell already reserved it, so every primary action sat 100-odd pixels left of the right edge of its own content and left a visibly empty strip beside it. Header actions and content now share the column's right edge.
- **One create button per empty page**: flows, sites, views, accounts and bookmarks drew the same action in the header and again in the empty state. While the list is empty the action now appears only next to the sentence explaining it, and returns to the header once there is something to list.
- The tags page is no longer a narrow card pinned to the top-left: its create form and list fill the content width, name / colour / create share one row, and the action closes that row on the right.
- The performance monitor gained a vertical scale, gridlines and a filled area, so a lane answers "at what percentage" instead of just "it moved". Metrics now follow Chrome's performance monitor order: CPU → JS heap → DOM nodes / listeners / documents / frames → layouts/s / style recalcs/s, with colour grouped by category (heat, memory, structure, churn).
- **Mobile emulation**: the docked panel gained a Device tab with iPhone 15, iPhone SE, Pixel 8, Galaxy S24 and iPad mini — viewport size, pixel ratio, touch and a mobile UA in one click. The emulation survives navigation, so following a link no longer drops the page back to desktop.
- **Drag to resize**: the Device tab has a preview box whose bottom-right corner drags the width and height, applying on release. One preview pixel is one CSS pixel, so the number tracks the pointer rather than a scale factor you have to guess.
- **Device and size are separate choices**: Apply device carries the full mobile identity; Size only pins the viewport while the page still believes it is a desktop (no touch, desktop UA), which is what checking a 768px layout needs. Clearing a device keeps its size — only adaptive goes back to filling the cell.
- **Performance monitor**: a new Performance tab with the same metrics as Chrome's and Edge's performance monitor — CPU usage, DOM nodes, JS event listeners, documents, document frames, JS heap, layouts/s and style recalcs/s — each with its own sparkline. Clicking a metric's name hides that metric. Sampling only runs while the tab is showing.
- The performance monitor now samples five times a second and derives each rate from the gap since the previous reading. At one sample a second, divided by the total elapsed time, every spike was averaged into the whole run and the chart was a flat line while the page was visibly busy. A 200ms stutter is now visible, and points are spaced by real time.
- Fixed the native DevTools panel reappearing over the Device and Performance tabs when the split was dragged: it is a native view, so being written back into place put it on top of our own panel.
- Zoom moved out of the toolbar into two places — the viewport menu and the app menu — keeping the − value + shape (click the number to reset). Ctrl + plus/minus, Ctrl + wheel and Ctrl + 0 raise a transient overlay with the new percentage, which fades on its own.
- The DevTools top strip is now three tabs: front-end (the native panel), device and performance. When the panel is too narrow for labels the tabs keep only their icons, with the name on hover.
- The panel's share of the split is now measured from the cell, so choosing a phone no longer squeezes the panel itself down to a hundred-odd pixels.
- Signing in on a site opened from a bookmark or the address bar now offers to save the account, creating the site and an isolated identity on the spot and launching it right away.
- Fixed "save this login" failing on a site the workspace had not seen yet: the capture path passed blank optional fields to the site schema, so the save was rejected. It now creates the site and opens the account form, and a save that still fails leaves the password in the pending list instead of consuming it.
- The first-run guide was reordered: it first explains what the window is — the workbench on the left, the stage on the right, with a layout diagram — then the three-step path, and only then what an AI can do instead.
- Closing the save prompt no longer loses the capture: it is recorded in the message centre, so you can go back and save it later instead of signing in again.
- Multi-tenant logins (tenant + user + password) are recognised properly: the tenant is saved with the account, and the same username under another tenant counts as a separate account.
- Sites that redirect no longer stall for ten seconds on open, and plain form logins — including pages that clear the fields after submitting — now offer to save the account too.
- Added a **message centre**: captured logins, account problems and AI actions are kept in one history that survives restarts, and each row can act — save the account, sign in again, or jump to the page the AI touched. Reachable from the rail, with an unread badge and a toolbar bell.
- The toolbar is down to the everyday controls: DevTools and AI access moved into the app menu at its right end, where the DevTools row shows a tick while it is open and the AI row states whether the endpoint is running.
- Find in page now floats over the page at the top right instead of taking a row of its own and pushing the page down. Ctrl+F works from the chrome and from inside the page, and opening it focuses and selects the previous query.
- A docked DevTools panel steps aside while any dropdown is open. That is now decided once, by whether a floating layer is open at all, so every menu is covered and nested menus keep the right state — before, only one menu did it, and it reported the wrong state.
- Stepping aside no longer widens the page back over the panel's half of the split, so opening the downloads panel or a menu leaves the seam where the user put it instead of looking like DevTools vanished.
- Closing a tab now closes its DevTools too. The front-end used to keep running with nothing in the strip naming it and no way left to close it.
- **The AI can now see more of a page**: `read_browser_console` returns the page's errors, console output and requests in one call and clears them, so it answers "what happened since I last looked"; `wait_browser` gained `network-idle`, which waits until every request has finished and the page has gone quiet instead of guessing which element to watch; page reads now carry `parent` and `depth` per node, so a button can be attributed to the dialog it sits in; and `screenshot_browser_tab` takes `inline` to return the image itself, for clients that cannot open a local path.
- **The AI can measure performance too**: `measure_browser_performance` reports, for a short observation window, each of the eight metrics' mean, peak, when the peak happened and the latest reading — from the same CDP counters Chrome's performance monitor uses, so "is this page slow" stops being a guess. Consecutive calls continue where the previous one left off and sampling keeps running in between, which is what lets "measure, click, measure again" show the cost of that click; the peak's offset pairs with the timestamps of console lines. `read_browser_performance` serves callers that want the points. When the panel is already sampling, an AI read takes it over instead of restarting it, so a user's chart is never wiped.
- **Fixed the Dock icon disappearing on macOS**: creating the floating strip or the identity label transformed the whole process into a menu-bar (accessory) app and nothing ever transformed it back, taking the Dock icon, the app menu and Cmd+Tab with it. Showing on every Space is kept; the process type is no longer touched.
- **Fixed the macOS app menu stealing page shortcuts**: Cmd+R / Cmd+Shift+R / Cmd+±/0 acted on the shell — reloading the whole UI and zooming the chrome instead of the page — and Cmd+W closed the window or quit the app outright. They now forward to the framed page; Cmd+W closes the tab first and only falls back to the window when there is none, and closing the window moved to Cmd+Shift+W.
- **Fixed macOS engine versions, orphan-browser sweeping and a spurious teardown error**: the `Info.plist` lookup walked one directory too far, so every engine reported no version; `ps` output holds an unquoted profile path with spaces, which was cut at the first space so no leftover browser was ever recognised; and `taskkill` was spawned on non-Windows platforms, raising an async error nothing could catch.

## [2.0.0] - 2026-11-08

### 中文

- **内置浏览器核心重写**：被测页面从「叠在界面之上的原生窗口」改为应用界面自身的一部分。菜单、弹窗、提示从此直接盖在页面上，不再有任何「被页面挡住」「先冻结再遮罩」的妥协。
- **界面全面翻新**：运行栏与页面导航合并为左侧一列，标签条贴边、动效统一；浅色主题换成明快的金黄主色。
- **书签并入浏览器**：新标签页顶部就是书签栏，悬停逐层展开、右键管理、拖拽排序；管理页支持多选批量删除。
- **启动更跟手**：点击账号立即切换过去；批量启动空格子先就位、逐格点亮并显示进度。
- **开发者工具停靠进页面格位**（分隔条可拖、页面实时跟随）；遇到 401 鉴权或代理认证会弹出登录框，凭据只存内存、退出即清。

#### 完整变更

**内置浏览器核心重写（webview 承载）**

- 旧方案里被测页面是系统级的原生窗口，永远叠在应用界面之上：菜单、toast、拖拽分屏的每个浮层都要先「冻结舞台 → 停放页面 → 盖 HTML → 回位」，仍然处处受限。2.0 把页面改成应用文档内的 webview 节点（ADR 0011），界面与页面同处一份 DOM——浮层天然盖住页面，冻结回路整套删除。
- **AI 与自动化能力原样保留**：控制面仍是 CDP，MCP 工具集不受影响；填充、截图、会话检测、语义定位全部照旧。CDP 空闲约 1.5 秒自动断开，Google 登录一类探测调试协议的风控页面看到的仍是干净 Chromium。
- **后台标签常驻**：切到账号页时页面继续活着，AI 截图、读页、开页照常工作，后台页截图毫秒级返回。
- **隔离与安全不降级**：每个身份仍是磁盘上独立的持久化分区——升级后所有登录态原样保留；页面进程无 Node、全沙箱、协议白名单，弹窗统一路由进应用的标签模型。
- 配套底座升级：Electron 45、凭据存储链路（safeStorage）全面异步化。
- 升级注意：页面节点随应用启动重建，若个别页面显示异常，重启应用即可；会话与凭据数据不受影响。

**界面与外壳**

- 外壳重做为扁平化平面风格：左侧一列上半是运行栏、下半是页面导航，设置改用侧边标签、整窗覆盖；顶部标签条贴边，选中态改用中性灰阶，浮层统一进出场动画。
- 收起侧栏后窗口就是普通浏览器；收起态为每个运行中的实例保留一个站点图标，点击切换。运行坞里不属于任何视图的分组更名为「实例」。
- 浅色主题主色重做：填充用明快金黄配深色文字，链接与彩色文字用专门的金色。
- 设置页常规选项按「外观 / 浏览 / 启动与填充 / 应用 / 工具」分节。
- 新建视图的默认布局为「无布局」，每个页面占满整块舞台，需要分格时再选布局。
- 首次打开改为弹出**使用指南**（一页讲清「建站点 → 录账号 → 启动」），取代逐个指控件的高亮教程。

**浏览器与开发者工具**

- DevTools 停靠进页面格位：分隔条可拖、拖动时页面实时跟随；支持绕过缓存的强制刷新。停靠面板在下拉菜单打开期间自动让位，菜单关闭后回到原位。
- 打开需要登录的网站（nginx 401、代理认证）弹出账号密码输入框；同一保护空间会话内只问一次，取消后短时间内安静。凭据只存内存，退出即清；服务器返回的中文保护区域说明自动还原。
- 点击账号或视图立即切换到浏览器页，页面后台继续加载；批量启动显示「正在启动 N/M」进度，页面逐格点亮，且不再闪现「实例」分组。
- 顶部标签条可拖动排序，中键点击关闭（格位内标签条同样支持）；把某一格正在显示的页拖到同一账号的另一格不再出现空白格。
- 新建页面选择器底部并排提供「空白页」与「干净会话」：一次性会话的空标签页用完即弃、不留登录状态。

**书签**

- 新标签页顶部书签栏：一层放平的书签与文件夹，悬停逐层展开、跨层级只保留一条路径；右键改名/删除，拖拽排序；放不下的收进右端溢出菜单。原有的书签瓦片网格移除。
- 书签并入左侧导航；站点页主操作改为「新建身份」。
- 管理页支持多选批量删除（文件夹连同其中全部内容一起移除）；行内操作按钮跟随行内容显示，宽窗口下不再出现在屏幕最右缘。
- 从 Edge / Chrome / Firefox 导入的书签直接合并到顶层，不再套一层浏览器根目录。
- 书签栏的文件夹面板限高滚动；二级及更深的面板贴视口定位，父面板滚动时自动收起，不再被裁切或悬错位置。

**其他修复**

- 侧栏收起态的运行数角标不再被窗口顶边裁掉一半。
- 英文界面下，应用自动生成的默认名称（新标签页、无身份页面的占位名、书签导入的「默认配置」「未命名文件夹」）跟随界面语言。

### English

- **The embedded browser core is rewritten**: pages move from native windows stacked above the UI into the app's own document. Menus, dialogs and toasts simply draw over pages — no more freezing, parking or burying.
- **A refreshed shell**: the running dock and page navigation merge into one left column; edge-attached tab strip, unified motion; the light theme moves to a crisp gold accent.
- **Bookmarks join the browser**: the new-tab page opens with a bookmark bar — hover to expand level by level, right-click to manage, drag to reorder; the management page supports multi-select delete.
- **Launches feel instant**: clicking an account switches right away; a batch launch seats its cells first, lights each page as it lands and shows progress.
- **DevTools dock into the page's cell** (draggable divider, the page follows in real time); HTTP 401 and proxy authentication now open a sign-in dialog — credentials live in memory only and die with the app.

#### Complete changes

**The embedded browser core is rewritten (webview carrier)**

- Pages used to be system-level native windows composited above the app UI: every floating layer — menus, toasts, split-view drags — had to freeze the stage, park the pages, draw HTML over the hole and restore. 2.0 hosts pages as webview nodes inside the app's own document (ADR 0011), so HTML simply stacks over them and the entire freeze loop is deleted.
- **AI and automation are unchanged**: the control plane is still CDP and the MCP tool set is unaffected; fill, screenshots, session checks and semantic targeting all work as before. CDP detaches after ~1.5s idle, so risk-control pages such as Google's sign-in still see a clean Chromium.
- **Background tabs stay alive**: switching to the accounts page keeps every page running — AI screenshots, reads and opens work as usual, and background-page screenshots come back in milliseconds.
- **Isolation and safety are not traded away**: each identity keeps its own persistent partition on disk — every login state survives the upgrade; page processes have no Node, run fully sandboxed behind a protocol allow-list, and popups are routed into the app's tab model.
- Underpinnings moved too: Electron 45 and a fully async credential chain (safeStorage).
- Upgrade note: page nodes are rebuilt on app start; if a page ever looks wrong, restarting the app fixes it. Session and credential data are unaffected.

**Shell & appearance**

- The shell is redrawn flat: one left column with the running dock above and page navigation below; settings covers the whole window with its own side tabs; the tab strip sits flush with the window edge, selection turned neutral grey, and floating layers share one entry/exit motion.
- With the sidebar hidden the window is a plain browser; each running instance keeps one site icon in the collapsed strip. The dock's group for instances outside any view is now called "Instances".
- The light theme's accent is redone: bright gold fills with dark text, and a dedicated deep gold for links and coloured text.
- The settings page's general options are grouped into sections (Appearance / Browsing / Launch & fill / Application / Tools).
- New views default to the "no layout" mode: each page fills the whole stage; pick a layout when you want cells.
- The first launch opens a **guide** (one page: create a site → add an account → launch), replacing the spotlight tour.

**Browser & DevTools**

- DevTools dock into the page's cell: draggable divider with the page following in real time; a cache-bypassing reload is available. A docked panel steps aside while a dropdown menu is open and returns when it closes.
- Websites requiring a sign-in (nginx 401, proxy auth) open a username-and-password dialog; each protection space is asked about once per session and dismissing it stays quiet for a while. Credentials are kept in memory only and die with the app; a server's non-ASCII realm is recovered automatically.
- Clicking an account or a view switches to the browser page right away while the page keeps loading; a batch launch shows "Starting N/M", lights each cell as its page lands, and no longer flashes through the loose "Instances" group.
- Tabs in the top strip can be dragged to reorder and closed with a middle-click (a cell's strip supports it too); dragging the page a cell was showing onto another cell of the same account no longer leaves a blank cell.
- The page chooser's footer offers "Blank page" and "Clean session" side by side: a blank tab in a throwaway session is a first-class choice, and nothing it picks up survives.

**Bookmarks**

- The new-tab page opens with a bookmark bar: one flat row of bookmarks and folders that expand level by level on hover, keeping a single hover path across levels; right-click to rename or delete, drag to reorder, overflow collected at the right end. The old tile grid is gone.
- Bookmarks join the left navigation; the sites page's primary action is now "New identity".
- The management page supports multi-select delete (a folder goes together with everything inside it); row actions follow the row's content instead of sitting at the screen's far edge.
- Bookmarks imported from Edge / Chrome / Firefox merge into the top level directly, without an extra browser root folder.
- Folder panels in the bookmark bar cap their height and scroll; panels below the root level pin to the viewport and collapse when their parent scrolls.

**Other fixes**

- The run-count badge on the collapsed sidebar is no longer clipped in half by the window's top edge.
- In the English UI, names the app generates automatically (the new-tab label, the placeholder for a page without an identity, and bookmark import's "Default profile" / "Untitled folder") follow the interface language.

## [1.4.0] - 2026-11-03

### 中文

- **新增使用指南**：右上角书签图标打开，首屏一张三步流程图讲清最小路径（箭头穿插在块与块之间，子页不再重复导航）；其余功能在左侧分类里按需看，没读过时图标有红点——按钮本身这次也补上了样式，此前按原生渲染图标不居中；引导走完自动打开一次并回到浏览器页
- **分屏更好用**：空单元格直接挑身份开页，不用先建空白页；页面还能钉到固定分辨率（内置手机/桌面预设、可手输宽高），按目标尺寸排版并等比缩小到格位，查响应式不用开第二个窗口；AI 侧同步拿到 set_browser_viewport / reset_browser_viewport
- **同一账号可以两页并排**：把一格的页签拖到另一格，这个浏览器实例就同时占两格、各显示一页——Cookie 和登录态完全共享，不用再开第二个实例重新登录。分屏后每格只列自己那一页，末尾的按钮变回「解除分屏」；运行栏改成一格一行，层级和屏幕上的格子对得上
- **缩进和层级对不上的问题修好了**：此前两格都画完整页签、运行栏又按实例嵌页，缩进描述的和肉眼看到的不是一回事；关掉被钉住的那页时也不再留下两格同图
- **每处「新建页面」都会先问你选哪个账号**：视图标题栏的「+」、地址栏旁的「+」此前会默默新建一个日常档案的空白页，现在统一弹账号选择窗，视图有归属站点时只列那个站点的账号
- **工作区级分辨率放进工具栏**：作为「全局默认」和单页的右键设置分工，菜单里一行字说明两者关系；改回自适应后缩放会正确回到 100%（此前显示 100% 但页面仍是上一个分辨率的缩放）
- **书签支持多层文件夹，像文件管理器一样操作**：新建/编辑走一个弹窗；管理页左侧是目录树，「全部」列出顶层文件夹和未分类书签；行可拖拽——拖到文件夹归档或移动、拖到行排序，磁贴拖到文件夹条归档；删除文件夹时内容上提一级；支持直接从本机的 Edge / Chrome / Firefox 导入书签（只读、自动去重）；旧数据自动迁移
- **AI 驱动更可靠**：语义定位与点击穿透 shadow DOM 和同源 iframe；点击结果带实际落点（hit），被遮挡不再靠猜；自动填充失败会说清缺的是哪一个密码；运行栏 AI 次数徽标按页面计数，审计日志补记页面 id
- **站点默认密码可以在站点上设置**：以前只能进账号对话框配，站点下一堆账号都继承时反而没人找得到；现在建站点、改站点时就能填，列表上直接标出「已设置 / 未设置」
- **登录态检测认得私订头令牌站点了**：此前只带 cookie 的检测在令牌站点上永远显示「已过期」，重新登录也消不掉；现在站点可配令牌存储键，检测会读页面里的会话令牌随请求发送，重新登录成功后还会自动复检、过期徽标当场更新
- **新标签页书签改为逐层导航**：浏览器导入几百条书签不再平铺成一面墙；当前层文件夹先成瓦片、点击下钻，面包屑回跳，磁贴拖上去即归档
- **书签管理页左右独立滚动**：目录树与列表各自滚动，面包屑不再被长树拖走；树行数字贴右缘、悬停按钮浮层化，不再像排坏了
- **新标签页搜索直达深层书签**：搜索框输入即全树匹配书签名（↑↓ 选择、回车打开，不选则照常走网址/引擎）；面包屑每级带下拉箭头，展开该层子文件夹直达——深树不必逐层点进去再退出来
- **Ctrl+R / F5 刷新内置页面**：页面内、地址栏、dock 上按都生效；Ctrl+Shift+R 绕过缓存强制刷新（macOS 为 Cmd）
- **运行栏层级清晰化**：身份色点下沉为网站图标角标、格位号只在多格布局显示、子页缩进严格深于父行——多账号时父/子页面一眼可分
- **toast 在 dock 展开时不再被页面盖住半截**：舞台上的原生页面永远画在 HTML 之上，此前 toast 比 dock 宽的部分连同折行尾字都被盖住；现在宽度钳制在 dock 之内，完整可见
- **更多列表可以拖拽排序**：标签页拖动手柄调整顺序（站点页的分组顺序随之变化）；站点卡片可在分组内拖动，顺序全局生效；书签文件夹支持同级排序（拖到行的上/下缘插入，拖到中间仍是归档）；流程步骤可直接拖动，上下箭头保留
- **修复语言「跟随系统」保存报错**：设置校验漏了 `system`，点按钮只弹校验错误、不生效；现在能正常保存，AI 的 update_settings 也同步放开
- **代理设置新增「测试连接」**：一键探测更新接口（GitHub）和代理出口（gstatic 204），逐条显示延迟并按结果给判读——「更新检查不走代理」是不是分流规则把 GitHub 指成了直连，一眼可见

#### 完整变更

- 使用指南做成独立弹窗（`GuideDialog.vue`）而不是继续加引导步骤：引导要在真实界面上逐个指控件，所以只能走一次；指南是一页可反复查看的内容，首屏一张图讲清最小路径，AI 那一块单独强调，其余按需展开
- 指南版本号（`guideVersion`）与引导版本号（`onboardingVersion`）分开：两者是不同东西，一个计数器答不了两个问题——跳过引导的人仍该看到指南红点
- 分屏槽位的身份选择器只列该视图所属站点的账号：视图定义里有 `siteId`；手工拼的容器没有定义，则从容器里已有的页面推断。两者都没有时不显示选择器
- `openEmbeddedTabInSlot` 新增可选 `identityId`：带上时用该身份的会话分区打开，标签页按身份命名与着色
- 书签文件夹升级为 id + parentId 的记录树（可多层嵌套）：按名字存在多层下意味着改一个中层名要重写全部后代路径，树拥有名字后改名与移动子树都是一次写。删除文件夹把子文件夹和书签上提一级，孤儿规则从「不可能有」变成「删除时重挂」；把文件夹移进它自己的子树会被拒绝
- 站点默认密码跟着站点草稿一起写，不拆成「先存站点、再 setPassword」：新站点在保存前还没有 id，拆开就得存两遍，而且密码写失败时会留下一个静默没密码的站点。草稿里带密码时先验密钥库是否解锁，锁着就整体失败
- 密码输入框永远不回填，界面只知道「有没有」；清空输入框不等于删除，删除要单独勾选——空输入是最常见的误触，不能让它悄悄抹掉一个别人依赖的密码
- 书签的新建与编辑合并成一个弹窗（名称、地址、文件夹树选择器），管理页改为左树右列表加面包屑：树负责在层级里导航，列表只显示当前文件夹自己的书签；地址栏星标收藏也从静默直存改为先弹窗确认再保存。行内的 window.prompt 重命名按钮随就地编辑移除（Electron 不实现 prompt()，原按钮一点击就抛异常，从未可用过），改名进弹窗。行内移动保留统一下拉，选项按完整路径标注；MCP 的 save_bookmark 增加 folderId，list_bookmarks 连文件夹一起返回
- 管理页按文件管理器语义工作：「全部」是根目录（顶层文件夹 + 未分类），列表先子文件夹后书签；拖拽一套手势——行拖到文件夹行或树节点 = 归档/移动，拖到书签行 = 排序，新标签页磁贴拖到文件夹条 = 归档；把文件夹拖进它自己的子树被服务层拒绝
- 从浏览器导入书签：主进程只读解析 Edge / Chrome 的 Bookmarks JSON 和 Firefox 的 places.sqlite（连同 -wal/-shm 复制到临时副本再打开，不碰原浏览器），按浏览器原有分组导成「<浏览器> 书签」顶层文件夹；地址去重与工作区同一 URL 规范化比对，被去重清空的分支自动剪枝，重复导入幂等；渲染层只见来源 id，不接触文件路径
- 标题栏 `guide-button` / `guide-dot` 此前没有任何样式规则，按钮按浏览器默认渲染，图标自然不居中；补齐后与旁边 launch-switch 同一套视觉词汇。教程窗口同步瘦身：删掉子页返回链接、回到开始按钮与底部快捷标签（左侧导航承担全部切换且永不滚走），流程箭头改为独立元素穿插在块与块之间，导航首项去掉装饰图标让列表左缘对齐
- 修复 `sanitizeBookmarks` 漏掉新字段导致文件夹在重启后消失：该函数逐字段重建记录，新增字段必须同时加进去。已加两条回归测试（含一条走「保存 → 重新加载」全链路），并验证删掉该行会让它们变红
- 修复书签网格被压成单列：新增的文件夹容器让网格宽度变成 `fit-content`，而 `auto-fill` 需要确定宽度才能算列数
- MCP 新增 `update_settings`：只接受白名单内的显示与启动偏好；凭据、密钥库、MCP 端点自身的开关/端口/令牌/权限一律拒绝，理由写在错误信息里——改权限等于自己给自己提权。白名单检查在 schema 之前，被拒的 key 能得到可用清单
- 徽标计数键从 origin 改为 tab id：徽标挂在行上，行就是页面，按站点计数答的是另一个问题。审计日志的页面动作行同时记录 `origin`（权限单位）与 `tabId`（页面单位），`e2e-ai-policy` 的「徽标 = 审计数」断言改为按 tab 比对，并新增「同站点两个标签各自独立计数」检查
- 固定分辨率的实现是「bounds 等比缩放 + zoomFactor 设为缩放比」：bounds `w·f × h·f` 配 zoom `f`，页面排版正好是 `w × h`（媒体查询、innerWidth 精确命中目标），不需要 CDP 的 deviceMetricsOverride。视口模式下 Ctrl+/- 无效（缩放比归拟合管），Ctrl+0 退出该模式；拟合在 DevTools 分割后的剩余格位里继续成立，冻结遮罩改用视图真实 bounds 定位以保持居中对齐
- `tests/embedded-viewport.test.ts` 钉住「bounds/scale = 目标尺寸」这条恒等式与校验边界；MCP 侧两条测试覆盖预设应用与越界拒绝（拒绝发生在到达 surface 之前，不会留下半套状态）
- MCP 新增 `compose_view`：把已打开的若干标签页组合成一个视图并分配格位。先全量校验再动手，中途失败按逆序把页面送回原位
- `update_settings` 拒绝带用户名密码的代理地址：审计日志是明文文件，脱敏按字段名匹配，藏在 URL 里的凭据会被原样写盘。同一处理也覆盖了导航工具里的 URL
- 运行栏（dock）行内结构精简：5px 独立身份色点改为 favicon 右下角 4px 角标（与折叠图标列同款）；格位号列仅网格布局（`slots > 1`）显示；散标签组的「▣/·」列删除（选中行 accent 竖条已表达同义）；`.pages` 缩进 21px → 23px/45px（网格），修复「父级缩进反而更大」的层级倒挂
- 刷新快捷键两层拦截：焦点在页面时走页面的 `before-input-event`，焦点在应用壳上时由主窗口兜底重载「壳当前框住的页面」；DevTools 面板聚焦沿用既有转发。Electron 不绑默认刷新，不拦就是死键
- toast 宽度绑定 dock 宽度（`min(380px, dock - 36px)`），`e2e-toast-geometry` 新增「stack ⊆ dock 矩形」断言（9 项）。dock 折叠态（34px 图标列）为已知架构边界，彻底方案是独立原生 toast 窗口
- 1.3.1 的 Teleport 修复保留：它防的是祖先 transform 劫持 fixed 锚点的另一类问题
- `e2e-zoom-devtools` 的 mock 服务器加 GET 计数器，新增 4 条刷新用例（33 项）；刷新只能从服务端请求数观测，DOM 无法区分新载与活页
- 令牌探测：站点新增 `authTokenKey` / `authTokenHeader`（站点对话框与 MCP create_site / update_site 均可配置），探针在检查时从页面 localStorage 读令牌随请求发送；打开窗口检测、无窗口后台检测、内置表面自动登录等待循环三处同源生效。重新登录（`fillLogin`）提交成功后静置 2 秒自动复检并落库，过期结果附填充记录（「HTTP 200 + signed-out marker · 已填充并提交」），把「填了但没登录上」与「还没检测」区分开
- 树行悬停按钮从占位改为浮层：原来 `opacity: 0` 的按钮仍占布局，把每个计数从右缘顶到行中间，看起来像 bug；现在计数贴真实右缘、悬停时按钮淡入盖住计数的位置。顺带修了一个隐患——隐形按钮此前仍可接收点击（`pointer-events` 直到悬停才打开）
- 新标签页网格 move 语义修正：拖拽排序的落点索引改按全量书签序解析，层过滤视图下原来会插错位置；文件夹瓦片与面包屑都是投递目标，拖到根面包屑即取消归档
- 搜索建议在名称前缀 > 名称包含 > URL 包含三档排序、上限 8 条：检索是深层书签的主路径，网格导航留给浏览；无输入或关闭「新标签页显示书签」设置时不出现。面包屑下拉只列该层子文件夹（带子树书签计数），链两级下拉即达任意深度；点外部关闭，箭头在有子级的层才显示
- 标签、站点、书签文件夹的重排各加一条 IPC（`site-tag:move` / `site:move` / `bookmark:folder-move`）：服务层沿用视图的「数组顺序即列表顺序」，只有文件夹用 `order` 且只在同级重排。分组视图里的落点下标按存储数组换算，避免一开筛选就落错位置
- 书签拖进文件夹时改为追加到目标文件夹末尾：原先保留旧的全局 `order`，归档后的位置由旧序号决定，看起来像随机插入
- 流程步骤拖拽只在编辑器草稿内重排，保存时随流程整体提交，因此不新增 IPC；步骤行加拖拽手柄，避免与输入框的文本选择冲突
- 修复语言「跟随系统」无法保存：`settingsPatchSchema` 只列了 zh/en，点设置页第一段（存 `system`）时 zod 校验失败，错误原文以 toast 弹出且设置不落盘。schema 与 MCP `update_settings` 的枚举改为从 `LOCALE_SETTINGS` 单一来源派生（类型同步），补 schema 回归测试与实机 e2e（`pnpm run e2e:settings-locale`）
- 代理设置新增连通性测试：两个探针都走 defaultSession（与更新检查同一网络栈、同一份代理设置），非 2xx 也按失败返回并保留状态码；判读文案覆盖「全通 / GitHub 被分流 / 仅 GitHub 通 / 全不通」四种组合。探针端点是 `src/shared/proxy.ts` 里的常量，e2e 用 `ENSEMBLE_CONNECTIVITY_*` 指向本地服务器验证全流程（`pnpm run e2e:connectivity`）

### English

- **New in-app guide**: opens from the book icon in the title bar. The first screen is one three-step diagram — arrows between the boxes now, and subpages no longer repeat the navigation; everything else sits in the left list. A dot marks it unread (and the button itself finally has its styles — it rendered native with an off-center icon); finishing the tour opens it once and lands on the browser page
- **Split-screen is nicer**: fill an empty cell with an account directly instead of stacking a blank page; and a page can be pinned to a fixed CSS resolution (phone/desktop presets or custom size), laid out at the target and scaled to fit its cell — responsive checks without a second window. The AI side gains set_browser_viewport / reset_browser_viewport
- **One account can show two pages side by side**: drag a page tab from one cell onto another and that browser instance fills both, each cell showing a different page — cookies and the session are shared, so there is no second instance and no second login. A split cell lists only its own page and its "+" becomes "stop splitting"; the dock draws one row per cell so its indentation matches the grid on screen
- **The indent that disagreed with the hierarchy is fixed**: both cells used to list the window's whole tab strip while the dock nested pages under one instance, so the indentation described a relationship the screen did not show; closing a pinned page no longer leaves two identical cells behind
- **Every "new page" control asks which account first**: the view header's "+" and the one beside the address bar used to create a blank page on the daily profile without saying so; both now open the account chooser, limited to the view's own site when it has one
- **A workspace-wide resolution control lands in the toolbar**: it is the default for every page, with per-page overrides staying on the tab's right-click menu and a line in the menu explaining the split. Going back to adaptive now restores 100% zoom too — it used to read 100% while the page kept the previous resolution's scale
- **Bookmarks nest, and the page works like a file manager**: creating and editing happens in one dialog; the management page has a folder tree, All lists top-level folders plus unfiled bookmarks, and rows drag — onto a folder to file it, onto a row to reorder, tiles onto the start-page strip to file them; deleting a folder moves its contents up one level. Bookmarks import straight from Edge / Chrome / Firefox installed on this machine (read-only, duplicates skipped); legacy name labels load as real folders
- **AI driving is more reliable**: snapshots and clicks pierce shadow DOM and same-origin iframes; click results carry where the events actually landed (hit); a failed autofill says which password is missing; the dock's AI badge counts per page and the audit log records the page id
- **A site can carry its own default password**: it was only settable from an account dialog, so when every account on a site inherited it, nobody could find it. It now lives on the site dialog itself, and the site list shows Set / Not set
- **Session checks understand header-token sites**: a cookie-only probe read every session as expired on sites that authenticate a private header from localStorage — re-logging in never cleared the badge. A site can now declare its token storage key; the probe reads and sends the token, and a successful relogin re-checks automatically so the badge updates on the spot
- **The new-tab bookmark grid navigates**: a browser import no longer flattens hundreds of bookmarks into one wall; the current level's folders come first as tiles that drill in, with a breadcrumb to jump back and drop targets to file tiles
- **The bookmark management page scrolls in two panes**: the tree and the list scroll independently and the breadcrumb stays put; tree counts sit at the true right edge and hover actions fade in over them instead of looking mislaid
- **Deep bookmarks are reachable from the new tab directly**: the search box now matches bookmark names across the whole tree (arrow keys to pick, Enter to open — otherwise it still resolves as a URL or a search), and every breadcrumb crumb carries a dropdown of that level's child folders, so a deep tree no longer means walking in and back out
- **Ctrl+R / F5 reload embedded pages**: works from inside a page, the address bar, and the dock; Ctrl+Shift+R bypasses the cache (Cmd on macOS)
- **Toasts are no longer half-covered by the page while the dock is open**: the stage's native view paints above every HTML layer, so the part of a toast wider than the dock — including a wrapped tail character — went unpainted. Toasts are now clamped to the dock's width and render fully
- **More lists reorder by dragging**: tags reorder from their row grip (the site groups follow), site cards drag inside a group with the order applying globally, bookmark folders reorder among siblings (drop on the top or bottom edge to insert, the middle still files), and flow steps drag directly while the arrow buttons stay
- **Fixed the "follow system" language option**: the settings validation missed `system`, so clicking it only surfaced an error and never saved; it saves now, and the AI's update_settings accepts it too
- **The proxy settings gain a connectivity test**: one click probes the update API (GitHub) and a proxy exit (gstatic 204), shows per-probe latency, and reads the combination for you — so "is my update check really going through the proxy" stops being guesswork

#### Full changes

- The guide is its own dialog rather than more tour steps: the tour points at live controls and can only run once, while a guide is a page you can return to at any time
- `guideVersion` is separate from `onboardingVersion`: one counter cannot answer both "have they been walked through the app" and "have they read the summary"
- The slot picker lists only accounts of that view's site, read from the view definition; a hand-assembled container falls back to the pages already in it, and an empty container with neither shows no picker
- `openEmbeddedTabInSlot` takes an optional `identityId` and opens the page in that identity's own partition, named and coloured after it
- Bookmark folders are records now (id + parentId, arbitrarily deep): name labels would mean rewriting every descendant's path on a middle-node rename, while the tree owning names makes rename and subtree moves single writes. Deleting a folder re-parents its contents one level up, and moving a folder under its own subtree is refused. Legacy name labels migrate into real top-level folders on load; exports carry the tree, and a bookmark's folderId survives an import only when the file carries that folder
- The site's default password rides on the site draft instead of a follow-up `setPassword`: a new site has no id to address until it is saved, so splitting it would mean two writes and would leave a site whose password silently did not land when the vault was locked. A draft carrying a password checks the vault first, so a locked vault fails the whole save
- Fixed `sanitizeBookmarks` dropping the new field, which made folders vanish after a restart: the function rebuilds records field by field, so a new field has to be added there too. Two regression tests cover it, one of them through a save-and-reload cycle, both verified to fail without the fix
- Fixed the bookmark grid collapsing to one column: the folder strip made its width `fit-content`, and `auto-fill` needs a definite width to count tracks
- MCP gains `update_settings`: a closed whitelist of display and launch preferences. Credentials, the vault and the MCP endpoint's own enable/port/token/permissions are refused, with the reason stated — changing those over MCP is escalating itself. The whitelist runs before the schema so a rejected key learns what is allowed
- MCP gains `compose_view`: it groups already-open tabs into a view and assigns slots. It validates everything before touching anything and rolls back in reverse order on failure
- `update_settings` refuses a proxy URL carrying credentials: the audit log is plain text and redacts by field name, so a credential inside a URL would be written verbatim. The same treatment covers URLs passed to navigation tools
- The password input is never prefilled and the UI only knows whether one exists; emptying the field is not a delete, which needs its own checkbox — a blank input is a common accident and must not quietly wipe a password others depend on
- Bookmark create and edit share one dialog (name, address, folder picked from a tree), and the management page is a tree on the left with a breadcrumb and one folder's bookmarks on the right; the address-bar star opens the dialog instead of saving silently. The window.prompt rename button is gone with it (Electron does not implement prompt() — the button threw on click and never worked); renaming lives in the dialog now. Row moves keep the shared dropdown, labelled by full path; MCP's save_bookmark takes a folderId and list_bookmarks returns folders too
- The management page works like a file manager: All is the root (top-level folders plus unfiled bookmarks) and subfolders list before bookmarks; one drag vocabulary covers everything — a row dropped on a folder row or tree node files it, a row dropped on another row reorders, a start-page tile dropped on a folder chip files it; dropping a folder into its own subtree is refused by the service
- Browser import: the main process read-only parses Edge / Chrome's Bookmarks JSON and Firefox's places.sqlite (copied to a temp staging dir with its -wal/-shm sidecars and opened read-only; the browser is never touched), maps each browser group to a "<browser> bookmarks" top-level folder, dedupes with the same URL canonicalization the workspace stores, prunes branches the dedupe emptied, and is idempotent on re-import; the renderer only ever sees opaque source ids, never file paths
- The title bar's `guide-button` / `guide-dot` had no style rules at all, so the button rendered native with an off-center icon; it now shares the visual vocabulary of the launch switch beside it. The guide window is slimmed down: the per-section back link, the back-to-start button and the cross-link chips are gone (the left list owns navigation and never scrolls away), the flow arrows sit between the boxes instead of inside them, and the nav's first entry drops its decorative icon so the list's left edge aligns
- Reload shortcuts are intercepted at two layers: the page's `before-input-event` when a page has focus, and a main-window fallback that reloads the page the chrome is framing when the focus is on the app's own UI; the DevTools panel keeps its existing forward-to-page behavior. Electron binds no default reload — without this the keys are simply dead
- Toast width now tracks the dock width (`min(380px, dock - 36px)`); `e2e-toast-geometry` gains a "stack inside the dock rectangle" assertion (9 checks). The collapsed dock (34px icon strip) remains a known architectural boundary; the complete fix would be a dedicated native toast window
- The 1.3.1 Teleport fix stays: it guards the other class of problem, a transformed ancestor stealing the fixed anchor
- `e2e-zoom-devtools`' mock server now counts GETs and gained 4 reload checks (33 total); a reload is only observable server-side — the DOM cannot tell a fresh load from a live one
- Token probes: sites gain `authTokenKey` / `authTokenHeader` (settable in the site dialog and via MCP create_site / update_site); the probe reads the token from the page's localStorage at check time. All three probe sites share it — the open-window check, the windowless background check, and the embedded surface's auto-login wait loop. A relogin (`fillLogin`) now settles for two seconds after a submit, re-checks, and persists; an expired verdict carries the fill record ("HTTP 200 + signed-out marker · filled and submitted"), separating "filled but not signed in" from "never checked"
- Tree row actions overlay the count instead of reserving layout space: the invisible buttons used to push every count off the right edge, mid-row, like a rendering bug. Counts sit at the true right edge now and the actions fade in over the vacated spot. This also fixes a latent trap — invisible buttons still caught clicks until now (`pointer-events` opens only on hover)
- The new-tab grid's move semantics are fixed: a drag-drop landing index resolves against the full workspace order — in a level-filtered view the filtered position used to land the tile in the wrong place; folder tiles and breadcrumb crumbs are drop targets, and the root crumb unfiles
- Suggestions rank name-prefix above name-substring above URL-substring and cap at eight rows: retrieval is the main path to a deep bookmark, the grid remains for browsing; nothing appears with an empty input or when the new-tab bookmark setting is off. The crumb dropdown lists child folders only, with their subtree bookmark counts — two chained dropdowns reach any depth; it closes on an outside click and the caret only renders where children exist
- Tag, site and bookmark-folder reordering each got one IPC (`site-tag:move`, `site:move`, `bookmark:folder-move`); the service follows the view rule — the stored array order is the list order — and only folders use `order`, scoped to siblings. Drop indexes from a grouped view are translated to the stored array, so turning on a filter cannot land the row somewhere else
- Filing a bookmark into a folder now appends it to that folder: the old code kept the bookmark's global `order`, so it landed wherever its previous slot happened to fall
- Flow-step drag reorders the editor draft only and saves with the flow, so no IPC is involved; the grip keeps the drag away from the row's inputs
- Fixed the "follow system" language option failing to save: the settings patch schema listed only zh/en, so clicking the picker's first segment (which stores `system`) failed validation, surfaced the raw issues as a toast and never persisted. The schema and MCP `update_settings` enums now derive from a single `LOCALE_SETTINGS` source (the type follows), with a schema regression test and a real-app e2e (`pnpm run e2e:settings-locale`)
- The proxy settings gain a connectivity test: both probes ride the default session (the same network stack and proxy settings as the update check), and a non-2xx answer counts as a failure with its status kept. The readout covers all four combinations. Probe endpoints live as constants in `src/shared/proxy.ts`; the e2e points them at local servers via `ENSEMBLE_CONNECTIVITY_*` (`pnpm run e2e:connectivity`)

## [1.3.1] - 2026-10-31

### 中文

- **多开账号不再白烧 CPU**：上一版宣称的「停放页闲置降速」实际从未生效（扫描没被启动、手段也压不住 3D 帧循环），现改为闲置 60 秒后整体冻结页面脚本，AI 一操作立即恢复
- **右下角提示不再被裁成两截**：批量启动后的「自动登录未完成」提示卡片此前可能贴着 dock 宽度排版、文字从两侧被裁断，现已挂到窗口根上，任何情况下都完整显示在右下角

#### 完整变更

- **停放页睡眠重做**：CDP CPU 节流拖不动 compositor 驱动的 rAF 帧循环、`setVisible(false)` 连 `visibilityState` 都不变（均实测），真正生效的是 `Page.setWebLifecycleState: "frozen"`——页面 JavaScript 整体挂起，3D 场景随之停。停放页闲置 60 秒（期间无 AI 操作）即冻结；AI 的每条命令先唤醒再执行，回到画面中或导航也会唤醒。正在播放声音、开着 DevTools 或在画面中的页面不受影响；自动化测试运行不启用
- **修复扫描启动**：上一版的降速扫描挂在「第一次 AI 命令」上才启动，纯手工使用的会话里从未运行过；现于浏览器构造时无条件启动
- **Toast 锚点加固**：`position: fixed` 的视口锚定在祖先带 transform 时会被劫持（toast 被按 dock 宽度排版、文字两侧裁断）。ToastStack 现在 Teleport 到 body，锚点不可能再被任何祖先偷走；宽度同时钳制在视口内
- 回归覆盖：`e2e-toast-geometry.mjs`（8 项，含 125% 缩放视口）新增；`e2e-batch-launch`（10 项）、`e2e-overlay-freeze`（7 项）复跑全绿

### English

- **Many open accounts no longer burn CPU**: the previous release's "idle parked tabs slow down" never actually engaged (the sweep was not started, and the lever could not tame rAF-driven 3D loops). Parked tabs now freeze entirely after 60 seconds idle and wake the moment the AI touches them
- **Bottom-right toasts are no longer clipped**: the batch-launch "auto-login incomplete" cards could be laid out at the dock's width with text cut on both edges; they are now mounted at the document root and always render fully in the corner

#### Full changes

- **Parked-tab sleep reworked**: CDP CPU throttling does not slow compositor-driven rAF loops and `setVisible(false)` does not even flip `visibilityState` (both measured); what works is `Page.setWebLifecycleState: "frozen"`, which suspends the page's JavaScript entirely. A parked tab freezes after 60 seconds without AI traffic; every AI command wakes the page before it runs, and re-staging or navigation wakes it too. Audible pages, pages with DevTools open, and pages on stage are never frozen; headless test runs keep the feature off
- **Sweep start fixed**: the previous release armed the sweep lazily on the first AI command, so a hands-on session never froze anything; it now starts unconditionally when the browser is constructed
- **Toast anchor hardened**: a `position: fixed` viewport anchor is hijacked whenever an ancestor carries a transform (toasts laid out at the dock's width with both text edges clipped). ToastStack now teleports to body, so no ancestor can steal the anchor, and its width is clamped to the viewport
- Regression coverage: new `e2e-toast-geometry.mjs` (8 checks, at a 125%-scaled viewport); `e2e-batch-launch` (10) and `e2e-overlay-freeze` (7) re-run green


## [1.3.0] - 2026-10-31

### 中文

- **批量启动一次全开**：多个账号同时打开，不再一个等一个，总时长约原来的三分之一；中途改布局也不会再打断启动
- **接口「未登录也返回 200」的站点能自动登录了**：站点设置新增「未登录标记」，填一段未登录响应里才有的文字，检测命中就按未登录处理
- **多开更省资源**：不在画面里的标签页闲置一分钟后自动降速，AI 一操作立即恢复全速，多账号并排不再持续吃满 GPU
- 修复无布局 / 松散标签页下打开菜单时，底下的页面整体上移一截的问题

#### 完整变更

- **批量启动改由主进程并发执行**：一批最多 3 页同时打开；落格按打开时的实时布局计算，中途切到无布局只会让多出的页面留在视图内，不再抛「槽位不存在」打断整批；任一页面失败时整批连同容器一起回收，不会留下开了一半的结果
- **站点新增「未登录标记」（可选）**：有些后端无论是否登录都返回 HTTP 200，登录与否只看响应体里的业务码，导致自动登录永远误判「已登录」。在站点设置里填入未登录响应里出现的文字（前 4 KB 内匹配），命中即按未登录处理，优先于 HTTP 状态。启动自动登录与账号页的批量登录态检测共用这一判定；MCP 的 `create_site` / `update_site` 也可设置
- **停放页自动降速**：不在画面中的标签页闲置 60 秒后按 8× CPU 节流降速，rAF 驱动的 3D 场景帧率按比例回落；正在播放声音、开着 DevTools 或回到画面中的页面不受影响；AI 的每条操作（读取、点击、截图）都会先把页面恢复全速再执行。自动化测试运行（headless）不启用降速
- **修复无布局弹层底图上移**：打开「从站点打开」菜单、右键菜单等弹层时，垫在底下的页面截图比实况位置高出一个标签条高度（26px），弹层关闭后恢复。根因是冻结截图没有走与实况摆放相同的几何函数
- 回归覆盖：批量与登录标记 `e2e-batch-launch`（10 项）、弹层底图 `e2e-overlay-freeze`（7 项）、标记判定 `tests/auth-check-marker.test.ts`

### English

- **Batch launch opens everyone at once**: identities in a batch now open concurrently instead of one after another, finishing in about a third of the time; changing the layout mid-run no longer aborts the launch
- **Auto-login works on APIs that answer 200 even when signed out**: sites gain an optional "signed-out marker" — a snippet from the signed-out response body; when the check endpoint's body matches it, the session is treated as signed out
- **Lighter when many accounts are open**: tabs outside the stage throttle down after a minute idle and return to full speed the moment the AI touches them, so a wall of accounts no longer pins the GPU
- Fixed the page jumping up by the tab-strip height whenever an overlay opened over a flat / no-layout stage

#### Full changes

- **Batch launch is owned by the main process and runs concurrently**: up to 3 pages open at a time; slot assignment re-reads the live layout, so switching to the Free layout mid-run simply parks the extra pages instead of throwing and killing the batch; any failure recycles the whole batch together with its container
- **Sites gain an optional "signed-out marker"**: some backends wrap every answer in HTTP 200 and put the verdict in the body, which made the session probe read signed-out as signed-in and never fill. Enter a snippet that only appears in the signed-out body (matched within the first 4 KB); a hit overrides the HTTP status. Both the launch auto-login and the accounts-page batch auth check share this rule, and MCP `create_site` / `update_site` can set it
- **Parked tabs slow down when idle**: after 60 seconds without AI traffic, an off-stage tab is throttled to 8× CPU, which brings rAF-driven 3D scenes down proportionally. Audible pages, pages with DevTools open, and pages on stage are never touched, and every AI command restores full speed before it runs. Headless test runs keep throttling off
- **Fixed the overlay backdrop jumping in flat mode**: the frozen picture painted under menus sat one 26px tab-strip band higher than the live page, because the freeze path skipped the geometry function the live placement uses
- Regression coverage: batch and marker `e2e-batch-launch` (10 checks), overlay freeze `e2e-overlay-freeze` (7 checks), marker matching `tests/auth-check-marker.test.ts`


## [1.2.0] - 2026-10-27

### 中文

- **开了代理终于能正常下载更新**：以前更新检查和下载不跟随系统代理，开着 Clash 之类的工具只会看到进度条一动不动；现在默认跟随系统代理，读不到时也可以在设置页手填地址
- **AI 客户端连上就知道这是什么**：只给一个 MCP 端点，它也能读到站点 / 身份 / 视图这套模型和几个容易踩的规则，不用你再解释一遍
- **新增「网络代理」设置**：跟随系统、直连、手动三档，内置浏览器和自动更新共用同一套规则，本地地址始终直连
- 运行栏「AI 操作次数」徽标的说明改成应用内即时提示，不再是等一秒才冒出来的系统原生提示框

#### 完整变更

- **更新检查与下载改走 Chromium 的网络栈**：`net.fetch` 使用 `session.defaultSession`，代理设置才能生效；全局 `fetch` 跑在应用从未配置过的 session 上，这正是「进度条不涨」的原因——请求根本没发出去，而是挂在 DNS 上直到超时
- 新增「网络代理」设置，三档：跟随系统（默认，等同普通浏览器）、直连、手动填地址（`http://127.0.0.1:7890` 或 `socks5://…`）。本地地址始终跳过代理——测试环境都在 127.0.0.1，被代理出去就加载不出来
- 手动地址在保存时就校验格式，不合法会就地提示，而不是等到下载时才无声失败；不合法的地址也不会回退成直连，否则用户会以为设置被忽略
- 内置浏览器的每个身份分区都要单独应用代理规则（Chromium 按 session 保存），打开新页面时读取当前设置；已打开的页面保留它加载时的代理，刷新后跟随新设置
- 设置页的代理改动实时生效，不用重启；主进程会打一行日志说明当前生效的是什么
- 新增 `scripts/e2e-proxy.mjs`：起一个桩代理，把更新地址指向一个只在代理里能解析的域名，断言请求确实经过代理且响应被解析成版本。已验证把 `net.fetch` 改回全局 `fetch` 时这条会失败（`fetch failed`，代理侧看不到请求）
- `tests/proxy.test.ts` 覆盖代理规则的四种情形（跟随系统、直连、可用地址、不可用地址）与跳过列表；顺带发现并修掉一个真 bug：`URL.hostname` 对 IPv6 已经带方括号，代码又包了一层，会得到 `[[::1]]`
- **MCP 连接时返回 `instructions`**：这是协议里唯一能介绍「这个端点是什么」的字段，此前完全没有，模型只看到 60 个动词。现在有一段 1.3KB 的说明，交代工作区 → 站点 → 身份 → 视图这条主线、日常档案页默认只读、先用 `read_browser_page` 再用 label 定位、用 `wait_browser` 而不是 sleep
- 两个标签工具的旧别名（`save_site_tag` / `delete_site_tag`）从 `tools/list` 隐藏：仍然可以调用，但不再占每个会话的上下文——同义动词让模型二选一毫无收益
- `create_identity` 与 `create_identities` 的字段定义合并成一处，`tabId` 的说明也统一，避免同一句话在列表里重复十遍
- 新增 `scripts/measure-mcp-context.mjs`：量 `initialize` 与 `tools/list` 的实际字节数与字符数，用于以后判断注入量是否又长回去了
- 新增契约测试：`instructions` 必须提到 Ensemble、站点/身份/视图、来源规则，且长度必须小于 2000 字符（它会加到每个会话里）；别名必须可调用但不出现在列表里
- 标题栏左上角不再重复显示版本号，右下角状态栏那一处保留；渲染层的设置兜底值改为直接复用 `DEFAULT_SETTINGS`，避免新增字段时漏掉一处
- **AI 次数徽标的提示由原生 `title` 改为自绘**：原生提示不能改样式、要等一秒、还会以系统窗口的形式盖在应用之上；自绘的提示挂在徽标内部向左展开，始终留在停靠栏内。原因是停靠栏和各视图块都裁切溢出，而停在舞台上的被测页面是原生视图、永远画在应用 HTML 之上，所以提示不能往右或往舞台方向溢出
- 提示文案为「本次会话在本站的操作次数」：数字已经在徽标上，再抄一遍既啰嗦又会让计数涨到三位数后撑破停靠栏；含中文的句子改用正文字体栈，不走等宽（等宽栈会让中文回退成宋体）
- 行上的原生 URL 提示移到标题文字上：徽标在行尾，若整行仍挂着原生 `title`，悬停徽标会同时冒出系统提示与自绘提示两种
- `e2e-ai-policy` 的徽标断言重写：断言徽标数字与审计日志里该来源的条数完全相等（这是「这个数字是真的吗」的直接答案，也顺带钉住「按来源算」而不是按工具调用或标签页算）；再断言徽标没有原生 `title`、悬停后出现自绘提示、移开后消失，并把停靠栏拖到最窄（240px）后量出提示相对每一层裁切祖先的位置，要求完全在内；同一处还会把提示换成英文再量一次宽度，确认两种语言都放得下。已分别把计数步长改成 2、把提示改成向右展开验证两条都会失败，确认有鉴别力
- README 中英双版写明 AI 操作次数按来源计数，同一站点的两个标签显示同一个数字是设计如此

### English

- **Updates download again when a proxy is running**: the update check and download ignored the system proxy, so with Clash on the progress bar simply never moved. They now follow the system proxy by default, with a manual address for setups it does not reach
- **An AI client knows what this is from the endpoint alone**: given only the MCP config it now reads the site / identity / view model and the rules that are easy to get wrong, instead of needing you to explain them
- **New "Network proxy" setting**: follow system, direct, or manual — one rule set for both the built-in browser and automatic updates, with local addresses always connected directly
- The hover hint on the dock's AI action count is now drawn in-app and appears at once, instead of a native OS tooltip that waits a second

#### Full changes

- **Update check and download now run on Chromium's network stack**: `net.fetch` uses `session.defaultSession`, which is the only session the proxy settings reach. The global `fetch` runs on a session the app never configured — that is exactly "the progress bar never moves": the request never left, it sat in DNS until it timed out
- New "Network proxy" setting with three modes: follow system (default, what a normal browser does), direct, and a manual address (`http://127.0.0.1:7890` or `socks5://…`). Local addresses always skip the proxy — every test environment lives on 127.0.0.1, and proxying it would stop the page loading
- A manual address is validated when saved, so a typo is reported in place instead of failing silently at download time; an unusable address never falls back to direct, which would look like the setting was ignored
- Every identity partition in the built-in browser gets the rules applied separately (Chromium keeps them per session) and reads the current settings when a page opens; pages already open keep the proxy they loaded with and follow the new one after a reload
- Proxy changes apply live from the settings page without a restart, and the main process logs what is in force
- New `scripts/e2e-proxy.mjs`: a stub proxy plus an update endpoint on a host that only resolves through it, asserting the request really went through the proxy and the response parsed as a release. Verified to fail when `net.fetch` is swapped back for the global `fetch` (`fetch failed`, nothing reaches the proxy)
- `tests/proxy.test.ts` covers the four proxy rule cases (system, direct, usable address, unusable address) and the bypass list; it also caught a real bug: `URL.hostname` already returns an IPv6 literal in brackets, so wrapping it again produced `[[::1]]`
- **MCP now returns `instructions` on connect**: it is the one field in the protocol for "what is this endpoint", and it was empty — the model saw 60 verbs and no sentence joining them. A 1.3KB paragraph now covers the workspace → site → identity → view model, that daily-profile pages are read-only until the origin is allowed, to call `read_browser_page` before reaching for a selector, and to use `wait_browser` instead of sleeping
- The two tag-tool aliases (`save_site_tag` / `delete_site_tag`) are hidden from `tools/list`: still callable, but no longer costing every session context for a choice the model cannot gain from
- `create_identity` and `create_identities` share one field definition, and the `tabId` description is defined once instead of being repeated ten times
- New `scripts/measure-mcp-context.mjs` measures the real bytes and characters of `initialize` and `tools/list`, so a future change can be checked against this baseline
- New contract tests: `instructions` must mention Ensemble, the site/identity/view model and the origin rule, and must stay under 2000 characters (it is prepended to every session); the aliases must be callable while staying out of the list
- The duplicated version number leaves the title bar; the renderer's settings fallback now reuses `DEFAULT_SETTINGS` instead of a literal copy that a new field can miss
- **The AI-count tooltip is drawn by the app instead of a native `title`**: a native hint cannot be styled, waits a second, and paints as an OS window above the app; the drawn one sits inside the badge and opens leftwards, staying within the dock. It has to: the dock and every view block clip their overflow, and the pages parked on the stage are native views that always paint above app HTML, so the hint cannot spill rightwards or towards the stage
- The hint reads "AI operations on this site so far": the number already sits in the badge, and repeating it made the sentence grow with the count until it no longer fit at three digits. The sentence also uses the body font stack — the badge is mono because it holds a number, and a mono stack falls back to a serif for Chinese
- The row's native URL hint moves onto the title text: with it still on the whole row, hovering the badge would raise the OS tooltip alongside the drawn one
- `e2e-ai-policy`'s badge check is rewritten: it asserts the badge number equals the number of audited entries for that origin — the direct answer to "is this number real", and what pins the count to origins rather than tool calls or tabs — then that there is no native `title`, that hovering opens a drawn hint and leaving closes it, and — after dragging the dock to its narrowest (240px) — that the hint sits inside every clipping ancestor; it finally swaps in the English text and measures again, so neither language can ship wider than the panel. Verified to fail both when the counter steps by two and when the hint is flipped to open rightwards
- README (both languages) documents the badge as counting per origin, with two tabs of one site showing one number by design


## [1.1.3] - 2026-10-27

### 中文

- **修复切走的页面截图要等 4 秒**：AI 操作的那页被你切到后台、或窗口最小化时，截图会先等满 4 秒超时才回退；现在直接走渲染器，同样的图 40ms 出来
- README 新增「AI 操作时，你可以继续做你的事」一节：页面没有独立窗口可弹、切走不打断 AI、AI 不抢前台、测试全静默

#### 完整变更

- **截图路径按页面是否在屏幕上选择**：合成分器对被移出窗口的视图不产帧，`Page.captureScreenshot` 在那里不会报错、而是永不返回，于是离台页面的每次截图都先付满 4 秒超时。实测：在台上 CDP 约 40ms，离台 4023ms，最小化 4023ms；改后离台 37ms、最小化 40ms，图像字节数一致
- 判定抽成 `shared/embedded.ts` 的纯函数 `viewIsOnScreen(rect, content, host)`，三个输入都是调用方直接可读的；判定错只会让截图走较慢的路，不影响像素结果
- `CdpClient.screenshot` 新增 `preferRenderer` 参数，`EmbeddedBrowser.screenshot` 依据 `viewIsOnScreen` 传入；`capturePage` 回退保留，覆盖无法预判的状态
- `tests/embedded.test.ts` 新增 6 条覆盖判定本身（在台上、已停放、最小化、隐藏、零尺寸、恰好贴边），已用「恒为真」验证会失败
- `e2e-embedded` 新增一条：后台页面截图必须在 1.5s 内返回且有内容。注意无头模式下所有页面都离台，这条在无头里没有鉴别力，真正守住逻辑的是上面的单元测试
- README 中英双版新增「AI 操作时，你可以继续做你的事」：说明页面没有独立窗口、切走不打断、AI 不抢前台、20 套测试全部离屏运行

### English

- **Fixed screenshots of a switched-away page taking 4 seconds**: when the page the AI was driving moved to the background or the window was minimised, a screenshot waited out a full 4s timeout before falling back; it now reads from the renderer directly and returns the same image in ~40ms
- README gains "The AI works; you keep working": pages have no separate window to pop up, switching away does not interrupt the AI, the AI never raises your window, and the test suites run silently

#### Full changes

- **The screenshot path now follows whether the page is on screen**: the compositor produces no frames for a view moved off-window, and `Page.captureScreenshot` there does not fail — it never returns, so every screenshot of a parked page paid the full 4s timeout first. Measured: on stage ~40ms via CDP, parked 4023ms, minimised 4023ms; after the change 37ms and 40ms with identical bytes
- The decision is a pure function, `viewIsOnScreen(rect, content, host)` in `shared/embedded.ts`; a wrong answer only routes the screenshot down the slower path, never a wrong pixel
- `CdpClient.screenshot` gains a `preferRenderer` flag that `EmbeddedBrowser.screenshot` sets from `viewIsOnScreen`; the `capturePage` fallback stays for states this cannot predict
- `tests/embedded.test.ts` gains 6 cases covering the decision itself (on stage, parked, minimised, hidden, zero-sized, exactly at the edge), verified to fail when the predicate is forced to true
- `e2e-embedded` gains one check: a backgrounded page must screenshot within 1.5s with real content. Note it has no discriminating power headless — every page is parked there — so the unit tests are what actually pin the logic
- README (both languages) gains "The AI works; you keep working": no separate window, switching away is safe, the AI never steals focus, and all 20 test suites run off-screen


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
