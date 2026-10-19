# 发布与打包

## 本地打包

```bash
pnpm dist
```

输出到 `release/`：

| 产物 | 用途 |
| --- | --- |
| `Ensemble-<version>-win-x64-setup.exe` | NSIS 安装程序，可选安装目录 |
| `Ensemble-<version>-win-x64-portable.exe` | 免安装便携版 |
| `win-unpacked/` | 解压后的完整目录，排查问题时直接运行 |

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

| 平台 | 目标 | 要求 |
| --- | --- | --- |
| Windows | nsis + portable | 无 |
| macOS | dmg | 需要 Apple 开发者证书做签名与公证，否则用户需手动放行 |
| Linux | AppImage + deb | 依赖系统 WebKitGTK 运行时 |

GitHub Actions 的三平台矩阵由 `.github/workflows/ci.yml` 负责校验；发布产物建议单独加
一个 tag 触发的 workflow，避免每次 PR 都打包。

## 签名

当前配置会在 Windows 上用 `signtool` 尝试签名，但没有证书时不会失败。正式发布前：

1. 准备代码签名证书（Windows）或 Apple Developer ID（macOS）。
2. 通过环境变量注入（`CSC_LINK` / `CSC_KEY_PASSWORD`），不要把证书提交进仓库。
3. macOS 还需要 `notarize` 配置，否则用户首次打开会被 Gatekeeper 拦截。

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
