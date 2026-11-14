<script setup lang="ts">
/**
 * A checkbox and its wording, as one clickable row.
 *
 * `<label class="check">` was spelled out at eight call sites, each with its own
 * gap, font size and alignment, and one of them (`DevicePanel`) sat on the same
 * baseline as a number input only because of a hand-tuned `padding-bottom: 5px`.
 * The row owns that alignment now.
 *
 * The native input stays native. A custom-drawn checkbox would need its own
 * focus ring, its own disabled state and its own keyboard story, and none of
 * that buys anything here: the platform control is already correct in both
 * themes and at every DPI.
 */
withDefaults(
  defineProps<{
    modelValue?: boolean;
    disabled?: boolean;
  }>(),
  { disabled: false },
);

defineEmits<{ "update:modelValue": [value: boolean] }>();
</script>

<template>
  <label class="check" :class="{ disabled }">
    <input
      type="checkbox"
      :checked="modelValue"
      :disabled="disabled"
      @change="$emit('update:modelValue', ($event.target as HTMLInputElement).checked)"
    />
    <span><slot /></span>
  </label>
</template>

<style scoped>
.check {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
}

.check.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.check input {
  margin: 0;
  flex: 0 0 auto;
  accent-color: var(--accent);
}
</style>
