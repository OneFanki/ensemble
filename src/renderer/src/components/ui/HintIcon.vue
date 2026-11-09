<script setup lang="ts">
/**
 * A paragraph of explanation, behind an info glyph.
 *
 * The interface rule this serves: a label says what a control is, and anything
 * longer lives on hover. A hint here is still written carefully — it appears
 * exactly when someone is unsure, which is the moment it has to be accurate.
 *
 * `tabindex` and `aria-label` make it reachable without a pointer: the text is
 * the accessible name, so a screen reader reads the explanation itself rather
 * than "info icon".
 */
import { Info } from "lucide-vue-next";

defineProps<{ text: string; placement?: "top" | "bottom" }>();
</script>

<template>
  <span
    class="hint-icon"
    role="note"
    tabindex="0"
    :aria-label="text"
    v-tooltip="{ text, placement: placement ?? 'bottom' }"
  >
    <Info :size="12" />
  </span>
</template>

<style scoped>
.hint-icon {
  display: inline-flex;
  align-items: center;
  color: var(--faint);
  cursor: help;
  flex: 0 0 auto;
  border-radius: 50%;
  vertical-align: -2px;
}

.hint-icon:hover,
.hint-icon:focus-visible {
  color: var(--muted);
  outline: none;
}
</style>
