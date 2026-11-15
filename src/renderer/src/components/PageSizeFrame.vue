<script setup lang="ts">
/**
 * The visible frame around a fixed-size page, with edges you can drag.
 *
 * A fixed viewport is laid out at a CSS size and then fitted into its cell, so
 * the page on screen is a scaled rectangle with slack around it. The device
 * panel is on the other side of the window; dragging the page's own edge is the
 * shortest path to "make this a bit wider", and the badge names the CSS size
 * the page will report rather than the display pixels it currently occupies.
 *
 * The page is centred by the layout, so a width change moves both edges. The
 * drag math therefore works from the page centre: the edge under the pointer
 * stays under it. A page that would no longer fit its cell is capped instead of
 * being fitted down — a shrinking page while the pointer moves outwards reads
 * as the frame losing the edge. See `resizePageToPointer` for the full rules.
 */
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import {
  type EmbeddedTab,
  type EmbeddedViewport,
  type PageResizeEdge,
  type StageRect,
  resizePageToPointer,
} from "@shared/embedded";
import { useEmbeddedStore } from "../stores/embedded";

const props = defineProps<{
  tab: EmbeddedTab;
  stageWidth: number;
  stageHeight: number;
}>();

const emit = defineEmits<{
  resize: [size: { width: number; height: number }];
}>();

const { t } = useI18n();
const store = useEmbeddedStore();

interface Gesture {
  edge: PageResizeEdge;
  size: EmbeddedViewport;
  /** The fitted page rect when the drag started; must not track live layout. */
  rect: StageRect;
  /** The box the page is fitted into, as reported by main. */
  cell: StageRect;
  stage: HTMLElement;
  pointer: { x: number; y: number };
}

interface Draft {
  width: number;
  height: number;
  rect: StageRect;
}

const fixed = computed(() => props.tab.device ?? props.tab.viewport ?? null);
const bounds = computed(() => props.tab.bounds);

/** The cell main fitted the page into; the stage is the fallback. */
const fitCell = computed<StageRect>(() => {
  const cell = props.tab.cell;
  if (cell && cell.width > 0 && cell.height > 0) return cell;
  return { x: 0, y: 0, width: props.stageWidth, height: props.stageHeight };
});

const draft = ref<Draft | null>(null);
const gesture = ref<Gesture | null>(null);
let pending: { width: number; height: number } | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let lastSent = 0;

const shownSize = computed(() => {
  if (draft.value) return { width: draft.value.width, height: draft.value.height };
  return fixed.value ?? undefined;
});

const frameRect = computed<StageRect | null>(() => draft.value?.rect ?? bounds.value ?? null);

const visible = computed(
  () =>
    Boolean(fixed.value && bounds.value && frameRect.value) &&
    Boolean(props.tab.bounds) &&
    !props.tab.sleeping,
);

const outsideRight = computed(() => {
  const rect = frameRect.value;
  return rect ? rect.x + rect.width + 8 <= props.stageWidth : false;
});

const outsideBottom = computed(() => {
  const rect = frameRect.value;
  return rect ? rect.y + rect.height + 8 <= props.stageHeight : false;
});

const badgeStyle = computed(() => {
  const rect = frameRect.value;
  if (!rect) return {};
  const insideRight = rect.x + rect.width + 8 + 110 > props.stageWidth;
  const insideBottom = rect.y + rect.height + 8 + 26 > props.stageHeight;
  // The badge is a child of the frame, so these offsets are frame-relative;
  // adding rect.x/y again pushed it a page-width to the right, landing it
  // behind the docked panel where nobody could see the number.
  return {
    left: `${insideRight ? rect.width - 8 : rect.width + 8}px`,
    // Inside the bottom edge, the badge would sit on top of the corner grip
    // that tells people this edge is draggable. Lift it clear of that corner.
    top: `${insideBottom ? rect.height - 34 : rect.height + 8}px`,
    transform: `translate(${insideRight ? "-100%" : "0"}, ${insideBottom ? "-100%" : "0"})`,
  };
});

function pointIn(stage: HTMLElement, event: PointerEvent): { x: number; y: number } {
  const rect = stage.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function flush(force = false): void {
  if (timer) {
    clearTimeout(timer);
    timer = undefined;
  }
  if (!pending) return;
  const now = performance.now();
  if (!force && now - lastSent < 80) {
    timer = setTimeout(() => flush(), 80 - (now - lastSent));
    return;
  }
  const next = pending;
  pending = undefined;
  lastSent = now;
  emit("resize", next);
}

function queue(size: { width: number; height: number }): void {
  pending = size;
  if (timer) return;
  const wait = Math.max(0, 80 - (performance.now() - lastSent));
  timer = setTimeout(() => flush(), wait);
}

function onMove(event: PointerEvent): void {
  const current = gesture.value;
  if (!current) return;
  const step = resizePageToPointer(
    {
      size: current.size,
      rect: current.rect,
      cell: current.cell,
      pointer: current.pointer,
    },
    current.edge,
    pointIn(current.stage, event),
  );
  draft.value = { width: step.width, height: step.height, rect: step.rect };
  queue({ width: step.width, height: step.height });
}

function cleanup(): void {
  window.removeEventListener("pointermove", onMove, true);
  window.removeEventListener("pointerup", onUp, true);
  window.removeEventListener("pointercancel", onUp, true);
  if (timer) clearTimeout(timer);
  timer = undefined;
  pending = undefined;
  store.releasePointer();
  gesture.value = null;
}

function onUp(): void {
  flush(true);
  draft.value = null;
  cleanup();
}

function startResize(edge: PageResizeEdge, event: PointerEvent): void {
  const rect = bounds.value;
  const size = fixed.value;
  if (!rect || !size) return;
  const stage = (event.currentTarget as HTMLElement | null)?.closest(".stage");
  if (!(stage instanceof HTMLElement)) return;
  const point = pointIn(stage, event);
  event.preventDefault();
  event.stopPropagation();

  gesture.value = {
    edge,
    size: { width: size.width, height: size.height },
    rect: { ...rect },
    cell: { ...fitCell.value },
    stage,
    pointer: point,
  };
  store.holdPointer();
  window.addEventListener("pointermove", onMove, true);
  window.addEventListener("pointerup", onUp, true);
  window.addEventListener("pointercancel", onUp, true);
}

onBeforeUnmount(cleanup);
</script>

<template>
  <div
    v-if="visible && frameRect"
    class="page-frame"
    :class="{ dragging: Boolean(gesture) }"
    :style="{
      left: `${frameRect.x}px`,
      top: `${frameRect.y}px`,
      width: `${frameRect.width}px`,
      height: `${frameRect.height}px`,
    }"
    data-page-frame
  >
    <div
      class="frame-handle resize-e"
      :class="{ outside: outsideRight }"
      data-page-resize="e"
      @pointerdown="startResize('e', $event)"
    ></div>
    <div
      class="frame-handle resize-s"
      :class="{ outside: outsideBottom }"
      data-page-resize="s"
      @pointerdown="startResize('s', $event)"
    ></div>
    <div
      class="frame-handle resize-se"
      :class="{ outside: outsideRight && outsideBottom }"
      data-page-resize="se"
      v-tooltip="t('app.deviceResizeHint')"
      @pointerdown="startResize('se', $event)"
    >
      <span class="frame-grip" aria-hidden="true"></span>
    </div>
    <span v-if="shownSize" class="frame-size mono" :style="badgeStyle" data-page-size>
      {{ shownSize.width }} × {{ shownSize.height }}
    </span>
  </div>
</template>

<style scoped>
.page-frame {
  position: absolute;
  z-index: 3;
  pointer-events: none;
  border: 1px solid var(--line-soft);
  border-radius: 1px;
  transition: border-color var(--motion-fast) var(--ease-out);
}

.page-frame.dragging {
  border-color: var(--accent);
}

.frame-handle {
  position: absolute;
  pointer-events: auto;
  touch-action: none;
}

.resize-e {
  top: 0;
  right: 0;
  width: 7px;
  height: 100%;
  cursor: ew-resize;
}

.resize-e.outside {
  right: -8px;
  width: 8px;
}

.resize-s {
  left: 0;
  bottom: 0;
  width: 100%;
  height: 7px;
  cursor: ns-resize;
}

.resize-s.outside {
  bottom: -8px;
  height: 8px;
}

.resize-se {
  right: 0;
  bottom: 0;
  width: 12px;
  height: 12px;
  cursor: nwse-resize;
}

/*
 * Visible edges, not just a cursor.
 *
 * The drag strips are otherwise invisible until the pointer is exactly on them,
 * so the frame read as a picture of the page rather than something you can pull.
 * A short accent line appears on hover and a small diagonal grip stays in the
 * corner: the same cue Edge's device mode gives before the first drag.
 */
.resize-e::after,
.resize-s::after {
  content: "";
  position: absolute;
  border-radius: 2px;
  background: var(--line);
  opacity: 0;
  transition: opacity var(--motion-fast) var(--ease-out);
}

.resize-e::after {
  top: 28%;
  right: 2px;
  width: 2px;
  height: 44%;
}

.resize-s::after {
  left: 28%;
  bottom: 2px;
  width: 44%;
  height: 2px;
}

.resize-e.outside::after {
  right: 3px;
}

.resize-s.outside::after {
  bottom: 3px;
}

.resize-e:hover::after,
.resize-s:hover::after,
.page-frame.dragging .resize-e::after,
.page-frame.dragging .resize-s::after {
  background: var(--accent);
  opacity: 1;
}

.frame-grip {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 9px;
  height: 9px;
  background: repeating-linear-gradient(
    135deg,
    transparent 0 2px,
    var(--muted) 2px 3px
  );
  clip-path: polygon(100% 0, 100% 100%, 0 100%);
  opacity: 0.65;
  transition: opacity var(--motion-fast) var(--ease-out);
}

.resize-se:hover .frame-grip,
.page-frame.dragging .frame-grip {
  opacity: 1;
}

.resize-se.outside {
  right: -8px;
  bottom: -8px;
}

.frame-size {
  position: absolute;
  z-index: 1;
  padding: 2px 6px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text-secondary);
  font-size: var(--fs-2xs);
  white-space: nowrap;
  pointer-events: none;
}
</style>
