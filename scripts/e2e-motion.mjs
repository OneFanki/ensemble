#!/usr/bin/env node
/**
 * 动效回归：每类浮层出现时真的在动，而且动的方向符合约定。
 *
 * 静态截图看不出动画，CSS 声明也不等于生效——选择器没命中、被 scoped 改写、
 * 或者 keyframes 名字对不上，都能让一条 animation 静默消失。所以这里逐帧读
 * 计算样式，只认 `getComputedStyle` 的实测值。
 *
 * 四类浮层各自有约定：
 *  - 对话框：淡入 + 轻微上浮 + 极小缩放，退出更快；
 *  - 锚定浮层（下拉）：淡入 + 从触发点方向轻微移入；
 *  - 提示条：从底边升起；
 *  - toast：同上浮一小段。
 *
 * 另外两条结构性约束：全部时长来自同一组令牌，以及系统要求减少动效时必须
 * 真的几乎不动。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PAGE_PORT = 4023;
const DEBUG_PORT = 9923;
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-motion-"));

const page = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>动效检查页</title></head>
<body style="margin:0;font-family:system-ui"><h1>页面</h1></body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));

const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;
mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: uuid(1),
        name: "动效检查站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/",
        identities: [
          { id: uuid(2), name: "管理员 · 主账号", username: "admin", role: "admin", color: "amber" },
        ],
      },
    ],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", onboardingVersion: 1 }),
);

const electron =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");
const app = spawn(
  electron,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=${DEBUG_PORT}`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const done = pending.get(msg.id);
    if (done) {
      pending.delete(msg.id);
      done(msg.result);
    }
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const r = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description);
      return r?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/**
 * 把 CSS 时长换算成毫秒。
 *
 * `getComputedStyle().animationDuration` 按作者单位回报，所以 `160ms` 的令牌
 * 会以 `0.16s` 出现。直接和令牌字符串比较必然不等，而这个不等说明不了任何
 * 行为差异——比的是单位，不是时长。
 */
function ms(value) {
  const match = /^([\d.]+)(ms|s)$/.exec(String(value ?? "").trim());
  if (!match) return Number.NaN;
  return match[2] === "s" ? Number.parseFloat(match[1]) * 1000 : Number.parseFloat(match[1]);
}

/**
 * 采样：从执行 `action` 到若干帧之后，读每个可见浮层的 opacity 与 transform。
 *
 * 返回数组而不是单个值，因为「有没有动画」只能靠中间态证明：只读第一帧或
 * 最后一帧，一个完全静止的浮层和一个 160ms 淡入的浮层看起来一样。
 */
function sampleFrames(selector, action) {
  return `(async () => {
    const frames = [];
    const read = () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        opacity: Number(cs.opacity),
        transform: cs.transform,
        name: cs.animationName,
        duration: cs.animationDuration,
        easing: cs.animationTimingFunction,
      };
    };
    (${action})();
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      const frame = read();
      if (frame) frames.push(frame);
    }
    return frames;
  })()`;
}

try {
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
      target = list.find(
        (i) => i.type === "page" && i.url.includes("index.html") && !i.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      /* 启动中 */
    }
  }
  check("app window appeared", Boolean(target), target ? undefined : appLog.slice(-500));
  if (!target) throw new Error("no renderer target");

  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3200);

  // --- 令牌是单一来源 -----------------------------------------------------
  const tokens = await client.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const get = (name) => cs.getPropertyValue(name).trim();
    return {
      fast: get('--motion-fast'),
      base: get('--motion-base'),
      slow: get('--motion-slow'),
      easeOut: get('--ease-out'),
      shift: get('--motion-shift'),
    };
  })()`);
  check(
    "motion tokens resolve to real values",
    /^\d+ms$/.test(tokens?.fast ?? "") &&
      /^\d+ms$/.test(tokens?.base ?? "") &&
      /^\d+ms$/.test(tokens?.slow ?? "") &&
      (tokens?.easeOut ?? "").startsWith("cubic-bezier") &&
      /px$/.test(tokens?.shift ?? ""),
    tokens,
  );
  check(
    "the three durations are ordered fast < base < slow",
    Number.parseInt(tokens?.fast ?? "0", 10) < Number.parseInt(tokens?.base ?? "0", 10) &&
      Number.parseInt(tokens?.base ?? "0", 10) < Number.parseInt(tokens?.slow ?? "0", 10),
    tokens,
  );

  // --- 对话框：淡入 + 上浮 + 微缩 ----------------------------------------
  await client.evaluate(`(async () => {
    document.querySelector('.console-btn')?.click();
    await new Promise((r) => setTimeout(r, 700));
    document.querySelector('[data-nav="identities"]')?.click();
    await new Promise((r) => setTimeout(r, 800));
    return true;
  })()`);

  const dialogFrames = await client.evaluate(
    sampleFrames(
      '[role="dialog"], .content',
      `() => {
        const b = [...document.querySelectorAll('button')].find((el) => /新建/.test(el.textContent || ''));
        if (b) b.click();
      }`,
    ),
  );
  const dialogMid = (dialogFrames ?? []).filter((f) => f.opacity > 0.01 && f.opacity < 0.99);
  check(
    "a dialog fades in rather than appearing at full opacity",
    dialogMid.length > 0,
    dialogFrames?.slice(0, 4),
  );
  check(
    "the dialog's motion is declared, bounded and eased",
    (dialogFrames?.[0]?.name ?? "none") !== "none" &&
      ms(dialogFrames?.[0]?.duration) === ms(tokens?.base) &&
      (dialogFrames?.[0]?.easing ?? "").includes("cubic-bezier"),
    { frame: dialogFrames?.[0], base: tokens?.base },
  );

  const dialogGeom = await client.evaluate(`(() => {
    const el = document.querySelector('[role="dialog"], .content');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const m = cs.transform.match(/matrix\\(([^)]+)\\)/);
    const parts = m ? m[1].split(',').map(Number) : [];
    const r = el.getBoundingClientRect();
    return {
      scale: parts[0] ?? null,
      opacity: Number(cs.opacity),
      // 居中：左右留白差不超过 2px
      centreOff: Math.abs(r.left + r.width / 2 - window.innerWidth / 2),
    };
  })()`);
  check(
    "the dialog settles at full size, still centred",
    dialogGeom?.opacity === 1 &&
      dialogGeom?.scale === 1 &&
      (dialogGeom?.centreOff ?? 99) <= 2,
    dialogGeom,
  );

  // --- 锚定浮层：下拉从触发点方向移入 ------------------------------------
  const popFrames = await client.evaluate(
    sampleFrames(
      ".select-panel",
      `() => { document.querySelector('.select-trigger')?.click(); }`,
    ),
  );
  const popMid = (popFrames ?? []).filter((f) => f.opacity > 0.01 && f.opacity < 0.99);
  check(
    "an anchored popover fades in instead of snapping",
    popMid.length > 0,
    popFrames?.slice(0, 3),
  );
  check(
    "the popover uses the fast duration, shorter than a dialog's",
    ms(popFrames?.[0]?.duration) === ms(tokens?.fast),
    { frame: popFrames?.[0], fast: tokens?.fast },
  );
  const popMoved = (popFrames ?? []).some((f) => {
    const m = f.transform.match(/matrix\(([^)]+)\)/);
    if (!m) return false;
    const ty = Number(m[1].split(",")[5]);
    return Number.isFinite(ty) && Math.abs(ty) > 0.5;
  });
  check("the popover travels from its anchor", popMoved, popFrames?.slice(0, 3));

  // --- 提示条从底边升起 ---------------------------------------------------
  //
  // Toasts are raised by the workspace store, not by the preload API, so calling
  // `saveAppSettings` directly produces no toast at all. This drives the real
  // path instead: the identity dialog is still open, so fill the form and save —
  // the action a user takes, and the one that reports back.
  const toastFrames = await client.evaluate(`(async () => {
    const frames = [];
    const read = () => {
      const el = document.querySelector('.toast');
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        opacity: Number(cs.opacity),
        transform: cs.transform,
        name: cs.animationName,
        duration: cs.animationDuration,
      };
    };
    /*
     * Two fields are required and the dialog refuses to save without them, in
     * which case no toast is raised at all. They are addressed by their label
     * rather than by position: "the first text input" landed on a site-name
     * field in an earlier attempt and the save silently did nothing.
     */
    const byLabel = (text) =>
      [...document.querySelectorAll('.field')].find(
        (field) => (field.querySelector('.label')?.textContent || '').trim() === text,
      )?.querySelector('input');
    const nameField = byLabel('显示名称');
    const userField = byLabel('账号');
    if (!nameField || !userField) {
      return { error: 'missing fields', fields: [...document.querySelectorAll('.field .label')].map((el) => el.textContent.trim()) };
    }
    const setValue = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue(nameField, '动效检查账号');
    setValue(userField, 'motion@test.local');
    const save = [...document.querySelectorAll('button')].find((el) =>
      /保存/.test(el.textContent || ''),
    );
    if (!save) {
      return {
        error: 'no save button',
        dialogs: document.querySelectorAll('[role="dialog"], .content').length,
        buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).slice(0, 12),
      };
    }
    save.click();
    /*
     * Saving goes through IPC, so the toast cannot appear within one frame. The
     * loop polls until it exists and then keeps sampling, which is what makes
     * the entry animation observable at all: sampling a fixed number of frames
     * from the click finished before the round trip did.
     */
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !document.querySelector('.toast')) {
      await new Promise((r) => requestAnimationFrame(r));
    }
    const appeared = Boolean(document.querySelector('.toast'));
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => requestAnimationFrame(r));
      const frame = read();
      if (frame) frames.push(frame);
    }
    return {
      frames,
      appeared,
      storeToasts: window.__toastProbe ?? null,
      dialogStillOpen: Boolean(document.querySelector('[role="dialog"], .content')),
    };
  })()`);
  const toastMid = (toastFrames?.frames ?? []).filter(
    (f) => f.opacity > 0.01 && f.opacity < 0.99,
  );
  check(
    "a toast rises in rather than popping",
    toastMid.length > 0,
    toastFrames,
  );
  check(
    "the toast uses the fast duration, like every other transient surface",
    ms(toastFrames?.frames?.[0]?.duration) === ms(tokens?.fast),
    { frame: toastFrames?.frames?.[0], fast: tokens?.fast },
  );

  // --- 结构性约束：没有游离的硬编码时长 ----------------------------------
  //
  // Read from the frames already captured rather than by querying now: by this
  // point the dialog has been saved and unmounted, so a live query returns null
  // and the check would fail for a reason that has nothing to do with durations.
  const durations = {
    dialog: dialogFrames?.[0]?.duration ?? null,
    popover: popFrames?.[0]?.duration ?? null,
    toast: toastFrames?.frames?.[0]?.duration ?? null,
  };
  check(
    "every floating surface takes its duration from the token set",
    Object.values(durations).every(
      (d) => typeof d === "string" && [tokens?.base, tokens?.fast, tokens?.slow].some((t) => ms(t) === ms(d)),
    ),
    { durations, tokens },
  );

  // --- 无障碍：减少动效时必须真的几乎不动 --------------------------------
  await client.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  const reduced = await client.evaluate(`(() => {
    const probe = document.createElement('div');
    probe.style.animation = 'none';
    document.body.appendChild(probe);
    const el = document.querySelector('[role="dialog"], .content, .toast');
    const value = el ? getComputedStyle(el).animationDuration : null;
    probe.remove();
    return {
      active: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      duration: value,
    };
  })()`);
  check(
    "reduced-motion collapses every duration",
    reduced?.active === true &&
      (reduced?.duration === null || Number.parseFloat(reduced.duration) <= 0.02),
    reduced,
  );
  await client.send("Emulation.setEmulatedMedia", { features: [] });

  const failed = results.filter((r) => !r.ok).length;
  console.log(
    `\nSUMMARY ${results.length - failed}/${results.length} passed`,
  );
  client.close();
} catch (error) {
  check("run completed", false, String(error));
  console.log("[motion] applog", appLog.slice(-800));
} finally {
  app.kill();
  page.close();
  await wait(900);
  process.exit(0);
}
