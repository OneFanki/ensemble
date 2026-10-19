# Architecture Decision Records

记录「为什么这样选」，尤其是**被否的方案**，避免未来包括 AI 在内的重复争论。

| 编号 | 决策 | 状态 |
| --- | --- | --- |
| [0001](./0001-cdp-over-playwright.md) | 人工操作用系统浏览器 + CDP，不用 Playwright 托管窗口 | 已采纳 |
| [0002](./0002-electron-shell-not-embedded-browser.md) | Electron 只做管理台，不内嵌被测页面 | 已采纳 |
| [0003](./0003-identity-environment-scene.md) | 三层模型与凭据边界：身份存真值、环境存默认、顶层只存钥匙 | 已采纳 |
| [0004](./0004-ui-stack.md) | Reka UI + Lucide + CSS 变量，不用 Element Plus | 已采纳 |
| [0005](./0005-no-bundled-browsers.md) | 不打包浏览器，启动时扫描系统引擎 | 已采纳 |

新决策模板：

```markdown
# NNNN. <决策一句话>

- 日期：
- 状态：提议 / 已采纳 / 已废弃（被 NNNN 取代）

## 背景
## 决策
## 被否方案（必填）
## 后果
```
