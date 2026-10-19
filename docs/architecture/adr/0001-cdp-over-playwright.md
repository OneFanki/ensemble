# 0001. 人工操作用系统浏览器 + CDP，不用 Playwright 托管窗口

- 日期：2026-10-19
- 状态：已采纳

## 背景

Ensemble 的窗口是给人手动操作的：点击、填表、看权限差异、验证协作冲突。它不是自动化
测试脚本的执行器。

## 决策

用 `spawn` 启动系统已安装的 Chromium 系浏览器，参数为：

```
--user-data-dir=<profileDir> --remote-debugging-port=0
```

浏览器把实际端口写进 `<profileDir>/DevToolsActivePort`，Ensemble 读取并连接 CDP，
只使用三类能力：导航、登录表单填充、登录态检测与窗口定位。

## 被否方案

**Playwright `launchPersistentContext`**：隔离和持久化能力完全满足，但行为会偏离真实浏览器：

- 未注册 `dialog` 监听时，`alert` / `confirm` / `prompt` 全部自动 dismiss，删除确认、退出确认直接返回 false。
- 下载默认落到临时目录，context 关闭即删除，下载功能无法验收。
- 默认带 `--disable-extensions` / `--disable-sync`；品牌 Chrome 已不支持侧载扩展。
- 文件选择器需要额外接管。

这些差异会让人手测试得到错误结论，这是放弃它的根本原因，不是体积或依赖问题。

**`browser.newContext()`**：关闭即失，没有独立密码库和扩展，只适合自动化脚本。

## 后果

- 需要自己维护一个约数百行的 CDP 客户端与启动器。
- 对话框、下载、上传、扩展、原生密码管理器、Google SSO 全部保持浏览器原生行为。
- 窗口平铺走 `Browser.getWindowForTarget` + `Browser.setWindowBounds`，三平台通用；Wayland 可能忽略绝对定位。
- Playwright 仍可用于管理台自身的无头 E2E 测试，但不进入产品运行时。
