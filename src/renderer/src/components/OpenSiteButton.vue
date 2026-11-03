<script setup lang="ts">
import { onClickOutside } from "@vueuse/core";
import { Plus } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import SiteOpenMenu from "./SiteOpenMenu.vue";

/**
 * The "+" that asks "as whom?" before it creates anything.
 *
 * A page in this app is almost never just a page: it belongs to a system and
 * usually to an account, and which account decides the session partition. A
 * one-click "+" therefore had to guess, and the guess was the daily profile — so
 * a view built to compare accounts got an anonymous page in a cell instead. Now
 * the click is a question: pick an account (opened at its start page and filled),
 * open the site daily or clean, or explicitly ask for a blank page.
 *
 * `lockedSiteId` is set where the surrounding container already names the
 * system — a view's own "+" — so the chooser lists that site's accounts and
 * nothing else.
 *
 * A page strip's "+" is deliberately *not* this component: adding a tab to a
 * running browser instance inherits that instance's session, so there is nothing
 * to ask.
 */
const props = defineProps<{
  /** Compact variant for headers and empty slots. */
  compact?: boolean;
  /** Narrow the chooser to one site; its columns collapse to the account list. */
  lockedSiteId?: string;
}>();

const emit = defineEmits<{
  /** A blank page in the daily profile was asked for by name. */
  openBlank: [];
  openDaily: [siteId: string];
  openClean: [siteId: string];
  openIdentity: [identityId: string];
}>();

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const { t } = useI18n();
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

// The panel floats over the stage, so the native pages must be parked while it
// is open. The store carries the signal because this component also lives in
// the dock, outside the browser page's own overlay handling.
watch(open, (value) => {
  embedded.setStageMenu(value);
  if (value) document.addEventListener("keydown", onKeydown);
  else document.removeEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  embedded.setStageMenu(false);
  document.removeEventListener("keydown", onKeydown);
});

onClickOutside(root, (event) => {
  const target = event.target as Node | null;
  if (target && panel.value?.contains(target)) return;
  open.value = false;
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

const label = computed(() =>
  props.lockedSiteId ? t("app.browserAddTab") : t("app.browserNewTab"),
);
/**
 * The lock only counts when the site still exists.
 *
 * A view can outlive the site it was built from (the definition is deleted, or
 * the container was assembled by hand). Falling back to the full chooser beats
 * opening a 250px panel with an empty account column.
 */
const effectiveLock = computed(() =>
  props.lockedSiteId && store.sites.some((site) => site.id === props.lockedSiteId)
    ? props.lockedSiteId
    : undefined,
);
/** True while the stage is being captured for this menu. */
const parking = ref(false);

async function toggle(): Promise<void> {
  if (open.value) {
    open.value = false;
    return;
  }
  if (parking.value) return;
  // Show the menu only after the native pages are off the stage: painting the
  // menu first and parking afterwards leaves its left half covered by the live
  // page for about 100ms, which reads as "the menu appears in pieces".
  parking.value = true;
  try {
    await embedded.coverStage();
  } finally {
    parking.value = false;
  }
  open.value = true;
  void nextTick(placePanel);
}

/**
 * Puts the panel next to its trigger, inside the viewport.
 *
 * The trigger lives in the dock as well as in the toolbar, and the dock is a
 * scroll container with its own stacking context — the panel is teleported to
 * body, so it can only be placed from the trigger's viewport rect. It flips
 * above the trigger when there is no room below, which is the common case for a
 * view header near the bottom of the dock.
 */
function placePanel(): void {
  const trigger = root.value?.querySelector<HTMLElement>(".split-main");
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = effectiveLock.value ? 250 : 400;
  const margin = 8;
  const estimate = effectiveLock.value ? 300 : 380;
  const roomBelow = window.innerHeight - rect.bottom - margin;
  const above = roomBelow < estimate && rect.top > roomBelow;
  const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
  panelStyle.value = {
    left: `${left}px`,
    ...(above
      ? { bottom: `${window.innerHeight - rect.top + 6}px` }
      : { top: `${rect.bottom + 6}px` }),
    width: `${width}px`,
  };
}

function chooseBlank(): void {
  open.value = false;
  emit("openBlank");
}

function chooseDaily(siteId: string): void {
  open.value = false;
  emit("openDaily", siteId);
}

function chooseClean(siteId: string): void {
  open.value = false;
  emit("openClean", siteId);
}

function chooseIdentity(identityId: string): void {
  open.value = false;
  emit("openIdentity", identityId);
}
</script>

<template>
  <span ref="root" class="split" :class="{ compact }">
    <button
      type="button"
      class="split-main"
      :title="label"
      :aria-label="label"
      :aria-expanded="open"
      @click.stop="toggle"
    >
      <Plus :size="compact ? 11 : 14" />
    </button>
  </span>

  <Teleport to="body">
    <div v-if="open" ref="panel" class="open-panel" :style="panelStyle">
      <SiteOpenMenu
        :sites="store.sites"
        :identities="store.identities"
        :locked-site-id="effectiveLock"
        @open-blank="chooseBlank"
        @open-daily="chooseDaily"
        @open-clean="chooseClean"
        @open-identity="chooseIdentity"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.split {
  display: inline-flex;
  align-items: stretch;
  border: none;
  border-radius: var(--radius);
  overflow: hidden;
  /* Level with every other toolbar control (--control-lg): a shorter control
     reads as secondary. */
  height: var(--control-lg);
}

/*
 * Tinted, unlike every other control on this row.
 *
 * Its "+" is not "another tab" — it asks which account the page should open as,
 * which is the one thing this browser does that a browser does not. A plain
 * glyph here sat 34px below the tab strip's own "+" and looked interchangeable
 * with it; the tint says "this one creates something" without a label.
 */
.split-main {
  display: grid;
  place-items: center;
  width: 32px;
  color: var(--accent);
  background: var(--accent-soft);
  cursor: pointer;
  border-radius: var(--radius);
}

.split-main:hover {
  color: var(--accent-strong);
  background: color-mix(in srgb, var(--accent) 22%, transparent);
}

/* Dock headers and empty cells are denser than the toolbar, and the tint would
   make a small "+" shout inside a cell. */
.split.compact .split-main {
  width: 22px;
  color: var(--text-secondary);
  background: transparent;
}

.split.compact .split-main:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 7%, transparent);
}

.split.compact {
  height: 20px;
}

.open-panel {
  position: fixed;
  z-index: 71;
  /* The panel waits for the stage to be parked (about 100ms) before it renders,
     so it arrives complete. A short fade turns that wait into an opening
     animation instead of a pause. */
  animation: panel-in 120ms ease-out;
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
