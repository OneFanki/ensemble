/**
 * Getting to the app's own pages from an automated run.
 *
 * There are exactly two destinations now:
 *
 * 1. **Accounts** — the single entry at the foot of the account column
 *    (`[data-rail-entry="identities"]`). It opens a floating pane over the page;
 *    the browser is never replaced, so "go there" is one click, not a view
 *    switch. Sites and site groups are configured inside it (a site is the
 *    heading of its accounts), which is why there is no separate sites page.
 * 2. **Settings** — the one full-window page left, opened from the app menu
 *    (`[data-app-menu]` → `[data-menu-item="settings"]`). Bookmarks, messages,
 *    flows and site groups live there as `[data-section]` tabs.
 *
 * AI activity is not a destination: it is the panel behind the toolbar's AI
 * button, which knows how to show the full history.
 *
 * Repeating that in fifteen suites is how the selectors drift apart; the
 * snippets here are the single copy.
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
 * The browser is always mounted; what can be covering it is the accounts pane
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
 * Opens the accounts pane.
 *
 * Always from the browser: a pane that is already open is dismissed first, so
 * every arrival is a real mount. Suites that rely on "go there" meaning
 * "freshly mounted" would otherwise read a copy left over from an earlier step.
 */
const openLayer = `
  ${ensureBrowser}
  const entry = document.querySelector('[data-rail-entry="identities"]');
  if (!entry) return false;
  entry.click();
  await new Promise((done) => setTimeout(done, 450));
  ${awaitPane}
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

/** Settings sections that moved out of the management pane. */
const CONTENT_SECTIONS = new Set(["bookmarks", "messages", "flows", "groups"]);

/**
 * Opens one of the app's pages.
 *
 * `nav` is either `identities` (the accounts pane, which also carries sites and
 * site groups), or a settings section: a preference one (`general`, `engines`,
 * `vault`, `data`, `mcp`, `about`) or a content one (`bookmarks`, `messages`,
 * `flows`, `groups`). `settings` alone opens the page on whatever section it
 * remembers.
 *
 * `sites` is accepted as an alias for `identities`: sites are what that pane
 * shows, and old call sites should not have to know that.
 */
export function openNav(nav) {
  if (nav === "sites" || nav === "identities") {
    return `(async () => {${openLayer}return true;})()`;
  }
  const section =
    nav === "settings" ? null : nav.startsWith("settings-") ? nav.slice("settings-".length) : nav;
  const known =
    section === null ||
    section === "general" ||
    section === "engines" ||
    section === "vault" ||
    section === "data" ||
    section === "mcp" ||
    section === "about" ||
    CONTENT_SECTIONS.has(section);
  if (!known) {
    // An unknown destination is a suite bug, not a page: fail loudly instead of
    // landing on settings and letting the assertions read the wrong screen.
    return `(async () => false)()`;
  }
  return `(async () => {
    ${menuItem("settings")}
    const wanted = ${JSON.stringify(section)};
    if (wanted) {
      const sectionTab = document.querySelector('.page.settings [data-section="' + wanted + '"]');
      if (!sectionTab) return false;
      if (sectionTab.getAttribute('aria-selected') !== 'true') sectionTab.click();
      await new Promise((done) => setTimeout(done, 450));
    }
    return Boolean(document.querySelector('.page.settings'));
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
 * Closing the pane is enough; the browser was never unmounted. Settings has its
 * own way back, handled inside `ensureBrowser`.
 */
export function backToBrowser() {
  return `(async () => {
    ${ensureBrowser}
    return true;
  })()`;
}
