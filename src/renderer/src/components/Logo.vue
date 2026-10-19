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
    <defs>
      <linearGradient :id="`ens-logo-${size}`" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#f0bd6f" />
        <stop offset="1" stop-color="#cf8c33" />
      </linearGradient>
    </defs>
    <rect width="32" height="32" rx="8" :fill="`url(#ens-logo-${size})`" />
    <rect x="6.5" y="8.4" width="19" height="3.8" rx="1.9" fill="#1a1305" />
    <rect x="6.5" y="14.2" width="13.5" height="3.8" rx="1.9" fill="#1a1305" />
    <rect x="6.5" y="20" width="8" height="3.8" rx="1.9" fill="#1a1305" />
    <circle cx="21.6" cy="21.9" r="2.9" fill="#1a1305" />
  </svg>
</template>

<style scoped>
.logo {
  display: block;
  flex: 0 0 auto;
  border-radius: 6px;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
}
</style>
