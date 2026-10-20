# 发布与打包

## 本地打包

```bash
pnpm dist
```

输出到 `release/`：

| 产物 | 用途 |
| --- | --- |
| `Ensemble-<version>-win-x64-setup.exe` | NSIS 安装程序，可选安装目录；对外只发布这一个 Windows 产物 |
| `win-unpacked/` | 解压后的完整目录，排查问题时直接运行 |

**不再产出便携版。** portable target 是一个自解压 stub，每次启动都要先把整个 Electron
运行时解压到临时目录，冷启动多等一到两秒；更麻烦的是它和安装版是两个同名的 exe，用户
分不清该下哪个，下错就会觉得「这软件启动怎么这么慢」。需要免安装场景时，直接拷
`win-unpacked/` 目录即可，它没有解压开销。

图标由 `scripts/make-icon.mjs` 生成，不依赖任何图像库；`build/icon.ico` 供 Windows、
`build/icon.png` 供 Linux/macOS。改图标只需改这个脚本。

## 国内网络注意事项

Electron 本体与 electron-builder 的辅助二进制需要外网。构建时使用镜像与代理：

```bash
export HTTPS_PROXY=http://127.0.0.1:7897
export HTTP_PROXY=http://127.0.0.1:7897
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
pnpm dist
```

## 三平台

| 平台 | 目标 | 构建环境 |
| --- | --- | --- |
| Windows | nsis | Windows，或 GitHub Actions 的 `windows-latest` |
| macOS | dmg（x64 + arm64） | 必须在 macOS 上构建 |
| Linux | AppImage + deb | Linux，或 Docker 中的 `electronuserland/builder` |

dmg 需要 `hdiutil`，签名需要 `codesign` 与钥匙串，二者只存在于 macOS，所以 Mac 版绕不开
真机或 macOS runner。Linux 产物可以在 Windows 上用 Docker 交叉构建，也可以交给 CI。

`.github/workflows/release.yml` 负责三平台矩阵与发布；`.github/workflows/ci.yml` 只做
PR/main 校验，不打包。

## 签名策略

**本项目不购买代码签名证书，发布的产物默认未签名。** 这是有意取舍：证书年费对个人开源
项目不划算，而签名只影响首次运行的系统提示，不影响功能与安全边界。CI 里设置了
`CSC_IDENTITY_AUTO_DISCOVERY=false`，避免 runner 上残留的证书造成「本地未签名、CI 已签名」
的不一致。

### Windows

未签名的实际表现：

- 浏览器下载时可能提示「不常下载，可能有害」，选择保留
- 首次运行触发 SmartScreen「Windows 已保护你的电脑」：点「更多信息」→「仍要运行」
- 文件属性 → 数字签名标签为空

核验方法：

```powershell
Get-AuthenticodeSignature .\Ensemble-0.1.0-win-x64-setup.exe | Format-List Status
# NotSigned
```

### macOS

未签名、未公证的 dmg 首次打开会被 Gatekeeper 拦截，提示「无法验证开发者」。放行方式：

- 在 Finder 中右键应用 →「打开」→ 确认一次
- 或执行 `xattr -dr com.apple.quarantine /Applications/Ensemble.app`

Apple Silicon 要求二进制至少有签名才能运行。electron-builder **不会**在没有证书时自动
ad-hoc 签名，所以 `electron-builder.yml` 的 `mac` 段显式写了 `identity: "-"`；同时
`hardenedRuntime: false`——带硬化的 ad-hoc 签名会拒绝 Electron 自带的不同 Team ID 框架。
ad-hoc 不等于通过 Gatekeeper，首次打开仍需用户手动放行。

### 以后若要签名

不需要改代码，只在构建环境注入变量：

- Windows OV 证书：`CSC_LINK`（.pfx 的路径或 base64）与 `CSC_KEY_PASSWORD`。新签发的
  OV 证书没有 SmartScreen 信誉，需要一段时间的下载量才会减少提示
- Windows EV 证书：私钥在硬件令牌里，需要改用云签名服务（如 Azure Trusted Signing）
- macOS：`CSC_LINK` / `CSC_KEY_PASSWORD` 提供 Developer ID 证书，另加 `APPLE_ID`、
  `APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`，并在 `electron-builder.yml` 打开公证

## 发布流程

版本号唯一来源是 `package.json` 的 `version`。**没有 bump 版本号的合入不会产生新版本。**

1. 合入 main 的 PR 修改 `version`：feature 升 minor，修复升 patch
2. `release.yml` 读取版本号并拼出 `v<version>`
3. 远端已存在该 tag → 普通合入，跳过发布
4. 不存在 → 校验通过后三平台并行构建，创建 GitHub Release 并自动生成 release notes，
   tag 指向本次提交
5. 需要补发或重跑时，推送同名 tag；此时 tag 必须与 `package.json` 一致，否则 workflow 失败

主仓在云效时，需要额外配置一个 GitHub remote，并在发布时把 main 与 tag 一起推过去：

```bash
git push github main --follow-tags
```

公开仓库使用标准 runner 构建三平台不产生费用；私有仓库的 macOS 分钟按约 10 倍计费。

## 版本号

`package.json` 的 `version` 是唯一来源，安装包文件名、应用内「关于」都读它。
发布前手动改版本号并提交，不要用构建脚本自动改。

## 发布前检查

```bash
pnpm verify          # 类型 + 单测 + 契约 + 构建
pnpm dist            # 实际打包
```

然后在干净环境里跑一次 `win-unpacked\Ensemble.exe`，确认：

- 首次启动能扫到系统浏览器
- 启动一个身份后浏览器窗口出现，且退出应用后进程被回收
- 数据写在 `%APPDATA%\Ensemble`，不在安装目录
