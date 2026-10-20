<script setup lang="ts">
withDefaults(defineProps<{ size?: number; label?: string }>(), {
  size: 22,
  label: "Ensemble",
});
</script>

<template>
  <svg
    class="logo"
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    role="img"
    :aria-label="label"
  >
    <!--
      Same deck as scripts/make-icon.mjs: two recessed frames behind, one filled
      card in front. The plate is dark so the amber shape carries the identity;
      an amber plate with a dark glyph read as a generic placeholder.
    -->
    <rect width="32" height="32" rx="7.5" fill="#171b22" />
    <rect
      x="6.5"
      y="5.5"
      width="15"
      height="11"
      rx="2.2"
      fill="none"
      stroke="#8b7040"
      stroke-width="1.6"
    />
    <rect
      x="9.5"
      y="8.8"
      width="15"
      height="11"
      rx="2.2"
      fill="none"
      stroke="#b98544"
      stroke-width="1.6"
    />
    <rect x="12.5" y="12.2" width="15" height="11.5" rx="2.2" fill="#e0a44e" />
    <rect x="15.2" y="15.2" width="6" height="2" rx="1" fill="#0b0d10" />
    <circle cx="23" cy="18.6" r="1.5" fill="#0b0d10" />
  </svg>
</template>

<style scoped>
.logo {
  display: block;
  flex: 0 0 auto;
  border-radius: 5px;
}
</style>
