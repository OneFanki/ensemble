<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Grid2x2, Plus, Trash2 } from "lucide-vue-next";
import Modal from "./Modal.vue";
import LayoutPreview from "./LayoutPreview.vue";
import AppButton from "./ui/AppButton.vue";
import { clampSlot, snapSlotMove, snapSlotResize, type SnapGuides } from "@shared/layouts";
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
const guides = reactive<SnapGuides>({ vertical: [], horizontal: [] });

/** Snap distance in stage pixels; converted to fractions of the stage per axis. */
const SNAP_PIXELS = 7;

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
  guides.vertical = [];
  guides.horizontal = [];
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", endDrag, { once: true });
}

function onMove(event: PointerEvent) {
  const box = stage.value?.getBoundingClientRect();
  if (!box) return;
  const dx = (event.clientX - drag.startX) / box.width;
  const dy = (event.clientY - drag.startY) / box.height;
  const rect = drag.rect;
  const others = form.slots.filter((_, index) => index !== drag.index);
  // The threshold is expressed in stage pixels so snapping feels identical no
  // matter how wide the editor dialog is.
  const threshold = { x: SNAP_PIXELS / box.width, y: SNAP_PIXELS / box.height };

  if (drag.mode === "move") {
    const snapped = snapSlotMove({ ...rect, x: rect.x + dx, y: rect.y + dy }, others, threshold);
    form.slots[drag.index] = snapped.rect;
    guides.vertical = snapped.guides.vertical;
    guides.horizontal = snapped.guides.horizontal;
    return;
  }

  const snapped = snapSlotResize(
    { ...rect, width: rect.width + dx, height: rect.height + dy },
    others,
    threshold,
  );
  form.slots[drag.index] = snapped.rect;
  guides.vertical = snapped.guides.vertical;
  guides.horizontal = snapped.guides.horizontal;
}

function endDrag() {
  window.removeEventListener("pointermove", onMove);
  guides.vertical = [];
  guides.horizontal = [];
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
        <!-- Snap guides: shown only while an edge is locked to a stage or neighbour edge. -->
        <span
          v-for="line in guides.vertical"
          :key="`v-${line}`"
          class="guide guide-v"
          :style="{ left: `${line * 100}%` }"
        ></span>
        <span
          v-for="line in guides.horizontal"
          :key="`h-${line}`"
          class="guide guide-h"
          :style="{ top: `${line * 100}%` }"
        ></span>

        <div
          v-for="(item, index) in sortedSlots"
          :key="item.index"
          class="slot"
          :class="{ selected: selected === item.index }"
          :style="{
            left: `${item.slot.x * 100}%`,
            top: `${item.slot.y * 100}%`,
            width: `${item.slot.width * 100}%`,
            height: `${item.slot.height * 100}%`,
            // The slot being edited must never lose its resize handle behind a
            // neighbouring slot, so it is lifted above every other one.
            zIndex: selected === item.index ? 30 : 10,
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
      <AppButton variant="danger" v-if="preset" @click="emit('delete')">
        <Trash2 :size="12" />
        {{ $t("app.delete") }}
      </AppButton>
      <span class="spacer"></span>
      <AppButton @click="emit('close')">{{ $t("app.cancel") }}</AppButton>
      <AppButton variant="primary" @click="submit">{{ $t("app.save") }}</AppButton>
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
  border-radius: 0;
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

.guide {
  position: absolute;
  z-index: 40;
  pointer-events: none;
  background: var(--accent);
  opacity: 0.85;
}

.guide-v {
  top: 0;
  bottom: 0;
  width: 1px;
  transform: translateX(-0.5px);
}

.guide-h {
  left: 0;
  right: 0;
  height: 1px;
  transform: translateY(-0.5px);
}

.slot {
  position: absolute;
  border: 1px solid color-mix(in srgb, var(--line) 70%, var(--accent));
  border-radius: 0;
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

.spacer {
  flex: 1;
}
</style>
