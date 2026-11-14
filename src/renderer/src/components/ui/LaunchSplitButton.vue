<script setup lang="ts">
/**
 * "Launch this, in which browser?"
 *
 * A split control: the left half runs the everyday path (the built-in surface) in
 * one click, the right half opens the browser list. This replaced a global
 * "launch target" switch in the app menu, which had two problems that only showed
 * up in use: every button said "启动" while the surface it would use lived in
 * another menu, and that surface was sticky — a mode set on Monday silently
 * decided Tuesday's fidelity check. A choice belongs at the moment of choosing.
 *
 * The built-in row is first and is also what the plain click does, because that
 * is the surface the app exists for: side-by-side accounts in one window. The
 * external rows are the fidelity check — a real browser, real extensions, real
 * enterprise policy — and they are listed by name because that is the whole
 * question a fidelity check asks.
 *
 * Blocked engines stay in the list, disabled, with their reason. Hiding them
 * would make "I know Firefox is installed" and "the app lists no Firefox" a
 * contradiction the user cannot resolve from here.
 */
import { onClickOutside } from "@vueuse/core";
import { AppWindow, ChevronDown, Monitor, Square } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../../stores/workspace";
import { useAnchoredPanel } from "../../composables/anchoredPanel";

const props = withDefaults(
  defineProps<{
    /**
     * Label on the main half. Omitted for an icon-only control, which is what
     * the denser pages (profiles, run dock) use.
     */
    label?: string;
    /** Busy state: the main half is disabled while a launch is in flight. */
    disabled?: boolean;
    /**
     * The action is currently "stop". Draws the stop glyph on the main half —
     * the label already says which action it is, and the glyph is what makes a
     * toggle read as one control rather than two states of a label.
     */
    busy?: boolean;
    /**
     * Dense variant for table rows: icon-only, 20px, and the panel drops the
     * version line so it stays a menu rather than a table.
     */
    compact?: boolean;
    /**
     * Filled accent, for when launching is the bar's own primary action (the
     * batch selection bar). Everywhere else the control stays quiet: a launch
     * button on every row of a grid would be six accents competing.
     */
    primary?: boolean;
    /** Accessible name for the main half, when `label` is not shown. */
    ariaLabel?: string;
    /** Stable hook for tests; the panel rows use `<hook>-engine`. */
    dataHook?: string;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  /** Run the everyday path: the built-in surface. */
  launch: [];
  /** Run in one external browser. */
  launchExternal: [engineId: string];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});

/*
 * Engines worth offering.
 *
 * Everything the scan found, in the app's own order: the blocked ones stay with
 * their reason attached, because "it is installed but this build cannot drive it"
 * is information the user needs and cannot get anywhere else on this page.
 */
const engines = computed(() => store.engines);

onClickOutside(root, (event) => {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-floating-panel]")) return;
  open.value = false;
});

// Shared placement: teleports to the body and flips above the trigger when there
// is no room below. The dock's own rows sit near the bottom of the window often
// enough that this is not an edge case.
useAnchoredPanel({
  open,
  anchor: () => root.value?.querySelector<HTMLElement>(".launch-main"),
  panel,
  style: panelStyle,
  minWidth: 220,
});

function runEmbedded(): void {
  if (props.disabled) return;
  emit("launch");
}

function toggle(): void {
  if (props.disabled) return;
  open.value = !open.value;
}

function chooseExternal(engineId: string): void {
  open.value = false;
  emit("launchExternal", engineId);
}
</script>

<template>
  <span ref="root" class="launch-split" :class="{ compact, primary }">
    <button
      type="button"
      class="launch-main"
      :disabled="disabled"
      :aria-label="ariaLabel ?? label ?? t('app.launchTargetEmbedded')"
      v-tooltip="compact ? (ariaLabel ?? label ?? t('app.launchTargetEmbedded')) : undefined"
      :data-launch-main="dataHook"
      @click.stop="runEmbedded"
    >
      <Square v-if="busy" :size="compact ? 9 : 11" />
      <Monitor v-else :size="compact ? 11 : 12" />
      <span v-if="label" class="launch-label">{{ label }}</span>
    </button>
    <button
      type="button"
      class="launch-arrow"
      :disabled="disabled"
      :aria-label="t('app.launchPickBrowser')"
      v-tooltip="t('app.launchPickBrowser')"
      :aria-expanded="open"
      aria-haspopup="menu"
      :data-launch-menu="dataHook"
      @click.stop="toggle"
    >
      <ChevronDown :size="compact ? 9 : 10" :class="{ flip: open }" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="launch-panel"
        :style="panelStyle"
        role="menu"
        data-floating-panel
        :data-launch-panel="dataHook"
      >
        <button
          type="button"
          role="menuitem"
          class="row"
          :data-engine="`embedded`"
          @click.stop="
            open = false;
            runEmbedded();
          "
        >
          <Monitor :size="12" class="row-icon" />
          <span class="row-name">{{ t("app.launchTargetEmbedded") }}</span>
        </button>

        <!--
          The external browsers.

          One line each: the name, and nothing else. The version was there to
          help tell two builds apart and answered a question nobody asks at this
          moment — which browser to open, not which build of it. A blocked engine
          keeps its reason because that one is not a detail: without it the row
          looks like a browser the app refuses to use for no reason.
        -->
        <div v-if="engines.length" class="rule" role="separator"></div>
        <button
          v-for="engine in engines"
          :key="engine.id"
          type="button"
          role="menuitem"
          class="row"
          :disabled="engine.status === 'blocked'"
          :data-engine="engine.id"
          @click.stop="chooseExternal(engine.id)"
        >
          <AppWindow :size="12" class="row-icon" />
          <span class="row-name">{{ engine.brand }}</span>
          <span v-if="engine.status === 'blocked'" class="row-note">
            {{ engine.blockReason ?? t("app.engineBlockedSuffix") }}
          </span>
        </button>
      </div>
    </Teleport>
  </span>
</template>

<style scoped>
/*
 * One rounded box, two hit areas, a hairline between them. The split has to read
 * as one control: two separate buttons side by side would say "a button and a
 * menu", which is what it used to be, and the whole point is that they are one
 * decision with two levels of specificity.
 *
 * Transparent fill, hairline outline. `--surface-2` is a *recessed* step — it is
 * darker than a card in the dark theme and greyer than one in the light theme —
 * so filling the control with it drew a black hole in the middle of a card. The
 * control sits at the card's own level and is separated by its outline, which is
 * also how every other small control on these cards behaves.
 */
.launch-split {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: transparent;
  overflow: hidden;
  flex: 0 0 auto;
}

.launch-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 0 9px;
  height: 26px;
  font-size: 11.5px;
  color: var(--muted);
  background: transparent;
  border: 0;
  white-space: nowrap;
}

.launch-main:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text);
}

/* The arrow is a separate target but never a separate box: no border of its own,
   and narrower than a full button so the pair reads as one shape. */
.launch-arrow {
  display: grid;
  place-items: center;
  width: 20px;
  height: 26px;
  border: 0;
  border-left: 1px solid var(--line);
  background: transparent;
  color: var(--faint);
}

.launch-arrow:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.launch-split:has(.launch-main:disabled) {
  opacity: 0.5;
}

/*
 * The primary variant keeps the same shape and takes the action fill, so the
 * batch bar's main action stays the loudest thing in its row while still
 * offering the browser list.
 */
.launch-split.primary {
  border-color: transparent;
  background: var(--action);
}

.launch-split.primary .launch-main {
  color: var(--action-foreground);
  font-weight: 500;
}

.launch-split.primary .launch-main:hover:not(:disabled) {
  background: var(--action-hover);
}

.launch-split.primary .launch-arrow {
  color: color-mix(in srgb, var(--action-foreground) 65%, transparent);
  border-left-color: color-mix(in srgb, #000 16%, transparent);
}

.launch-split.primary .launch-arrow:hover:not(:disabled) {
  background: var(--action-hover);
  color: var(--action-foreground);
}

.launch-main:disabled,
.launch-arrow:disabled {
  cursor: not-allowed;
}

.flip {
  transform: rotate(180deg);
}

/* Dense: what a table row can afford. Same two halves, half the height.
   The icon half is a square so the glyph sits centred rather than in a letterbox
   — an icon-only control padded like a labelled one reads as a button with its
   text missing, which is exactly how it looked. */
.launch-split.compact {
  border-radius: var(--radius-sm);
}

.launch-split.compact .launch-main {
  padding: 0;
  width: 22px;
  height: 20px;
  justify-content: center;
}

.launch-split.compact .launch-arrow {
  width: 15px;
  height: 20px;
}

.launch-panel {
  position: fixed;
  pointer-events: auto;
  z-index: 90;
  min-width: 220px;
  max-height: 320px;
  overflow-y: auto;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: launch-panel-in var(--motion-base) var(--ease-out);
  transform-origin: top left;
}

@keyframes launch-panel-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 7px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.row:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.row:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.row-icon {
  flex: 0 0 auto;
  color: var(--faint);
}

/* One line per row, so the name takes the space and ellipses rather than
   wrapping. A blocked engine's reason sits after it, quiet — it is the one note
   that earns a place here. */
.row-name {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-note {
  margin-left: auto;
  flex: 0 1 auto;
  min-width: 0;
  font-size: 9.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rule {
  height: 1px;
  margin: 4px 6px;
  background: var(--line-soft);
}
</style>
