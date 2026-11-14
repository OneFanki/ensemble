<script setup lang="ts">
import type { EmbeddedDevice, EmbeddedViewport } from "@shared/embedded";
import {
  DEVICE_DPR_MAX,
  DEVICE_DPR_MIN,
  DEVICE_PRESETS,
  VIEWPORT_MAX_HEIGHT,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN,
  VIEWPORT_PRESETS,
} from "@shared/embedded";
import { Monitor, Smartphone, Tablet } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import AppButton from "./ui/AppButton.vue";
import Checkbox from "./ui/Checkbox.vue";
import FormField from "./ui/FormField.vue";
import TextField from "./ui/TextField.vue";

/**
 * Device emulation, docked where DevTools would be.
 *
 * Two kinds of choice on one page, and the separation is the point:
 *
 * - **Size only** pins the layout viewport. The page still believes it is on a
 *   desktop: no touch, desktop UA, `pointer: fine`. Useful for checking a 768px
 *   layout without touching the window.
 * - **Device** adds what actually makes a site serve its mobile UI: touch, a
 *   device pixel ratio and a mobile UA.
 *
 * Picking a size while a device is on replaces the device rather than layering
 * under it — "keep the size, stop pretending to be a phone" — because that is
 * the direction people debug in. Clearing a device keeps its size for the same
 * reason; only "自适应" goes back to filling the cell.
 */
const props = defineProps<{
  /** Device currently applied to this page, if any. */
  device?: EmbeddedDevice;
  /** Effective viewport (from a device, a size choice, or the workspace default). */
  viewport?: EmbeddedViewport | null;
}>();

const emit = defineEmits<{
  /** `null` clears; a size-only choice passes an `EmbeddedDevice` without touch. */
  device: [device: EmbeddedDevice | null];
  /** Size only, with no device semantics. */
  viewport: [mode: { width: number; height: number } | "adaptive" | "inherit"];
}>();

const { t } = useI18n();

/**
 * Which size is in effect, for showing a tick.
 *
 * A device carries its own size, so a plain viewport choice can never own the
 * size while a device is on. The custom fields edit whichever one is live, which
 * keeps the box showing the number the page is actually using.
 */
const width = ref(props.viewport?.width ?? 0);
const height = ref(props.viewport?.height ?? 0);
const dpr = ref(props.device?.dpr ?? 1);
const touch = ref(props.device?.touch ?? true);
const userAgent = ref(props.device?.userAgent ?? "");

watch(
  () => [props.viewport?.width, props.viewport?.height, props.device] as const,
  () => {
    width.value = props.viewport?.width ?? 0;
    height.value = props.viewport?.height ?? 0;
    dpr.value = props.device?.dpr ?? 1;
    touch.value = props.device?.touch ?? true;
    userAgent.value = props.device?.userAgent ?? "";
  },
);

const valid = computed(() => {
  const ok = (value: number, max: number) =>
    Number.isInteger(value) && value >= VIEWPORT_MIN && value <= max;
  return ok(width.value, VIEWPORT_MAX_WIDTH) && ok(height.value, VIEWPORT_MAX_HEIGHT);
});

function clampSize(value: unknown, max: number): number {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return VIEWPORT_MIN;
  return Math.min(max, Math.max(VIEWPORT_MIN, number));
}

/** Applies the fields as a size-only viewport. */
function applyViewport(): void {
  if (!valid.value) return;
  emit("viewport", { width: width.value, height: height.value });
}

/** Applies the fields as a device: same size, plus the phone-shaped identity. */
function applyDevice(): void {
  if (!valid.value) return;
  emit("device", {
    width: width.value,
    height: height.value,
    dpr: Math.min(DEVICE_DPR_MAX, Math.max(DEVICE_DPR_MIN, Number(dpr.value) || 1)),
    touch: touch.value,
    ...(userAgent.value.trim() ? { userAgent: userAgent.value.trim() } : {}),
  });
}

/*
 * Drag to resize.
 *
 * The handle lives on a preview box in this panel, not on the page's own edge.
 * On the page it would be indistinguishable from the stage divider that resizes
 * the *cell*, and dragging there would sometimes move a split instead of a
 * viewport. A dedicated box has one meaning.
 *
 * The mapping is "one preview pixel = one CSS pixel", so the number under the
 * handle tracks the pointer rather than some scale factor the user has to guess.
 */
const dragOrigin = ref<{ x: number; y: number; width: number; height: number } | null>(null);

function startDrag(event: PointerEvent): void {
  event.preventDefault();
  dragOrigin.value = {
    x: event.clientX,
    y: event.clientY,
    width: width.value,
    height: height.value,
  };
  (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
}

function onDrag(event: PointerEvent): void {
  const origin = dragOrigin.value;
  if (!origin) return;
  width.value = clampSize(origin.width + (event.clientX - origin.x), VIEWPORT_MAX_WIDTH);
  height.value = clampSize(origin.height + (event.clientY - origin.y), VIEWPORT_MAX_HEIGHT);
}

function endDrag(event: PointerEvent): void {
  if (!dragOrigin.value) return;
  dragOrigin.value = null;
  (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
  // Commit once at the end: applying on every pointer move would round-trip the
  // whole layout through the main process dozens of times per second.
  if (props.device) applyDevice();
  else applyViewport();
}

function pickDevice(preset: EmbeddedDevice): void {
  emit("device", { ...preset });
}

function pickViewport(preset: EmbeddedViewport): void {
  emit("viewport", { width: preset.width, height: preset.height });
}

function iconFor(preset: EmbeddedDevice) {
  return preset.width >= 700 ? Tablet : Smartphone;
}
</script>

<template>
  <div class="device-panel" data-device-panel>
    <div class="device-layout">
      <div class="device-body">
        <!-- Drag box. The only place a size can be dragged, see startDrag. -->
        <div class="preview">
          <div class="preview-frame">
            <div class="preview-size mono">{{ width }} × {{ height }}</div>
            <div
              class="preview-grip"
              data-device-grip
              @pointerdown="startDrag"
              @pointermove="onDrag"
              @pointerup="endDrag"
              @pointercancel="endDrag"
            ></div>
          </div>
          <p class="preview-hint">{{ t("app.deviceDragHint") }}</p>
        </div>

        <div class="device-fields">
          <div class="field-row">
            <FormField plain :label="t('app.deviceWidth')">
              <TextField
                mono
                type="number"
                :min="VIEWPORT_MIN"
                :max="VIEWPORT_MAX_WIDTH"
                :model-value="width"
                data-device-width
                @change="width = clampSize(($event.target as HTMLInputElement).value, VIEWPORT_MAX_WIDTH)"
              />
            </FormField>
            <FormField plain :label="t('app.deviceHeight')">
              <TextField
                mono
                type="number"
                :min="VIEWPORT_MIN"
                :max="VIEWPORT_MAX_HEIGHT"
                :model-value="height"
                data-device-height
                @change="height = clampSize(($event.target as HTMLInputElement).value, VIEWPORT_MAX_HEIGHT)"
              />
            </FormField>
          </div>

          <div class="field-row">
            <FormField plain :label="t('app.deviceDpr')">
              <TextField
                mono
                type="number"
                :min="DEVICE_DPR_MIN"
                :max="DEVICE_DPR_MAX"
                step="0.1"
                v-model.number="dpr"
                data-device-dpr
              />
            </FormField>
            <Checkbox v-model="touch" data-device-touch>{{ t("app.deviceTouch") }}</Checkbox>
          </div>

          <FormField plain :label="t('app.deviceUa')">
            <TextField v-model="userAgent" mono data-device-ua />
          </FormField>

          <div class="actions">
            <AppButton variant="primary" data-device-apply @click="applyDevice">
              {{ t("app.deviceApply") }}
            </AppButton>
            <AppButton data-device-size-only @click="applyViewport">
              {{ t("app.deviceSizeOnly") }}
            </AppButton>
            <AppButton v-if="device" variant="ghost" data-device-clear @click="emit('device', null)">
              {{ t("app.deviceClear") }}
            </AppButton>
          </div>
        </div>
      </div>

      <div class="device-lists">
        <section class="list-block">
          <p class="list-title">{{ t("app.devicePresets") }}</p>
          <button
            v-for="preset in DEVICE_PRESETS"
            :key="preset.name"
            type="button"
            class="list-row"
            :class="{ active: device?.name === preset.name }"
            :data-device-preset="preset.name"
            @click="pickDevice(preset)"
          >
            <component :is="iconFor(preset)" :size="13" />
            <span class="row-name">{{ preset.name }}</span>
            <span class="row-meta mono">{{ preset.width }}×{{ preset.height }}</span>
          </button>
        </section>

        <section class="list-block">
          <p class="list-title">{{ t("app.deviceViewports") }}</p>
          <button
            type="button"
            class="list-row"
            :class="{ active: !device && !viewport }"
            data-device-adaptive
            @click="emit('viewport', 'adaptive')"
          >
            <Monitor :size="13" />
            <span class="row-name">{{ t("app.viewportGlobalOff") }}</span>
          </button>
          <button
            v-for="preset in VIEWPORT_PRESETS"
            :key="preset.name"
            type="button"
            class="list-row"
            :class="{
              active:
                !device && viewport?.width === preset.width && viewport?.height === preset.height,
            }"
            :data-viewport-preset="preset.name"
            @click="pickViewport(preset)"
          >
            <Monitor :size="13" />
            <span class="row-name mono">{{ preset.name }}</span>
          </button>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.device-panel {
  height: 100%;
  min-height: 0;
  background: var(--surface);
  /*
   * Container queries, not media queries.
   *
   * The panel's width depends on the view's layout (a 2×2 cell gives it a
   * quarter of a quarter), not on the window. A `@media` rule would never fire
   * for the case this has to handle — a narrow panel in a wide window — so the
   * panel measures itself instead.
   *
   * The container has to be this outer element: a container query resolves
   * against an *ancestor*, so `container-type` cannot sit on the element whose
   * own children the query is supposed to restyle.
   */
  container-type: inline-size;
}

.device-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.device-body {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  gap: 16px;
  padding: 12px 14px;
  border-right: 1px solid var(--line-soft);
  overflow: auto;
}

.preview {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  flex: none;
}

/* A box whose bottom-right corner is the grip. Its own size is fixed so the
   grip stays reachable at any viewport: the *number* changes, not the box. */
.preview-frame {
  position: relative;
  box-sizing: border-box;
  width: 148px;
  max-width: 100%;
  height: 148px;
  border: 1px dashed var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.preview-size {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 10.5px;
  color: var(--faint);
}

.preview-grip {
  position: absolute;
  right: -4px;
  bottom: -4px;
  width: 14px;
  height: 14px;
  border-right: 2px solid var(--accent-text);
  border-bottom: 2px solid var(--accent-text);
  border-radius: 0 0 3px 0;
  cursor: nwse-resize;
  touch-action: none;
}

.preview-hint {
  margin: 0;
  max-width: 148px;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--faint);
  text-align: center;
}

.device-fields {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.field-row {
  display: flex;
  gap: 8px;
}

/* This panel is 210px wide, so its fields are a size smaller than a dialog's.
   The overrides are sizes only — the look is the shared field's. */
.device-fields :deep(.field) {
  flex: 1 1 0;
  gap: 3px;
}

.device-fields :deep(.input) {
  height: 26px;
  padding: 0 7px;
  background: var(--surface-2);
  font-size: 11px;
}

/* The touch box sits on the same baseline as the number input beside it, which
   has no caption of its own to line up against. */
.device-fields :deep(.check) {
  align-items: flex-end;
  padding-bottom: 5px;
  font-size: 10.5px;
  color: var(--text-secondary);
}

.device-fields :deep(.btn) {
  height: 26px;
  padding: 0 10px;
  font-size: 11px;
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: auto;
}

.device-lists {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 10px;
  width: 210px;
  padding: 12px 10px;
  overflow: auto;
}

.list-title {
  margin: 0 0 4px 2px;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.list-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 5px 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.list-row:hover {
  background: var(--surface-2);
}

.list-row.active {
  background: var(--surface-3);
  color: var(--text);
}

.row-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-meta {
  flex: none;
  font-size: 9.5px;
  color: var(--faint);
}

/*
 * Narrow panel: one column, one scrollbar.
 *
 * In a docked panel the device form and the preset list cannot sit side by side
 * — five fields plus a drag box already need most of the width. Stacking them
 * *and* giving each its own scrollbar was worse than either: the Apply button
 * ended up below an inner scroll area that gave no sign it existed.
 *
 * So the two blocks keep their natural heights and the panel scrolls as a
 * whole: preview, parameters, actions, then the presets.
 *
 * This block sits at the end of the sheet on purpose. A container query has the
 * same specificity as the plain rule it overrides, so source order decides —
 * written above `.device-body`/`.device-lists` it was silently dropped, and all
 * that survived was `flex-direction`, leaving Apply clipped inside a
 * fixed-height inner scroll box.
 */
@container (max-width: 520px) {
  .device-layout {
    flex-direction: column;
    overflow-y: auto;
  }

  .device-body {
    flex: none;
    flex-direction: column;
    gap: 12px;
    padding-bottom: 0;
    border-right: none;
    overflow: visible;
  }

  .device-lists {
    flex: none;
    width: auto;
    overflow: visible;
  }

  /* Width and height one per row: two 200px columns clip their inputs. */
  .field-row {
    flex-direction: column;
  }

  .check {
    align-items: center;
    padding-bottom: 0;
  }

  .actions {
    flex-wrap: wrap;
  }
}
</style>
