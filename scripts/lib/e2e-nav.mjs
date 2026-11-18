/**
 * Getting to the app's own pages from an automated run.
 *
 * Two different shapes, so two different paths:
 *
 * - **Assets** (sites, identities, flows, tags, bookmarks, …) are reached from
 *   the browser page's instance rail: the [管理] button at its right end opens
 *   a menu naming every destination. The rail only exists on the browser page,
 *   so a run that starts elsewhere goes back to the browser first — every
 *   management page carries the band back-arrow (`[data-nav="browser"]`).
 * - **Settings** covers the window. It has no rail and its own tab bar, so the
 *   path is the same menu plus a click on the tab inside the page.
 *
 * Repeating that in ten suites is how the selectors drift apart; the snippets
 * here are the single copy.
 */

/** Returns to the browser page when another page is showing. */
const ensureBrowser = `
  if (!document.querySelector('.instance-rail') && !document.querySelector('.rail')) {
    if (document.querySelector('.page.settings')) {
      document.querySelector('.settings-head .back')?.click();
      await new Promise((done) => setTimeout(done, 600));
    } else {
      document.querySelector('[data-nav="browser"]')?.click();
      await new Promise((done) => setTimeout(done, 600));
    }
  }
`;

/**
 * Opens one of the app's pages.
 *
 * `nav` is a management menu item's `data-manage-item` value (`sites`,
 * `identities`, `flows`, `tags`, `bookmarks`, `settings`) or a settings section
 * spelled `settings-<id>` (`settings-general`, `settings-mcp`, …).
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
        ${ensureBrowser}
        document.querySelector('[data-manage-btn]')?.click();
        await new Promise((done) => setTimeout(done, 400));
        document.querySelector('[data-manage-item="settings"]')?.click();
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
    ${ensureBrowser}
    const row = document.querySelector('[data-manage-btn]');
    if (!row) return false;
    row.click();
    await new Promise((done) => setTimeout(done, 400));
    const item = document.querySelector('[data-manage-item="${nav}"]');
    if (!item) return false;
    item.click();
    await new Promise((done) => setTimeout(done, 500));
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
 * Two ways out, because the two shapes have two ways in: settings carries its own
 * back button, every other management page has the band back-arrow.
 */
export function backToBrowser() {
  return `(async () => {
    if (document.querySelector('.page.settings')) {
      document.querySelector('.settings-head .back')?.click();
      await new Promise((done) => setTimeout(done, 500));
      return true;
    }
    document.querySelector('[data-nav="browser"]')?.click();
    await new Promise((done) => setTimeout(done, 300));
    return true;
  })()`;
}
