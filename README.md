# Ensemble · 同台

Multiple identities, one stage.

Ensemble 是一个本地多账号浏览器工作台，面向需要同时登录多个账号来验证**权限系统**与**多人协作**的前端、后端和 QA。它不内置浏览器，而是启动系统里已经安装的真实 Chrome、Edge、Brave、Vivaldi 或 Firefox，每个身份使用独立的浏览器 profile，登录态、Cookie、扩展、下载行为都与真人使用一致。

## 核心概念

| 概念 | 含义 | 是否隔离 |
| --- | --- | --- |
| 环境 | 被测目标：baseUrl、登录入口、登录检测地址、默认凭据 | 否，是作用域 |
| 身份 | 一个账号 + 一个独立的浏览器 profile | 是，完全隔离 |
| 场景 | 一次测试要同时拉起的身份组合与窗口布局 | 否，是编排 |

三个概念的关系是：环境 1—N 身份，环境 1—N 场景，场景 N—N 身份。身份只属于一个环境；同一账号要测两个环境时，创建两个身份。

## 能力

- 启动时自动扫描系统中的浏览器，也可手动指定可执行文件，随时重新扫描
- 每个身份独立 profile 目录，支持同时登录多个账号
- 一键启动单个身份，或按场景批量拉起并按网格平铺窗口
- 凭据集中管理：身份存自定义密码，环境存默认密码，应用层加密存储
- 登录态检测（需配置检测地址）与重新登录自动填充
- 干净会话：不登录、关闭即清除的临时窗口
- 退出时回收自己启动的所有浏览器进程

## 非目标

- 不做指纹伪装、反检测或自动化养号
- 不内置浏览器内核，不打包 Chromium
- 不做用例管理、测试报告或 CI 平台
- 不支持 Safari 多开（Safari 没有独立的 profile 目录模型）
- Firefox 通过外部模式启动：可多开、可布局、可复制密码，但不做页面内自动填充与登录态检测

## 引擎支持

| 平台 | 默认 | 完整支持（CDP） | 外部模式 | 检测但不支持 |
| --- | --- | --- | --- | --- |
| Windows | Microsoft Edge | Edge / Chrome / Brave / Vivaldi / Chromium | Firefox | — |
| macOS | Google Chrome（若已安装，否则 Edge） | Chrome / Edge / Brave / Vivaldi / Chromium | Firefox | Safari |
| Linux | Chromium 系（若已安装） | Chrome / Chromium / Edge / Brave / Vivaldi | Firefox | — |

所有支持 CDP 的浏览器都由系统更新，Ensemble 不提供、也不负责更新浏览器版本。

## 技术架构

```
src/core/       纯 Node 层：引擎扫描、CDP 客户端、启动器、凭据、进程注册表
src/main/       Electron 主进程：窗口、IPC、安全存储、系统集成
src/preload/    受控 IPC 桥
src/renderer/   Vue 3 管理台界面
```

`src/core` 不依赖 Electron，可单独运行单元测试，也可被未来的 CLI 或 CI 复用。管理台界面与被测浏览器是两个完全独立的进程；界面不在 Electron 里内嵌被测页面。

## 开发

要求 Node.js >= 22.12、pnpm 12。

```bash
pnpm install
pnpm dev        # 启动开发模式
pnpm verify     # 全量校验：类型 + 单测 + 结构契约 + 构建
pnpm test       # 核心层单元测试
pnpm typecheck  # 类型检查
pnpm build      # 构建
pnpm dist       # 打包安装程序与便携版到 release/
```

`pnpm dist` 产出 `release/Ensemble-<version>-win-x64-setup.exe`（安装版）与
`...-portable.exe`（便携版）。**日常请用安装版**：便携版每次启动都要把运行时解压到临时
目录，冷启动会明显慢一些。

首次安装 Electron 需要访问外网。国内网络请先配置代理，例如：

```bash
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
pnpm install
```

也可以在本机创建 `.npmrc`（已被 `.gitignore` 忽略），使用镜像：

```ini
registry=https://registry.npmmirror.com
electron_mirror=https://npmmirror.com/mirrors/electron/
```

如果 `pnpm install` 之后 `node_modules/electron/dist` 不存在，说明 Electron 的下载脚本没有执行成功。可以单独重试：

```bash
node node_modules/electron/install.js
```

下载成功但解压失败时，压缩包通常已在 Electron 缓存目录（Windows 为
`%LOCALAPPDATA%\electron\Cache`），可手动解压到 `node_modules/electron/dist`，
并写入 `node_modules/electron/path.txt`（Windows 内容为 `electron.exe`）。


## 数据与安全

- 运行数据位于 Electron `userData` 目录，Windows 为 `%APPDATA%\Ensemble`，macOS 为 `~/Library/Application Support/Ensemble`，Linux 为 `~/.config/Ensemble`。
- `profiles/` 保存各身份的浏览器 profile；`workspace.json` 保存环境、身份、场景；`vault.json` 保存加密后的凭据。
- 凭据通过 Electron `safeStorage` 加密（Windows DPAPI、macOS Keychain、Linux 取决于系统密钥环）。Linux 上若没有可用密钥环，界面会明确提示。
- 密码不会发送到渲染进程，也不会写入日志；自动填充在主进程通过 CDP 完成。
- 渲染进程开启 `contextIsolation`，关闭 `nodeIntegration`，IPC 入参全部校验。
- 不要把 `profiles/`、`workspace.json`、`vault.json` 提交到仓库。

## 已知限制

- Wayland 下浏览器窗口的绝对定位可能被合成器忽略，网格平铺会退化为普通窗口。
- 需要重新登录时，密码由应用填充；双因素验证码、图形验证码需要人工完成。
- 浏览器大版本升级可能迁移 profile 格式，降级不一定可靠。
- Chrome 136 起禁止对默认数据目录开启远程调试；Ensemble 始终使用独立 profile 目录，不受影响。

## License

MIT
