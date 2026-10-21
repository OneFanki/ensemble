<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";
import { onClickOutside } from "@vueuse/core";

export interface SelectOption {
  value: string;
  label: string;
  /** Shown under the label, e.g. a version or a URL. */
  hint?: string;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string | undefined;
  options: SelectOption[];
  /** Shown when nothing is selected. */
  placeholder?: string;
  ariaLabel?: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string | undefined] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);
const panel = ref<HTMLElement | null>(null);
const panelStyle = ref<Record<string, string>>({});
const activeIndex = ref(-1);

// The panel is teleported out of the trigger, so it needs its own listener.
onClickOutside(root, () => {
  open.value = false;
});
onClickOutside(panel, () => {
  open.value = false;
});

const selected = computed(() => props.options.find((item) => item.value === props.modelValue));

/**
 * The panel lives in a teleport because dialogs clip their body with
 * `overflow-y: auto`; an absolutely positioned list would be cut off.
 */
function placePanel() {
  const trigger = root.value?.querySelector<HTMLElement>(".select-trigger");
  if (!trigger) return;
  const rect = trigger.getBoundingClientRect();
  const width = Math.max(rect.width, 180);
  const margin = 8;
  const left = Math.min(Math.max(margin, rect.left), window.innerWidth - width - margin);
  panelStyle.value = { left: `${left}px`, top: `${rect.bottom + 4}px`, width: `${width}px` };
  void nextTick(() => {
    const height = panel.value?.offsetHeight ?? 0;
    if (!height) return;
    const below = window.innerHeight - rect.bottom - margin;
    if (height > below && rect.top - margin > below) {
      panelStyle.value = { left: `${left}px`, top: `${rect.top - 4 - height}px`, width: `${width}px` };
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

function toggle() {
  open.value = !open.value;
  if (open.value) {
    activeIndex.value = props.options.findIndex((item) => item.value === props.modelValue);
  }
}

function choose(option: SelectOption) {
  if (option.disabled) return;
  emit("update:modelValue", option.value);
  open.value = false;
}

/** Keyboard support mirrors the native control it replaces. */
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    open.value = false;
    return;
  }
  if (!open.value) {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      toggle();
    }
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const step = event.key === "ArrowDown" ? 1 : -1;
    const count = props.options.length;
    if (count === 0) return;
    activeIndex.value = (activeIndex.value + step + count) % count;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    const option = props.options[activeIndex.value];
    if (option) choose(option);
  }
}
</script>

<template>
  <div ref="root" class="select" @keydown="onKeydown">
    <button
      type="button"
      class="select-trigger"
      :aria-label="ariaLabel"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
    >
      <span class="select-value" :class="{ empty: !selected }">
        {{ selected?.label ?? placeholder ?? "—" }}
      </span>
      <ChevronDown :size="12" class="chevron" :class="{ flip: open }" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panel"
        class="select-panel"
        :style="panelStyle"
        role="listbox"
        @keydown="onKeydown"
      >
        <button
          v-for="(option, index) in options"
          :key="option.value"
          type="button"
          role="option"
          class="option"
          :class="{ active: index === activeIndex, selected: option.value === modelValue }"
          :aria-selected="option.value === modelValue"
          :disabled="option.disabled"
          @click="choose(option)"
          @mouseenter="activeIndex = index"
        >
          <span class="option-copy">
            <span class="option-label">{{ option.label }}</span>
            <span v-if="option.hint" class="option-hint mono">{{ option.hint }}</span>
          </span>
          <Check v-if="option.value === modelValue" :size="12" class="check" />
        </button>
        <p v-if="!options.length" class="empty">{{ $t("app.noOptions") }}</p>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.select {
  position: relative;
  min-width: 0;
}

.select-trigger {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--text);
  text-align: left;
}

.select-trigger:hover {
  border-color: color-mix(in srgb, var(--line) 65%, var(--accent));
}

.select-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.select-value.empty {
  color: var(--faint);
}

.chevron {
  flex: 0 0 12px;
  color: var(--faint);
  transition: transform 0.15s ease;
}

.chevron.flip {
  transform: rotate(180deg);
}

.select-panel {
  position: fixed;
  z-index: 90;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 14px 34px rgb(0 0 0 / 45%);
  padding: 4px;
}

.option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 7px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.option:hover,
.option.active {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.option.selected {
  color: var(--text);
}

.option:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.option-copy {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.option-hint {
  font-size: 9.5px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.check {
  margin-left: auto;
  color: var(--accent);
  flex: 0 0 12px;
}

.empty {
  margin: 6px 8px;
  font-size: 11px;
  color: var(--faint);
}
</style>
