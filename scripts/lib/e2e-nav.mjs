/**
 * Getting to the app's own pages from an automated run.
 *
 * Two different shapes, so two different paths:
 *
 * - **Assets** (sites, identities, views, flows, tags, bookmarks) live beside a
 *   navigation column, and that column only exists while there is something to
 *   navigate from — so a run that starts on the browser opens the workbench
 *   through the app menu first.
 * - **Settings** covers the window. It has no column and its own tab bar, so the
 *   path is the menu row plus a click on the tab inside the page.
 *
 * Repeating that in ten suites is how the selectors drift apart; the snippets
 * here are the single copy.
 */

/** Opens the column if it is not up. Shared by every asset destination. */
const ensureColumn = `
  if (!document.querySelector('.sidebar-nav')) {
    document.querySelector('[data-app-menu]')?.click();
    await new Promise((done) => setTimeout(done, 400));
    document.querySelector('[data-menu-item="workspace"]')?.click();
    await new Promise((done) => setTimeout(done, 700));
  }
`;

/**
 * Opens one of the app's pages.
 *
 * `nav` is a sidebar row's `data-nav` value (`browser`, `sites`, `identities`,
 * `views`, `flows`, `tags`, `bookmarks`) or a settings section spelled
 * `settings-<id>` (`settings-general`, `settings-mcp`, …).
 *
 * The waits are real: the menu is a Vue render away from existing, and the row
 * it opens is another render away from being clickable. Reading the DOM in the
 * same task as the click returns `null` and the step silently does nothing,
 * which is a whole class of "the suite passed but looked at the wrong screen".
 */
export function openNav(nav) {
  if (nav === "settings" || nav.startsWith("settings-")) {
    const section = nav === "settings" ? null : nav.slice("settings-".length);
    return `(async () => {
      if (!document.querySelector('.page.settings')) {
        // Settings has its own row at the bottom of the column; from the browser
        // the column is not up yet, so open the workbench first.
        if (!document.querySelector('.sidebar-nav')) {
          document.querySelector('[data-app-menu]')?.click();
          await new Promise((done) => setTimeout(done, 400));
          document.querySelector('[data-menu-item="workspace"]')?.click();
          await new Promise((done) => setTimeout(done, 700));
        }
        document.querySelector('[data-nav="settings"]')?.click();
        await new Promise((done) => setTimeout(done, 700));
      }
      const wanted = ${JSON.stringify(section)};
      if (wanted) {
        const tab = document.querySelector('.page.settings [data-section="' + wanted + '"]');
        if (tab && !tab.classList.contains('active')) tab.click();
        await new Promise((done) => setTimeout(done, 500));
      }
      return Boolean(document.querySelector('.page.settings'));
    })()`;
  }
  return `(async () => {
    ${ensureColumn}
    const row = document.querySelector('[data-nav="${nav}"]');
    if (!row) return false;
    if (!row.classList.contains('active')) row.click();
    await new Promise((done) => setTimeout(done, 500));
    return Boolean(document.querySelector('.sidebar-nav'));
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
 * Two ways out, because the two shapes have two ways in: settings carries its own
 * back button, everything else has the column's browser row.
 */
export function backToBrowser() {
  return `(async () => {
    if (document.querySelector('.page.settings')) {
      document.querySelector('.settings-head .back')?.click();
      await new Promise((done) => setTimeout(done, 500));
      return true;
    }
    document.querySelector('[data-nav="browser"]')?.click();
    return true;
  })()`;
}
