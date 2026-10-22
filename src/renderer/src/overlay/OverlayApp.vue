<script setup lang="ts">
import type { RunningInstance } from "@shared/types";
import { GripVertical, Minimize2, Power, X } from "lucide-vue-next";
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { type Locale, setLocale } from "../i18n";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();

const root = ref<HTMLElement | null>(null);
const header = ref<HTMLElement | null>(null);
const list = ref<HTMLElement | null>(null);
const footer = ref<HTMLElement | null>(null);
/**
 * Collapsed means the window is the small docked square: a fixed 48px box. The
 * state lives in the main process (it owns the window size), so it arrives with
 * the page URL and changes only through `setOverlayCompact`.
 */
const collapsed = ref(new URLSearchParams(location.search).get("compact") === "1");
/**
 * Instance whose window currently owns the OS foreground. Read from the system
 * rather than from our own clicks, so raising a window by hand (taskbar, alt-tab)
 * also moves the highlight.
 */
const activeId = ref<string | null>(null);
let disposeActive: (() => void) | undefined;

const groups = computed(() => {
  // Instances are grouped by site so the same display name in two
  // sites cannot be mistaken for one window.
  const map = new Map<string, { id: string; name: string; instances: RunningInstance[] }>();
  for (const instance of store.instances) {
    const site =
      store.sites.find((item) => item.id === instance.siteId)?.name ?? "";
    const key = instance.siteId;
    const existing = map.get(key);
    if (existing) existing.instances.push(instance);
    else map.set(key, { id: key, name: site, instances: [instance] });
  }
  return [...map.values()];
});

/** Only show the site heading when more than one is running. */
const showGroupNames = computed(() => groups.value.length > 1);

const colorOf = (instance: RunningInstance) =>
  store.identities.find((identity) => identity.id === instance.identityId)?.color ?? "slate";

/** Color of the ball's rim: follows whichever window is in front, if any. */
const activeColor = computed(() => {
  const instance = store.instances.find((item) => item.id === activeId.value);
  return instance ? colorOf(instance) : null;
});

async function setCollapsed(next: boolean) {
  collapsed.value = next;
  await window.ensemble.setOverlayCompact(next);
  if (!next) reportSize();
}

function collapse() {
  void setCollapsed(true);
}

function expand() {
  void setCollapsed(false);
}

function applyTheme() {
  const theme = store.settings.theme;
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.dataset["theme"] = resolved;
}

async function focus(instance: RunningInstance) {
  // Works for external-mode windows too: those have no CDP connection, so the
  // main process activates them through the OS instead.
  await store.focusInstance(instance.id);
}

function stop(instance: RunningInstance) {
  void store.stopInstance(instance.id);
}

function stopAll() {
  void store.stopAll();
}

/**
 * The window is frameless. Height follows the content up to a ceiling set by the
 * main process, after which the list scrolls; the user can drag the bottom-right
 * corner to pick their own size, and that size wins over the measured one.
 *
 * Collapsed needs no measurement at all: the main process fixes the square, and
 * reporting a size here would fight it.
 */
const resized = ref(localStorage.getItem("ensemble.overlay.resized") === "1");

function reportSize() {
  if (resized.value || collapsed.value) return;
  void nextTick(() => {
    if (!header.value) return;
    // Measure the content, not the window: the window may already be clamped to
    // the ceiling, and scrollHeight still reports the height the list wants.
    const content =
      header.value.getBoundingClientRect().height +
      (list.value?.scrollHeight ?? 0) +
      (footer.value?.getBoundingClientRect().height ?? 0);
    if (content > 0) {
      // Height only. The window may be mid-animation between the ball and the
      // strip, so reading `window.innerWidth` here would shrink the expanded
      // panel to the ball's width; the main process keeps the width the user
      // last chose.
      // Two border pixels are not included in either measurement.
      void window.ensemble.resizeOverlay({ height: Math.ceil(content) + 2 });
    }
  });
}

watch(() => [store.instances.length, collapsed.value, store.loading], reportSize);

// ---- manual resize ----

const RESIZE_MIN_WIDTH = 148;
const RESIZE_MIN_HEIGHT = 40;

function startResize(event: PointerEvent) {
  event.preventDefault();
  // Take over immediately: any window resize during the drag would otherwise fire
  // `reportSize`, which snaps the height back to the content before the pointer
  // is released.
  resized.value = true;
  localStorage.setItem("ensemble.overlay.resized", "1");

  const startX = event.screenX;
  const startY = event.screenY;
  const startWidth = window.innerWidth;
  const startHeight = window.innerHeight;
  const handle = event.currentTarget as HTMLElement;
  handle.setPointerCapture(event.pointerId);

  const move = (moveEvent: PointerEvent) => {
    const width = Math.max(RESIZE_MIN_WIDTH, startWidth + (moveEvent.screenX - startX));
    const height = Math.max(RESIZE_MIN_HEIGHT, startHeight + (moveEvent.screenY - startY));
    void window.ensemble.resizeOverlay({ width, height });
  };
  const finish = () => {
    handle.removeEventListener("pointermove", move);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
  };
  handle.addEventListener("pointermove", move);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}

/** Double-clicking the corner restores automatic height. */
function resetResize() {
  resized.value = false;
  localStorage.removeItem("ensemble.overlay.resized");
  reportSize();
}

// ---- collapsed square drag ----

/**
 * The collapsed square is a fixed-size frameless window, so CSS cannot move it.
 * Pointer positions are reported in screen coordinates and the main process
 * repositions the window; releasing docks it to the nearest side so it behaves
 * like a desktop widget instead of a stray window parked in the middle.
 *
 * A press that never moves is a click: that is how the square expands. The
 * threshold keeps a slightly shaky click from turning into a 1px drag.
 */
const dragging = ref(false);
let dragPointer = -1;
let dragStart = { x: 0, y: 0 };
let dragOrigin = { x: 0, y: 0 };
let dragLast = { x: 0, y: 0 };
let dragMoved = false;

function onBallPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  dragging.value = true;
  dragMoved = false;
  dragPointer = event.pointerId;
  dragStart = { x: event.screenX, y: event.screenY };
  dragOrigin = { x: window.screenX, y: window.screenY };
  dragLast = { ...dragOrigin };
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
}

function onBallPointerMove(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== dragPointer) return;
  const dx = event.screenX - dragStart.x;
  const dy = event.screenY - dragStart.y;
  if (!dragMoved && Math.hypot(dx, dy) < 4) return;
  dragMoved = true;
  dragLast = { x: dragOrigin.x + dx, y: dragOrigin.y + dy };
  void window.ensemble.moveOverlay(dragLast);
}

function onBallPointerUp(event: PointerEvent) {
  if (!dragging.value || event.pointerId !== dragPointer) return;
  dragging.value = false;
  dragPointer = -1;
  const target = event.currentTarget as HTMLElement;
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
  if (!dragMoved) {
    expand();
    return;
  }
  void window.ensemble.moveOverlay({ ...dragLast, snap: true });
}

onMounted(async () => {
  await store.init();
  // This window is a second renderer: it never runs App.vue's startup, so the
  // theme and language have to be applied here too.
  setLocale(store.settings.locale as Locale);
  applyTheme();
  reportSize();
  window.addEventListener("resize", reportSize);
  disposeActive = window.ensemble.onActiveInstance((instanceId) => {
    activeId.value = instanceId;
  });
});

watch(
  () => store.settings.theme,
  () => applyTheme(),
);

onUnmounted(() => {
  window.removeEventListener("resize", reportSize);
  disposeActive?.();
});
</script>

<template>
  <div ref="root" class="overlay" :class="{ compact: collapsed }">
    <!--
      Collapsed: one small rounded square, draggable and edge-snapping. It shows
      the number of running windows and nothing else — no title, no close button —
      so it can sit in a screen corner without covering anything. Click expands,
      drag moves. The hit area is the whole window, which is a few pixels larger
      than the square so its drop shadow is not clipped into a black rectangle.
    -->
    <div
      v-if="collapsed"
      class="ball-hit no-drag"
      @pointerdown="onBallPointerDown"
      @pointermove="onBallPointerMove"
      @pointerup="onBallPointerUp"
      @pointercancel="onBallPointerUp"
    >
      <button
        type="button"
        class="ball"
        :style="activeColor ? { '--role': `var(--role-${activeColor})` } : {}"
        :aria-label="$t('app.overlayBallLabel', { count: store.instances.length })"
        :title="$t('app.overlayBallHint')"
        tabindex="-1"
      >
        <span class="ball-count mono">{{ store.instances.length }}</span>
        <span v-if="activeColor" class="ball-live"></span>
      </button>
    </div>

    <template v-else>
      <header ref="header" class="bar drag-region">
        <GripVertical :size="11" class="grip" />
        <span class="title">{{ $t("app.overlayTitle") }}</span>
        <span class="count mono">{{ store.instances.length }}</span>
        <button
          type="button"
          class="icon no-drag"
          :aria-label="$t('app.overlayCollapse')"
          :title="$t('app.overlayCollapse')"
          @click="collapse"
        >
          <Minimize2 :size="12" />
        </button>
      </header>

      <div ref="list" class="list">
        <section v-for="group in groups" :key="group.id" class="group">
          <p v-if="showGroupNames" class="group-name">{{ group.name || "—" }}</p>
          <div
            v-for="instance in group.instances"
            :key="instance.id"
            class="row"
            :class="{ active: instance.id === activeId }"
            :style="{ '--role': `var(--role-${colorOf(instance)})` }"
          >
            <button
              type="button"
              class="switch"
              :title="instance.label"
              :aria-current="instance.id === activeId"
              @click="focus(instance)"
            >
              <span class="dot"></span>
              <span class="name">{{ instance.label }}</span>
            </button>
            <span v-if="instance.clean" class="tag">{{ $t("app.cleanShort") }}</span>
            <span v-else-if="instance.mode === 'external'" class="ext mono">EXT</span>
            <button
              type="button"
              class="stop"
              :aria-label="$t('app.stop')"
              @click="stop(instance)"
            >
              <X :size="10" />
            </button>
          </div>
        </section>
      </div>

      <!--
        Close-all lives below the list on purpose: in the header it either stole
        the width the title needs or sat one stray click away from collapse and
        hide. Down here it reads as "the action for the whole list".
      -->
      <div ref="footer" class="footer">
        <button type="button" class="close-all no-drag" @click="stopAll">
          <Power :size="10" />
          {{ $t("app.closeAll") }}
        </button>
      </div>

      <!-- The window has no native frame, so its resize affordance is this corner.
           Double-click restores the automatic height. -->
      <div
        class="resize-handle no-drag"
        :title="$t('app.overlayResize')"
        @pointerdown="startResize"
        @dblclick="resetResize"
      ></div>
    </template>
  </div>
</template>

<style scoped>
/*
 * The overlay window sizes itself to its content from the main process. The
 * shared base stylesheet assumes a full-height app shell, which would clamp the
 * measured height to the current window and make the resize a no-op.
 */
:global(html[data-mode="overlay"]),
:global(html[data-mode="overlay"] body),
:global(html[data-mode="overlay"] #app) {
  height: 100%;
  min-height: 0;
  background: transparent;
  overflow: hidden;
}

.overlay {
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  border: 1px solid var(--line);
  border-radius: 9px;
  /* Solid, not translucent: the strip floats above browser windows, so it has to
     stay readable whatever page is underneath. */
  background: var(--bg-elevated);
  box-shadow: 0 12px 32px rgb(0 0 0 / 45%);
  overflow: hidden;
  user-select: none;
}

/* The ball paints its own circle; the window itself is just a transparent box. */
.overlay.compact {
  border: 0;
  background: transparent;
  box-shadow: none;
  overflow: visible;
}

.ball-hit {
  width: 100%;
  height: 100%;
  display: grid;
  place-items: center;
  cursor: grab;
  touch-action: none;
}

.ball-hit:active {
  cursor: grabbing;
}

.ball {
  --role: var(--role-slate);
  width: 48px;
  height: 48px;
  /* Rounded square, not a circle: the same radius language as every other
     surface in the app, and it does not turn into a soft blob when the shadow
     spreads on a light page underneath. */
  border-radius: var(--radius-lg);
  display: grid;
  place-items: center;
  position: relative;
  border: 1px solid color-mix(in srgb, var(--line) 72%, transparent);
  background: color-mix(in srgb, var(--bg-elevated) 96%, transparent);
  /* The window reserves 8px around this square for exactly this shadow; drawing
     it inside a window the same size as the square clipped it at the frame. */
  box-shadow: 0 4px 12px rgb(0 0 0 / 32%);
  pointer-events: none;
  transition: border-color 0.15s ease;
}

.ball-hit:hover .ball {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
}

.ball-hit:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

.ball-hit:hover .ball {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--line));
}

.ball-hit:focus-visible {
  outline: 1px solid var(--accent);
  outline-offset: 2px;
}

.ball-count {
  font-size: 15px;
  font-weight: 500;
  color: var(--text-secondary);
  line-height: 1;
}

/* The window in front, echoed on the ball's rim. Same meaning as the row ring:
   which account is actually visible right now. */
.ball-live {
  position: absolute;
  right: 6px;
  bottom: 6px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--role);
  box-shadow: 0 0 0 2px var(--bg-elevated);
}

.bar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 7px 6px 7px 6px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}

/* Three dots in the corner, macOS style; faint until hovered so the strip does
   not grow a visible scrollbar-like decoration. */
.resize-handle {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 13px;
  height: 13px;
  cursor: nwse-resize;
  opacity: 0.3;
  transition: opacity 0.12s ease;
  background-image:
    radial-gradient(circle, var(--faint) 1px, transparent 1.2px),
    radial-gradient(circle, var(--faint) 1px, transparent 1.2px),
    radial-gradient(circle, var(--faint) 1px, transparent 1.2px);
  background-size: 4px 4px;
  background-position: 7px 7px, 3px 7px, 7px 3px;
  background-repeat: no-repeat;
}

.resize-handle:hover {
  opacity: 0.75;
}

.grip {
  color: var(--faint);
  flex: 0 0 11px;
}

/* The title gives way before any control does: the header must never wrap to a
   second line, which is what made the old collapsed strip grow taller. */
.title {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 0 1 auto;
}

.count {
  font-size: 10px;
  color: var(--accent-foreground);
  background: var(--accent);
  border-radius: 999px;
  min-width: 15px;
  height: 15px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  flex: 0 0 auto;
}

.icon {
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
  flex: 0 0 18px;
}

.icon:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.icon:last-child {
  margin-left: auto;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 5px 6px;
  /*
   * Deliberately not `flex: 1`. A growing list makes its own scrollHeight equal
   * to the window height, so the auto-height measurement feeds back into itself
   * and the strip climbs to the ceiling. Content decides the height here; the
   * window only clamps it, and overflow turns into a scrollbar.
   */
  flex: 0 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.footer {
  padding: 0 6px 7px;
  flex: 0 0 auto;
}

.close-all {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
  color: var(--faint);
  border-radius: 4px;
  padding: 2px 5px;
}

.close-all:hover {
  color: var(--red);
  background: var(--surface-3);
}

.group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group + .group {
  margin-top: 4px;
}

.group-name {
  margin: 2px 0 1px 6px;
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.row {
  --role: var(--role-slate);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px 1px 1px;
  border-radius: 5px;
  min-width: 0;
  /* An inset ring rather than a border: a border would shift the row and make
     the list jump every time focus moves. */
  box-shadow: inset 0 0 0 1px transparent;
  transition: background 0.12s ease, box-shadow 0.12s ease;
}

.row:hover {
  background: var(--surface-3);
}

/*
 * The window the user is actually looking at. Identical pages make this the only
 * feedback that a switch really happened, so it is louder than hover: tinted
 * background, role-colored ring, and a filled dot.
 *
 * The ring follows the row's radius. An edge-only bar (the previous design) had
 * its ends rounded by the container, which read as a clipped decoration.
 */
.row.active {
  background: color-mix(in srgb, var(--role) 13%, var(--surface-2));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--role) 50%, transparent);
}

.row.active .name {
  color: var(--text);
}

.row.active .dot {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--role) 30%, transparent);
}

.switch {
  display: flex;
  align-items: center;
  gap: 7px;
  flex: 1 1 auto;
  min-width: 0;
  padding: 4px 5px;
  border-radius: 5px;
  text-align: left;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--role);
  flex: 0 0 5px;
}

.name {
  font-size: 11px;
  color: var(--text-secondary);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tag,
.ext {
  font-size: 9px;
  color: var(--faint);
  flex: 0 0 auto;
}

.tag {
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0 4px;
}

.stop {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
  flex: 0 0 16px;
  opacity: 0;
  cursor: pointer;
}

.row:hover .stop,
.stop:focus-visible {
  opacity: 1;
}

.stop:hover {
  color: var(--red);
  background: var(--surface-2);
}
</style>
