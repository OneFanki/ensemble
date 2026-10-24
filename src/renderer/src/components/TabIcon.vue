<script setup lang="ts">
/**
 * One page's icon, with the same neutral placeholder everywhere.
 *
 * A page that has not reported a favicon yet — still loading, about:blank, a site
 * without one — used to render as nothing, and the collapsed dock fell back to a
 * single letter. Both read as "this row lost its icon". A globe says "a page
 * lives here" in either theme and needs no font, so the fallback is the same
 * mark in every place a page is listed.
 *
 * The wrapper is a fixed-size box on purpose: an `<img>` and an inline `<svg>`
 * have different intrinsic boxes, so rows would jump by a pixel when a favicon
 * arrived. Both cases fill the same box instead.
 */
import { Globe } from "lucide-vue-next";
import { computed, ref, watch } from "vue";

const props = withDefaults(defineProps<{ src?: string; size?: number }>(), { size: 12 });

/** A stored icon can be a stale data URL; a broken image is worse than none. */
const failed = ref(false);
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);

const showImage = computed(() => Boolean(props.src) && !failed.value);
</script>

<template>
  <span class="tab-icon" :style="{ width: `${size}px`, height: `${size}px` }">
    <img v-if="showImage" :src="src" alt="" draggable="false" @error="failed = true" />
    <Globe v-else :size="Math.max(8, Math.round(size * 0.82))" />
  </span>
</template>

<style scoped>
.tab-icon {
  display: inline-grid;
  place-items: center;
  flex: none;
  border-radius: 3px;
  overflow: hidden;
}

.tab-icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

/* Inherits the row's tone, so a placeholder never looks louder than the title
   next to it. */
.tab-icon svg {
  color: currentColor;
  opacity: 0.75;
}
</style>
