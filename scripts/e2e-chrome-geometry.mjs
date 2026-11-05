#!/usr/bin/env node
/**
 * End-to-end check of the window's top-right corner and the run dock's grouping.
 *
 * Three reported problems, all of them in the same corner of the screen:
 *
 * 1. **创建视图 and the collapse button were invisible with the dock open.** The
 *    native caption buttons are painted over the app's own frame, and the dock is
 *    the surface that meets that corner in bench mode. Its first row landed
 *    underneath them: not faint, not clipped — covered by a window button, which
 *    means unreadable and unclickable. Measured before the fix at y=12–34 against
 *    a caption band of y=0–34.
 * 2. **The tab strip kept a 138px hole.** The reservation was unconditional, so
 *    with the dock on the right the strip reserved a band for buttons that were
 *    not over it, leaving dead space between the last tab and the dock.
 * 3. **Two dock groups read as one list.** With the boxes removed, nothing was
 *    left between them but an 8px gap, so the lower group's header looked like one
 *    more row. The rule that was added had to be visible in both themes, which
 *    `--line`/`--line-soft` are not: both are tuned for white surfaces and are
 *    lighter than the dock's own background in the light theme.
 *
 * Everything here is geometry read from the real window, because every one of
 * these bugs was invisible in the DOM — the elements existed, they were just in
 * the wrong place or drawn in a colour that does not show.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";

const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-chrome-"));
const uuid = (i) =>
  `${String(i).repeat(8)}-${String(i).repeat(4)}-4${String(i).repeat(3)}-8${String(i).repeat(3)}-${String(i).repeat(12)}`;

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [],
    identities: [
      { id: uuid(2), name: "管理员 · 主账号", username: "admin", role: "admin", color: "amber" },
      { id: uuid(3), name: "成员 · 子账号", username: "member", role: "member", color: "teal" },
    ],
    views: [],
    flows: [],
    bookmarks: [],
    bookmarkFolders: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
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
const app = spawn(electron, [".", `--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  env: { ...process.env, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (c) => (appLog += c));
app.stderr.on("data", (c) => (appLog += c));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
  if (!ok && detail !== undefined) console.log(`        ${JSON.stringify(detail)}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const done = pending.get(message.id);
    if (done) {
      pending.delete(message.id);
      done(message.result);
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
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

try {
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) => item.type === "page" && item.url.includes("index.html") && !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      /* starting */
    }
  }
  if (!target) throw new Error(`no renderer\n${appLog.slice(-800)}`);
  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3400);

  // Two groups: one view with two accounts, plus a loose tab. That is the
  // smallest arrangement with a boundary in the dock.
  await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.createEmbeddedView({ layoutId: "2x1", name: "权限矩阵" });
    // The runtime container id is what every later call takes; the id in
    // \`activeViewId\` is the definition id, a different namespace.
    const state = await api.getEmbeddedState();
    const viewId = state.activeViewId;
    await api.openEmbeddedTabInSlot(viewId, 0);
    await api.openEmbeddedTabInSlot(viewId, 1);
    return true;
  })()`);
  await wait(2200);
  await client.evaluate(`(async () => {
    // A page outside any view gives the dock its second block.
    await window.ensemble.openEmbeddedTab({});
    return true;
  })()`);
  await wait(1500);

  // --- 1. The controls reserve the caption band -----------------------------
  const corner = await client.evaluate(`(() => {
    const controls = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--window-controls-width') || '0',
    );
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    };
    return {
      controlsWidth: controls,
      innerWidth: window.innerWidth,
      titlebar: box('.dock-titlebar'),
      dockHead: box('.dock-head'),
      addView: box('.add-view'),
      collapse: box('.dock-head .collapse-btn'),
      bench: document.querySelector('.browser')?.classList.contains('bench') ?? false,
      // The dock's own top padding is where a header would start without a
      // reserved band, so the assertion can name the actual failure.
      dockPaddingTop: (() => {
        const dock = document.querySelector('.dock');
        return dock ? Number.parseFloat(getComputedStyle(dock).paddingTop) : null;
      })(),
    };
  })()`);

  check("the window reports how wide its caption buttons are", corner?.controlsWidth > 0, corner);
  check("the run dock is open", corner?.bench === true, corner);

  // The measurement itself: everything in the dock's first row starts below the
  // band the caption buttons occupy — not merely somewhere positive. Comparing
  // against the band rather than against zero is what makes this fail when the
  // reservation is missing.
  const bandBottom = 34;
  check(
    "a drag band occupies the corner above the dock's header",
    corner?.titlebar?.h > 0 && corner?.titlebar?.y === 0,
    corner,
  );
  check(
    "the dock's header sits below the caption buttons",
    corner?.dockHead !== null &&
      corner?.dockHead?.y >= bandBottom &&
      corner?.addView !== null &&
      corner?.addView?.y >= bandBottom,
    corner,
  );
  check(
    "创建视图 is not underneath a window button",
    corner?.addView !== null &&
      corner.addView.w > 0 &&
      corner.addView.x + corner.addView.w <= corner.innerWidth,
    corner,
  );
  check("a drag band occupies the corner instead", corner?.titlebar?.h > 0, corner);

  // Collapsed, the whole 46px strip is inside the caption band, so its first
  // tile has to start below it too — otherwise the expand control and its count
  // badge sit under a window button and cannot be clicked.
  const collapsed = await client.evaluate(`(async () => {
    document.querySelector('.dock-head .collapse-btn')?.click();
    await new Promise((r) => setTimeout(r, 500));
    const strip = document.querySelector('.dock');
    const first = document.querySelector('.mini .expand');
    const box = first?.getBoundingClientRect();
    const stripBox = strip?.getBoundingClientRect();
    return {
      isCollapsed: strip?.classList.contains('collapsed') ?? false,
      stripWidth: stripBox ? Math.round(stripBox.width) : null,
      firstTileTop: box ? Math.round(box.top) : null,
      firstTileWidth: box ? Math.round(box.width) : null,
    };
  })()`);
  check("collapsing keeps the strip", collapsed?.isCollapsed === true, collapsed);
  check(
    "the collapsed strip's first tile clears the caption buttons",
    collapsed?.firstTileTop !== null && collapsed.firstTileTop >= bandBottom,
    collapsed,
  );

  // Reopen for the remaining checks.
  await client.evaluate(`(async () => {
    document.querySelector('.mini .expand')?.click();
    await new Promise((r) => setTimeout(r, 500));
    return true;
  })()`);

  // --- 2. No dead hole between the last tab and the dock --------------------
  const strip = await client.evaluate(`(() => {
    const strip = document.querySelector('.tabstrip');
    const dock = document.querySelector('.dock');
    if (!strip || !dock) return null;
    const tabs = [...strip.querySelectorAll('.tab')];
    const lastTab = tabs[tabs.length - 1];
    const addition = strip.querySelector('.strip-add');
    const gear = strip.querySelector('.console-btn');
    const dockBox = dock.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    return {
      stripRight: Math.round(stripBox.right),
      dockLeft: Math.round(dockBox.left),
      stripPaddingRight: getComputedStyle(strip).paddingRight,
      // The UI lives in the toolbar, so the gear is not in the strip at all.
      gearInStrip: Boolean(gear),
      gapToDock: Math.round(dockBox.left - stripBox.right),
      lastTabRight: lastTab ? Math.round(lastTab.getBoundingClientRect().right) : null,
      additionRight: addition ? Math.round(addition.getBoundingClientRect().right) : null,
    };
  })()`);
  check(
    "the tab strip gives its caption reservation back to the dock",
    strip !== null && Number.parseFloat(strip.stripPaddingRight) < 10,
    strip,
  );
  check("the strip ends where the dock begins", strip?.gapToDock === 0, strip);

  // --- 3. The console entry is a gear in the toolbar ------------------------
  const entry = await client.evaluate(`(() => {
    const inToolbar = document.querySelector('.toolbar .console-btn');
    const inStrip = document.querySelector('.tabstrip .console-btn');
    const icon = inToolbar?.querySelector('svg');
    // Lucide ships one path per glyph; the gear's is the one with the tooth ring
    // plus a knurled circle. What matters is that this is no longer the grid.
    return {
      inToolbar: Boolean(inToolbar),
      inStrip: Boolean(inStrip),
      label: inToolbar?.getAttribute('aria-label') ?? null,
      nativeTitle: inToolbar?.getAttribute('title') ?? null,
      iconPaths: icon ? icon.querySelectorAll('path, circle, rect').length : 0,
      iconClass: icon?.getAttribute('class') ?? null,
    };
  })()`);
  check("the console entry lives in the toolbar", entry?.inToolbar === true, entry);
  check("nothing interactive sits in the tab strip's dead band", entry?.inStrip === false, entry);
  check("the console entry is named", Boolean(entry?.label), entry);
  check("the console entry has no native title", entry?.nativeTitle === null, entry);

  // --- 4. A drawn tooltip, not the OS one ----------------------------------
  const tip = await client.evaluate(`(async () => {
    const button = document.querySelector('.toolbar .console-btn');
    if (!button) return null;
    button.dispatchEvent(new PointerEvent('pointerenter'));
    await new Promise((r) => setTimeout(r, 700));
    const host = document.querySelector('.app-tooltip');
    const box = host?.getBoundingClientRect();
    const style = host ? getComputedStyle(host) : null;
    const result = {
      present: Boolean(host),
      text: host?.textContent ?? null,
      visible: host?.classList.contains('visible') ?? false,
      opacity: style?.opacity ?? null,
      zIndex: style?.zIndex ?? null,
      pointerEvents: style?.pointerEvents ?? null,
      insideWindow: box ? box.left >= 0 && box.right <= window.innerWidth : false,
    };
    button.dispatchEvent(new PointerEvent('pointerleave'));
    await new Promise((r) => setTimeout(r, 200));
    return { ...result, closedOnLeave: !document.querySelector('.app-tooltip.visible') };
  })()`);
  check(
    "hovering the gear draws the app's own label",
    tip?.visible === true && tip?.opacity === "1" && Boolean(tip?.text),
    tip,
  );
  check("the label sits inside the window", tip?.insideWindow === true, tip);
  check("the label cannot steal the pointer", tip?.pointerEvents === "none", tip);
  check("the label clears on pointer leave", tip?.closedOnLeave === true, tip);

  // --- 5. Groups are separated, in both themes -----------------------------
  for (const theme of ["dark", "light"]) {
    // Set the renderer's own switch: the CSS under test is keyed on
    // `data-theme`, and going through the settings UI would test that path
    // instead of this one.
    await client.evaluate(`(async () => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      await new Promise((r) => requestAnimationFrame(r));
      return true;
    })()`);
    const groups = await client.evaluate(`(() => {
      // Relative luminance, so the comparison is about how far apart two colours
      // read rather than about whether their strings differ. This is the whole
      // point of the assertion: \`--line-soft\` over the dock's \`--bg\` in the
      // light theme is a *lighter* colour on a light surface — two different
      // strings, and still invisible.
      //
      // The rule is semi-transparent (it is mixed from \`--text\`), so it has to be
      // composited over the surface before it is measured. Reading the declared
      // colour instead would compare a 16%-alpha value against an opaque one and
      // get the answer wrong in the dark theme.
      const parse = (color) => {
        const nums = (color.match(/[\\d.]+/g) ?? []).map(Number);
        if (nums.length < 3) return null;
        // \`color(srgb r g b / a)\` carries 0–1 channels; the legacy functions
        // carry 0–255. Both put alpha last when it is present.
        const scale = color.startsWith("color(") ? 255 : 1;
        return {
          r: nums[0] * scale,
          g: nums[1] * scale,
          b: nums[2] * scale,
          a: nums.length > 3 ? nums[3] : 1,
        };
      };
      const luminance = (c) => {
        const channel = (value) => {
          const v = value / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
      };
      const over = (top, bottom) => ({
        r: top.a * top.r + (1 - top.a) * bottom.r,
        g: top.a * top.g + (1 - top.a) * bottom.g,
        b: top.a * top.b + (1 - top.a) * bottom.b,
        a: 1,
      });
      const contrast = (top, bottom) => {
        const fill = top.a < 1 ? over(top, bottom) : top;
        const la = luminance(fill);
        const lb = luminance(bottom);
        return Math.round(((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)) * 100) / 100;
      };

      const dock = document.querySelector(".dock");
      const dockColor = dock ? parse(getComputedStyle(dock).backgroundColor) : null;
      const blocks = [...document.querySelectorAll(".dock .view-block")];
      return blocks.map((el) => {
        const style = getComputedStyle(el);
        const head = el.querySelector(".block-head");
        const headStyle = head ? getComputedStyle(head) : null;
        const rule = parse(style.borderTopColor);
        const headFill = headStyle ? parse(headStyle.backgroundColor) : null;
        return {
          borderTopWidth: Number.parseFloat(style.borderTopWidth),
          borderTopColor: style.borderTopColor,
          paddingTop: Number.parseFloat(style.paddingTop),
          headBackground: headStyle?.backgroundColor ?? null,
          dockBackground: dockColor,
          ruleContrast: rule && dockColor ? contrast(rule, dockColor) : null,
          headContrast: headFill && dockColor ? contrast(headFill, dockColor) : null,
        };
      });
    })()`);

    check(`${theme}: the dock has two groups to separate`, groups?.length >= 2, groups);
    // The boundary exists only between blocks, so the first has none.
    check(
      `${theme}: a later group draws a rule at its top`,
      groups?.[1]?.borderTopWidth > 0 && groups?.[1]?.paddingTop > 0,
      groups?.[1],
    );
    // 1.25:1 is the floor that separates the shipped rule from the token that
    // failed in the light theme (1.15:1). The working rule measures ≈1.37:1.
    check(
      `${theme}: the rule reads against the dock, not just differs from it`,
      (groups?.[1]?.ruleContrast ?? 0) >= 1.25,
      groups?.[1],
    );
    check(
      `${theme}: every group header reads as a band`,
      groups?.every((group) => (group.headContrast ?? 0) >= 1.03),
      groups?.map((group) => ({ bg: group.headBackground, ratio: group.headContrast })),
    );
  }

  // --- 6. The cell boundary can be dragged ---------------------------------
  //
  // Never covered before, which is why it shipped broken. The handler has to
  // survive the pointer leaving the handle and entering a live page — so the
  // gesture is driven through CDP's real input pipeline rather than with
  // synthetic DOM events. A synthetic `dispatchEvent` still reaches the window
  // listeners even when a guest would have taken the pointer, which is exactly
  // the bug: it passes on a broken build.
  const dividerBox = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const state = await api.getEmbeddedState();
    const view = state.views.find((item) => item.id === state.activeViewId);
    if (!view) return { error: "no active view" };
    await api.setEmbeddedViewSlots(view.id, [
      { x: 0, y: 0, width: 0.5, height: 1 },
      { x: 0.5, y: 0, width: 0.5, height: 1 },
    ]);
    await new Promise((r) => setTimeout(r, 900));
    const handle = document.querySelector(".divider.vertical");
    if (!handle) return { error: "no vertical divider" };
    const rect = handle.getBoundingClientRect();
    return {
      viewId: view.id,
      x: Math.round(rect.x + rect.width / 2),
      y: Math.round(rect.y + rect.height / 2),
      beforeWidth: (await api.getEmbeddedState()).views.find((v) => v.id === view.id)?.slotRects?.[0]?.width ?? null,
    };
  })()`);

  if (dividerBox?.error) {
    check("the view has a vertical cell boundary", false, dividerBox);
  } else {
    check("the view has a vertical cell boundary", true, dividerBox);
    // Real mouse input: press on the handle, move past it into the page beside
    // it, release.
    //
    // What this can and cannot prove: CDP's `Input.dispatchMouseEvent` reaches
    // the renderer's main frame, so the move stream keeps arriving even without
    // the pointer shield — the gesture therefore passes on a build where the
    // shield is missing, and this test cannot be the evidence for it. What it
    // does cover is the rest of the chain: handler wired, rects computed, IPC
    // applied. The shield's own effect is asserted below on the state, which is
    // the only place the difference is visible.
    await client.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: dividerBox.x,
      y: dividerBox.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    // The shield has to be up during the gesture, or a real mouse would have
    // handed the pointer to a page at the first move.
    const duringDrag = await client.evaluate(`(() => {
      const pool = document.querySelector('.guest-pool');
      return {
        shielded: pool?.dataset.shielded ?? null,
        holds: pool?.dataset.shieldHolds ?? null,
      };
    })()`);
    check(
      "a page cannot take the pointer while the boundary is being dragged",
      duringDrag?.shielded === "1",
      duringDrag,
    );
    for (const step of [30, 80, 130]) {
      await client.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: dividerBox.x + step,
        y: dividerBox.y,
        button: "left",
        buttons: 1,
      });
      await wait(90);
    }
    await client.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: dividerBox.x + 130,
      y: dividerBox.y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await wait(1200);

    const afterResize = await client.evaluate(`(async () => {
      const state = await window.ensemble.getEmbeddedState();
      const view = state.views.find((item) => item.id === state.activeViewId);
      const pool = document.querySelector('.guest-pool');
      return {
        afterWidth: view?.slotRects?.[0]?.width ?? null,
        shielded: pool?.dataset.shielded ?? null,
        holds: pool?.dataset.shieldHolds ?? null,
      };
    })()`);
    const moved =
      dividerBox.beforeWidth !== null && afterResize?.afterWidth !== null
        ? Math.round((afterResize.afterWidth - dividerBox.beforeWidth) * 1000) / 1000
        : null;
    check("dragging the boundary actually moves it", (moved ?? 0) > 0.05, {
      beforeWidth: dividerBox.beforeWidth,
      afterWidth: afterResize?.afterWidth,
      moved,
    });
    check(
      "releasing the drag gives the pages their pointer back",
      afterResize?.shielded === "0" && afterResize?.holds === "0",
      afterResize,
    );
  }

  // Restore the theme the throwaway profile started with.
  await client.evaluate(`document.documentElement.dataset.theme = 'dark'`);
  client.close();
} catch (error) {
  check("the suite ran to completion", false, String(error));
  console.error(appLog.slice(-1200));
} finally {
  app.kill();
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n[chrome-geometry] ${passed}/${results.length} assertions passed`);
process.exit(passed === results.length ? 0 : 1);
