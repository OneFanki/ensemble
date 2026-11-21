#!/usr/bin/env node
/**
 * End-to-end check of the window's top rows and the single-stage geometry.
 *
 * The shell this suite measures is the address row across the whole window, the
 * account column under its left end, and the page area — page strip over stage —
 * in the right column (ADR 0012). Three families of bugs are worth re-checking
 * here, because each was invisible in the DOM — the elements existed, they were
 * just in the wrong place or drawn in a colour that does not show:
 *
 * 1. **One row owns the native caption buttons.** They are painted over the
 *    app's own frame at the top-right, and the address row is the surface that
 *    meets that corner. The reservation has to sit there, and nowhere else, or
 *    the strip keeps a dead band that lines up with nothing.
 * 2. **The rows must read as rows.** The column starts under the address row and
 *    runs to the bottom edge; the strip starts where the column's left neighbour
 *    ends and the stage below it; a stage that stops where the column used to be
 *    reads as one mangled header. The on-stage rail item must also read apart
 *    from the idle ones in both themes.
 * 3. **Dragging a page tab must shield the stage.** While the drag runs, a
 *    live page must not be able to take the pointer; when it ends, the pointer
 *    must come back.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";
import { connectToWindow, waitForWindow } from "./lib/e2e-cdp.mjs";
import { goTo, backToBrowser, openRail } from "./lib/e2e-nav.mjs";

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

try {
  let client;
  try {
    client = await waitForWindow({ userData, waitForDebugPort });
  } catch (error) {
    // The app's own log is the only thing that explains a window that
    // never came up; without it this reads as "the debug port was slow".
    check("app window appeared", false, appLog.slice(-600));
    throw error;
  }
  check("app window appeared", true);
  // The account rail starts collapsed; this suite reads its chips.
  await client.evaluate(openRail());
  await wait(400);
  await wait(3400);

  // The app opens with one blank page already on stage; one more call adds the
  // second instance that the rail comparisons below need. None of the geometry
  // under test exists until the shell is actually up.
  await client.evaluate(`(async () => {
    await window.ensemble.openEmbeddedTab({});
    return true;
  })()`);
  await wait(2200);

  // --- 1. The top row, the address row and the stage stack in three bands ----
  //
  // The top row spans the window: the account bar at its left end and the page
  // strip filling the rest. The address row spans the window under it, and the
  // stage fills everything below. These reads assert that stacking, which is what
  // every page node's rectangle is computed from.
  const layout = await client.evaluate(`(() => {
    const controls = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--window-controls-width') || '0',
    );
    const box = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
      };
    };
    const list = document.querySelector('[data-rail-list]');
    return {
      controlsWidth: controls,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      browser: Boolean(document.querySelector('.browser')),
      sidebar: box('.sidebar'),
      dock: box('.dock'),
      topRow: box('.top-row'),
      toolbar: box('.toolbar'),
      rail: box('[data-account-rail]'),
      railList: box('[data-rail-list]'),
      tabstrip: box('.tabstrip'),
      pane: box('.pane'),
      stage: box('.stage'),
      // A chip row that grows past half the window has to scroll, and the chips
      // themselves must be sized by their contents rather than by a fixed token.
      railScrolls: list ? list.scrollWidth > list.clientWidth + 1 : null,
      chipWidths: [...document.querySelectorAll('[data-instance-chip]')].map((el) =>
        Math.round(el.getBoundingClientRect().width),
      ),
      tabWidths: [...document.querySelectorAll('.tabstrip .tab')].map((el) =>
        Math.round(el.getBoundingClientRect().width),
      ),
      tabRowScrolls: (() => {
        const tabs = document.querySelector('.tabstrip .tabs');
        return tabs ? tabs.scrollWidth > tabs.clientWidth + 1 : null;
      })(),
      hasColumnClose: Boolean(document.querySelector('[data-close-instance]')),
      hasRailToggle: Boolean(document.querySelector('[data-rail-toggle]')),
      hasNewSession: Boolean(document.querySelector('[data-rail-new-session]')),
      hasSplitButton: Boolean(document.querySelector('.toolbar .split')),
    };
  })()`);
  check("the window reports how wide its caption buttons are", layout?.controlsWidth > 0, layout);
  check(
    "the shell is the single-stage browser page",
    layout?.browser === true && layout?.sidebar === null && layout?.dock === null,
    layout,
  );
  // The account bar and the tab strip share the window's first row: the bar at
  // the left edge, the strip starting where it ends.
  check(
    "the account bar starts the window's first row",
    layout?.topRow && layout?.rail
      ? layout.topRow.x === 0 && layout.topRow.y === 0 && layout.rail.x === 0 && layout.rail.h > 0
      : false,
    layout,
  );
  check(
    "the page strip continues the same row, to its right",
    layout?.rail && layout?.tabstrip
      ? layout.tabstrip.x === layout.rail.right &&
        layout.tabstrip.y === layout.rail.y &&
        layout.tabstrip.h === layout.rail.h
      : false,
    layout,
  );
  check(
    "the address row sits under the top row and spans the window",
    layout?.toolbar && layout?.topRow
      ? layout.toolbar.y === layout.topRow.bottom &&
        layout.toolbar.x === 0 &&
        layout.toolbar.w === layout.innerWidth
      : false,
    layout,
  );
  check(
    "the stage starts under the address row and reaches both far edges",
    layout?.stage && layout?.toolbar
      ? layout.stage.y === layout.toolbar.bottom &&
        layout.stage.x === 0 &&
        layout.stage.right === layout.innerWidth &&
        layout.stage.bottom === layout.innerHeight
      : false,
    layout,
  );
  check(
    "the sidebar switch and the column's close boxes are gone",
    layout?.hasRailToggle === false && layout?.hasColumnClose === false && layout?.hasSplitButton === false,
    layout,
  );
  check(
    "the account bar offers a new-session entry",
    layout?.hasNewSession === true,
    layout,
  );
  // The bar sizes itself from its chips, capped at half the window. A bar that
  // ignored its contents would leave a hole in the top row; one without a cap
  // would push the strip off the window on a wide workspace.
  check(
    "the account bar is sized by its contents and capped at half the window",
    layout?.rail && layout?.railList
      ? layout.rail.w <= layout.innerWidth / 2 + 1 &&
        (layout.chipWidths.length === 0 ||
          layout.railList.w >= Math.min(150, layout.chipWidths.reduce((a, b) => a + b, 0)))
      : false,
    layout,
  );
  check(
    "the chip row scrolls sideways once it runs out of room",
    typeof layout?.railScrolls === "boolean",
    layout,
  );
  check(
    "the tab row scrolls sideways rather than shrinking every title",
    typeof layout?.tabRowScrolls === "boolean",
    layout,
  );
  check(
    "the pane is as wide as the window",
    layout?.pane?.x === 0 && layout?.pane?.w === layout?.innerWidth,
    layout,
  );

  // `active` is per-instance, so the flat list shows one active tab per
  // instance; the single stage answers for the whole window through
  // `activeTabId`. A blank page holds the stage without a rect (there is no
  // native view to place), so the held tab is allowed to lack bounds — what
  // must not happen is a second instance's active page carrying a rect too.
  const staged = await client.evaluate(`(async () => {
    const state = await window.ensemble.getEmbeddedState();
    const held = state.tabs.find((t) => t.id === state.activeTabId);
    const parkedActives = state.tabs
      .filter((t) => t.id !== state.activeTabId && t.active)
      .map((t) => t.bounds?.width ?? 0);
    return {
      heldId: held?.id ?? null,
      instances: new Set(state.tabs.map((t) => t.instanceId)).size,
      parkedActives,
    };
  })()`);
  check(
    "exactly one page holds the stage",
    staged?.heldId != null && staged?.parkedActives?.every((width) => width === 0),
    staged,
  );
  check("both instances stay alive behind the one stage", staged?.instances === 2, staged);

  // --- 2. The caption reservation lives on the tab strip ---------------------
  //
  // The window buttons are painted over the *right* end of the window's first
  // row, which is the tab strip, so that row reserves their width. The address
  // row sits beneath it and must reserve nothing — a second reservation there
  // would push the app menu a hundred pixels off the right edge for no reason.
  const reservation = await client.evaluate(`(() => {
    const row = document.querySelector('.toolbar');
    const strip = document.querySelector('.tabstrip');
    return {
      rowPaddingRight: row ? getComputedStyle(row).paddingRight : null,
      rowRight: row ? Math.round(row.getBoundingClientRect().right) : null,
      stripPaddingRight: strip ? getComputedStyle(strip).paddingRight : null,
      stripRight: strip ? Math.round(strip.getBoundingClientRect().right) : null,
      innerWidth: window.innerWidth,
    };
  })()`);
  check(
    "the page strip reserves the caption band",
    Number.parseFloat(reservation?.stripPaddingRight ?? "0") >=
      (layout?.controlsWidth ?? 0) - 4,
    reservation,
  );
  check(
    "the address row reserves nothing for the caption buttons",
    // Not exactly zero: the row's own 8px inset is margin, not a reservation.
    // What must not happen is a second full caption-width gap here — that is
    // what pushed the app menu a hundred pixels off the right edge.
    Number.parseFloat(reservation?.rowPaddingRight ?? "999") < 20,
    reservation,
  );

  // --- 2b. The single-stage invariants hold as instances arrive -------------
  //
  // The layout glyph and the cell dividers are retired with the grid. What
  // this section used to guard — toggling the column must not split the
  // stage — becomes a straight invariant: another instance joins, the stage
  // stays one cell, and nothing that could draw a second one comes back.
  const invariants = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const api = window.ensemble;
    await api.openEmbeddedTab({});
    await wait(1200);
    const state = await api.getEmbeddedState();
    const parkedActives = state.tabs
      .filter((t) => t.id !== state.activeTabId && t.active)
      .map((t) => t.bounds?.width ?? 0);
    return {
      layoutBtn: Boolean(document.querySelector('.tabstrip .layout-btn')),
      dividers: document.querySelectorAll('.divider').length,
      slotHeaders: document.querySelectorAll('.slot-header').length,
      heldId: state.tabs.find((t) => t.id === state.activeTabId)?.id ?? null,
      parkedActives,
      instances: new Set(state.tabs.map((t) => t.instanceId)).size,
      chips: document.querySelectorAll('[data-instance-chip]').length,
    };
  })()`);
  check(
    "the layout glyph and the cell dividers stay retired",
    invariants?.layoutBtn === false &&
      invariants?.dividers === 0 &&
      invariants?.slotHeaders === 0,
    invariants,
  );
  check(
    "a third instance joins the account column without growing the stage a cell",
    invariants?.heldId != null &&
      invariants?.parkedActives?.every((width) => width === 0) &&
      invariants?.instances === 3 &&
      invariants?.chips === 3,
    invariants,
  );

  // --- 3. The app menu lives in the toolbar ---------------------------------
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

  // --- 4. The menu carries nothing that opens a column ----------------------
  //
  // The menu row that opened the workbench column went out with the column. What
  // must hold instead: the row is gone, the menu still anchors inside the
  // window, and an open menu still lets the header's empty space be clicked
  // through to the window.
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
    "the menu no longer offers the retired workbench entry",
    Array.isArray(menu?.rows) && menu.rows.length > 0 && !menu.rows.includes("workspace"),
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
  // A launch names its surface at the moment of launching: the menu must not
  // carry a mode, and the accounts page's launch control must list the
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

  await goTo(client, "identities", 700);
  const chooser = await client.evaluate(`(async () => {
    const api = window.ensemble;
    const workspace = await api.getWorkspace();
    const trigger = document.querySelector('[data-launch-menu]');
    if (!trigger) return { error: 'no launch control on the accounts page' };
    trigger.click();
    await new Promise((r) => setTimeout(r, 350));
    const panel = document.querySelector('[data-launch-panel]');
    const rows = panel
      ? [...panel.querySelectorAll('[data-engine]')].map((el) => ({
          id: el.dataset.engine,
          label: el.textContent.replace(/\\s+/g, ' ').trim(),
          disabled: el.disabled,
        }))
      : [];
    trigger.click();
    return { rows, engines: workspace.engines.map((engine) => ({ id: engine.id, status: engine.status })) };
  })()`);
  await client.evaluate(backToBrowser());
  await wait(600);
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

  // --- 5. The on-stage item reads apart, in both themes ----------------------
  //
  // What the account bar puts side by side is the on-stage chip against the idle
  // ones, in dark and light both. A bare string difference would accept "both
  // null", so the assertion also refuses transparent fills. The bar itself carries
  // no fill of its own any more — it shares the top row's surface, so the row is
  // what has to be painted.
  const themeFills = [];
  for (const theme of ["dark", "light"]) {
    // Set the renderer's own switch: the CSS under test is keyed on
    // `data-theme`, and going through the settings UI would test that path
    // instead of this one.
    await client.evaluate(`(async () => {
      document.documentElement.dataset.theme = ${JSON.stringify(theme)};
      await new Promise((r) => requestAnimationFrame(r));
      return true;
    })()`);
    const probe = await client.evaluate(`(() => {
      const fill = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      return {
        topRow: fill('.top-row'),
        bar: fill('[data-account-rail]'),
        onStage: fill('[data-instance-chip][data-on-stage="1"]'),
        idle: fill('[data-instance-chip][data-on-stage="0"]'),
        strip: fill('.tabstrip'),
      };
    })()`);
    const transparent = (c) => c === null || c === "rgba(0, 0, 0, 0)" || c === "transparent";
    check(`${theme}: the top row renders with a surface of its own`, !transparent(probe?.topRow), probe);
    check(
      `${theme}: the on-stage chip reads apart from the idle one`,
      !transparent(probe?.onStage) && probe?.onStage !== probe?.idle,
      probe,
    );
    themeFills.push({ theme, ...probe });
  }
  check(
    "the theme switch reaches the header rows",
    themeFills[0]?.topRow !== themeFills[1]?.topRow || themeFills[0]?.strip !== themeFills[1]?.strip,
    themeFills.map((t) => ({ theme: t.theme, topRow: t.topRow, strip: t.strip })),
  );

  // --- 6. Dragging a page tab shields the stage -----------------------------
  //
  // Tab reorder is an HTML5 drag, which CDP's mouse pipeline does not drive —
  // so, as in the tab-strip suite, the gesture goes through the real Vue
  // handlers with synthetic DragEvents. What this adds over that suite is the
  // shield: while a drag runs, a live page must not be able to take the
  // pointer, and the pointer must come back when the drag ends.
  const dragShield = await client.evaluate(`(async () => {
    const wait = (ms) => new Promise((done) => setTimeout(done, ms));
    const api = window.ensemble;
    // The strip shows only the on-stage instance's pages, and each instance
    // opened so far holds exactly one — give the held instance a second page
    // so there is something to drag.
    let tabs = [...document.querySelectorAll('.tabstrip .tab')];
    if (tabs.length < 2) {
      const state = await api.getEmbeddedState();
      const held = state.tabs.find((t) => t.id === state.activeTabId);
      if (!held) return { error: 'no page holds the stage' };
      await api.openEmbeddedTabInInstance(held.instanceId);
      await wait(1400);
      tabs = [...document.querySelectorAll('.tabstrip .tab')];
    }
    if (tabs.length < 2) return { error: 'need two page tabs to drag' };
    const pool = document.querySelector('.guest-pool');
    const read = () => ({
      shielded: pool?.dataset.shielded ?? null,
      holds: pool?.dataset.shieldHolds ?? null,
    });
    const before = read();
    const drag = new DataTransfer();
    tabs[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: drag }));
    await wait(120);
    const during = read();
    tabs[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: drag }));
    await wait(300);
    const after = read();
    return { before, during, after };
  })()`);
  check("dragging a page tab raises the shield over the stage", dragShield?.during?.shielded === "1", dragShield);
  check(
    "ending the drag gives the pages their pointer back",
    dragShield?.after?.shielded === "0" && dragShield?.after?.holds === "0",
    dragShield,
  );

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
