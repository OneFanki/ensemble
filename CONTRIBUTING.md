# Contributing

感谢有兴趣参与。Ensemble 保持小而聚焦，提交前请先读下面几段。

## Setup

```bash
pnpm install
pnpm dev
```

要求 Node.js >= 22.12、pnpm 12。

## Before opening a pull request

```bash
pnpm verify     # 类型 + 单测 + 结构契约 + 构建
pnpm test:e2e   # 改了启动、CDP 或填充逻辑时
```

第二条需要本机已安装 Chromium 系浏览器。涉及浏览器启动、登录填充、窗口定位的改动，
还应在真实浏览器上手工确认：退出后没有残留的浏览器进程。

## Commit messages

使用中文，按功能拆分，前缀使用 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`：

```
feat(core): 支持 Flatpak 浏览器探测
fix(cdp): 修复登录态检测未携带 Cookie
docs(readme): 补充 Wayland 窗口定位限制
```

一个提交只做一件事。不要把格式化整个仓库和个人改动混在一起。

## Code layout

- `src/core/`：纯 Node，不允许 import `electron`（由契约测试守护）。
- `src/main/`：Electron 主进程，负责窗口、IPC、系统能力。
- `src/preload/`：只暴露白名单 API。
- `src/renderer/`：Vue 3 界面，不直接访问 Node API。
- `tests/`：Vitest，核心层单元测试与结构契约。

新增平台探测逻辑时，把纯解析函数和文件系统访问分开，便于测试。

## Conventions worth knowing

- **用户可见文案必须走 `src/renderer/src/i18n/index.ts`**，同时补 `zh` 和 `en`。
  组件里用 `$t(...)` 或 `useI18n()`，store 里用 `tr(...)`。
- **凭据相关代码不能引入明文回退**，也不能把密码放进 IPC 返回值或日志。
- **新增浮层要对齐既有层级**：遮罩 70、弹窗 71、toast 100。
- **字体**：等宽字体只用于技术数据，且不得以泛型 `monospace` 结尾（Windows 会把中文回退成宋体）。

## Security

不要提交任何真实凭据、内部地址、Cookie 或浏览器 profile。测试数据使用
`example.com`、`test.local` 之类的占位域名。演示数据同样不能出现真实业务名或人名。

## Reporting bugs

用 issue 模板提交，并附上 Ensemble 版本、操作系统与浏览器版本。安全漏洞请走
[SECURITY.md](SECURITY.md)，不要开公开 issue。
