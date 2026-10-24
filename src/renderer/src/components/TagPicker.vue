<script setup lang="ts">
import type { Tag } from "@shared/types";
import { useI18n } from "vue-i18n";

/**
 * Multi-select chips for the shared tag namespace.
 *
 * Sites, identities and views all use the same tags, so one control keeps the
 * interaction identical everywhere and the colours mean the same thing.
 */
const props = defineProps<{
  modelValue: string[] | undefined;
  tags: Tag[];
  /** Shown when the user has not created any tags yet. */
  emptyHint?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();
const { t } = useI18n();

function toggle(id: string): void {
  const current = props.modelValue ?? [];
  const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id];
  emit("update:modelValue", next);
}
</script>

<template>
  <div class="tag-picker">
    <button
      v-for="tag in tags"
      :key="tag.id"
      type="button"
      class="tag-toggle"
      :class="{ on: modelValue?.includes(tag.id) }"
      :style="{ '--tag': `var(--role-${tag.color})` }"
      :aria-pressed="Boolean(modelValue?.includes(tag.id))"
      @click="toggle(tag.id)"
    >
      <span class="tag-dot"></span>
      {{ tag.name }}
    </button>
    <span v-if="!tags.length" class="tag-empty">{{ emptyHint ?? t("app.tagsNone") }}</span>
  </div>
</template>

<style scoped>
.tag-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.tag-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 10.5px;
  color: var(--faint);
  background: transparent;
  transition: border-color 0.14s ease, color 0.14s ease, background 0.14s ease;
}

.tag-toggle:hover {
  color: var(--text-secondary);
  border-color: var(--line);
}

.tag-toggle.on {
  border-color: color-mix(in srgb, var(--tag) 52%, var(--line));
  background: color-mix(in srgb, var(--tag) 10%, transparent);
  color: color-mix(in srgb, var(--tag) 78%, var(--text));
}

.tag-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tag);
  opacity: 0.72;
}

.tag-toggle.on .tag-dot {
  opacity: 1;
}

.tag-empty {
  font-size: 10.5px;
  color: var(--faint);
}
</style>
