# Contributing

## Setup

```bash
pnpm install
pnpm dev
```

Node.js >= 22.12，pnpm 12。

## Before opening a pull request

```bash
pnpm typecheck
pnpm test
pnpm build
```

## Commit messages

使用中文，按功能拆分，前缀使用 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。示例：

```
feat(core): 支持 Flatpak 浏览器探测
fix(cdp): 修复登录态检测未携带 Cookie
docs(readme): 补充 Wayland 窗口定位限制
```

## Code layout

- `src/core/`：纯 Node，不允许 import `electron`。
- `src/main/`：Electron 主进程，负责窗口、IPC、系统能力。
- `src/preload/`：只暴露白名单 API。
- `src/renderer/`：Vue 3 界面，不直接访问 Node API。
- `tests/`：核心层单元测试，使用 Vitest。

新增平台探测逻辑时，把纯解析函数和文件系统访问分开，便于测试。

## Security

不要提交任何真实凭据、内部地址、Cookie 或浏览器 profile。测试数据使用 `example.com`、`test.local` 之类的占位域名。
