<script setup lang="ts">
import { onClickOutside } from "@vueuse/core";
import { ChevronDown, Plus } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import SiteOpenMenu from "./SiteOpenMenu.vue";

/**
 * The "+", in two halves with two answers.
 *
 * The main half is the blank answer: one click opens a blank page in the
 * default profile — the app's own new-tab surface, no site navigated, no
 * account question asked. Every other "+" in a browser works this way, and
 * asking "as whom?" before showing any page turned "just open something empty"
 * into a trip through an account chooser that had already pre-picked a site.
 *
 * The arrow half is the account answer: it opens the chooser to pick an account
 * (opened at its start page and filled), a site's default-profile or throwaway
 * opening, or a blank browser in a named profile. The chooser is the secondary
 * door — reached only on purpose — because a page here usually belongs to an
 * account, and which account decides the session partition.
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
  /** A blank browser in one profile was asked for by name. */
  openProfile: [profileId: string];
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

/** The main half opens a blank page; the arrow is what opens the chooser. */
const blankLabel = computed(() => t("app.browserNewBlank"));
const label = computed(() =>
  props.lockedSiteId ? t("app.browserAddTab") : t("app.browserOpenAs"),
);
/** The blank page needs a cookie jar: the user's default profile. */
const defaultProfileId = computed(() => store.settings.defaultProfileId);
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
  const trigger = root.value?.querySelector<HTMLElement>(".split-arrow");
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

function chooseProfile(profileId: string): void {
  open.value = false;
  emit("openProfile", profileId);
}

/**
 * The main half: a blank page, straight away.
 *
 * The chooser never opens on this path — no panel, no pre-picked site — which
 * is the whole point of the split. Reusing `openProfile` with the default
 * profile keeps one code path per landing spot: the container's existing
 * `@open-profile` wiring already knows whether the page belongs in its view,
 * the flat strip or on stage.
 */
function openBlank(): void {
  open.value = false;
  emit("openProfile", defaultProfileId.value);
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
      :aria-label="blankLabel"
      v-tooltip="blankLabel"
      @click.stop="openBlank"
    >
      <Plus :size="compact ? 11 : 14" />
    </button>
    <button
      type="button"
      class="split-arrow"
      :aria-label="label"
      :aria-expanded="open"
      :aria-haspopup="true"
      v-tooltip="label"
      @click.stop="toggle"
    >
      <ChevronDown :size="compact ? 10 : 12" />
    </button>
  </span>

  <Teleport to="body">
    <div v-if="open" ref="panel" class="open-panel" :style="panelStyle">
      <SiteOpenMenu
        :sites="store.sites"
        :identities="store.identities"
        :profiles="store.settings.profiles ?? []"
        :default-profile-id="store.settings.defaultProfileId"
        :locked-site-id="effectiveLock"
        @open-profile="chooseProfile"
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
 * A plain toolbar button.
 *
 * It used to be tinted amber to distinguish it from the tab strip's own "+".
 * Two amber-filled controls above the page pull the eye away from the page, and
 * "this one asks who to open as" is already carried by its position and its
 * tooltip — the size and the place distinguish it, not a second accent.
 */
.split-main {
  display: grid;
  place-items: center;
  width: 32px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  border-radius: var(--radius);
}

.split-main:hover,
.split-arrow:hover {
  color: var(--text);
  background: color-mix(in srgb, var(--text) 7%, transparent);
}

/*
 * The arrow half. Narrow, divided from the main half by a hairline: two
 * answers to one "+" — blank now, or asked as whom — that still read as a
 * single control in the toolbar.
 */
.split-arrow {
  display: grid;
  place-items: center;
  width: 18px;
  color: var(--text-secondary);
  background: transparent;
  cursor: pointer;
  border-left: 1px solid var(--line-soft);
}

/* Dock headers and empty cells are denser than the toolbar. */
.split.compact .split-main {
  width: 22px;
  color: var(--text-secondary);
  background: transparent;
}

.split.compact .split-arrow {
  width: 14px;
  color: var(--text-secondary);
  background: transparent;
}

.split.compact .split-main:hover,
.split.compact .split-arrow:hover {
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
     so it arrives complete. A base-length fade-and-lift turns that wait into an
     opening animation instead of a pause; at the fast token it read as a snap. */
  animation: panel-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}
</style>
