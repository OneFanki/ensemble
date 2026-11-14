<script setup lang="ts">
/**
 * The window's one navigation column, on the left.
 *
 * It replaced two separate things: the run dock (a right-hand column of running
 * instances) and the console's own rail (a left-hand column of management
 * pages). Having both meant the same question — "where am I, and what else is
 * there?" — was answered in two places with two vocabularies, and the answer
 * moved sides depending on which of them was on screen.
 *
 * Now there is one column with two halves:
 *
 * - **Top**: what is running, unchanged (`RunDock.vue`). It was already the
 *   vertical list of browser instances, which is what a left column of tabs is.
 * - **Bottom**: where you can go. `browser` is first and is the default, and
 *   picking it means the pane on the right *is* the browser page — the
 *   management pages are the same pane with different content, not a different
 *   screen.
 *
 * The column appears when the workbench opens and stays while a management page
 * is up, so there is always a way back to the browser. In plain browsing it is
 * not there: a browser is a tab strip, a toolbar and a page.
 *
 * Width, collapse and the drag handle all live here now. The dock used to own
 * them, but the dock is only half the column — a child that kept the width would
 * draw a second border and reserve window controls it no longer touches.
 */
import {
  Bookmark,
  Globe,
  Inbox,
  Layers,
  LayoutGrid,
  Settings,
  Sparkles,
  Tag,
  Users,
  Workflow,
} from "lucide-vue-next";
import type { Component } from "vue";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import RunDock from "./RunDock.vue";

/** Everything the pane can show beside the column. `browser` is a page, the rest are management. */
export type AppView =
  | "browser"
  | "messages"
  | "ai"
  | "sites"
  | "identities"
  | "views"
  | "flows"
  | "tags"
  | "bookmarks"
  | "profiles";

defineProps<{ view: AppView }>();
const emit = defineEmits<{ navigate: [view: AppView]; settings: [] }>();

const embedded = useEmbeddedStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const collapsed = computed(() => embedded.sidebarCollapsed);
/** True while the right edge is dragged, so the width transition stays off. */
const resizing = ref(false);
const platform = computed(() => workspace.snapshot?.platform ?? "win32");
const reservesControls = computed(() => platform.value !== "darwin");

/**
 * Where you can go, in two groups.
 *
 * The first group is the browser itself plus the bookmarks and profiles — all
 * three are about *going somewhere*: the page you have open, the addresses you
 * keep, and the cookie jars you open them in. The second is the workspace's own
 * assets.
 *
 * Bookmarks used to sit in the asset group, beside sites, and that pairing was
 * the whole confusion: a site is a login recipe for a system you keep accounts
 * in, a bookmark is one address. Reading them as two entries of one list made
 * people ask what the difference was. They answer different questions, so they
 * no longer share a list. Profiles belong on this side for the same reason: they
 * are how everyday browsing is organised, while sites and accounts describe
 * systems under test.
 */
const browserEntries = computed<Array<{ view: AppView; label: string; icon: Component; count: number }>>(
  () => [
    {
      view: "messages",
      label: t("app.messages"),
      icon: Inbox,
      // Unread, not total: a badge that counts history you already read is a
      // counter of nothing.
      count: workspace.unreadMessages,
    },
    // No badge, deliberately: AI activity is a log, and a number that grew with
    // every tool call would be the notification noise this list was moved out of
    // the message centre to avoid.
    { view: "ai", label: t("app.aiActivityTitle"), icon: Sparkles, count: 0 },
    {
      view: "bookmarks",
      label: t("app.bookmarks"),
      icon: Bookmark,
      count: workspace.bookmarks.length,
    },
    {
      view: "profiles",
      label: t("app.profiles"),
      icon: Layers,
      // Persistent profiles only: the clean session is not managed here, so
      // counting it would make the rail disagree with the page it opens.
      count: (workspace.settings.profiles ?? []).filter((profile) => profile.retention !== "ephemeral").length,
    },
  ],
);

const assetEntries = computed<Array<{ view: AppView; label: string; icon: Component; count: number }>>(
  () => [
    { view: "sites", label: t("app.sites"), icon: Globe, count: workspace.sites.length },
    {
      view: "identities",
      label: t("app.identities"),
      icon: Users,
      count: workspace.identities.length,
    },
    { view: "views", label: t("app.views"), icon: LayoutGrid, count: workspace.views.length },
    { view: "flows", label: t("app.flows"), icon: Workflow, count: workspace.flows.length },
    { view: "tags", label: t("app.tags"), icon: Tag, count: workspace.snapshot?.tags.length ?? 0 },
  ],
);

/**
 * The settings sections are deliberately not rows here.
 *
 * Settings is a page of its own — it covers the whole window, this column
 * included, and carries its own tab bar. Flattening its six sections into the
 * column put navigation on screen while the thing it navigates was hidden under
 * it, and made the column look like a list of settings when it is a list of
 * places. One row at the bottom is the way in; which settings is the page's
 * business.
 */

/**
 * Drags the column's right edge to resize it.
 *
 * Width is written to the store on every move so the stage re-lays out live, but
 * persistence waits for pointerup: writing localStorage 60 times a second during
 * a drag is what makes sidebars feel sticky.
 *
 * The pointer is captured for the duration. Without it the drag stops the moment
 * the cursor crosses out of the column: the pages are `<webview>` nodes on the
 * stage, and a guest is its own native surface, so it takes the pointer and the
 * embedder never sees the move — every later position was lost and the column
 * stayed at its starting width.
 */
function startResize(event: PointerEvent): void {
  if (collapsed.value) return;
  event.preventDefault();
  const handle = event.currentTarget as Element | null;
  try {
    handle?.setPointerCapture(event.pointerId);
  } catch {
    // A capture that cannot be taken still leaves the window listeners working
    // for the part of the drag that stays inside the column.
  }
  const startX = event.clientX;
  const startWidth = embedded.dockWidth;
  resizing.value = true;
  embedded.holdPointer();
  const move = (next: PointerEvent) => {
    // The column is on the left, so dragging its right edge right widens it.
    embedded.setDockWidth(startWidth + (next.clientX - startX), false);
  };
  const up = () => {
    resizing.value = false;
    embedded.setDockWidth(embedded.dockWidth);
    embedded.releasePointer();
    try {
      handle?.releasePointerCapture(event.pointerId);
    } catch {
      // Already released by the browser.
    }
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}
</script>

<template>
  <aside
    class="sidebar"
    :class="{ collapsed, resizing }"
    :data-platform="platform"
    :style="{ '--sidebar-width': `${embedded.dockWidth}px` }"
  >
    <!--
      No spacer band at the top any more.

      The column used to reserve a 34px strip above its first row so the OS-drawn
      caption buttons would not sit on top of it — but those buttons are painted
      at the window's top *right*, and this column is at the top left, so the band
      was reserving nothing. It only pushed "运行中" a full title bar down, which
      read as a hole in the corner: the tab strip beside it starts at y=0 and the
      column did not.

      The drag band did not go away, it moved: `RunDock` draws its header at this
      exact height and marks it draggable, so the column still moves the window
      from the one row that has nothing clickable in it. macOS keeps a real inset
      because its traffic lights *are* on the left.
    -->
    <!-- Straddles the border from the inside: the column clips its own overflow,
         so a handle hanging outside would never be hit. -->
    <span
      v-if="!collapsed"
      class="sidebar-resize"
      role="separator"
      aria-orientation="vertical"
      :aria-label="t('app.browserResizeDock')"
      v-tooltip="t('app.browserResizeDock')"
      @pointerdown="startResize"
    ></span>

    <RunDock class="sidebar-dock" />

    <nav class="sidebar-nav" :aria-label="t('app.consoleNav')">
      <button
        type="button"
        class="nav-item nav-browser"
        :class="{ active: view === 'browser' }"
        :aria-current="view === 'browser' ? 'page' : undefined"
        data-nav="browser"
        v-tooltip="t('app.browser')"
        @click="emit('navigate', 'browser')"
      >
        <Globe :size="14" class="nav-icon" />
        <span class="nav-label">{{ t("app.browser") }}</span>
      </button>

      <!-- The rest of "going somewhere": the addresses you keep. -->
      <button
        v-for="entry in browserEntries"
        :key="entry.view"
        type="button"
        class="nav-item"
        :class="{ active: view === entry.view }"
        :aria-current="view === entry.view ? 'page' : undefined"
        :data-nav="entry.view"
        v-tooltip="entry.label"
        @click="emit('navigate', entry.view)"
      >
        <component :is="entry.icon" :size="14" class="nav-icon" />
        <span class="nav-label">{{ entry.label }}</span>
        <span v-if="entry.count" class="nav-count mono">{{ entry.count }}</span>
      </button>

      <div class="nav-group">
        <p class="nav-title">{{ t("app.consoleGroupWorkspace") }}</p>
        <button
          v-for="entry in assetEntries"
          :key="entry.view"
          type="button"
          class="nav-item"
          :class="{ active: view === entry.view }"
          :aria-current="view === entry.view ? 'page' : undefined"
          :data-nav="entry.view"
          v-tooltip="entry.label"
          @click="emit('navigate', entry.view)"
        >
          <component :is="entry.icon" :size="14" class="nav-icon" />
          <span class="nav-label">{{ entry.label }}</span>
          <span v-if="entry.count" class="nav-count mono">{{ entry.count }}</span>
        </button>
      </div>
    </nav>

    <!--
      One row, at the very bottom, outside the navigation's scroller.

      Settings is not a place you work in — it changes how the others behave — and
      it leaves this column behind entirely when it opens. It sits below the
      places rather than among them, and outside the scroller so a long list of
      destinations can never push the only way into settings off the screen.
    -->
    <div class="sidebar-tail">
      <button
        type="button"
        class="nav-item"
        data-nav="settings"
        v-tooltip="t('app.settings')"
        @click="emit('settings')"
      >
        <Settings :size="14" class="nav-icon" />
        <span class="nav-label">{{ t("app.settings") }}</span>
      </button>
    </div>
  </aside>
</template>

<style scoped>
/*
 * One column, two halves: instances above, destinations below.
 *
 * The border is on the right because the column is on the left now. The width
 * animates (there is no native child inside the column — the pages live in the
 * stage beside it), so expanding and collapsing read as one motion.
 */
.sidebar {
  position: relative;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-height: 0;
  width: var(--sidebar-width);
  padding: 0 8px 8px;
  gap: 8px;
  background: var(--bg);
  border-right: 1px solid var(--line-soft);
  overflow: hidden;
}

.sidebar:not(.resizing) {
  /* Padding travels with the width: the collapsed column drops its side padding
     to centre a 34px tile, and doing that in one frame while the width animates
     made the last few pixels jump. */
  transition:
    width var(--motion-slow) var(--ease-out),
    padding var(--motion-slow) var(--ease-out);
}

.sidebar.resizing {
  user-select: none;
  cursor: col-resize;
}

/* Only macOS needs a band: its traffic lights are painted over the window's top
   left, which is where this column starts. Windows and Linux put the caption
   buttons on the right, so the column begins at the window's own top edge and
   its first row is the title bar. */
.sidebar[data-platform="darwin"] {
  padding-top: 38px;
}

.sidebar-resize {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 6px;
  cursor: col-resize;
  z-index: 2;
}

.sidebar-resize::after {
  content: "";
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 1px;
  background: transparent;
  transition: background var(--motion-base) var(--ease-out);
}

.sidebar-resize:hover::after,
.sidebar.resizing .sidebar-resize::after {
  background: color-mix(in srgb, var(--accent) 55%, transparent);
}

.sidebar.collapsed {
  width: 46px;
  padding: 0 0 8px;
  align-items: center;
}

/* The inset outranks the collapsed padding reset: both rules are equally
   specific, so without this one the 46px rail would crawl back under the
   traffic lights the moment the column is folded. */
.sidebar.collapsed[data-platform="darwin"] {
  padding-top: 38px;
}

.sidebar-dock {
  flex: 1 1 auto;
  min-height: 0;
}

/*
 * The navigation is its own scroller with a ceiling.
 *
 * Instances can be many and destinations are few, so the two do not deserve the
 * same share of the column: the dock takes what is left, and the navigation is
 * capped rather than allowed to push the dock to nothing on a short window.
 */
.sidebar-nav {
  flex: 0 1 auto;
  min-height: 0;
  max-height: 52%;
  overflow-y: auto;
  scrollbar-width: thin;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding-top: 4px;
  border-top: 1px solid var(--line-soft);
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 1px;
}

/* The way into settings: below the navigation scroller, never inside it. */
.sidebar-tail {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  padding-top: var(--space-2);
  border-top: 1px solid var(--line-soft);
}

/* Group captions are structure, not items: small, muted, not clickable. */
.nav-title {
  margin: 0;
  padding: var(--space-2) 8px var(--space-2);
  font-size: var(--fs-2xs);
  letter-spacing: 0.03em;
  color: var(--faint);
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: var(--fs-sm);
  text-align: left;
  min-width: 0;
  transition:
    background var(--motion-base) var(--ease-out),
    color var(--motion-base) var(--ease-out),
    width var(--motion-slow) var(--ease-out);
}

.nav-item:hover {
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text);
}

/* The selected row is the chrome surface — the same fill an active browser tab
   uses, which is what makes the rail and the page read as one window. */
.nav-item.active {
  background: var(--chrome);
  color: var(--text);
}

/* The active row's icon keeps the row's own text colour.
 *
 * It used to take the accent-text gold (#7a4e05 on light) — a dark brown sitting
 * beside a near-black label. Two different darks in one row read as
 * misalignment: the glyph looked like it had slipped out of line with its text
 * rather than like it was tinted. A 14px mark cannot carry a hue anyway; the
 * word next to it already says where you are. */
.nav-item.active .nav-icon {
  color: inherit;
}

.nav-icon {
  flex: 0 0 14px;
}

.nav-label {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-count {
  flex: 0 0 auto;
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.nav-item.active .nav-count {
  color: var(--muted);
}

/* The browser row is a destination like the others, but it is the one people
   come back to, so it sits above the caption rather than inside a group. */
.nav-browser {
  margin-top: 2px;
}

/*
 * Labels fade instead of vanishing.
 *
 * They used to be `display: none` in the collapsed state, which is a jump cut:
 * the column animated its width over 220ms while the text disappeared in one
 * frame, so collapsing read as the panel breaking rather than shrinking. Fading
 * them over the same window as the width is what makes it one motion.
 */
.sidebar-nav .nav-label,
.sidebar-nav .nav-count,
.sidebar-nav .nav-title {
  transition:
    opacity var(--motion-slow) var(--ease-out),
    visibility var(--motion-slow);
  opacity: 1;
  visibility: visible;
}

.sidebar.collapsed .nav-title,
.sidebar.collapsed .nav-label,
.sidebar.collapsed .nav-count {
  opacity: 0;
  visibility: hidden;
  /* Out of the flow while invisible: the collapsed column is 46px wide and a
     hidden label that still occupied space would push the icons off centre. */
  position: absolute;
  pointer-events: none;
}

.sidebar.collapsed .sidebar-nav {
  align-items: center;
  max-height: none;
  gap: 2px;
}

.sidebar.collapsed .sidebar-tail {
  align-items: center;
}

.sidebar.collapsed .nav-item {
  justify-content: center;
  width: 34px;
  padding: 0;
}
</style>
