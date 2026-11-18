/**
 * Getting to the app's own pages from an automated run.
 *
 * Navigation lives in the account column on the left: three entries at its foot
 * (`[data-rail-entry="sites"|"identities"|"more"]`) open a floating pane over the
 * page. The browser is never replaced — the stage keeps its rectangle and the
 * pages stay on it — so "go to a page" is one click on an entry, not a view
 * switch.
 *
 * Two destinations need a second click inside their pane:
 * - **More** hosts four sections (`[data-more-tab]`: bookmarks / tags / messages /
 *   ai), and flows is a tab of the AI section (`[data-ai-tab="flows"]`).
 * - **Settings** is the one full-window page left. It opens from the app menu
 *   (`[data-app-menu]` → `[data-menu-item="settings"]`) and keeps its own
 *   section list (`[data-section]`).
 *
 * Repeating that in fifteen suites is how the selectors drift apart; the snippets
 * here are the single copy.
 */

/** The floating pane's root, once it has been mounted. */
const PANE = "[data-floating-pane]";

/**
 * Closes a floating pane, leaving the browser underneath.
 *
 * The pane's own close control is the way out — a real button, so a script does
 * not depend on keyboard state or on a pointer event reaching the scrim. Esc is
 * the user's other gesture and is covered by the console-overlap suite; the
 * scrim press is only a fallback here, for a build whose head band has no
 * control.
 */
const closePane = `
  const pane = document.querySelector(${JSON.stringify(PANE)});
  if (pane) {
    const closeBtn = pane.querySelector('.pane-head button');
    if (closeBtn) closeBtn.click();
    else pane.querySelector('[data-floating-scrim]')?.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true }),
    );
    await new Promise((done) => setTimeout(done, 350));
  }
`;

/**
 * Puts the browser page on screen.
 *
 * The browser is always mounted now; what can be covering it is a floating pane
 * or the settings page. Both are dismissed here — the pane by its own close
 * control, settings by the arrow in its title bar.
 */
const ensureBrowser = `
  ${closePane}
  if (document.querySelector('.page.settings')) {
    document.querySelector('.page.settings .settings-head .back')?.click();
    await new Promise((done) => setTimeout(done, 350));
  }
  await new Promise((done) => setTimeout(done, 120));
  if (!document.querySelector('[data-account-rail]')) return false;
`;

/** Waits out the render that follows a click, then confirms the pane exists. */
const awaitPane = `
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (document.querySelector(${JSON.stringify(PANE)})) break;
    await new Promise((done) => setTimeout(done, 50));
  }
  if (!document.querySelector(${JSON.stringify(PANE)})) return false;
`;

/**
 * Opens a floating pane by its rail entry.
 *
 * Always from the browser: a pane that is already open is dismissed first, so
 * every arrival is a real mount. Suites that rely on "go there" meaning
 * "freshly mounted" would otherwise read a copy left over from an earlier step.
 */
function openLayer(entry) {
  return `
    ${ensureBrowser}
    const entry = document.querySelector('[data-rail-entry="${entry}"]');
    if (!entry) return false;
    entry.click();
    await new Promise((done) => setTimeout(done, 450));
    ${awaitPane}
  `;
}

/** Opens a `[data-more-tab]` section inside the More pane. */
function moreTab(target) {
  return `
    ${openLayer("more")}
    const moreBtn = document.querySelector('[data-more-tab="${target}"]');
    if (!moreBtn) return false;
    if (moreBtn.getAttribute('aria-selected') !== 'true') moreBtn.click();
    await new Promise((done) => setTimeout(done, 450));
    if (!document.querySelector('[data-more-tab="${target}"][aria-selected="true"]')) {
      return false;
    }
  `;
}

/** The flows tab inside the AI section. */
const FLOWS_TAB = `
  const flowsTab = document.querySelector('[data-ai-tab="flows"]');
  if (!flowsTab) return false;
  if (flowsTab.getAttribute('aria-selected') !== 'true') flowsTab.click();
  await new Promise((done) => setTimeout(done, 450));
  return Boolean(document.querySelector('[data-ai-tab="flows"][aria-selected="true"]'));
`;

/**
 * Opens the app menu and clicks one of its rows.
 *
 * The menu is the only door to settings now. Its rows carry `data-menu-item`
 * (`settings`, `guide`, `devtools`, `clean-session`), so the click is addressable
 * without matching a translated label.
 */
function menuItem(target) {
  return `
    ${ensureBrowser}
    const menu = document.querySelector('[data-app-menu]');
    if (!menu) return false;
    if (!document.querySelector('[data-menu-item]')) {
      menu.click();
      await new Promise((done) => setTimeout(done, 250));
    }
    const item = document.querySelector('[data-menu-item="${target}"]');
    if (!item) return false;
    item.click();
    await new Promise((done) => setTimeout(done, 450));
  `;
}

/**
 * Opens one of the app's pages.
 *
 * `nav` is a rail entry (`sites`, `identities`), a More section (`bookmarks`,
 * `tags`, `messages`, `ai`), the flows tab spelled `flows`, or a settings
 * section spelled `settings-<id>` (`settings-general`, `settings-mcp`, …).
 */
export function openNav(nav) {
  if (nav === "settings" || nav.startsWith("settings-")) {
    const section = nav === "settings" ? null : nav.slice("settings-".length);
    return `(async () => {
      ${menuItem("settings")}
      const wanted = ${JSON.stringify(section)};
      if (wanted) {
        const sectionTab = document.querySelector('.page.settings [data-section="' + wanted + '"]');
        if (sectionTab && sectionTab.getAttribute('aria-selected') !== 'true') sectionTab.click();
        await new Promise((done) => setTimeout(done, 450));
      }
      return Boolean(document.querySelector('.page.settings'));
    })()`;
  }
  if (nav === "flows") {
    return `(async () => {
      ${moreTab("ai")}
      ${FLOWS_TAB}
    })()`;
  }
  if (nav === "sites" || nav === "identities") {
    return `(async () => {
      ${openLayer(nav)}
      return true;
    })()`;
  }
  return `(async () => {
    ${moreTab(nav)}
    return true;
  })()`;
}

/** The same, as an expression a caller can await from `evaluate`. */
export async function goTo(client, nav, wait = 400) {
  await client.evaluate(openNav(nav));
  await new Promise((done) => setTimeout(done, wait));
}

/**
 * Back to the browser page.
 *
 * A floating pane goes away through its close control; settings has its own back
 * arrow. The browser is never unmounted, so there is nothing else to restore.
 */
export function backToBrowser() {
  return `(async () => {
    ${ensureBrowser}
    return true;
  })()`;
}
