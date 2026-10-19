# Ensemble 项目约束

> 本文件只保留每次任务都必须看到的约束。详细规范按任务读取，不一次性加载全部文档。
> 通用工程纪律（提交规范、文档纪律、踩坑升级机制）在本文件；项目特有的业务规则在
> `docs/architecture.md` 与 `docs/engineering/` 下。

## 定位

本地多身份浏览器工作台，用于验证权限系统与多人协作。Electron + Vue 3 + 纯 Node 核心层。

## 规则优先级

1. 用户当前明确要求
2. 数据正确性、账号隔离、凭据安全
3. 现有架构边界（`core` 不依赖 Electron、浏览器不由 Electron 渲染）
4. 局部便利

本文件中的「必须 / 禁止」是硬约束；「默认 / 优先」是一般策略，偏离时必须说明理由。

## 开发命令

```bash
pnpm install          # 安装依赖（Node >= 22.12，pnpm 12）
pnpm dev              # 开发模式
pnpm verify           # 全量校验：类型 + 单测 + 结构契约 + 构建（非 fail-fast）
pnpm test             # 核心层单元测试
pnpm typecheck        # Node 侧 + 渲染层类型检查
pnpm build            # 构建 out/
pnpm screenshots      # 重新生成 README 截图（需先 build）
pnpm dist             # 打包安装程序与便携版到 release/
```

单跑某个测试文件：`pnpm test tests/grid.test.ts`。

## 强制约束

1. **被测浏览器不由 Electron 渲染。** 管理台用 Electron 自己的 WebView 渲染；被测站点必须由外部真实浏览器进程承载。禁止把被测页面塞进 `BrowserWindow` 或 `webview`，否则兼容性结论失真。
2. **`src/core/` 不允许 import `electron`。** 核心层要能在纯 Node 下测试，并为未来 CLI/CI 复用保留可能性。系统能力（safeStorage、screen、clipboard）由主进程注入。由 `tests/contracts/core-isolation.test.ts` 守护。
3. **每个身份一个独立 profile 目录**，路径 `<userData>/profiles/<envId>/<identityId>`。禁止两个身份共用 profile，禁止指向用户日常浏览器的 profile。
4. **凭据绝不进入渲染进程。** IPC 不返回明文密码；填充在主进程通过 CDP 完成；日志不打印密码或页面内容。
5. **进程清理只按 profile 路径归属。** 只清理命令行 `--user-data-dir` 指向自有 `profiles/` 根目录的进程，禁止按进程名批量杀浏览器。由 `tests/contracts/process-ownership.test.ts` 守护关键解析函数。
6. **场景启动必须原子。** 中途失败要回收本次已拉起的窗口，不能留下半套实例。
7. **不打包浏览器。** 引擎来自系统安装，版本由厂商更新；不要把 Playwright 自带浏览器或 Chromium 二进制放进安装包。由 `tests/contracts/no-bundled-browser.test.ts` 守护。
8. **主链路不用 Playwright 驱动人工窗口。** Playwright 会默认接管对话框与下载，会改变被测环境。它只能用于管理台自身的无头 E2E 测试。
9. **渲染层传给主进程的参数必须是可结构化克隆的纯数据。** Vue `reactive` 对象里的嵌套结构仍是 Proxy，IPC 会抛 `An object could not be cloned`。发 IPC 前先转换。
10. **浮层层级统一编号**：遮罩 70、弹窗内容 71、toast 100。新增浮层先对齐，不要各自取号。
11. **字体栈不得以泛型 `monospace` 结尾。** Windows 会把中文回退成宋体；等宽栈必须显式列出 CJK 无衬线字体。
12. **等宽字体只用于技术数据**（账号、路径、版本、时间戳）。含中文的标签用正文字体。
13. **界面文案与占位不得出现具体业务名或真实人名。** 用「本地开发环境」「管理员 · 主账号」这类中性示例。
14. **启动参数必须包含 `--disable-sync`。** 浏览器会自动用 Windows 账户登录并把同步数据（书签、扩展、密码）灌进新 profile，导致每个测试实例都带着操作者的账号和扩展。禁止改用 `--disable-extensions` 来规避——那会禁掉被测站点需要的扩展。
15. **MCP 工具永远不返回明文密码。** 可以写密码（`password` 参数进加密凭据库），但不得提供读密码、复制密码或任何回显明文的工具与字段。删除类工具必须要求 `confirm: true`，生产环境名必须要求 `confirmProduction: true`。
16. **MCP 端点只绑 `127.0.0.1`，并且必须校验 Bearer Token、`Host` 与 `Origin`。** 新增工具时按 read / write / run / danger 定档，权限开关在设置页控制；审计日志写入前对 `password|passphrase|token|secret` 递归脱敏。
17. **退出顺序固定**：先停 MCP → 销毁托盘 → 回收浏览器。由 `tests/contracts/tray-mcp-lifecycle.test.ts` 守护，禁止在 `before-quit` 里提前置 `quitting` 绕过。

## 质量要求

- TypeScript 保持 strict，不用 `any` 绕过类型（第三方边界处允许 `any`，但必须局部收口）。
- 修复缺陷时补回归测试；测试断言行为契约（输入→输出、边界约束），禁止写「变更检测器」式测试。
- 碰到报错或诡异行为，先查 `docs/engineering/踩坑库.md`；解决后当场追加条目（含日期）。
- 公共接口、目录结构或核心模式变化后，同步更新 `docs/architecture.md`；重大架构决策写 ADR 到 `docs/architecture/adr/`，**被否方案必填**。
- 修改看似冗余的代码前，先 `git log -p -S <符号>` 查原始意图；确认是防御性设计就保留并注释原因。
- 单文件膨胀到难以阅读时主动拆分，不在失衡结构上无限追加补丁。
- 文档改一次压缩一次：过时信息当场删除、重复合并、同一结论只留一个详细版本。

## Git 规范

- 未得到当次明确指令，不提交、不推送；提交与推送是两个独立授权。
- 提交格式 `type(scope): 中文描述`，`type` 只用 feat/fix/refactor/docs/test/chore，`scope` 必填（core/main/renderer/preload/docs/build/root），header ≤ 100 字符。
- 多 AI 并发是常态：`git add` / `git commit` 只包含当前任务文件，禁止 `git add -A`、`git add .`、`git commit -a`。
- 禁止对全项目执行自动修复（`lint --fix`、`format --write`）；检查只针对本次改动文件。

## 按任务读取

| 任务 | 必读 |
| --- | --- |
| 任何代码改动 | 本文件 + `docs/architecture.md` |
| 改动浏览器启动、CDP、窗口定位 | `docs/engineering/cdp-playbook.md` |
| 改动凭据、自动填充、生产环境行为 | `docs/architecture.md` 的安全边界一节 |
| 遇到报错或反常行为 | `docs/engineering/踩坑库.md` |
| 做架构取舍 | `docs/architecture/adr/` 现有决策，先看是否已被否 |
| 打包、发布、升级 Electron | `docs/engineering/release.md` |
| 改动管理台界面、更新 README 截图 | `.agents/skills/screenshot-refresh/SKILL.md` |
| 新增依赖 | 先确认是否真需要；UI 层禁止引入 Element Plus 一类带视觉主张的组件库 |

## 文档落点

| 内容 | 位置 |
| --- | --- |
| 当前架构与数据模型 | `docs/architecture.md` |
| 架构决策记录 | `docs/architecture/adr/` |
| 工程规范与操作手册 | `docs/engineering/` |
| 经验型踩坑 | `docs/engineering/踩坑库.md` |
| 用户可见说明 | `README.md` |
| 安全策略 | `SECURITY.md` |

## 标识

- 产品名：Ensemble / 同台
- GitHub：`OneFanki/ensemble`
- appId：`io.github.onefanki.ensemble`
- 环境变量前缀：`ENSEMBLE_`

## 验证清单

交付代码前至少：

```bash
pnpm verify
```

涉及浏览器启动、登录填充、窗口定位的改动，还必须在真实浏览器上手工验证，并确认退出后无残留进程：

```powershell
Get-CimInstance Win32_Process |
  Where-Object { $_.Name -match "msedge|chrome" -and $_.CommandLine -like "*Ensemble*" }
```
