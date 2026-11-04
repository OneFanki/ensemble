<script setup lang="ts">
/**
 * Every page of the built-in browser, as one `<webview>` node each.
 *
 * Mounted at the app root, not inside the browser page, for a hard reason: a
 * node removed from the document destroys its renderer process immediately
 * (measured on 45.2.1). The browser page unmounts whenever the user visits the
 * accounts page, while AI tools keep opening, reading and screenshotting tabs
 * from there — so the nodes have to outlive any single page.
 *
 * Nodes are never removed for being off-screen. Visibility is CSS, and a hidden
 * guest still answers CDP (`display:none`: evaluate fine, screenshot 57ms).
 *
 * Mounting is driven by main: it sends `embedded:guest-mount` with the
 * creation-time attributes, this component creates the node, and `dom-ready`
 * reports the guest id back. Creation-time matters — `partition` and
 * `allowpopups` cannot be applied afterwards.
 */
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useEmbeddedStore } from "../stores/embedded";

/** Electron's `<webview>` element, as much of it as this component uses. */
interface WebviewElement extends HTMLElement {
  getWebContentsId(): number;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
}

interface Mounted {
  node: WebviewElement;
  partition: string;
  /** Outstanding presentation requests; the page paints while this is non-zero. */
  presenting: number;
  /** Main has been told this node has a real box (reported once). */
  laidOut: boolean;
}

const embedded = useEmbeddedStore();
const container = ref<HTMLElement | null>(null);
const nodes = new Map<string, Mounted>();

/**
 * Where each page's node sits, in window coordinates, and whether it paints.
 *
 * `stageRect` is the box the browser page reported; a page's own rect is
 * relative to it, so the sum is absolute.
 *
 * Two inputs, each answering a different question:
 *
 * - **A reported rect** is authoritative: main already computed the cell, the
 *   fit for a fixed viewport, and the DevTools split.
 * - **No rect** means the page is alive but not on stage (another tab of an
 *   instance, an off-stage view, or the console covering the browser). It keeps
 *   a real box — a guest with no box reports a 0×0 viewport and every
 *   visibility check inside it then says false — but is parked just outside the
 *   window's left edge.
 *
 * Parked rather than laid over the chrome even when no stage is reported: a
 * guest is a real native surface, so a full-window node swallows the pointer for
 * everything drawn beside it. Dragging the run dock's handle was the visible
 * symptom — the drag started on the handle and then entered a page's box, which
 * took the pointer away and left the width where it was.
 */
function placeFor(tabId: string): {
  rect: { x: number; y: number; width: number; height: number };
  onStage: boolean;
} {
  const stage = embedded.stageRect;
  const tab = embedded.tabs.find((item) => item.id === tabId);
  const bounds = tab?.bounds;
  /*
   * Whether this page is one of the pages the stage is showing.
   *
   * The store already owns this question — a flat stage shows the focused
   * instance's page, a view stage shows the pages in its slots — and re-deriving
   * it here got it wrong: requiring `!tab.viewId` parked every member of every
   * view, so a 2×2 stage went blank while its state looked correct. The extra
   * check is that the view itself is the one on screen; a page of an off-stage
   * view is not visible even though its slot table still lists it.
   */
  const onStage = Boolean(
    tab &&
      (tab.viewId
        ? tab.viewId === embedded.state.activeViewId && embedded.isOnStage(tab)
        : embedded.isOnStage(tab)),
  );
  const hasBox = Boolean(bounds && bounds.width > 0 && bounds.height > 0);
  if (hasBox && onStage && stage && stage.width > 0 && stage.height > 0) {
    return {
      rect: {
        x: stage.x + bounds!.x,
        y: stage.y + bounds!.y,
        width: bounds!.width,
        height: bounds!.height,
      },
      onStage: true,
    };
  }
  // Off stage but must stay sized: park it outside the window's left edge. It is
  // transparent anyway; this only guarantees it cannot intercept a pointer meant
  // for the chrome.
  const width = stage && stage.width > 0 ? stage.width : Math.max(1, window.innerWidth);
  const height = stage && stage.height > 0 ? stage.height : Math.max(1, window.innerHeight);
  return {
    rect: { x: -width, y: stage?.y ?? 0, width, height },
    onStage: false,
  };
}

/**
 * Applies position and visibility; never adds or removes a node.
 *
 * Four states:
 *
 * - **On stage**: visible, receives input.
 * - **On stage but transparent** (`opacity: 0`): keeps a real viewport *and*
 *   still answers `Page.captureScreenshot`. Measured on 45.2.1: a guest is
 *   culled from the compositor when it is `visibility: hidden` or outside the
 *   window, not when it is merely transparent.
 * - **Presenting**: a background page brought into the window for one capture.
 *   This has to *move* the node, not just un-fade it — a page parked outside the
 *   window is culled no matter what its opacity is, and its capture then never
 *   replies (measured: the on-stage guest captured, the parked one timed out).
 * - **Parked**: kept alive at full size outside the window, so it keeps a real
 *   viewport for reads (`display: none` would report 0×0 and make every
 *   visibility check inside it answer false) while taking no pointer events.
 *
 * `visibility: hidden` is deliberately never used for a live page: it reports a
 * correct viewport but refuses screenshots, and it makes `checkVisibility()`
 * inside the page answer false for every element — which turned ordinary reads
 * into "element not found".
 */
function layout(): void {
  // While an app gesture owns the pointer, no page may take it: a guest that
  // swallows a drag the chrome started leaves the control frozen at its
  // starting value. `draggingTabId` is the same situation — a tab dragged out of
  // the dock crosses the stage before it is dropped.
  const shielded = embedded.pointerShield > 0 || Boolean(embedded.draggingTabId);
  const stage = embedded.stageRect;
  for (const [tabId, mounted] of nodes) {
    const placement = placeFor(tabId);
    const presenting = mounted.presenting > 0;
    // A presented background page is placed on the stage for the capture: the
    // window box if the stage is unknown (the console covers the browser).
    const rect =
      presenting && !placement.onStage
        ? stage && stage.width > 0 && stage.height > 0
          ? { x: stage.x, y: stage.y, width: stage.width, height: stage.height }
          : { x: 0, y: 0, width: Math.max(1, window.innerWidth), height: Math.max(1, window.innerHeight) }
        : placement.rect;
    const onStage = placement.onStage || presenting;
    const style = mounted.node.style;
    // `flex`, never `block`. Electron's `<webview>` ships as `display: flex`
    // because its inner frame is a flex item that fills the container; forcing
    // `block` leaves that item with the user-agent stylesheet's default height,
    // so the page lays out at `150px` tall no matter how tall the node is
    // (measured: node 757px, `innerHeight` 150; the width kept following because
    // a block frame still stretches horizontally). A page that paints only its
    // top eighth of the window is what that looks like.
    style.display = "flex";
    style.left = `${rect.x}px`;
    style.top = `${rect.y}px`;
    style.width = `${rect.width}px`;
    style.height = `${rect.height}px`;
    style.visibility = "visible";
    style.opacity = onStage ? "1" : "0";
    // A transparent page must not take clicks meant for the one in front, and
    // no page may take the pointer during an app gesture.
    style.pointerEvents = onStage && !shielded ? "auto" : "none";
    // Above the other nodes while presenting, so a temporarily shown background
    // page is not painted underneath the page on stage.
    style.zIndex = presenting ? "3" : "1";
    // A node that has never had a real box reports a 0×0 viewport, and every
    // visibility check inside the page then answers false. Main has to know the
    // difference between "mounted" and "ready to be read".
    if (!mounted.laidOut && rect.width > 0 && rect.height > 0) {
      mounted.laidOut = true;
      void window.ensemble.confirmEmbeddedGuestLaidOut(tabId).catch(() => undefined);
    }
  }
}

/**
 * Shows one page briefly so main can capture it, then puts it back.
 *
 * The page is moved onto the stage for the duration: a node parked outside the
 * window is culled from the compositor and its `Page.captureScreenshot` never
 * replies. Hiding it is the only thing that changes otherwise — nothing is
 * added or removed, and the page keeps running.
 *
 * Main resolves its screenshot call from the reply, so this reports after the
 * change is applied — the caller still retries the capture, because a
 * compositor frame takes a moment to land.
 */
async function presentNode(payload: {
  requestId: number;
  tabId: string;
  present: boolean;
}): Promise<void> {
  const mounted = nodes.get(payload.tabId);
  if (!mounted) {
    await window.ensemble.confirmEmbeddedGuestPresented(payload.requestId, false);
    return;
  }
  // Re-run the layout first: a page opened by main can be asked to present
  // before the state broadcast that carries its box has been applied, and a
  // 0×0 viewport makes every read inside it answer "not found".
  layout();
  if (payload.present) {
    mounted.presenting = Math.max(0, mounted.presenting + 1);
    layout();
    // One frame's worth of waiting: two rAFs land after the style change has
    // been committed, which is the earliest point a compositor frame can exist.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  } else {
    mounted.presenting = Math.max(0, mounted.presenting - 1);
    layout();
  }
  await window.ensemble.confirmEmbeddedGuestPresented(payload.requestId, true);
}

/** Creates the node for a page at the moment main asks for it. */
function mountNode(payload: {
  tabId: string;
  partition: string;
  url: string;
  allowPopups: boolean;
}): void {
  const existing = nodes.get(payload.tabId);
  if (existing) {
    void reportReady(payload.tabId, existing.node);
    return;
  }
  const node = document.createElement("webview") as unknown as WebviewElement;
  // Lets a diagnostic — or a person with DevTools open — say which page a node
  // is. The pool is flat and the nodes are absolutely positioned, so there is
  // otherwise nothing on screen tying one to a tab.
  node.dataset.tabId = payload.tabId;
  node.setAttribute("partition", payload.partition);
  // A creation-time capability: without it Chromium refuses the window-open
  // request before main ever hears about it, so `target="_blank"` and OAuth
  // popups would silently do nothing.
  if (payload.allowPopups) node.setAttribute("allowpopups", "");
  node.setAttribute("src", payload.url);
  node.setAttribute(
    "style",
    "position:fixed;border:0;background:#101317;display:none;flex:0 0 auto;z-index:1",
  );

  node.addEventListener("dom-ready", () => {
    void reportReady(payload.tabId, node);
  });
  const pushState = (): void => {
    // The chrome shows url/title/loading from main's state, and main learns them
    // from the guest's own events; the renderer only needs to nudge it to
    // re-read once the document is there.
    layout();
  };
  node.addEventListener("did-navigate", pushState);
  node.addEventListener("did-navigate-in-page", pushState);
  node.addEventListener("did-stop-loading", layout);

  nodes.set(payload.tabId, { node, partition: payload.partition, presenting: 0, laidOut: false });
  container.value?.appendChild(node);
  layout();
}

async function reportReady(tabId: string, node: WebviewElement): Promise<void> {
  let guestId = 0;
  try {
    guestId = node.getWebContentsId();
  } catch {
    // A node torn down between the event and this read has no guest.
  }
  if (!guestId) return;
  const mounted = nodes.get(tabId);
  await window.ensemble.registerEmbeddedGuest(guestId, tabId, mounted?.partition);
}

function unmountNode(payload: { tabId: string }): void {
  const mounted = nodes.get(payload.tabId);
  if (!mounted) return;
  nodes.delete(payload.tabId);
  // Main has already closed the CDP session by the time this arrives, which is
  // what makes removing the node safe: detaching after `destroyed` takes the
  // native target out from under a pending command.
  mounted.node.remove();
}

let unsubscribers: Array<() => void> = [];

/**
 * Re-lays out whenever anything the layout depends on changes.
 *
 * Both inputs arrive independently: a node is mounted by main's request, while
 * its rect comes from a state broadcast that may have landed before the node
 * existed. Watching both is what closes that ordering gap — otherwise a page
 * whose bounds were reported first stays hidden until the next unrelated update.
 *
 * The dependencies are the *values*, not the presence of a rect. A node laid out
 * before the run dock opened kept the pre-dock width: the broadcast that carried
 * the new bounds arrived, the listener below ran `layout()` before the store had
 * stored it, and a presence-only key never changed again, so nothing re-ran.
 */
const stopWatching = watch(
  () =>
    [
      embedded.stageRect?.x,
      embedded.stageRect?.y,
      embedded.stageRect?.width,
      embedded.stageRect?.height,
      embedded.state.activeTabId,
      embedded.tabs.map((tab) => {
        const bounds = tab.bounds;
        const rect = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "-";
        return `${tab.id}:${rect}:${tab.active ? 1 : 0}:${tab.viewId ?? ""}`;
      }),
    ] as const,
  () => layout(),
);

/**
 * Takes the pointer away from every page the instant a gesture starts.
 *
 * This one has to be synchronous, and that is not an optimisation. The gesture
 * begins on a handle beside the stage; the very next mouse move is already over
 * a page. Waiting for the normal reactive flush meant the first move — and, for
 * a short drag, the only one — arrived while the page was still hit-testable,
 * so the page took the pointer and the control never moved.
 */
const stopShield = watch(
  () => embedded.pointerShield > 0 || Boolean(embedded.draggingTabId),
  () => layout(),
  { flush: "sync" },
);

onMounted(() => {
  unsubscribers = [
    window.ensemble.onEmbeddedGuestMount(mountNode),
    window.ensemble.onEmbeddedGuestUnmount(unmountNode),
    window.ensemble.onEmbeddedGuestPresent((payload) => void presentNode(payload)),
    // Position changes arrive as ordinary state broadcasts.
    window.ensemble.onEmbeddedState(() => layout()),
  ];
  // Pages that were mounted before this component existed (a reload of the
  // embedder while tabs were open) have no node; main re-requests them the next
  // time anything needs them, and layout below covers the ones that do.
  layout();
});

onBeforeUnmount(() => {
  stopWatching();
  stopShield();
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
  for (const mounted of nodes.values()) mounted.node.remove();
  nodes.clear();
});
</script>

<template>
  <!-- No pointer events of its own: the nodes are placed by fixed coordinates
       and must not create a stacking or hit-testing layer of their own. -->
  <div ref="container" class="guest-pool" aria-hidden="true" />
</template>

<style scoped>
.guest-pool {
  position: fixed;
  inset: 0;
  z-index: 1;
  pointer-events: none;
}

.guest-pool :deep(webview) {
  pointer-events: auto;
}
</style>
