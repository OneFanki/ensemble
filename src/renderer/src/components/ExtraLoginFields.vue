<script setup lang="ts">
import type { LoginField } from "@shared/types";
import { Plus, X } from "lucide-vue-next";
import { computed } from "vue";

const props = defineProps<{
  modelValue: LoginField[] | undefined;
  /** Explains where the value comes from when rows are inherited. */
  scopeHint?: string;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  "update:modelValue": [value: LoginField[]];
}>();

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
</script>

<template>
  <div class="extra-fields">
    <div class="extra-head">
      <span class="label">{{ $t("app.extraFieldsTitle") }}</span>
      <button v-if="!disabled" type="button" class="add" @click="addRow">
        <Plus :size="11" />
        {{ $t("app.addField") }}
      </button>
    </div>

    <div v-for="(row, index) in rows" :key="index" class="row">
      <input
        class="input mono"
        :value="row.label"
        :disabled="disabled"
        :placeholder="$t('app.fieldNamePlaceholder')"
        @input="update(index, { label: ($event.target as HTMLInputElement).value })"
      />
      <input
        class="input mono"
        :value="row.value"
        :disabled="disabled"
        :placeholder="$t('app.fieldValuePlaceholder')"
        @input="update(index, { value: ($event.target as HTMLInputElement).value })"
      />
      <button v-if="!disabled" type="button" class="del" :aria-label="$t('app.removeField')" @click="removeRow(index)">
        <X :size="12" />
      </button>
    </div>

    <p class="hint">
      {{ scopeHint ?? $t("app.extraFieldsHint") }}
    </p>
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
  justify-content: space-between;
}

.label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.add,
.del {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 11px;
}

.add:hover,
.del:hover {
  color: var(--text);
}

.row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 7px;
  align-items: center;
}

.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 6px 9px;
  font-size: 11px;
  color: var(--text);
  outline: 0;
}

.input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.del {
  width: 22px;
  height: 22px;
  justify-content: center;
  border-radius: 5px;
}

.del:hover {
  background: var(--surface-3);
}

.hint {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--faint);
}
</style>
