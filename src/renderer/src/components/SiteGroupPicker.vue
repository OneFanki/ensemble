<script setup lang="ts">
import type { SiteGroup } from "@shared/types";
import { useI18n } from "vue-i18n";

/**
 * Multi-select chips for site groups.
 *
 * A site can be filed under more than one group, so this is a toggle list rather
 * than a dropdown: the answer is "which of these apply", and seeing every group
 * at once is the only way to answer that without opening something.
 */
const props = defineProps<{
  modelValue: string[] | undefined;
  groups: SiteGroup[];
  /** Shown when the user has not created any groups yet. */
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
  <div class="group-picker">
    <button
      v-for="group in groups"
      :key="group.id"
      type="button"
      class="group-toggle"
      :class="{ on: modelValue?.includes(group.id) }"
      :style="{ '--tag': `var(--role-${group.color})` }"
      :aria-pressed="Boolean(modelValue?.includes(group.id))"
      @click="toggle(group.id)"
    >
      <span class="group-dot"></span>
      {{ group.name }}
    </button>
    <span v-if="!groups.length" class="group-empty">{{ emptyHint ?? t("app.siteGroupsNone") }}</span>
  </div>
</template>

<style scoped>
.group-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.group-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  padding: 3px 8px;
  font-size: 10.5px;
  color: var(--faint);
  background: transparent;
  transition: border-color var(--motion-base) var(--ease-out), color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out);
}

.group-toggle:hover {
  color: var(--text-secondary);
  border-color: var(--line);
}

.group-toggle.on {
  border-color: color-mix(in srgb, var(--tag) 52%, var(--line));
  background: color-mix(in srgb, var(--tag) 10%, transparent);
  color: color-mix(in srgb, var(--tag) 78%, var(--text));
}

.group-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--tag);
  opacity: 0.72;
}

.group-toggle.on .group-dot {
  opacity: 1;
}

.group-empty {
  font-size: 10.5px;
  color: var(--faint);
}
</style>
