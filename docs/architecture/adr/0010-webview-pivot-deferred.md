# 0010. 内置浏览器渲染载体维持 WebContentsView（webview 迁移暂缓，列为观察项）

- 日期：2026-10-28
- 状态：已采纳（2026-10-28 用户裁决：维持现状）

## 背景

ZCode 于 2026-07-08 把内置浏览器从 main 进程 `WebContentsView` 迁回 renderer `<webview>`
（CDP-on-guest pivot），核心理由是：WebContentsView 是窗口 native 层，**永远合成在 renderer
DOM 之上**，菜单/下拉/tooltip 碰到页面区域就被遮且 z-index 无法修复（本质缺陷），并连带
setBounds/setVisible 定位、DPR 换算等一串 bug。Ensemble 是否跟进迁移，在 2026-10-28 形成
实际议题。

迁移影响面已经完整盘点（含全部行号证据，见本文末尾「影响面」），三个关键事实：

1. **Ensemble 已经为「native 层遮不住 HTML」付出过成本并形成工作回路**：冻结
   （`freeze()` CDP 截图成图）→ 停放（`parkAll` 把页面移出窗口）→ HTML 遮罩 → 回位。
   菜单、拖拽、地址联想全部走这条链，且实测有效。webview 的最大收益「浮层直接盖住页面」
   在 Ensemble 已通过替代方案达成，只是实现更绕。
2. **迁移可删除的机制同时也是最容易被删错的机制**：冻结/停放/DevTools 停靠分离条/Windows
   遮挡开关（`CalculateNativeWinOcclusion`）/0×0 viewport 首布局，每一处都是
   踩坑库级的实测补丁（截图矩阵：停放窗外 CDP 截图挂起、`capturePage` 可用、窗口全隐藏
   两者皆失败）。webview 下截图合成行为完全不同，这张实测矩阵必须整表重测。
3. **ZCode 接受了与 Ensemble 产品论点相反的安全权衡**：webview 方案里 agent 与 human 共用
   `persist:zcode-embedded-browser` 单一分区（agent 复用 human 登录态）。Ensemble 的立身
   之本是按身份隔离（每身份独立 `persist:` 分区与 profile），且 AGENTS.md 强制约束 1 要求
   内置 view 必须 sandbox、无 preload；迁移把被测页面 view 的宿主从 main 挪进管理台
   renderer，`webviewTag: true` 需要在主窗口打开（当前显式 `false`），架构边界（ADR 0006
   的「浏览器不由 Electron 渲染」半句）需要重新表述。

## 决策（草案）

**暂缓迁移，维持 WebContentsView**，理由按权重：

1. 收益已大部分被现有回路覆盖（浮层可用，虽绕但稳）；
2. 迁移需要整表重测截图/几何矩阵并重写五套机制，风险窗口长；
3. ZCode 的 pivot 伴随的安全权衡（共用分区）不可接受，安全边界需要独立论证后才能重排。

**同时把迁移立为观察项**，满足任一条件时重启评估：

- 出现 WebContentsView 路线无法实现的浮层/交互需求（现有冻结回路覆盖不了的）；
- Electron 官方进一步弱化 `WebContentsView` 或 `<webview>` 反超为推荐方案；
- 几何/遮挡类 bug 的修复成本累计明显超过一次迁移。

若未来重启迁移，按 ZCode 验证过的五阶段走（P1 guest 底座 → P2 renderer webview 组件 →
P3 握手 → P4 删定位资产 → P5 回归），每阶段独立提交、真机验证，且先解决第 3 点的安全
边界并同步改写 ADR 0006。

## 被否方案

- **方案 A：立即迁移到 `<webview>` + CDP-on-guest**（本次被否）。理由见决策 1–3。被否的
  不是方向本身——ZCode 的实践证明该架构长期更简洁（DOM 内合成、可删冻结/停放两套机制）——
  而是时机：在隔离边界未重新论证、测试矩阵未重测计划未落定时动手，会把已稳定的表面
  推进长风险窗口。
- **方案 B：不迁移且不设观察项**（被否）。等于把「每加一个浮层需求都要先过冻结回路」
  固化为永久成本，与「越改越难受」的长期担忧相反。

## 影响面（迁移若重启时的清单摘要）

- 几何：`attachView`/`applyLayout`/`parkAll`/`hostContentSize`/`setStage`/`describe().bounds`
  ——webview 下 stage rect 上报与 ResizeObserver 同步回路整体删除，改 DOM 布局。
- 截图：`EmbeddedCdp.screenshot` 双路径矩阵需整表重测；`freeze()` 在 webview 下可整体删除。
- DevTools：`mountDevTools`/`placeDevTools`/分离条 16ms 光标轮询/webview 下大多简化，但每处
  都是实测补丁，删除需逐条重验（F12、前端 reload 重建、语言提示条）。
- 弹窗：`setWindowOpenHandler` 路由语义迁移到 webview 的创建期契约（`allowpopups` 必须在
  React 创建节点时声明，后补无效——ZCode 实测踩坑）。
- 安全：`webviewTag` 开关、主窗口 webPreferences、被测页面 renderer 归属重述。
- MCP 面绝缘：`EmbeddedSurface` 只传 tabId 与可序列化结果，迁移不影响 MCP 工具集。
