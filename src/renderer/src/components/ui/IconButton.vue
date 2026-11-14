<script setup lang="ts">
/**
 * An icon-only button.
 *
 * `ariaLabel` is required: an icon button with no accessible name is invisible
 * to a screen reader and unfindable in a test. `title` gives the same text as a
 * hover hint and defaults to the label, so callers usually pass the same string
 * twice — that is deliberate, not redundant.
 *
 * The hint is drawn by the app (`v-tooltip`), not by the OS. A native `title`
 * waits about a second, uses the system font at the system scale, and appears
 * where the platform decides; on a toolbar of icon-only controls that reads as
 * something bolted on. `title` remains the prop name because that is what the
 * value means here — the text of the hint.
 *
 * ## Why `revealOnRow`
 *
 * The bookmark and folder rows show their actions only under the pointer: eight
 * permanent glyphs beside eight list rows turn the column into a wall of
 * controls, and every one of them is an edit or a delete. That is a property of
 * the *row*, not of the button, so it is a prop rather than a CSS override from
 * outside — the row opts in, and the hover/focus rule it needs lives with the
 * button that owns the transition.
 */
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    ariaLabel: string;
    title?: string;
    variant?: "default" | "danger";
    size?: "md" | "sm";
    active?: boolean;
    /** Declared rather than falling through: the root is a plain button, so the
     *  attribute would work anyway, but the type checker rejects unknown props
     *  on a component and every call site would need a cast. */
    disabled?: boolean;
    /** Hidden until the surrounding row is hovered, focused or contains focus. */
    revealOnRow?: boolean;
  }>(),
  { variant: "default", size: "md", revealOnRow: false },
);

const hint = computed(() => props.title ?? props.ariaLabel);
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="[variant, `size-${size}`, { active, reveal: revealOnRow }]"
    :aria-label="ariaLabel"
    :disabled="disabled"
    v-tooltip="hint"
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
  transition:
    opacity var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
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
  color: var(--accent-text);
}

/*
 * Revealed on row hover — and on keyboard focus, and while the focus is inside
 * it. A control that only exists under a mouse is unreachable by keyboard and
 * invisible to anyone who is not moving the pointer, so the rule cannot be
 * `:hover` alone.
 *
 * The row selectors are global because the row belongs to the page: this
 * component cannot know whether its host calls itself `.row` or `.tree-row`, and
 * `:deep()` from the page would reach into a component's internals — which is
 * exactly the coupling this pass is removing.
 */
.icon-btn.reveal {
  opacity: 0;
}

:global(.row:hover) .icon-btn.reveal,
:global(.tree-row:hover) .icon-btn.reveal,
:global(.row:focus-within) .icon-btn.reveal,
:global(.tree-row:focus-within) .icon-btn.reveal,
.icon-btn.reveal:focus-visible {
  opacity: 1;
}
</style>
