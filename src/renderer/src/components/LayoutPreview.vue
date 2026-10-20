<script setup lang="ts">
import type { LayoutPreset } from "@shared/types";

defineProps<{ preset: LayoutPreset; height?: string }>();

function slotStyle(index: number, slot: { x: number; y: number; width: number; height: number }) {
  return {
    left: `${slot.x * 100}%`,
    top: `${slot.y * 100}%`,
    width: `${slot.width * 100}%`,
    height: `${slot.height * 100}%`,
    zIndex: index + 1,
  };
}
</script>

<template>
  <div class="preview" :style="{ height: height ?? '120px' }">
    <template v-if="!preset.slots.length">
      <div class="free-note">{{ $t("app.freeLayoutPreview") }}</div>
    </template>
    <template v-else>
      <div
        v-for="(slot, index) in preset.slots"
        :key="index"
        class="cell"
        :style="slotStyle(index, slot)"
      >
        <slot name="slot" :index="index" :slot="slot">
          <span class="num mono">{{ index + 1 }}</span>
        </slot>
      </div>
    </template>
  </div>
</template>

<style scoped>
.preview {
  position: relative;
  width: 100%;
  border: 1px solid var(--line-soft);
  border-radius: 0;
  background: var(--bg-elevated);
  overflow: hidden;
}

.cell {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--line) 80%, transparent);
  background: color-mix(in srgb, var(--surface-2) 70%, transparent);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 7px;
  font-size: 10px;
  color: var(--faint);
  overflow: hidden;
  white-space: nowrap;
}

.num {
  color: var(--faint);
  font-size: 9.5px;
}

.free-note {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 10px;
  text-align: center;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--faint);
}
</style>
