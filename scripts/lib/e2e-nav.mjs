/**
 * Getting to the app's own pages from an automated run.
 *
 * The app's destinations live in the management pane (站点 / 账号 / AI 记录 /
 * 设置, with 书签 / 标签 / 消息 below a rule). The pane is opened by the
 * [管理] button at the right end of the browser page's instance rail, and its
 * sections carry `data-manage-item` just as the old dropdown rows did, so a
 * run reaches a page by opening the pane and clicking the section.
 *
 * The rail only exists on the browser page, so a run that starts on the pane
 * goes back first — the pane's band carries the back arrow
 * (`[data-nav="browser"]`), and the browser is the only other surface.
 *
 * Two destinations need a second click inside their section:
 * - **Flows** are a tab of the AI 记录 section (`data-ai-tab="flows"`).
 * - **Settings** covers its section with its own directory
 *   (`.page.settings [data-section="…"]`).
 *
 * Repeating that in ten suites is how the selectors drift apart; the snippets
 * here are the single copy.
 */

/** Puts the browser page on screen if the pane is showing instead. */
const ensureBrowser = `
  if (!document.querySelector('.rail')) {
    document.querySelector('[data-nav="browser"]')?.click();
    await new Promise((done) => setTimeout(done, 600));
  }
`;

/**
 * Opens the management pane on a section.
 *
 * Always through the browser page: the pane replaces it, so a run standing on
 * the pane steps out to the browser first and re-enters. That round trip is
 * also what makes every arrival a real mount — a section re-clicked from
 * inside the pane would keep the page the run is leaving, and suites that rely
 * on "go there" meaning "freshly mounted" would read a stale copy. The waits
 * are real: the pane is a Vue render away from existing, and the page a
 * section renders is another render away from being readable. Reading the DOM
 * in the same task as the click returns `null` and the step silently does
 * nothing, which is a whole class of "the suite passed but looked at the wrong
 * screen".
 */
function paneSection(target) {
  return `
    ${ensureBrowser}
    const btn = document.querySelector('[data-manage-btn]');
    if (!btn) return false;
    btn.click();
    await new Promise((done) => setTimeout(done, 500));
    if (!document.querySelector('[data-manage-pane]')) return false;
    const item = document.querySelector('[data-manage-item="${target}"]');
    if (!item) return false;
    item.click();
    await new Promise((done) => setTimeout(done, 600));
  `;
}

/** The flows tab inside the AI 记录 section. */
const FLOWS_TAB = `
  const tab = document.querySelector('[data-ai-tab="flows"]');
  if (!tab) return false;
  if (tab.getAttribute('aria-selected') !== 'true') tab.click();
  await new Promise((done) => setTimeout(done, 500));
  return Boolean(document.querySelector('[data-ai-tab="flows"]'));
`;

/**
 * Opens one of the app's pages.
 *
 * `nav` is a management pane section (`sites`, `identities`, `ai`,
 * `bookmarks`, `tags`, `messages`), the flows tab spelled `flows`, or a
 * settings section spelled `settings-<id>` (`settings-general`,
 * `settings-mcp`, …).
 */
export function openNav(nav) {
  if (nav === "settings" || nav.startsWith("settings-")) {
    const section = nav === "settings" ? null : nav.slice("settings-".length);
    return `(async () => {
      ${paneSection("settings")}
      const wanted = ${JSON.stringify(section)};
      if (wanted) {
        const tab = document.querySelector('.page.settings [data-section="' + wanted + '"]');
        if (tab && !tab.classList.contains('active')) tab.click();
        await new Promise((done) => setTimeout(done, 500));
      }
      return Boolean(document.querySelector('.page.settings'));
    })()`;
  }
  if (nav === "flows") {
    return `(async () => {
      ${paneSection("ai")}
      ${FLOWS_TAB}
    })()`;
  }
  return `(async () => {${paneSection(nav)}
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
 * The pane's band arrow is the way back; the browser carries the instance rail
 * the [管理] button lives on.
 */
export function backToBrowser() {
  return `(async () => {
    ${ensureBrowser}
    return true;
  })()`;
}
