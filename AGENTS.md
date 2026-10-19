# Ensemble 项目约束

## 定位

本地多身份浏览器工作台，用于验证权限系统与多人协作。Electron + Vue 3 + 纯 Node 核心层。

## 硬约束

1. **被测浏览器不由 Electron 渲染。** 管理台用 Electron 自己的 WebView 渲染；被测站点必须由外部真实浏览器进程承载。禁止把被测页面塞进 `BrowserWindow` 或 `webview`，否则兼容性结论失真。
2. **`src/core/` 不允许 import `electron`。** 核心层要能在纯 Node 下测试，并为未来 CLI/CI 复用保留可能性。系统能力（safeStorage、screen、clipboard）由主进程注入。
3. **每个身份一个独立 profile 目录**，路径 `<userData>/profiles/<envId>/<identityId>`。禁止两个身份共用 profile，禁止指向用户日常浏览器的 profile。
4. **凭据绝不进入渲染进程。** IPC 不返回明文密码；填充在主进程通过 CDP 完成；日志不打印密码或页面内容。
5. **进程清理只按 profile 路径归属。** 只清理命令行 `--user-data-dir` 指向自有 `profiles/` 根目录的进程，禁止按进程名批量杀浏览器。
6. **场景启动必须原子。** 中途失败要回收本次已拉起的窗口，不能留下半套实例。
7. **不打包浏览器。** 引擎来自系统安装，版本由厂商更新；不要引入 Playwright 自带浏览器作为主链路依赖。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/core/engines/` | 跨平台浏览器探测与排序 |
| `src/core/cdp/` | CDP 客户端、目标发现、登录填充脚本 |
| `src/core/launch/` | 参数构造、spawn、停止与回收 |
| `src/core/credentials/` | 凭据库与继承解析 |
| `src/core/layout/` | 网格布局计算 |
| `src/core/processes/` | 进程发现与 workspace 数据结构 |
| `src/core/service.ts` | 用例编排 |
| `src/main/` | Electron 主进程、IPC、系统能力 |
| `src/preload/` | 白名单 IPC 桥 |
| `src/renderer/` | Vue 3 管理台 |
| `tests/` | 核心层单元测试 |

## 技术选型（已拍板）

- Electron 44 + Vue 3.5 + TypeScript + Vite + pnpm
- UI：Reka UI（无样式行为层）+ Lucide 图标 + CSS 变量；不引入 Element Plus
- 表格：确有复杂表格需求时用 TanStack Table，不自研
- 状态：Pinia；校验：Zod；测试：Vitest
- 主链路：系统浏览器 + CDP，不用 Playwright 驱动人工窗口

## 标识

- 产品名：Ensemble / 同台
- GitHub：`OneFanki/ensemble`
- appId：`io.github.onefanki.ensemble`
- 环境变量前缀：`ENSEMBLE_`

## 提交规范

中文，按功能拆分，前缀 `feat` / `fix` / `docs` / `refactor` / `test` / `chore`。
主会话按显式路径暂存，禁止 `git add -A`。

## 验证

改动核心层后至少跑：

```bash
pnpm test
pnpm typecheck
pnpm build
```

涉及浏览器启动、登录填充、窗口定位的改动，需要在真实浏览器上手工验证，并确认退出后无残留进程。
