# Security Policy

## Reporting

请通过 [GitHub Security Advisory](https://github.com/OneFanki/ensemble/security/advisories/new)
私下报告安全问题，不要开公开 issue。请在报告中说明影响版本、复现步骤和影响范围。
Security issues are handled privately; please do not open a public issue.

## Threat model

Ensemble 是本地单用户工具。它假定：

- 运行它的操作系统账户是可信的。
- 被测站点是用户自己的开发、测试或预发布环境。
- 系统已安装的浏览器是可信的。

它不防御：

- 已经控制当前操作系统账户的攻击者（主密码只能提高离线读取门槛，不能对抗键盘记录或内存转储）。
- 被测页面本身被盗用或包含恶意脚本。自动填充只在本机浏览器页面内执行，但页面仍可能读取已填充的表单值。
- 浏览器扩展窃取页面内容。
- 以你的账户身份运行、主动读取进程内存或注入浏览器的恶意程序。

## Sensitive data

以下内容属于敏感数据，不应提交到仓库，也不应出现在日志里：

- `profiles/`：浏览器 Cookie、LocalStorage、IndexedDB、扩展数据
- `vault.json`：加密后的凭据、KDF 参数
- `workspace.json`：环境地址、账号名、内部路径

`workspace.json` 与 `vault.json` 位于 Electron `userData` 目录，不在仓库内。仓库的 `.gitignore` 已覆盖常见泄漏路径。

## Credential handling

凭据有两层保护，可在设置页选择：

1. **系统密钥环（默认）**：Electron `safeStorage`。Windows 用 DPAPI，macOS 用 Keychain，
   Linux 取决于桌面环境的 keyring。密钥由操作系统账户托管，无需记忆。
2. **应用主密码**：scrypt（N=32768, r=8, p=1，随机 16 字节 salt）派生 256 位密钥，
   每条凭据用 AES-256-GCM 加密，携带随机 12 字节 IV 与 16 字节认证标签。
   vault 文件只保存 salt、KDF 参数、密文与一段用于校验密码的密文金丝雀。

此外：

- 没有明文回退。系统既无密钥环又未设置主密码时，应用会明确拒绝保存密码，而不是写入明文。
- 旧版本遗留的 `plain:` 条目在启动时自动用当前密钥重新加密。
- 主密码模式下每次启动都处于锁定状态，直到用户输入主密码；可随时「立即锁定」。
- 渲染进程只能请求“复制密码”，不能读取明文；IPC 不返回密码字段。
- 密码不会写入日志、崩溃报告或 IPC 返回值。
- 剪贴板中的密码在 30 秒后自动清除（若期间未被覆盖）。

主密码不可找回。忘记后只能删除 `vault.json` 重新录入凭据。

## Production environments

环境分为 `local`、`staging`、`prod`。`prod` 环境必须显式确认后才能启动；不要在 `prod` 环境保存自动提交登录所需的凭据，除非你清楚后果。

## Supported versions

安全问题只针对最新发布版本修复。项目处于 0.x 阶段，接口与数据格式可能变化。
