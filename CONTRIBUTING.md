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

## Versioning and releases

`package.json` 的 `version` 是唯一来源：安装包文件名、应用内「关于」、GitHub tag 与 Release
标题都由它派生。发布是自动的——**合入 main 时版本号变了，就会发一版**；版本号没变，合并只
是普通提交，不会产生重复 Release。

什么时候动版本号（语义化版本，当前处于 0.x）：

| 改动 | 版本号 | 例子 |
| --- | --- | --- |
| 新功能，或破坏性变更（数据格式、导出文件、MCP 接口不兼容） | 升 minor | `0.1.3` → `0.2.0` |
| 修复、文档、内部重构，无行为变化 | 升 patch | `0.2.0` → `0.2.1` |
| 纯 CI / 依赖 / 注释，用户感知不到 | 不升 | — |

0.x 阶段 semver 允许把破坏性变更放进 minor，所以功能与破坏性变更共用同一档；等 1.0 之后
再拆分到 major。现在的判定从宽：只要用户需要重新导入配置或重建 profile，就必须升 minor，
并在 Release notes 里写清迁移方式。

操作方式：

```bash
pnpm version patch --no-git-tag-version   # 或 minor / 手动改成 0.2.0
git add package.json
git commit -m "chore(build): 版本号 0.2.1"
```

`--no-git-tag-version` 只改文件、不自动打 tag。**正常发布时不要手动推送 `v*` tag**：
tag 由 `.github/workflows/release.yml` 在构建成功后创建，手动推会让版本号和产物脱节。
只有需要重跑某个已发布版本时，才推一个与 `package.json` 完全一致的 tag。

一个 PR 只在需要发布时改版本号。多个 PR 一起合入时，由最后一个合入的 PR 负责 bump，
避免同一版本号被并发合入的 PR 重复使用。

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
