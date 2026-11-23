<script setup lang="ts">
import type { LoginField } from "@shared/types";
import { Plus, X } from "lucide-vue-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import HintIcon from "./ui/HintIcon.vue";
import IconButton from "./ui/IconButton.vue";
import TextField from "./ui/TextField.vue";

const props = defineProps<{
  modelValue: LoginField[] | undefined;
  /** Explains where the value comes from when rows are inherited. */
  scopeHint?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: LoginField[]];
}>();

const { t } = useI18n();

const rows = computed({
  get: () => props.modelValue ?? [],
  set: (next: LoginField[]) => emit("update:modelValue", next),
});

function addRow() {
  rows.value = [...rows.value, { label: "", value: "" }];
}

function update(index: number, patch: Partial<LoginField>) {
  rows.value = rows.value.map((row, position) => (position === index ? { ...row, ...patch } : row));
}

function removeRow(index: number) {
  rows.value = rows.value.filter((_, position) => position !== index);
}

/**
 * One hover explanation for the whole field: what a field name matches on the
 * page, and whose values these are. Both sentences answer the same question —
 * "what do I put here" — so they travel together.
 */
const hintText = computed(() => {
  const scope = props.scopeHint;
  return scope ? `${t("app.extraFieldsHint")} ${scope}` : t("app.extraFieldsHint");
});
</script>

<template>
  <div class="extra-fields">
    <div class="extra-head">
      <span class="label">{{ $t("app.extraFieldsTitle") }}</span>
      <HintIcon :text="hintText" />
    </div>

    <div v-for="(row, index) in rows" :key="index" class="row">
      <TextField
        mono
        :model-value="row.label"
        :disabled="disabled"
        :placeholder="$t('app.fieldNamePlaceholder')"
        @update:model-value="update(index, { label: $event })"
      />
      <TextField
        mono
        :model-value="row.value"
        :disabled="disabled"
        :placeholder="$t('app.fieldValuePlaceholder')"
        @update:model-value="update(index, { value: $event })"
      />
      <IconButton
        v-if="!disabled"
        size="sm"
        :ariaLabel="$t('app.removeField')"
        @click="removeRow(index)"
      >
        <X :size="12" />
      </IconButton>
    </div>

    <button v-if="!disabled" type="button" class="add" data-add-field @click="addRow">
      <Plus :size="11" />
      {{ $t("app.addField") }}
    </button>
  </div>
</template>

<style scoped>
.extra-fields {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.extra-head {
  display: flex;
  align-items: center;
  gap: 5px;
}

.label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 7px;
  align-items: center;
}

/*
 * The add row is a real button, not a link in the corner: a dashed outline the
 * width of the field reads as "there is room for another row here", which is
 * the one thing a bare "+ 添加字段" next to the caption never said loudly
 * enough.
 */
.add {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  align-self: flex-start;
  padding: 4px 10px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11px;
}

.add:hover {
  color: var(--text);
  border-color: color-mix(in srgb, var(--text) 30%, var(--line));
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
</style>
