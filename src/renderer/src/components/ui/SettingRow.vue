<script setup lang="ts">
/**
 * One setting: a name on the left, its control on the right.
 *
 * The name is the whole visible label. Anything that explains the setting goes
 * in `hint`, which renders as an info glyph and only appears on hover — a column
 * of paragraph-length hints is what made this page read as documentation instead
 * of a settings screen.
 *
 * A hint is still worth writing when the setting's effect is not obvious from
 * its name (a zoom that a per-page override beats, a proxy that only applies
 * after a restart). It just does not deserve permanent space beside the control.
 */
import HintIcon from "./HintIcon.vue";

defineProps<{
  label: string;
  /** Shown on hover/focus beside the label; omitted when the name says it all. */
  hint?: string;
}>();
</script>

<template>
  <div class="setting-row">
    <span class="setting-label">
      <span class="setting-name">{{ label }}</span>
      <HintIcon v-if="hint" :text="hint" />
    </span>
    <div class="setting-control">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.setting-row {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
  padding: 10px 0;
  border-top: 1px solid var(--line-soft);
}

/* The first row follows the card's own heading, which already separates it. */
.setting-row:first-of-type {
  border-top: 0;
  padding-top: 4px;
}

/*
 * The label column is sized by its own text, not fixed.
 *
 * A fixed 132px put every control at the same x, which read well until a label
 * outgrew it: "默认档案里允许 AI 操作的来源" was cut to an ellipsis with no way to
 * see the rest. A minimum keeps the controls roughly aligned, and the max keeps
 * one long label from pushing the control off the card.
 */
.setting-label {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 1 auto;
  min-width: 112px;
  max-width: 46%;
  font-size: var(--fs-sm);
  color: var(--text-secondary);
}

.setting-name {
  min-width: 0;
  overflow-wrap: anywhere;
}

.setting-control {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1 1 auto;
}
</style>
