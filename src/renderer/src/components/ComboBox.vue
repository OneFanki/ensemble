<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { ChevronDown } from "lucide-vue-next";
import { onClickOutside } from "@vueuse/core";

/**
 * Free-text input with suggestions.
 *
 * The role is a label the user chooses, not a fixed enum: teams name their
 * accounts differently ("管理员", "审核", "readonly"…), so typing must stay
 * possible. The suggestions only remove the need to remember spelling.
 */
const props = defineProps<{
  modelValue: string;
  suggestions: string[];
  placeholder?: string;
  /** Read-only mode, used when a field is synced from a reference. */
  disabled?: boolean;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const input = ref<HTMLInputElement | null>(null);

// The panel is teleported out of the input, so it needs its own listener.
onClickOutside(root, () => {
  open.value = false;
});
onClickOutside(panel, () => {
  open.value = false;
});

const filtered = computed(() => {
  const term = props.modelValue.trim().toLowerCase();
  const all = props.suggestions.filter((item) => item.trim().length > 0);
  if (!term) return all;
  // Keep every suggestion when the value already is one of them, so the list
  // does not collapse to a single row the moment a suggestion is chosen.
  if (all.some((item) => item.toLowerCase() === term)) return all;
  const matches = all.filter((item) => item.toLowerCase().includes(term));
  return matches.length > 0 ? matches : all;
});

/** Teleported for the same reason as SelectField: dialog bodies clip overflow. */
function placePanel() {
  const anchor = root.value;
  if (!anchor) return;
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  panelStyle.value = { left: `${rect.left}px`, top: `${rect.bottom + 4}px`, width: `${rect.width}px` };
  void nextTick(() => {
    const height = panel.value?.offsetHeight ?? 0;
    if (!height) return;
    const below = window.innerHeight - rect.bottom - margin;
    if (height > below && rect.top - margin > below) {
      panelStyle.value = { left: `${rect.left}px`, top: `${rect.top - 4 - height}px`, width: `${rect.width}px` };
    }
  });
}

function onViewportChange() {
  if (open.value) placePanel();
}

watch(open, (value) => {
  if (value) {
    placePanel();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
  } else {
    window.removeEventListener("resize", onViewportChange);
    window.removeEventListener("scroll", onViewportChange, true);
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
});

function choose(value: string) {
  emit("update:modelValue", value);
  open.value = false;
  input.value?.focus();
}

function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
  open.value = true;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    open.value = false;
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    open.value = true;
  }
  if (event.key === "Enter" && open.value) {
    // Enter takes the first suggestion instead of submitting the whole dialog.
    const first = filtered.value[0];
    if (first) {
      event.preventDefault();
      choose(first);
    }
  }
}
</script>

<template>
  <div ref="root" class="combo">
    <div class="combo-input">
      <input
        ref="input"
        class="input"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled"
        autocomplete="off"
        role="combobox"
        :aria-expanded="open"
        @input="onInput"
        @focus="!disabled && (open = true)"
        @keydown="onKeydown"
      />
      <button
        v-if="!disabled"
        type="button"
        class="chevron-btn"
        :aria-label="$t('app.roleSuggestions')"
        @click="open = !open; input?.focus()"
      >
        <ChevronDown :size="12" class="chevron" :class="{ flip: open }" />
      </button>
    </div>

    <Teleport to="body">
      <div v-if="open && filtered.length" ref="panel" class="combo-panel" :style="panelStyle" role="listbox">
        <button
          v-for="item in filtered"
          :key="item"
          type="button"
          role="option"
          class="option"
          :aria-selected="item === modelValue"
          @mousedown.prevent="choose(item)"
        >
          {{ item }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.combo {
  position: relative;
}

.combo-input {
  position: relative;
}

.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 26px 7px 9px;
  font-size: 11.5px;
  color: var(--text);
  outline: 0;
}

.input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.chevron-btn {
  position: absolute;
  right: 3px;
  top: 50%;
  transform: translateY(-50%);
  width: 20px;
  height: 20px;
  display: grid;
  place-items: center;
  border-radius: 4px;
  color: var(--faint);
}

.chevron-btn:hover {
  color: var(--text-secondary);
}

.chevron {
  transition: transform 0.15s ease;
}

.chevron.flip {
  transform: rotate(180deg);
}

.combo-panel {
  position: fixed;
  z-index: 90;
  max-height: 180px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 14px 34px rgb(0 0 0 / 45%);
  padding: 4px;
}

.option {
  display: block;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  color: var(--muted);
  text-align: left;
}

.option:hover {
  background: var(--surface-2);
  color: var(--text);
}

.option[aria-selected="true"] {
  color: var(--accent);
}
</style>
