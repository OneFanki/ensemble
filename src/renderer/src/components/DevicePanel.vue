<script setup lang="ts">
import {
  DESKTOP_RESOLUTIONS,
  DEVICE_PRESETS,
  type EmbeddedDevice,
  type EmbeddedViewport,
  VIEWPORT_MAX_HEIGHT,
  VIEWPORT_MAX_WIDTH,
  VIEWPORT_MIN,
} from "@shared/embedded";
import { ArrowLeftRight, Monitor, Smartphone } from "lucide-vue-next";
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import FormField from "./ui/FormField.vue";
import IconButton from "./ui/IconButton.vue";
import TextField from "./ui/TextField.vue";

/**
 * Two kinds of emulation, not a pile of independent switches.
 *
 * Desktop mode is geometry only: a plain viewport at a chosen size. Mobile mode
 * is an identity: a device preset applies size, DPR, touch and UA in one click,
 * and a custom size keeps whichever mobile profile was last chosen. Dragging the
 * page's edge or typing a width/height moves the selection to Custom, so the
 * list always names what the page is actually wearing.
 */
const props = defineProps<{
  /** Device currently applied to this page, if any. */
  device?: EmbeddedDevice;
  /** Plain viewport applied to this page, if any. */
  viewport?: EmbeddedViewport | null;
  /**
   * The page's own viewport choice.
   *
   * Needed to tell "follow the workspace default" from "this page is adaptive":
   * both report no effective viewport, but only the second one should stay
   * adaptive when the page returns from mobile mode.
   */
  viewportOverride?: EmbeddedViewport | null;
}>();

const emit = defineEmits<{
  device: [device: EmbeddedDevice | null];
  viewport: [mode: EmbeddedViewport | "adaptive" | "inherit"];
}>();

const { t } = useI18n();

type Mode = "desktop" | "mobile";

const FALLBACK = {
  desktop: { width: 1280, height: 720 },
  mobile: { width: DEVICE_PRESETS[0]?.width ?? 393, height: DEVICE_PRESETS[0]?.height ?? 852 },
};

const DEFAULT_MOBILE: EmbeddedDevice = DEVICE_PRESETS[0] ?? {
  width: 393,
  height: 852,
  dpr: 3,
  touch: true,
};

const currentSize = computed(() => props.device ?? props.viewport ?? null);
const mode = computed<Mode>(() => (props.device ? "mobile" : "desktop"));

const width = ref(currentSize.value?.width ?? FALLBACK.desktop.width);
const height = ref(currentSize.value?.height ?? FALLBACK.desktop.height);
const widthText = ref(String(width.value));
const heightText = ref(String(height.value));

/** Set when the user picked Custom or dragged an edge away from a preset. */
const forceCustom = ref(false);

/** Last mobile profile; a custom size keeps its DPR and UA. */
const lastMobile = ref<EmbeddedDevice>(mobilePresetOf(props.device) ?? DEFAULT_MOBILE);

/**
 * What desktop mode was wearing before the page became a phone.
 *
 * A mode is a whole preset, not just a size. Carrying the phone's 393×852 into
 * desktop mode left the panel claiming a custom desktop viewport of mobile
 * dimensions; switching back has to restore the desktop answer instead — a
 * resolution, an explicit adaptive page, or following the workspace default.
 */
type DesktopChoice = EmbeddedViewport | "adaptive" | "inherit";

function desktopChoice(): DesktopChoice {
  const override = props.viewportOverride;
  if (override === undefined) return "inherit";
  if (override === null) return "adaptive";
  return { width: override.width, height: override.height };
}

const lastDesktop = ref<DesktopChoice>(desktopChoice());

watch(
  () => [props.device, props.viewportOverride] as const,
  () => {
    // Remember only what desktop mode itself is wearing. While a device is
    // applied the viewport override is stale, and overwriting the memory with
    // the phone's size would bring the bug straight back.
    if (!props.device) lastDesktop.value = desktopChoice();
  },
  { deep: true },
);

function mobilePresetOf(device?: EmbeddedDevice): EmbeddedDevice | undefined {
  if (!device?.name) return undefined;
  return DEVICE_PRESETS.find((preset) => preset.name === device.name);
}

function setSize(size: { width: number; height: number }): void {
  width.value = size.width;
  height.value = size.height;
  widthText.value = String(size.width);
  heightText.value = String(size.height);
}

function syncFromPage(): void {
  const size = currentSize.value;
  if (size) setSize(size);
  const preset = mobilePresetOf(props.device);
  if (preset) lastMobile.value = { ...preset };
}

syncFromPage();
watch(() => [props.device, props.viewport] as const, syncFromPage, { deep: true });

const activeMobileName = computed(() =>
  forceCustom.value ? null : (mobilePresetOf(props.device)?.name ?? null),
);

const activeDesktopSize = computed(() => {
  if (forceCustom.value) return null;
  const size = props.viewport;
  if (!size) return null;
  const row = DESKTOP_RESOLUTIONS.find(
    (item) => item.width === size.width && item.height === size.height,
  );
  return row ? `${row.width}x${row.height}` : null;
});

const isCustom = computed(() => {
  if (forceCustom.value) return true;
  if (!currentSize.value) return false;
  return mode.value === "mobile" ? !activeMobileName.value : !activeDesktopSize.value;
});

function applyMobile(name?: string): void {
  const profile = name
    ? (DEVICE_PRESETS.find((preset) => preset.name === name) ?? lastMobile.value)
    : lastMobile.value;
  emit("device", {
    width: width.value,
    height: height.value,
    dpr: profile.dpr,
    touch: true,
    ...(profile.userAgent ? { userAgent: profile.userAgent } : {}),
    ...(name ? { name } : {}),
  });
}

function applyDesktop(): void {
  emit("viewport", { width: width.value, height: height.value });
}

function applyCurrent(): void {
  if (mode.value === "mobile") {
    applyMobile(isCustom.value ? undefined : (activeMobileName.value ?? undefined));
  } else {
    applyDesktop();
  }
}

/* --- Mode ------------------------------------------------------------- */

function setMode(next: Mode): void {
  if (next === mode.value) return;
  forceCustom.value = false;
  if (next === "mobile") {
    const preset = mobilePresetOf(props.device) ?? lastMobile.value;
    lastMobile.value = { ...preset };
    setSize(preset);
    emit("device", { ...preset });
    return;
  }
  // Desktop mode is restored, not derived from the phone that is on screen.
  const choice = lastDesktop.value;
  if (typeof choice === "string") {
    emit("viewport", choice);
    return;
  }
  setSize(choice);
  emit("viewport", { width: choice.width, height: choice.height });
}

/* --- Resolution rows --------------------------------------------------- */

function pickDevice(preset: EmbeddedDevice): void {
  forceCustom.value = false;
  lastMobile.value = { ...preset };
  setSize(preset);
  emit("device", { ...preset });
}

function pickDesktop(size: EmbeddedViewport): void {
  forceCustom.value = false;
  setSize(size);
  emit("viewport", { width: size.width, height: size.height });
}

function pickCustom(): void {
  forceCustom.value = true;
  if (!currentSize.value) setSize(mode.value === "mobile" ? FALLBACK.mobile : FALLBACK.desktop);
  applyCurrent();
}

function resetAdaptive(): void {
  forceCustom.value = false;
  emit("viewport", "adaptive");
}

/* --- The custom fields ------------------------------------------------- */

function clampSize(value: number, max: number): number {
  if (!Number.isFinite(value)) return VIEWPORT_MIN;
  return Math.min(max, Math.max(VIEWPORT_MIN, Math.round(value)));
}

function editSize(which: "width" | "height", value: string): void {
  const digits = value.replace(/\D/g, "").slice(0, 4);
  const number = Number(digits);
  if (which === "width") {
    widthText.value = digits;
    if (digits && number >= VIEWPORT_MIN && number <= VIEWPORT_MAX_WIDTH) width.value = number;
  } else {
    heightText.value = digits;
    if (digits && number >= VIEWPORT_MIN && number <= VIEWPORT_MAX_HEIGHT) height.value = number;
  }
}

function commitSize(which: "width" | "height"): void {
  const text = which === "width" ? widthText.value : heightText.value;
  const current = which === "width" ? width.value : height.value;
  const parsed = Number(text);
  const next = clampSize(parsed, which === "width" ? VIEWPORT_MAX_WIDTH : VIEWPORT_MAX_HEIGHT);
  if (!text || !Number.isFinite(parsed)) {
    if (which === "width") widthText.value = String(current);
    else heightText.value = String(current);
    return;
  }
  if (which === "width") {
    width.value = next;
    widthText.value = String(next);
  } else {
    height.value = next;
    heightText.value = String(next);
  }
  forceCustom.value = true;
  applyCurrent();
}

function swapOrientation(): void {
  const nextWidth = height.value;
  const nextHeight = width.value;
  setSize({ width: nextWidth, height: nextHeight });
  if (mode.value === "mobile" && activeMobileName.value && !forceCustom.value) {
    applyMobile(activeMobileName.value);
    return;
  }
  forceCustom.value = true;
  applyCurrent();
}
</script>

<template>
  <div class="device-panel" data-device-panel>
    <div class="mode-switch" role="tablist">
      <button
        type="button"
        class="mode"
        :class="{ active: mode === 'desktop' }"
        role="tab"
        :aria-selected="mode === 'desktop'"
        data-device-mode="desktop"
        @click="setMode('desktop')"
      >
        <Monitor :size="12" />
        {{ t("app.deviceDesktop") }}
      </button>
      <button
        type="button"
        class="mode"
        :class="{ active: mode === 'mobile' }"
        role="tab"
        :aria-selected="mode === 'mobile'"
        data-device-mode="mobile"
        @click="setMode('mobile')"
      >
        <Smartphone :size="12" />
        {{ t("app.deviceMobile") }}
      </button>
    </div>

    <section class="resolutions">
      <div class="section-head">
        <p class="section-title">{{ t("app.deviceResolution") }}</p>
        <IconButton
          v-if="currentSize"
          data-device-swap
          :ariaLabel="t('app.deviceSwap')"
          @click="swapOrientation"
        >
          <ArrowLeftRight :size="12" />
        </IconButton>
      </div>

      <template v-if="mode === 'desktop'">
        <button
          type="button"
          class="res-row"
          :class="{ active: !currentSize }"
          data-device-adaptive
          @click="resetAdaptive"
        >
          <Monitor :size="12" />
          <span class="res-name">{{ t("app.deviceAdaptive") }}</span>
        </button>
        <button
          v-for="row in DESKTOP_RESOLUTIONS"
          :key="`desktop-${row.width}x${row.height}`"
          type="button"
          class="res-row"
          :class="{ active: activeDesktopSize === `${row.width}x${row.height}` }"
          :data-device-resolution="`${row.width}x${row.height}`"
          @click="pickDesktop(row)"
        >
          <span class="res-name mono">{{ row.width }} × {{ row.height }}</span>
        </button>
      </template>

      <template v-else>
        <button
          v-for="preset in DEVICE_PRESETS"
          :key="preset.name"
          type="button"
          class="res-row"
          :class="{ active: activeMobileName === preset.name }"
          :data-device-device="preset.name"
          :data-device-resolution="`${preset.width}x${preset.height}`"
          @click="pickDevice(preset)"
        >
          <span class="res-name">{{ preset.name }}</span>
          <span class="res-size mono">
            {{ activeMobileName === preset.name ? `${width} × ${height}` : `${preset.width} × ${preset.height}` }}
          </span>
        </button>
      </template>

      <button
        type="button"
        class="res-row"
        :class="{ active: isCustom }"
        data-device-custom
        @click="pickCustom"
      >
        <span class="res-name">{{ t("app.deviceCustom") }}</span>
        <span v-if="isCustom" class="res-size mono">{{ width }} × {{ height }}</span>
      </button>
    </section>

    <div v-if="isCustom" class="custom-size">
      <FormField plain class="size-field" :label="t('app.deviceWidth')">
        <TextField
          mono
          inputmode="numeric"
          pattern="[0-9]*"
          spellcheck="false"
          :model-value="widthText"
          data-device-width
          @update:model-value="editSize('width', $event)"
          @change="commitSize('width')"
          @keydown.enter="commitSize('width')"
        />
      </FormField>
      <span class="times">×</span>
      <FormField plain class="size-field" :label="t('app.deviceHeight')">
        <TextField
          mono
          inputmode="numeric"
          pattern="[0-9]*"
          spellcheck="false"
          :model-value="heightText"
          data-device-height
          @update:model-value="editSize('height', $event)"
          @change="commitSize('height')"
          @keydown.enter="commitSize('height')"
        />
      </FormField>
    </div>
    <p v-if="isCustom" class="hint">{{ t("app.deviceCustomHint") }}</p>
  </div>
</template>

<style scoped>
.device-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;
  padding: 10px 12px 14px;
  overflow-y: auto;
  background: var(--surface);
  font-size: 11.5px;
  color: var(--text-secondary);
}

/* --- Mode ----------------------------------------------------------------- */

.mode-switch {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
}

.mode {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 26px;
  border: 0;
  border-radius: calc(var(--radius-sm) - 1px);
  background: transparent;
  color: var(--muted);
  font-size: 11px;
  cursor: pointer;
}

.mode:hover {
  color: var(--text);
}

.mode.active {
  background: var(--surface-3);
  color: var(--text);
}

/* --- Resolution list ------------------------------------------------------ */

.resolutions {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 22px;
  padding: 0 2px;
}

.section-title {
  margin: 0;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.res-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 6px 7px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  text-align: left;
  cursor: pointer;
}

.res-row > svg {
  flex: 0 0 auto;
  align-self: center;
}

.res-row:hover {
  background: var(--surface-2);
}

.res-row.active {
  background: var(--surface-3);
  color: var(--text);
}

.res-name {
  flex: 0 0 auto;
}

.res-size {
  min-width: 0;
  margin-left: auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--faint);
}

.res-row.active .res-size {
  color: var(--muted);
}

/* --- Custom size ---------------------------------------------------------- */

.custom-size {
  display: flex;
  align-items: flex-end;
  gap: 6px;
}

.size-field {
  flex: 1 1 0;
  min-width: 0;
}

.device-panel :deep(.field) {
  gap: 3px;
  min-width: 0;
}

.device-panel :deep(.input) {
  height: 26px;
  padding: 0 7px;
  background: var(--surface-2);
  font-size: 11px;
}

.times {
  padding-bottom: 6px;
  color: var(--faint);
}

.hint {
  margin: 0;
  font-size: 9.5px;
  line-height: 1.5;
  color: var(--faint);
}
</style>
