---
name: screenshot-refresh
description: 改动管理台界面后更新 README 截图、新增或调整截图页面时使用
---

# README 截图刷新

## 结论

界面改动后一条命令重出全部截图：

```bash
pnpm build && pnpm screenshots
```

只重出一张：`node scripts/capture-screenshots.mjs --only settings`。
输出到 `docs/screenshots/`，README 直接引用同名文件。

脚本是唯一实现：`scripts/capture-screenshots.mjs`。它启动构建后的应用（临时
`--user-data-dir` + 随机调试端口），注入中性演示数据，通过 CDP 截取窗口，
不依赖人工点击。

## 步骤

1. `pnpm build`——脚本读 `out/`，不先构建会直接报错退出。
2. 按需修改 `SHOTS`（截图名 / 语言 / 视图 / 主题 / 点击 / 悬停）与 `DEMO`
   （演示环境、身份、场景）。
3. 运行 `pnpm screenshots`。
4. 打开生成的 PNG 核对：文案是否随语言切换、是否有残留中文、是否有空状态或错位。
5. 新增或删除截图后，同步更新 `README.md` 与 `README.en.md` 的引用。

截图支持三类交互，够覆盖绝大多数界面状态：

| 字段 | 作用 |
| --- | --- |
| `view` | 点击 `[data-nav="<view>"]` 切到该页 |
| `clicks` | 依次点击 CSS 选择器，例如 `[".env-switch"]` 拍展开的下拉菜单 |
| `hover` | 把鼠标移到某个元素上再截图，用于验证按钮 hover 态 |

## 注意点

- 演示数据必须中性：不得出现真实业务名、公司名或人名（AGENTS.md 硬约束 13）。
- 视图切换靠 `[data-nav="..."]`，新增视图时给导航按钮补这个属性，否则脚本点不到。
- 截图固定 1440×900、2x 缩放；CSS 改版后重点看窄宽度下的断行与溢出。
- 脚本只杀自己 spawn 的 PID，并删除自己的临时目录；不要改成按进程名清理。
- 调试端口随机取 9900–9989，避免碰到本机常驻服务（如 9527）。
- 数据结构变了要同步 `seed()`：它直接写 `workspace.json`，字段与 `@shared/types`
  不一致时应用会静默回落到空状态，截出来就是一张空页面。

## 变更触发

改动 `src/renderer/` 的任何可见界面、i18n 文案、`workspace.json` 结构或
`scripts/capture-screenshots.mjs` 时，必须重出受影响的截图并检查 README 引用；
截图与界面不一致视为未完成。
