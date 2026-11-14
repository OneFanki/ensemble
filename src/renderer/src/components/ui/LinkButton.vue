<script setup lang="ts">
/**
 * An inline text action: "add a row", "open the detail".
 *
 * It is a real `<button>` styled as a link, not an `<a>`: every one of its uses
 * changes state in place rather than navigating, and a button is what a screen
 * reader and the keyboard expect for that. `.link-btn` was a class applied to
 * plain `<button>` elements at four sites — each of them also re-declared the
 * colour, the size and the hover underline locally.
 */
withDefaults(defineProps<{ disabled?: boolean; type?: "button" | "submit" }>(), {
  disabled: false,
  type: "button",
});
</script>

<template>
  <button :type="type" class="link-btn" :disabled="disabled">
    <slot />
  </button>
</template>

<style scoped>
.link-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  color: var(--accent-text);
  font-size: 11.5px;
}

/* On light, `--accent-text` is a deep brown gold — chosen to read as text on
   white, and correct for a sentence. For a one-word action it reads as mud,
   because there is no surrounding paragraph to make it look deliberate. The
   stronger step is the same hue with more life, and only the action word is
   ever set in it. */
:root[data-theme="light"] .link-btn {
  color: var(--accent-strong);
}

.link-btn:hover:not(:disabled) {
  color: var(--accent-strong);
  text-decoration: underline;
}

.link-btn:disabled {
  color: var(--faint);
  cursor: not-allowed;
}
</style>
