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
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

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
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
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

  // A workbench with two accounts in one view, plus a loose tab: none of the
  // geometry below exists until the shell is actually up.
  await client.evaluate(`(async () => {
    const api = window.ensemble;
    await api.createEmbeddedView({ layoutId: "2x1", name: "权限矩阵" });
    const state = await api.getEmbeddedState();
    const viewId = state.activeViewId;
    await api.openEmbeddedTabInSlot(viewId, 0);
    await api.openEmbeddedTabInSlot(viewId, 1);
    return true;
  })()`);
  await wait(2200);
  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({});
    return true;
  })()`);
  await wait(1500);

  // --- 1. The sidebar owns the window's left edge ---------------------------
  //
  // The column moved from the right to the left, which is what makes it one
  // navigation surface instead of a dock plus a separate console rail. That
  // move is the thing to assert: the column's right edge is where the page
  // starts, and the caption band at the very top belongs to the column now.
  const layout = await client.evaluate(`(() => {
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
      platform: document.querySelector('.sidebar')?.dataset.platform ?? null,
      sidebar: box('.sidebar'),
      dockHead: box('.dock-head'),
      tabstrip: box('.tabstrip'),
      nav: box('.sidebar-nav'),
      pane: box('.pane'),
      stage: box('.stage'),
      bench: document.querySelector('.browser')?.classList.contains('bench') ?? false,
    };
  })()`);

  check("the window reports how wide its caption buttons are", layout?.controlsWidth > 0, layout);
  check("the workbench is open", layout?.bench === true, layout);
  check("the sidebar is on the left", layout?.sidebar?.x === 0, layout);
  check(
    "the sidebar reaches the window's top edge",
    layout?.sidebar?.y === 0 && layout?.sidebar?.h > 0,
    layout,
  );
  // The corner used to hold a blank 34px band: the column reserved the caption
  // area even though the OS paints its buttons on the right. The first row is
  // now the column's own title bar, and it has to line up with the tab strip
  // beside it — a column that starts a full title bar lower reads as a hole.
  check(
    "the column's first row is the top row, level with the tab strip",
    layout?.dockHead?.y === 0 &&
      layout?.tabstrip?.y === 0 &&
      layout?.dockHead?.h === layout?.tabstrip?.h,
    layout,
  );
  check(
    "the pane starts where the sidebar ends",
    layout?.pane?.x === layout?.sidebar?.w,
    layout,
  );
  check(
    "the stage is as wide as the pane",
    layout?.stage?.w === layout?.pane?.w,
    layout,
  );

  // --- 2. The caption reservation lives on the left, not the tab strip ------
  //
  // The window buttons are painted over the *right* end. With the column on the
  // left, nothing else competes for it — so the strip keeps its reservation in
  // both shells, and the column never needs one.
  const reservation = await client.evaluate(`(() => {
    const strip = document.querySelector('.tabstrip');
    const sidebar = document.querySelector('.sidebar');
    return {
      stripPaddingRight: strip ? getComputedStyle(strip).paddingRight : null,
      sidebarPaddingRight: sidebar ? getComputedStyle(sidebar).paddingRight : null,
      stripRight: strip ? Math.round(strip.getBoundingClientRect().right) : null,
      innerWidth: window.innerWidth,
    };
  })()`);
  check(
    "the tab strip reserves the caption band",
    Number.parseFloat(reservation?.stripPaddingRight ?? "0") >=
      (layout?.controlsWidth ?? 0) - 4,
    reservation,
  );

  // --- 2b. Showing the sidebar does not rearrange the stage -----------------
  //
  // The glyph beside the first tab is the sidebar's switch. It used to also give
  // a one-cell view a 2×1 layout on the way in, so turning the column on split
  // the stage and nothing put it back. The two answers are separate now: this one
  // controls whether the column is on screen, the layout picker controls cells.
  const noRearrange = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const api = window.ensemble;
    // A one-cell view, the case that used to get split.
    const created = await api.createEmbeddedView({ name: "单格" });
    await wait(700);
    const viewId = created.activeViewId;
    const before = (await api.getEmbeddedState()).views.find((v) => v.id === viewId);
    const btn = document.querySelector('.tabstrip .layout-btn');
    // Hide, then show, through the button itself.
    btn?.click();
    await wait(700);
    const hidden = !document.querySelector('.sidebar');
    btn?.click();
    await wait(800);
    const after = (await api.getEmbeddedState()).views.find((v) => v.id === viewId);
    return {
      shownAgain: Boolean(document.querySelector('.sidebar')),
      hidden,
      // Cell count, not filled cells: a fresh view has empty slots and the split
      // is exactly what would show up as more of them.
      slotsBefore: before?.slotTabs?.length ?? null,
      slotsAfter: after?.slotTabs?.length ?? null,
      layoutAfter: after?.layoutId ?? null,
    };
  })()`);
  check("the glyph hides and shows the column", noRearrange?.hidden === true && noRearrange?.shownAgain === true, noRearrange);
  check(
    "showing the column does not split the stage",
    noRearrange?.slotsAfter === 1 && noRearrange?.layoutAfter === "free",
    noRearrange,
  );

  // --- 3. The app menu replaces the bare gear -------------------------------
  const entry = await client.evaluate(`(() => {
    const inToolbar = document.querySelector('.toolbar [data-app-menu]');
    const icon = inToolbar?.querySelector('svg');
    return {
      inToolbar: Boolean(inToolbar),
      label: inToolbar?.getAttribute('aria-label') ?? null,
      nativeTitle: inToolbar?.getAttribute('title') ?? null,
      iconParts: icon ? icon.querySelectorAll('path, circle, rect').length : 0,
    };
  })()`);
  check("the app menu lives in the toolbar", entry?.inToolbar === true, entry);
  check("the app menu is named", Boolean(entry?.label), entry);
  check("the app menu has no native title", entry?.nativeTitle === null, entry);

  // --- 4. The menu carries a second door into the workbench -----------------
  //
  // The grid glyph beside the first tab is the quiet entry; someone who has
  // never seen this app has no reason to try it, and the workbench is the whole
  // product. The menu row is that door, and it has to actually land somewhere.
  const menu = await client.evaluate(`(async () => {
    const button = document.querySelector('[data-app-menu]');
    if (!button) return { error: 'no menu button' };
    button.click();
    await new Promise((r) => setTimeout(r, 300));
    const rows = [...document.querySelectorAll('.app-menu [data-menu-item]')].map(
      (el) => el.dataset.menuItem,
    );
    const anchored = document.querySelector('.app-menu')?.getBoundingClientRect();
    return {
      rows,
      insideWindow: anchored ? anchored.right <= window.innerWidth + 1 : false,
      floating: document.documentElement.dataset.floating ?? null,
    };
  })()`);
  check(
    "the menu offers the workbench as a row",
    Array.isArray(menu?.rows) && menu.rows.includes("workspace"),
    menu,
  );
  check("the menu stays inside the window", menu?.insideWindow === true, menu);
  check(
    "an open menu lets the header's empty space be clicked",
    menu?.floating === "1",
    menu,
  );

  // --- 4a. Every launch point carries its own browser list ------------------
  //
  // There used to be one global "launch target" switch in this menu, and its
  // regression story is why it is gone: deleting the row from the title bar left
  // every page still reading the stored value, so the app stayed on whatever
  // surface it was last set to and nothing looked broken. A launch now names its
  // surface at the moment of launching, so what has to hold is different — the
  // menu must no longer carry the mode, and the launch control must list the
  // built-in surface plus every real browser the scan found.
  const menuAfterMode = await client.evaluate(`(() => {
    document.querySelector('[data-app-menu]')?.click();
    return new Promise((resolve) => setTimeout(() => resolve({
      rows: [...document.querySelectorAll('.app-menu [data-menu-item]')].map((el) => el.dataset.menuItem),
    }), 400));
  })()`);
  check(
    "the app menu no longer offers a launch mode",
    Array.isArray(menuAfterMode?.rows) &&
      !menuAfterMode.rows.includes("launch-embedded") &&
      !menuAfterMode.rows.includes("launch-external"),
    menuAfterMode,
  );

  const chooser = await client.evaluate(`(async () => {
    const api = window.ensemble;
    // Close whatever the menu check left open, then go where the control lives.
    document.querySelector('[data-app-menu]')?.click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('[data-nav="identities"]')?.click();
    await new Promise((r) => setTimeout(r, 700));
    const workspace = await api.getWorkspace();
    const trigger = document.querySelector('[data-launch-menu]');
    if (!trigger) return { error: 'no launch control on the accounts page' };
    trigger.click();
    await new Promise((r) => setTimeout(r, 350));
    const panel = document.querySelector('[data-launch-panel]');
    const rows = panel
      ? [...panel.querySelectorAll('[data-engine]')].map((el) => ({
          id: el.dataset.engine,
          label: el.textContent.replace(/\\\\s+/g, ' ').trim(),
          disabled: el.disabled,
        }))
      : [];
    trigger.click();
    // Back to the browser page: the rest of this suite measures the stage, and
    // leaving the account list up would turn every later check into a failure
    // about a page it did not expect.
    document.querySelector('[data-nav="browser"]')?.click();
    await new Promise((r) => setTimeout(r, 600));
    return { rows, engines: workspace.engines.map((engine) => ({ id: engine.id, status: engine.status })) };
  })()`);
  const embeddedRow = chooser?.rows?.find((row) => row.id === "embedded");
  check(
    "the launch control lists the built-in surface first and every scanned browser after it",
    Boolean(embeddedRow) &&
      chooser.rows[0].id === "embedded" &&
      chooser.rows.length === (chooser?.engines?.length ?? 0) + 1,
    chooser,
  );

  // --- 4b. A drawn tooltip, not the OS one ---------------------------------
  const tip = await client.evaluate(`(async () => {
    const button = document.querySelector('[data-app-menu]');
    if (!button) return null;
    button.click();
    await new Promise((r) => setTimeout(r, 200));
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
      pointerEvents: style?.pointerEvents ?? null,
      insideWindow: box ? box.left >= 0 && box.right <= window.innerWidth : false,
    };
    button.dispatchEvent(new PointerEvent('pointerleave'));
    await new Promise((r) => setTimeout(r, 200));
    return { ...result, closedOnLeave: !document.querySelector('.app-tooltip.visible') };
  })()`);
  check(
    "hovering the menu button draws the app's own label",
    tip?.visible === true && tip?.opacity === "1" && Boolean(tip?.text),
    tip,
  );
  check("the label sits inside the window", tip?.insideWindow === true, tip);
  check("the label cannot steal the pointer", tip?.pointerEvents === "none", tip);
  check("the label clears on pointer leave", tip?.closedOnLeave === true, tip);

  // Close the menu before the colour checks below.
  await client.evaluate(`document.querySelector('[data-app-menu]')?.click()`);
  await wait(300);

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
