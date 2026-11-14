<script setup lang="ts">
/**
 * The one single-line text input.
 *
 * Every dialog used to write `<input class="input">` and then redefine
 * `.input` in its own `scoped` block. Twenty of those blocks existed, and they
 * had drifted: the device panel's was 26px tall, the canonical one 30px; padding
 * ranged over 6/7/9px. The drift was invisible in any single screen and obvious
 * the moment two of them were compared.
 *
 * Attributes fall through to the `<input>`, so `type`, `placeholder`,
 * `maxlength`, `inputmode`, `autocomplete` and `data-*` all work without being
 * declared here. `v-model` works the same way, through `modelValue`.
 *
 * `mono` is a prop rather than a class because it is not a one-off: a path, a
 * URL, a port and a token are technical data and are set in the mono face
 * wherever they appear, which is a rule with a reason (the CJK fallback in a
 * proportional font makes `l` and `1` indistinguishable at 11px).
 */
import { ref } from "vue";

withDefaults(
  defineProps<{
    modelValue?: string | number;
    /** Technical data: paths, URLs, ports, tokens. */
    mono?: boolean;
  }>(),
  { mono: false },
);

defineEmits<{ "update:modelValue": [value: string] }>();

const input = ref<HTMLInputElement | null>(null);

/** Lets a dialog put the caret in the first field when it opens. */
defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <input
    ref="input"
    class="input"
    :class="{ mono }"
    :value="modelValue"
    @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
  />
</template>

<style scoped>
.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--text);
  outline: 0;
  /* A border that changes colour, not a ring that appears. The field keeps its
     footprint, so a focused dialog does not shift by a pixel — and one shared
     transition is what makes every field in the app settle at the same speed. */
  transition: border-color var(--motion-base) var(--ease-out);
}

.input:focus {
  border-color: var(--accent);
}

.input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>
