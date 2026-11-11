<script setup lang="ts">
/**
 * One message's detail, as a floating layer.
 *
 * Two surfaces show message rows — the message centre and the toolbar bell's
 * popover — and in both of them a row used to either act immediately or expand
 * in place. Both were wrong for the same reason: a row is a summary, and the
 * thing you open when you doubt a summary must not move the list underneath it.
 * Expanding inside the list pushed every following row down, so the row you
 * were reading and the row you wanted next swapped places under the pointer.
 * A jump took the whole pane away.
 *
 * So the detail is a layer of its own: anchored to its row, teleported to the
 * body (the lists scroll and would clip it), and dismissed by Esc or by a press
 * outside. It carries the full text, when it happened, what it can still do and
 * why it cannot — and the row behind it stays exactly where it was.
 *
 * `placement` is the one thing the two callers do not share. On the message page
 * the detail opens below its row (the page has the room). Inside the bell's
 * popover it opens beside the popover: below the row it would cover the
 * neighbouring messages, which is precisely the list the user is choosing from.
 */
import type { AppMessageView } from "@shared/types";
import { X } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAnchoredPanel } from "../composables/anchoredPanel";
import { useFloatingLayer } from "../composables/floatingLayer";
import { MESSAGE_KIND_LABELS, useMessageRows } from "../composables/messageRows";

const props = withDefaults(
  defineProps<{
    /** The message to show; `null` keeps the layer closed. */
    message: AppMessageView | null;
    /** Where to hang it relative to its anchor row. */
    placement?: "below" | "left";
    /** Width in CSS pixels. */
    width?: number;
    /** The row it belongs to. Required: the layer positions against it. */
    anchor: HTMLElement | null;
  }>(),
  { placement: "below", width: 380 },
);

const emit = defineEmits<{
  close: [];
  /** The row's action ran; the caller decides what that means for its list. */
  act: [message: AppMessageView];
  /** The row is to be removed. */
  remove: [message: AppMessageView];
}>();

const { t } = useI18n();
const rows = useMessageRows(() => {});

const open = computed(() => props.message !== null);
useFloatingLayer(open);

const el = ref<HTMLElement | null>(null);
const style = ref<Record<string, string>>({});

useAnchoredPanel({
  open,
  anchor: () => props.anchor,
  panel: el,
  style,
  width: props.width,
  placement: props.placement,
  // The anchor is a list row: it has no room above or below worth flipping into,
  // and the composable already keeps the layer inside the window.
  gap: 6,
});

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  // Stopped so a parent popover does not also close: Esc in a detail means
  // "close the detail", not "close everything I was in".
  event.stopPropagation();
  emit("close");
}

/*
 * A press outside closes the detail.
 *
 * A document listener rather than `onClickOutside` on the ref: this element is
 * mounted by `v-if` inside a teleport, so at setup time the ref is still null,
 * and a handler bound then never sees it. The anchor is exempt — pressing the
 * row again is how a user toggles the layer, and closing here first would make
 * that click reopen it immediately, so the row would look stuck open.
 */
function onPointerDown(event: PointerEvent): void {
  if (!open.value) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  if (el.value?.contains(target)) return;
  if (props.anchor?.contains(target)) return;
  emit("close");
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener("pointerdown", onPointerDown, true);
  else document.removeEventListener("pointerdown", onPointerDown, true);
});

onBeforeUnmount(() => {
  // A layer unmounted while open (its row disappeared from the list) would
  // otherwise leave the listener behind for the rest of the session.
  document.removeEventListener("pointerdown", onPointerDown, true);
});

// Focus the layer when it opens so Esc reaches it without a click, and so a
// screen reader announces the row the user just opened.
watch(open, async (isOpen) => {
  if (!isOpen) return;
  await nextTick();
  el.value?.focus({ preventScroll: true });
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="message"
      ref="el"
      class="message-detail"
      role="dialog"
      :aria-label="rows.titleOf(message)"
      :style="style"
      data-message-detail
      tabindex="-1"
      @keydown="onKeydown"
    >
      <div class="detail-head">
        <span class="detail-kind">
          <component :is="rows.iconOf(message)" :size="12" />
          {{ t(MESSAGE_KIND_LABELS[message.kind]) }}
        </span>
        <span class="detail-when mono">{{ rows.whenOf(message) }}</span>
        <button
          type="button"
          class="detail-close"
          :aria-label="t('app.close')"
          data-message-detail-close
          @click="emit('close')"
        >
          <X :size="12" />
        </button>
      </div>

      <p class="detail-title">{{ rows.titleOf(message) }}</p>
      <p v-if="message.detail" class="detail-body mono">{{ message.detail }}</p>
      <p v-if="message.stale" class="detail-note">{{ rows.staleReason(message) }}</p>

      <div class="detail-actions">
        <button
          v-if="message.action && !message.stale"
          type="button"
          class="btn primary small"
          data-message-action
          @click="emit('act', message)"
        >
          {{ rows.actionLabelOf(message) }}
        </button>
        <button type="button" class="btn small" data-message-remove @click="emit('remove', message)">
          {{ t("app.messageRemove") }}
        </button>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * Teleported to `<body>`, so this block has to carry everything: it lives
 * outside every component's scoped tree.
 *
 * Not a modal: no overlay and no focus trap. A message detail is a peek at one
 * row, and the list behind it has to stay usable — that is the whole reason it
 * is a layer rather than a page.
 */
.message-detail {
  position: fixed;
  z-index: 90;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 11px 12px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-menu);
  animation: message-detail-in var(--motion-base) var(--ease-out);
  transform-origin: top center;
  /* Focused on open so Esc reaches it, but the layer is not a text field: the
     global focus ring drew a bright outline around the whole popover, which
     read as a selection rather than as "the keyboard is here". */
  outline: none;
}

@keyframes message-detail-in {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--motion-shift))) scale(var(--motion-pop-scale));
  }
}

.detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-kind {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: var(--fs-2xs);
  color: var(--muted);
}

.detail-when {
  font-size: var(--fs-2xs);
  color: var(--faint);
}

.detail-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--faint);
  flex: 0 0 20px;
}

.detail-close:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.detail-title {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--text);
  line-height: 1.5;
}

/* The detail is a path, a token or a server error — technical data, and the one
   place it is shown in full rather than ellipsised. */
.detail-body {
  margin: 0;
  font-size: var(--fs-2xs);
  color: var(--text-secondary);
  line-height: 1.6;
  overflow-wrap: anywhere;
  user-select: text;
}

.detail-note {
  margin: 0;
  font-size: var(--fs-2xs);
  color: var(--faint);
  line-height: 1.6;
}

.detail-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
</style>
