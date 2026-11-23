/**
 * The guide's content version, shared because two sides key off it: the
 * renderer decides whether to auto-open the tour, and the main process seeds a
 * freshly spawned window's settings so that window does not replay the tour.
 *
 * Bumped when the guide's content changes enough that someone who already read
 * the old one should see this one.
 *
 * 2: the first screen opened with what the window *is*, then the three steps.
 * 3: the guide led with the AI instead of the manual path; added what the AI can
 *    observe, its activity record, and the two browser surfaces.
 * 4: the whole thing became a paginated tour with a looping diagram per page,
 *    and the order now starts from "it is a browser" / "every tab is isolated"
 *    rather than from site setup. Adds the headless-AI page and the developer
 *    tools page.
 * 5: the isolation page is told in the 身份 vocabulary the interface now uses,
 *    and the two-systems vocabulary page became the one-click account story.
 * 6: the compare page no longer describes grid layouts; side by side now means
 *    popped-out pages and a second window.
 * 7: the compare diagram draws two separate windows instead of a four-cell grid,
 *    matching the single-stage interface.
 */
export const GUIDE_VERSION = 7;
