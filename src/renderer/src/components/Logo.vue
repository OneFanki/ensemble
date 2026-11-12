<script setup lang="ts">
withDefaults(defineProps<{ size?: number; label?: string }>(), {
  size: 22,
  label: "Ensemble",
});
</script>

<template>
  <!--
    The same deck as scripts/make-icon.mjs: two recessed frames behind, one
    filled card in front.

    No plate behind the mark in the interface.

    The application icon keeps its dark plate — it sits among other icons on a
    taskbar or dock, and the dark square is what makes it hold its ground there.
    In the interface the plate has the opposite effect: it is a black sticker
    pasted onto a white page, and it fights the wordmark beside it instead of
    belonging to it. Dropping the plate also lets the two back frames carry the
    depth they were drawn for, which the dark plate used to flatten.

    The frames are drawn in greys that invert with the theme, so the stack keeps
    receding on either surface. Only the front card stays gold in both: that is
    the mark.
  -->
  <svg
    class="logo"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    role="img"
    :aria-label="label"
  >
    <rect
      x="4.5"
      y="3.5"
      width="15"
      height="11"
      rx="2.2"
      fill="none"
      stroke="var(--logo-back, #c9d1d9)"
      stroke-width="1.7"
    />
    <rect
      x="7.5"
      y="6.8"
      width="15"
      height="11"
      rx="2.2"
      fill="none"
      stroke="var(--logo-mid, #8a939e)"
      stroke-width="1.7"
    />
    <rect x="10.5" y="10.2" width="15" height="11.5" rx="2.2" fill="var(--logo-card, #e0a44e)" />
    <rect
      x="13.2"
      y="13.2"
      width="6"
      height="2"
      rx="1"
      fill="var(--logo-glyph, #1a1206)"
    />
    <circle cx="21" cy="16.6" r="1.5" fill="var(--logo-glyph, #1a1206)" />
  </svg>
</template>

<style scoped>
.logo {
  display: block;
  flex: 0 0 auto;
  border-radius: 5px;
}
</style>
