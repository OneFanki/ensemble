<script setup lang="ts">
/**
 * An icon-only button.
 *
 * `ariaLabel` is required: an icon button with no accessible name is invisible
 * to a screen reader and unfindable in a test. `title` gives the same text as a
 * hover hint, so callers usually pass the same string twice — that is
 * deliberate, not redundant.
 */
withDefaults(
  defineProps<{
    ariaLabel: string;
    title?: string;
    variant?: "default" | "danger";
    size?: "md" | "sm";
    active?: boolean;
  }>(),
  { variant: "default", size: "md" },
);
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="[variant, `size-${size}`, { active }]"
    :aria-label="ariaLabel"
    :title="title ?? ariaLabel"
    :aria-pressed="active === undefined ? undefined : active"
  >
    <slot />
  </button>
</template>

<style scoped>
.icon-btn {
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
  /*
   * `--dim`, not `--faint`: these are affordances the user has to find, not
   * hairlines. At `--faint` they measured 3.05:1 against the card surface —
   * technically over the 3:1 floor for non-text, but in practice the edit and
   * delete icons on a site card read as decoration until the pointer happens to
   * cross them. `--dim` is 3.9:1 and still clearly quieter than body text.
   */
  color: var(--dim);
  flex: 0 0 auto;
}

.icon-btn.size-md {
  width: 24px;
  height: 24px;
}

.icon-btn.size-sm {
  width: 20px;
  height: 20px;
}

.icon-btn:hover:not(:disabled) {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.icon-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--red) 14%, transparent);
  color: var(--red);
}

.icon-btn.active {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
}
</style>
