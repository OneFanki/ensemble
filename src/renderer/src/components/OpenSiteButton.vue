<script setup lang="ts">
import { onClickOutside } from "@vueuse/core";
import { ChevronDown, Plus } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import SiteOpenMenu from "./SiteOpenMenu.vue";

/**
 * "New tab" with a site list beside it.
 *
 * Browsers put bookmarks next to the address bar; here the bookmarks are sites.
 * The main button still does the obvious thing (a blank tab), and the chevron
 * opens a site — clean, or as one of its accounts.
 */
const props = defineProps<{
  /** Compact variant for headers and empty slots. */
  compact?: boolean;
}>();

const emit = defineEmits<{
  openBlank: [];
  openSite: [siteId: string];
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

// One handler for both parts. Two `onClickOutside` calls — one for the trigger,
// one for the panel — do not work here: the panel is teleported to `body`, so
// it is outside the trigger, and every click inside the panel closed it before
// the click could select a site.
onClickOutside(root, (event) => {
  const target = event.target as Node | null;
  if (target && panel.value?.contains(target)) return;
  open.value = false;
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") open.value = false;
}

const label = computed(() => t("app.browserNewTab"));
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
  void nextTick(() => {
    const trigger = root.value?.querySelector<HTMLElement>(".split-main");
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = 400;
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.right - width), window.innerWidth - width - margin);
    panelStyle.value = {
      left: `${left}px`,
      top: `${rect.bottom + 6}px`,
      width: `${width}px`,
    };
  });
}

function chooseSite(siteId: string): void {
  open.value = false;
  emit("openSite", siteId);
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
      @click="emit('openBlank')"
    >
      <Plus :size="compact ? 11 : 14" />
    </button>
    <button
      type="button"
      class="split-more"
      :title="t('app.openFromSite')"
      :aria-label="t('app.openFromSite')"
      :aria-expanded="open"
      @click="toggle"
    >
      <ChevronDown :size="compact ? 9 : 11" />
    </button>
  </span>

  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="open-panel"
      :style="panelStyle"
    >
      <SiteOpenMenu
        :sites="store.sites"
        :identities="store.identities"
        @open-site="chooseSite"
        @open-identity="chooseIdentity"
      />
    </div>
  </Teleport>
</template>

<style scoped>
.split {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  overflow: hidden;
  /* Level with the 30px toolbar controls: a shorter control reads as secondary,
     and "+" is the primary action on this row. */
  height: 30px;
}

.split-main,
.split-more {
  display: grid;
  place-items: center;
  color: var(--faint);
  background: transparent;
}

.split-main {
  width: 32px;
}

.split-more {
  width: 20px;
  border-left: 1px solid var(--line-soft);
}

.split-main:hover,
.split-more:hover {
  color: var(--text);
  background: var(--surface-2);
}

/* Dock headers and empty cells are denser than the toolbar. */
.split.compact {
  height: 20px;
  border-color: var(--line-soft);
}

.split.compact .split-main {
  width: 22px;
}

.split.compact .split-more {
  width: 15px;
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
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
