# Security Policy

## Reporting

请通过 GitHub Security Advisory 私下报告安全问题，不要开公开 issue。请在报告中说明影响版本、复现步骤和影响范围。

## Threat model

Ensemble 是本地单用户工具。它假定：

- 运行它的操作系统账户是可信的。
- 被测站点是用户自己的开发、测试或预发布环境。
- 系统已安装的浏览器是可信的。

它不防御：

- 已经控制当前操作系统账户的攻击者。
- 被测页面本身被盗用或包含恶意脚本。自动填充只在本机浏览器页面内执行，但页面仍可能读取已填充的表单值。
- 浏览器扩展窃取页面内容。

## Sensitive data

以下内容属于敏感数据，不应提交到仓库，也不应出现在日志里：

- `profiles/`：浏览器 Cookie、LocalStorage、IndexedDB、扩展数据
- `vault.json`：加密后的凭据
- `workspace.json`：环境地址、账号名、内部路径

`workspace.json` 与 `vault.json` 位于 Electron `userData` 目录，不在仓库内。仓库的 `.gitignore` 已覆盖常见泄漏路径。

## Credential handling

- 凭据只保存在主进程，使用 Electron `safeStorage` 加密。
- 渲染进程只能请求“复制密码”，不能读取明文。
- 密码不会写入日志、崩溃报告或 IPC 返回值。
- Linux 上没有系统密钥环时，`safeStorage` 可能退化为弱保护；界面会显示警告。

## Production environments

环境分为 `local`、`staging`、`prod`。`prod` 环境必须显式确认后才能启动；不要在 `prod` 环境保存自动提交登录所需的凭据，除非你清楚后果。

## Supported versions

安全问题只针对最新发布版本修复。项目处于 0.x 阶段，接口与数据格式可能变化。
