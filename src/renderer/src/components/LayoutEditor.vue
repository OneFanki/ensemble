<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Grid2x2, Plus, Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import LayoutPreview from "./LayoutPreview.vue";
import { clampSlot } from "@shared/layouts";
import type { LayoutPreset, SlotRect } from "@shared/types";

const props = defineProps<{
  preset?: LayoutPreset;
  /** Slots to start from when creating a new preset. */
  seed?: SlotRect[];
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: { id?: string; name: string; slots: SlotRect[] }];
  delete: [];
}>();

const { t } = useI18n();
const form = reactive({
  name: props.preset?.name ?? "",
  slots: (props.preset?.slots ?? props.seed ?? [{ x: 0, y: 0, width: 1, height: 1 }]).map(
    (slot) => ({ ...slot }),
  ),
});
const selected = ref(0);
const stage = ref<HTMLElement | null>(null);
const error = ref<string | null>(null);

watch(
  () => props.preset,
  (next) => {
    if (!next) return;
    form.name = next.name;
    form.slots = next.slots.map((slot) => ({ ...slot }));
  },
);

const previewPreset = computed<LayoutPreset>(() => ({
  id: props.preset?.id ?? "draft",
  name: form.name || t("app.customLayout"),
  slots: form.slots,
  builtin: false,
}));

const sortedSlots = computed(() =>
  form.slots
    .map((slot, index) => ({ slot, index }))
    .sort((a, b) => a.slot.y - b.slot.y || a.slot.x - b.slot.x),
);

function applyTemplate(columns: number, rows: number) {
  const slots: SlotRect[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      slots.push({
        x: column / columns,
        y: row / rows,
        width: 1 / columns,
        height: 1 / rows,
      });
    }
  }
  form.slots = slots;
  selected.value = 0;
}

/** New windows are inserted in the largest remaining area so they are visible. */
function addSlot() {
  const base: SlotRect = { x: 0, y: 0, width: 0.5, height: 0.5 };
  const offset = (form.slots.length % 4) * 0.1;
  form.slots = [
    ...form.slots,
    clampSlot({ ...base, x: Math.min(0.5, 0.04 + offset), y: Math.min(0.5, 0.04 + offset) }),
  ];
  selected.value = form.slots.length - 1;
}

function removeSlot(index: number) {
  if (form.slots.length <= 1) return;
  form.slots = form.slots.filter((_, current) => current !== index);
  selected.value = Math.min(selected.value, form.slots.length - 1);
}

type DragMode = "move" | "resize";

const drag = reactive<{
  mode: DragMode;
  index: number;
  startX: number;
  startY: number;
  rect: SlotRect;
}>({
  mode: "move",
  index: 0,
  startX: 0,
  startY: 0,
  rect: { x: 0, y: 0, width: 1, height: 1 },
});

function beginDrag(event: PointerEvent, index: number, mode: DragMode) {
  const box = stage.value?.getBoundingClientRect();
  if (!box) return;
  event.preventDefault();
  selected.value = index;
  drag.mode = mode;
  drag.index = index;
  drag.startX = event.clientX;
  drag.startY = event.clientY;
  drag.rect = { ...form.slots[index]! };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onMove(event: PointerEvent) {
  const box = stage.value?.getBoundingClientRect();
  if (!box) return;
  const dx = (event.clientX - drag.startX) / box.width;
  const dy = (event.clientY - drag.startY) / box.height;
  const rect = drag.rect;
  form.slots[drag.index] = clampSlot(
    drag.mode === "move"
      ? { ...rect, x: rect.x + dx, y: rect.y + dy }
      : { ...rect, width: rect.width + dx, height: rect.height + dy },
  );
}

function endDrag() {
  window.removeEventListener("pointermove", onMove);
}

function submit() {
  error.value = null;
  if (!form.name.trim()) {
    error.value = t("app.errLayoutName");
    return;
  }
  if (form.slots.length === 0) {
    error.value = t("app.errLayoutSlots");
    return;
  }
  emit("save", {
    ...(props.preset?.id ? { id: props.preset.id } : {}),
    name: form.name.trim(),
    slots: form.slots.map((slot) => ({ ...slot })),
  });
}
</script>

<template>
  <Modal
    :open="true"
    :title="preset ? $t('app.editLayoutTitle') : $t('app.newLayoutTitle')"
    :description="$t('app.layoutEditorDesc')"
    width="640px"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span class="label">{{ $t("app.layoutName") }}</span>
        <input v-model="form.name" class="input" :placeholder="$t('app.layoutNameExample')" />
      </label>

      <div class="template-row">
        <span class="template-label">{{ $t("app.startFrom") }}</span>
        <button type="button" class="tpl" @click="applyTemplate(1, 1)">1 × 1</button>
        <button type="button" class="tpl" @click="applyTemplate(2, 1)">2 × 1</button>
        <button type="button" class="tpl" @click="applyTemplate(1, 2)">1 × 2</button>
        <button type="button" class="tpl" @click="applyTemplate(2, 2)">2 × 2</button>
        <button type="button" class="tpl" @click="applyTemplate(3, 1)">3 × 1</button>
        <button type="button" class="tpl" @click="applyTemplate(2, 3)">2 × 3</button>
        <button type="button" class="tpl" @click="addSlot">
          <Plus :size="11" />
          {{ $t("app.addSlot") }}
        </button>
      </div>

      <div ref="stage" class="stage">
        <div
          v-for="(item, index) in sortedSlots"
          :key="index"
          class="slot"
          :class="{ selected: selected === item.index }"
          :style="{
            left: `${item.slot.x * 100}%`,
            top: `${item.slot.y * 100}%`,
            width: `${item.slot.width * 100}%`,
            height: `${item.slot.height * 100}%`,
          }"
          @pointerdown="beginDrag($event, item.index, 'move')"
        >
          <span class="slot-label mono">{{ index + 1 }}</span>
          <button
            v-if="form.slots.length > 1"
            type="button"
            class="slot-remove"
            :aria-label="$t('app.delete')"
            @pointerdown.stop
            @click.stop="removeSlot(item.index)"
          >
            <Trash2 :size="9" />
          </button>
          <span
            class="handle"
            :aria-label="$t('app.resizeSlot')"
            @pointerdown.stop="beginDrag($event, item.index, 'resize')"
          ></span>
        </div>
      </div>

      <p class="note">
        <Grid2x2 :size="12" />
        {{ $t("app.layoutEditorHint") }}
      </p>

      <details class="preview-block">
        <summary>{{ $t("app.preview") }}</summary>
        <LayoutPreview :preset="previewPreset" height="108px" />
      </details>

      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>

    <template #footer>
      <button v-if="preset" type="button" class="btn danger" @click="emit('delete')">
        <Trash2 :size="12" />
        {{ $t("app.delete") }}
      </button>
      <span class="spacer"></span>
      <button type="button" class="btn" @click="emit('close')">{{ $t("app.cancel") }}</button>
      <button type="button" class="btn primary" @click="submit">{{ $t("app.save") }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 7px 9px;
  font-size: 11.5px;
  color: var(--text);
  outline: 0;
}

.input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.template-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 5px;
}

.template-label {
  font-size: 10.5px;
  color: var(--faint);
  margin-right: 3px;
}

.tpl {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--faint);
  font-size: 10.5px;
  padding: 4px 8px;
}

.tpl:hover {
  color: var(--text-secondary);
  border-color: var(--line);
}

.stage {
  position: relative;
  height: 260px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: repeating-linear-gradient(
      90deg,
      transparent 0,
      transparent calc(10% - 1px),
      color-mix(in srgb, var(--line-soft) 60%, transparent) calc(10% - 1px),
      color-mix(in srgb, var(--line-soft) 60%, transparent) 10%
    ),
    repeating-linear-gradient(
      180deg,
      transparent 0,
      transparent calc(10% - 1px),
      color-mix(in srgb, var(--line-soft) 60%, transparent) calc(10% - 1px),
      color-mix(in srgb, var(--line-soft) 60%, transparent) 10%
    ),
    var(--bg-elevated);
  overflow: hidden;
  touch-action: none;
}

.slot {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--line) 70%, var(--accent));
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 10%, var(--surface-2));
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px;
  cursor: grab;
  touch-action: none;
}

.slot.selected {
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 18%, var(--surface-2));
}

.slot:active {
  cursor: grabbing;
}

.slot-label {
  font-size: 10px;
  color: var(--text-secondary);
}

.slot-remove {
  margin-left: auto;
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  border-radius: 3px;
  color: var(--faint);
  background: color-mix(in srgb, var(--bg) 60%, transparent);
}

.slot-remove:hover {
  color: var(--red);
}

.handle {
  position: absolute;
  right: -1px;
  bottom: -1px;
  width: 12px;
  height: 12px;
  cursor: nwse-resize;
  border-right: 2px solid var(--accent);
  border-bottom: 2px solid var(--accent);
  border-bottom-right-radius: 4px;
}

.note {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10.5px;
  color: var(--faint);
}

.preview-block summary {
  font-size: 10.5px;
  color: var(--faint);
  cursor: pointer;
  margin-bottom: 6px;
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 12px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
  border-color: color-mix(in srgb, var(--line) 70%, var(--accent));
}

.btn.primary {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.primary:hover:not(:disabled) {
  background: linear-gradient(
    180deg,
    var(--accent-strong),
    color-mix(in srgb, var(--accent) 88%, black)
  );
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  filter: brightness(1.07);
}

.btn.danger {
  color: var(--red);
  border-color: color-mix(in srgb, var(--red) 34%, var(--line));
}

.spacer {
  flex: 1;
}
</style>
