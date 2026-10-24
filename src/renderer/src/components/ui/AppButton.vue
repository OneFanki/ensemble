<script setup lang="ts">
/**
 * The one button in the app.
 *
 * Buttons used to be `<button class="btn primary">` with the styles copy-pasted
 * into each component's `scoped` block. A page that used the classes without
 * copying the styles rendered bare text — two pages shipped that way. Owning the
 * markup and the styles together makes that impossible.
 *
 * Extra attributes (`disabled`, `title`, `data-*`) and `class` fall through to
 * the root button, so page-specific tweaks stay possible without re-declaring
 * the base look.
 */
withDefaults(
  defineProps<{
    variant?: "default" | "primary" | "ghost" | "danger";
    size?: "md" | "sm";
  }>(),
  { variant: "default", size: "md" },
);
</script>

<template>
  <button type="button" class="btn" :class="[variant, size === 'sm' && 'sm']">
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
    background 0.14s ease,
    border-color 0.14s ease;
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
  color: var(--text);
}

.btn.primary {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

/* `.btn:hover` matches a primary button too; restate the gradient so it does
   not turn gray under the cursor. */
.btn.primary:hover:not(:disabled) {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.06);
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
</style>
