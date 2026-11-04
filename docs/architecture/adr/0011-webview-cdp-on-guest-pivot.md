# 0011. 内置浏览器迁移到 renderer `<webview>` + CDP-on-guest

- 日期：2026-11-03
- 状态：已采纳（方向；取代 [0010](./0010-webview-pivot-deferred.md) 的「暂缓」结论，分阶段落地）
- 前置：[0006](./0006-embedded-browser-first.md)（内置为主）、[0010](./0010-webview-pivot-deferred.md)

## 背景

0010（2026-10-28）裁决维持 `WebContentsView` 并把迁移立为观察项。三条重启条件中，
**第一条已经成立**：2.0 的产品方向要求「像浏览器」——omnibox 联想、菜单、拖拽分屏、
浮层控件都要盖在页面上方，而 `WebContentsView` 是窗口 native 层，永远合成在 renderer DOM
之上。我们为此付出的冻结→停放→HTML 遮罩→回位回路，每新增一个浮层需求都要先过一遍，
且每处都是踩坑库级的实测补丁（截图矩阵、DevTools 停靠、`CalculateNativeWinOcclusion`、
0×0 viewport 首布局）。

迁移按 P1–P5 五阶段推进，每阶段真机验证。三类高发问题——native UAF、CDP 风控探测、高 DPI
截图缺边——已有定论，见下文「已有明确结论的坑」，直接内建，不重踩。

## 决策

**迁移到 renderer `<webview>`，控制面保持 CDP**：页面宿主从 main 的 `WebContentsView`
改为 renderer DOM 里的 `<webview>`，main 经 `did-attach-webview` 拿到 guest `webContents`
后 `debugger.attach("1.3")` 执行既有 CDP 命令。executor 层（`core/cdp/inspect.ts` 与
`EmbeddedCdp` 的命令面）作用于 `webContents + CDP send` 抽象，**接口同构、零改复用**。

### 安全边界（0010 第 3 条的重论证）

0010 否决时的顾虑之一是 webview 方案常见的「agent 与 human 共用单一 `persist:` 分区」做法。
Ensemble **不采用这一点**：

- `<webview>` 的 `partition` 是**每 guest 一个属性**——每身份独立 `persist:<identityId>`
  分区在 webview 下比 WebContentsView 下表达更自然（创建期声明，不由 main 集中分发）；
- guest 硬化保持不变：`webviewTag: true` 只开在主窗口；`will-attach-webview` 里锁死
  `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`、`nodeIntegrationInSubFrames: false`，
  删除页面传入的 `preload`/`nodeintegration` 参数，只保留我们白名单的属性；
- URL 白名单：`will-attach-webview` 校验 `src` 协议（http/https/about + 我们的内部页），
  非法协议 `preventDefault()`；
- popup 路由：`setWindowOpenHandler` deny + 转内部 tab 的模型不变；**`allowpopups` 必须在
  renderer 创建 `<webview>` 节点时作为 attribute 输出**（创建期能力，事后补无效：实测
  guest attach 后再补 attribute，Chromium 在更早的权限边界已吞掉新窗口请求，main 的
  handler 收不到事件）；
- AGENTS.md 第 1 条的「不挂带权限的 preload」继续成立：页面 guest 一律不挂我们的 preload。
  「弹窗来源标题」一类需求需要 guest preload 做桥，**不采纳**；我们的 JS 弹窗只走 CDP
  （`Page.javascriptDialogOpening`），人类交互期弹窗显示问题另行设计（见阶段 P6）；
- 架构边界表述更新：AGENTS.md 第 3 条「浏览器不由 Electron 渲染」改为「被测页面不进
  管理台自己的 `BrowserWindow` 渲染进程的特权上下文」——webview guest 是独立渲染进程、
  无 Node、沙箱化，满足原意。

### 已有明确结论的坑（迁移时直接内建）

1. **CDP 空闲释放**：命令空闲约 1.5s 主动 `detach`。Google 登录等风控 JS 探测 CDP 会话即
   拒登；手动浏览期保持 detach，页面看到的就是干净 Chromium。
2. **re-attach 要重放 session 态**：detach 后裸 attach 得到干净 session，`Page.enable`
   丢失会让 dialog 事件黑洞；必须显式重放并以串行屏障挡住业务命令。
3. **销毁顺序**：guest `destroyed` 之后再 `detach()` 已太晚——native UAF。替换/关闭
   `<webview>` 前必须先走 main 的 teardown 握手（等在途命令归零 → detach → ACK），
   renderer 收到 ACK 才卸载节点；teardown single-flight，guest 分代。
4. **弹窗超时**：无人处理的 JS 弹窗 60s 自动 dismiss，否则页面挂死。
5. **高 DPI 截图**：固定 viewport 的截图准备层尺寸不得超过宿主可见窗口，否则 Windows
   高 DPI 下 Chromium guest raster 裁剪缺边，归一化把缺边拉伸成整图。
6. **最小化窗口 CDP Input 静默丢弃**：用户最小化后 agent 输入无效且不报错，截图前需
   `Emulation.setFocusEmulationEnabled`（我们已有）+ 窗口可见性处理。
7. **tab 硬上限**：每窗口 32 个逻辑 tab，超限逐出最久未活动的（带保护 lease：截图、
   下载、媒体播放中的 tab 不逐出）。
8. **agent 下载兜底**：agent 分组的 tab 触发下载不弹系统另存为（agent 点不了原生
   对话框），自动落下载目录并处理重名。

## 迁移阶段（每阶段独立提交、真机验证）

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **P1** main guest 底座 | `BrowserGuestManager`（attachGuest / execute 复用现有 executor / teardown 握手 / 空闲释放 / 分代）+ `will/did-attach-webview` 硬化与白名单 + webviewTag 开关 | 单测：attach 后 execute 走 guest；未 attach pending/超时；teardown 后旧 guest 命令被拒 |
| **P2** renderer webview 组件 | 格位容器从「矩形上报」改为渲染 `<webview partition="persist:…">`；`dom-ready` 上报 guestId；webview 事件驱动 chrome 状态；`allowpopups` 创建期声明 | 真机：菜单不再被遮；导航/截图/DevTools/多格 |
| **P3** agent 握手 | AI 开页命令 → 通知 renderer 建 webview tab → 上报 guestId → main attach → 完成 pending 命令（10s 超时） | 真机：MCP `open_browser_tab` → `read_browser_page` 全链路 |
| **P4** 删定位资产 | `attachView`/`setBounds`/`parkAll`/`freeze()`/遮挡开关/0×0 viewport 首布局/DevTools 停靠分离条，逐条确认后删除；`stageGeometry` 契约改 DOM 布局 | 截图/几何矩阵整表重测通过；冻结回路代码归零 |
| **P5** 回归 | 全部 e2e + 手工矩阵（缩放、最小化、多身份分区隔离、popup、下载） | 十套 e2e 全绿；分区隔离实测（A 身份 cookie 不落 B 身份） |
| **P6**（后置） | 人类交互期弹窗的展示形态；tab 硬上限与逐出 | 单独 spec |

P4 是风险最集中的一步：要删的每一处都是实测补丁，删除本身要逐条重验，不接受「应该没用了」。

### P1 落地记录（2026-11-04）

三块逻辑拆成纯核心模块，各自可单测，Electron 只在边缘做适配：

| 模块 | 位置 | 职责 |
| --- | --- | --- |
| 会话状态机 | `core/cdp/guest-sessions.ts` | attach 复用、空闲释放、teardown 握手、分代 |
| 挂载策略 | `core/cdp/guest-policy.ts` | 协议/分区白名单、guest `webPreferences` 强制硬化 |
| 等待队列 | `core/cdp/guest-slots.ts` | 开页到 attach 之间的命令挂起与超时 |
| 适配层 | `main/embedded/guests.ts` | `will/did-attach-webview` 接线、popup 路由、CDP 端口 |

两条与计划不同的落地结论：

1. **`allowpopups` 必须放行，不能剥掉。** 原计划按「未知属性一律丢弃」处理，实测语义是：
   属性缺失时 Chromium 在更早的权限边界就吞掉新窗口请求，main 的
   `setWindowOpenHandler` 根本收不到事件。所以它是白名单内成员，安全性由下一层的
   「一律 deny + 转 app tab」承担，而不是靠不发请求。
2. **executor 一行没改。** `EmbeddedCdp` 的构造参数本来就是 `WebContents`，guest 与原生
   view 在它眼里没有区别；迁移后只是换了一个创建位置。这也意味着 P4 删除的是定位资产，
   不是命令面。

`withGuest` 是所有命令的唯一入口：它在状态机里计数，teardown 才能等在途命令归零。
任何绕过它的调用都会让握手失去意义——这条约束没有类型能强制，靠 review 和这条记录守住。

### P2 前置实测（2026-11-04）

动手改渲染层之前，先在独立的最小工程里测掉四个决定架构的问题。结论改变了实现方式：

| 问题 | 结论 | 影响 |
| --- | --- | --- |
| 移除节点后 guest 还在吗 | **立刻销毁**（1.2s 内 `isDestroyed()`） | 后台标签只能留在 DOM 里用 CSS 隐藏，不能拔出节点；teardown 必须先 detach 再让渲染层移除 |
| 隐藏的节点还能截图吗 | **能**（`display:none` 下 57ms，切回显示后 38ms） | 「一标签一常驻节点」成立，不需要为后台标签另建载体 |
| guest 截图为什么挂起 | guest 的合成器在**嵌入方产出第一帧之前**不产帧 | 驱动 guest 前必须先对宿主 webContents 做一次 CDP 截图；只 attach 不够，`capturePage` 会抛 `UnknownVizError` |
| 宿主窗口隐藏后呢 | 截图挂起（与既有停放规律一致） | 与 `WebContentsView` 时期同样的约束，不是迁移引入的新问题 |

实验过程本身也有个坑：第一次用 `data:` URL 做宿主页面，连宿主自己的 `capturePage` 都抛
`UnknownVizError`，误判成 webview 截图不可用。换成 http 服务宿主后单个 guest 截图 40ms
正常。排查载体问题时宿主页面必须走真实协议。

两条已写进踩坑库（`<webview>` guest 截图预热、移除节点销毁 guest），P2 必须内建预热，
否则所有后台标签的 AI 截图会各自等满超时。



## 被否方案

- **A. 维持 WebContentsView 继续修**（0010 的现状，本次被否）。0010 的三条重启条件第一条
  已成立（浮层需求持续增长且现有回路覆盖成本线性上升）；webview 路线的长期可维护性也已
  被实际运行证实。0010 记录的三条顾虑中，截图矩阵与定位资产删除风险由 P4/P5 的逐条重验
  化解，安全权衡由本 ADR 的分区分节重论证化解。
- **B. 迁移并共用单一分区**（webview 方案的常见简化，被否）。与 Ensemble 的身份隔离立身
  之本冲突；webview 的 per-guest `partition` 属性让多分区反而更简单。
- **C. 迁移同时引入弹窗 preload 桥**（被否，本轮）。guest preload 是「带权限的 preload」
  边界上的 slippery slope，且 agent 链路的弹窗走 CDP 已足够；人类展示形态留 P6 单独设计，
  不让它绑架迁移主线。
- **D. 换 Electron 之外的载体**（被否，未评估）。与 0005（不打包浏览器）、0006（内置优先）
  冲突，且等于换产品。

## 影响面摘要

- 几何：`attachView`/`applyLayout`/`parkAll`/`stageGeometry` 整体改 DOM 布局，矩形上报回路删除。
- 截图：`EmbeddedCdp.screenshot` 双路径矩阵整表重测；`freeze()` 可整体删除。
- MCP 面绝缘：`EmbeddedSurface` 只传 tabId 与可序列化结果，**迁移不影响 MCP 工具集**。
- e2e：以现有十套（293 项）为迁移安全网，重构期间保持全绿。
