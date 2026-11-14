<script setup lang="ts">
/**
 * The one button in the app.
 *
 * Buttons used to be `<button class="btn primary">` with the styles copy-pasted
 * into each component's `scoped` block. A page that used the classes without
 * copying the styles rendered bare text — two pages shipped that way. Owning the
 * markup and the styles together makes that impossible.
 *
 * `type` is a prop, not a fall-through attribute.
 *
 * It used to be pinned to `"button"` on the root, so a caller who wrote
 * `type="submit"` got a submit button only because Vue's fall-through overwrote
 * the static attribute — behaviour nobody had verified, and which one dialog's
 * comment correctly guessed the opposite of. A button inside a form with no
 * `type` submits it, which is the one default that can fire a request the caller
 * did not intend; saying `type="button"` explicitly is the safe default and
 * making it a prop is what lets a form's own submit button opt in.
 *
 * Extra attributes (`disabled`, `title`, `data-*`) and `class` fall through to
 * the root button, so page-specific tweaks stay possible without re-declaring
 * the base look.
 */
withDefaults(
  defineProps<{
    variant?: "default" | "primary" | "ghost" | "danger";
    size?: "md" | "sm";
    type?: "button" | "submit";
    disabled?: boolean;
  }>(),
  { variant: "default", size: "md", type: "button" },
);
</script>

<template>
  <button :type="type" class="btn" :class="[variant, size === 'sm' && 'sm']" :disabled="disabled">
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 12px;
  white-space: nowrap;
  transition:
    background var(--motion-base) var(--ease-out),
    border-color var(--motion-base) var(--ease-out);
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
  color: var(--text);
}

/*
 * Flat: one colour, no bevel, no border.
 *
 * The border used to repeat the accent-text gold, which on a gold fill drew a
 * dark outline around every primary button — the one ring in the app. The fill
 * already separates itself from the page; a second colour around it only made
 * the shape look printed on.
 *
 * The colour comes from `--action`, not `--accent`: on light the most prominent
 * control has to be the darkest thing available, and gold is not. See the token
 * definitions.
 */
.btn.primary {
  background: var(--action);
  border: 0;
  color: var(--action-foreground);
  font-weight: 500;
}

/* `.btn:hover` matches a primary button too; restate the fill so it does not
   turn gray under the cursor. */
.btn.primary:hover:not(:disabled) {
  background: var(--action-hover);
  border: 0;
  color: var(--action-foreground);
}

.btn.ghost {
  background: transparent;
}

.btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 34%, var(--line));
}

.btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--red) 12%, transparent);
  border-color: color-mix(in srgb, var(--red) 45%, var(--line));
}

.btn.sm {
  padding: 5px 9px;
  font-size: 11.5px;
}

/*
 * A disabled control must not look like a dimmed copy of the enabled one.
 *
 * The global `opacity: 0.45` smears a filled accent button into the page and
 * leaves a pale tint — in the light theme it reads as a broken brand colour,
 * and in either theme it is easy to mistake for a hover state. Dropping the
 * fill instead makes "this is unavailable" structural rather than a shade:
 * same neutral surface as any other inert control, no accent, no weight.
 */
.btn:disabled {
  background: var(--surface-2);
  border-color: var(--line-soft);
  color: var(--faint);
  font-weight: 400;
  opacity: 1;
  cursor: not-allowed;
}
</style>
