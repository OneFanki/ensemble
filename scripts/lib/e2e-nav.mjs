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

/**
 * Makes sure the account bar is on screen.
 *
 * The bar lives in the window's first row now, always mounted — there is no
 * switch to collapse it. The wait stays because the bar is part of the first
 * paint's markup but a suite can evaluate before Vue has mounted, and a missing
 * `[data-account-rail]` then reads as "the suite's click landed nowhere".
 */
const ensureRail = `
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (document.querySelector('[data-account-rail]')) break;
    await new Promise((done) => setTimeout(done, 50));
  }
`;

/** The floating pane's root, once it has been mounted. */
const PANE = "[data-floating-pane]";

/**
 * Closes a floating pane, leaving the browser underneath.
 *
 * The close control is addressed by its own hook, not "the first button in the
 * head": the head also carries the face switch, and when the switch was added the
 * first button became "show the launch face" — so this helper stopped closing
 * anything and left the pane open, which showed up in unrelated suites as clicks
 * landing on a pane that should have been gone.
 *
 * The scrim press is the fallback, for a build whose head has no control.
 */
const closePane = `
  const pane = document.querySelector(${JSON.stringify(PANE)});
  if (pane) {
    const closeBtn = pane.querySelector('[data-pane-close]');
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
  ${ensureRail}
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
 *
 * The pane mounts on its launch face — tiles you click to open — because that is
 * what the pane is for almost every time. A suite that asserts on rows, columns,
 * group folding or drag ordering wants the edit face, so `nav` decides: the
 * `identities` destination switches to edit, and `accounts-use` leaves the launch
 * face alone for the suites that test it.
 */
const openLayer = `
  ${ensureBrowser}
  const entry = document.querySelector('[data-rail-entry="identities"]');
  if (!entry) return false;
  entry.click();
  await new Promise((done) => setTimeout(done, 450));
  ${awaitPane}
`;

/** Switches the accounts pane to its edit face, if it is not there already. */
const toEditFace = `
  if (!document.querySelector('[data-mode-edit][aria-pressed="true"]')) {
    document.querySelector('[data-mode-edit]')?.click();
    await new Promise((done) => setTimeout(done, 350));
  }
  if (!document.querySelector('.page.identities[data-mode="edit"]')) return false;
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
 * shows, and old call sites should not have to know that. `accounts-use` is the
 * one destination that stops on the launch face.
 */
export function openNav(nav) {
  if (nav === "identities" || nav === "sites") {
    return `(async () => {${openLayer}${toEditFace}return true;})()`;
  }
  if (nav === "accounts-use") {
    return `(async () => {${openLayer}
      if (!document.querySelector('.page.identities[data-mode="use"]')) return false;
      return true;})()`;
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

/**
 * Waits for the account bar, as an expression to `evaluate`.
 *
 * The bar is part of the window's first row and cannot be collapsed, so this only
 * waits for the mount. Suites that read a chip, a freeze badge or an AI dot call
 * it before their first read; `openNav` already does the same on its way to the
 * accounts pane.
 */
export function openRail() {
  return `(async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (document.querySelector('[data-account-rail]')) return true;
      await new Promise((done) => setTimeout(done, 100));
    }
    return Boolean(document.querySelector('[data-account-rail]'));
  })()`;
}
