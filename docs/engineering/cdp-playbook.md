# CDP 操作手册

本项目用 Chrome DevTools Protocol 控制真实浏览器。这里记录实际可用的调用方式与边界，
改动 `src/core/cdp/` 或 `src/core/launch/` 前先读一遍。

## 启动

```
--user-data-dir=<profileDir>
--remote-debugging-port=0
--no-first-run
--no-default-browser-check
--window-position=<x>,<y>
--window-size=<w>,<h>
<startUrl>
```

- **必须使用独立 `--user-data-dir`**。Chrome 136 起禁止对默认数据目录开启远程调试。
- `--remote-debugging-port=0` 让系统分配空闲端口，避免并发实例抢端口。
- 不要加 `--headless`，这个工具的窗口是给人看的。
- 不要传 `--disable-extensions` 之类会改变浏览器行为的参数。

## 就绪判定

浏览器启动后把端口写入 `<profileDir>/DevToolsActivePort`：

```
<port>
<devtools-browser-path>
```

两个坑：

1. 文件可能在上一轮运行后残留，启动前必须删除。
2. 文件出现不代表端口可用，必须同时探活 `GET /json/version`。

## 端点

| 端点 | 用途 |
| --- | --- |
| `GET /json/version` | 取浏览器级 WebSocket，用于窗口操作与关闭 |
| `GET /json/list` | 列出页面目标，用于找到真正加载 URL 的页面 |
| 页面级 WebSocket | `Runtime.evaluate`、`Page.navigate` |

`about:blank` 目标会先于真实页面出现，选择目标时优先跳过它。

## 用到的域

只启用必要的：

- `Page.enable` / `Page.navigate`：导航
- `Runtime.evaluate`：注入脚本
- `Browser.getWindowForTarget` / `Browser.setWindowBounds`：窗口定位
- `Browser.close`：退出

**不要启用 `Page.javascriptDialogOpening` 处理。** 启用并接管会改变对话框行为；不接管则
页面会阻塞等待用户，这正是我们要的原生行为。

## 登录填充

见 `src/core/cdp/login.ts`。要点：

- 用 `HTMLInputElement.prototype` 的 value setter 赋值，再派发 `input` 与 `change`，
  才能被 React / Vue 的受控组件识别。
- 用户名输入框的识别顺序：密码框之前、type 为 text/email/tel、且 name/id/placeholder/
  autocomplete 命中用户/邮箱/账号关键词；找不到再退回密码框前第一个可见文本输入框。
- 提交优先 `form.requestSubmit()`，其次 `form.submit()`，最后点可见的提交按钮。
- 填充前校验 `location.origin` 属于目标站点，跨域拒绝；与站点记录的 `lastOrigin` 不一致时暂停并要求确认。

### 账号密码之外的字段

SaaS 登录常见「租户名 / 公司码 + 用户名 + 密码」三段式表单。这类字段按**标签匹配**处理：

- 字段只存在账号上（`identity.extraFields`），合并逻辑在 `src/core/login-fields.ts`。
  站点曾经也带一份并下发给所有账号，已移除：站点是登录配方、没有自己的账号，那些值本来
  就属于「谁登录谁提供」。旧文件由 `sanitizeWorkspace` 把站点字段复制到其下每个账号。
- 同一个标签只取第一行；值留空表示不填这一项，不会向页面写空字符串。
- 填充时先处理额外字段，并把命中的元素记入 `used`，之后选用户名输入框时跳过它们，
  否则租户名输入框会被误当成用户名。
- 匹配线索：`name`、`id`、`autocomplete`、`placeholder`、`aria-label`、`<label>` 文本、
  `aria-labelledby` 指向的节点。所以字段名填「租户名」即可命中
  `placeholder="请输入租户名"`。
- 返回值带 `filledExtra` / `missingExtra` / `unmatchedInputs`：已填的、配置了但页面上
  找不到的、页面上存在但没配置的。界面用它提示用户补配置，而不是静默漏填。

额外字段是明文的非敏感值（租户码、公司域），**不要用它存密码**；密码仍走凭据库。

### 启动后自动填充

设置项 `autoFillOnLaunch` 默认开启。窗口登记到 `cdpRegistry` 后，服务在后台起一个
最多 8 秒的轮询（500ms 一次），直到页面出现密码框为止，然后复用同一条
`buildFillExpression` 路径填充，结果通过 `onAutoFill` 回调送到界面。

- 不阻塞启动：视图四开不会每个身份等 8 秒。
- 找不到密码框时按「已登录」处理（`skipped: "not-login-page"`），不报错。
- 外部模式（Firefox）与未存密码的情况直接跳过，`skipped` 里写明原因。
- 是否提交按 `site.autoSubmit ?? settings.autoSubmitLogin` 解析（全局默认开）；提交动作是
  **点登录按钮本身**，只有页面里真找不到按钮才退回 `requestSubmit()` / `form.submit()`。
  `requestSubmit()` 对「按钮是 `type="button"`、提交逻辑写在脚本里」的 SPA 登录页完全无效，
  却会让调用方以为已经提交——这条踩过，见 [踩坑库](./踩坑库.md)。
- 双因素验证码仍需人工输入。

## 登录态检测

页面内执行：

```js
fetch(checkPath, { credentials: "include", redirect: "follow" })
```

2xx 视为已登录，其余视为过期。前提是应用的检测接口在未登录时返回 401/403，而不是 200
加空数据——这需要在站点配置里写对地址。

## 窗口定位

```js
const { windowId } = await browser.send("Browser.getWindowForTarget", { targetId });
await browser.send("Browser.setWindowBounds", {
  windowId,
  bounds: { left, top, width, height, windowState: "normal" },
});
```

- Windows / macOS / X11 可用。
- **Wayland 下合成器可能忽略绝对定位**，窗口仍会打开但位置不受控，错误被吞掉而不是让
  启动失败。

## 停止

1. `Browser.close`（给页面 beforeunload 机会）
2. 超时后按 PID `SIGTERM`
3. 仍未退出则 `taskkill /PID <pid> /T /F`（Windows）或 `SIGKILL`

只对命令行 `--user-data-dir` 位于自有 `profiles/` 根目录的进程执行，绝不按进程名全杀。
