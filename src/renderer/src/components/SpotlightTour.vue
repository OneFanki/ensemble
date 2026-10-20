<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { CSSProperties } from "vue";
import { useI18n } from "vue-i18n";
import type { TourStep, TourView } from "../onboarding/tourSteps";

const props = defineProps<{
  open: boolean;
  steps: TourStep[];
}>();

const emit = defineEmits<{
  navigate: [view: TourView];
  close: [completed: boolean];
}>();

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const { t } = useI18n();
const index = ref(0);
const targetRect = ref<Rect | null>(null);
const cardEl = ref<HTMLElement | null>(null);
const nextEl = ref<HTMLButtonElement | null>(null);
const cardStyle = ref<CSSProperties>({ top: "-9999px", left: "-9999px" });
const centered = ref(false);

const step = computed(() => props.steps[index.value]);
const isLast = computed(() => index.value === props.steps.length - 1);

const spotlightStyle = computed<CSSProperties | undefined>(() => {
  const rect = targetRect.value;
  if (!rect || centered.value) return undefined;
  const pad = 6;
  return {
    top: `${rect.top - pad}px`,
    left: `${rect.left - pad}px`,
    width: `${rect.width + pad * 2}px`,
    height: `${rect.height + pad * 2}px`,
  };
});

function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function positionCard(): void {
  const card = cardEl.value;
  if (!card) return;
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const margin = 12;
  const gap = 14;
  const cardW = card.offsetWidth;
  const cardH = card.offsetHeight;
  const rect = targetRect.value;

  if (centered.value || !rect) {
    cardStyle.value = {
      left: `${Math.max(margin, (viewportW - cardW) / 2)}px`,
      top: `${Math.max(margin, (viewportH - cardH) / 2)}px`,
    };
    return;
  }

  const placement = step.value?.placement ?? "bottom";
  let top = rect.top + rect.height + gap;
  let left = rect.left + rect.width / 2 - cardW / 2;

  if (placement === "top") {
    top = rect.top - cardH - gap;
  } else if (placement === "left") {
    top = rect.top + rect.height / 2 - cardH / 2;
    left = rect.left - cardW - gap;
  } else if (placement === "right") {
    top = rect.top + rect.height / 2 - cardH / 2;
    left = rect.left + rect.width + gap;
  }

  // Flip when the preferred side would leave the viewport.
  if (placement === "bottom" && top + cardH > viewportH - margin) {
    top = rect.top - cardH - gap;
  } else if (placement === "top" && top < margin) {
    top = rect.top + rect.height + gap;
  } else if (placement === "right" && left + cardW > viewportW - margin) {
    left = rect.left - cardW - gap;
  } else if (placement === "left" && left < margin) {
    left = rect.left + rect.width + gap;
  }

  cardStyle.value = {
    left: `${Math.min(Math.max(margin, left), viewportW - cardW - margin)}px`,
    top: `${Math.min(Math.max(margin, top), viewportH - cardH - margin)}px`,
  };
}

async function measure(): Promise<void> {
  const current = step.value;
  if (!current) return;

  if (current.view) {
    emit("navigate", current.view);
    await nextTick();
    await frame();
  }

  let target: Element | null = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    target = document.querySelector(current.target);
    if (target) break;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }

  if (!target) {
    targetRect.value = null;
    centered.value = true;
    await nextTick();
    positionCard();
    nextEl.value?.focus();
    return;
  }

  const rect = target.getBoundingClientRect();
  targetRect.value = { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  centered.value = false;
  await nextTick();
  positionCard();
  nextEl.value?.focus();
}

function relayout(): void {
  if (!props.open) return;
  const current = step.value;
  if (!centered.value && current) {
    const target = document.querySelector(current.target);
    if (target) {
      const rect = target.getBoundingClientRect();
      targetRect.value = {
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }
  }
  positionCard();
}

function go(delta: number): void {
  const next = index.value + delta;
  if (next < 0 || next >= props.steps.length) return;
  index.value = next;
}

function next(): void {
  if (isLast.value) {
    emit("close", true);
    return;
  }
  go(1);
}

function prev(): void {
  go(-1);
}

function onKeydown(event: KeyboardEvent): void {
  if (!props.open) return;
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close", false);
  } else if (event.key === "ArrowRight") {
    event.preventDefault();
    next();
  } else if (event.key === "ArrowLeft") {
    event.preventDefault();
    prev();
  }
}

function onCardKeydown(event: KeyboardEvent): void {
  if (event.key !== "Tab" || !cardEl.value) return;
  const focusables = cardEl.value.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
  );
  if (focusables.length === 0) return;
  const first = focusables[0] as HTMLElement;
  const last = focusables[focusables.length - 1] as HTMLElement;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

watch(
  () => props.open,
  async (open) => {
    if (open) {
      index.value = 0;
      await nextTick();
      await measure();
      return;
    }
    targetRect.value = null;
    centered.value = false;
    cardStyle.value = { top: "-9999px", left: "-9999px" };
  },
  { immediate: true },
);

watch(index, () => {
  if (props.open) void measure();
});

onMounted(() => {
  window.addEventListener("resize", relayout);
  window.addEventListener("scroll", relayout, true);
  document.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", relayout);
  window.removeEventListener("scroll", relayout, true);
  document.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && step"
      class="tour-layer"
      :class="{ 'tour-layer--dim': centered }"
      @click.self.prevent
    >
      <div v-if="spotlightStyle" class="tour-spotlight" :style="spotlightStyle"></div>

      <section
        ref="cardEl"
        class="tour-card"
        :style="cardStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="t(step.titleKey)"
        @keydown="onCardKeydown"
      >
        <div class="tour-meta">
          <span class="tour-count mono">{{ index + 1 }} / {{ steps.length }}</span>
          <span class="tour-dots" aria-hidden="true">
            <span
              v-for="(item, dotIndex) in steps"
              :key="item.id"
              class="tour-dot"
              :class="{ on: dotIndex === index }"
            ></span>
          </span>
        </div>

        <h2>{{ t(step.titleKey) }}</h2>
        <p>{{ t(step.bodyKey) }}</p>

        <div class="tour-actions">
          <button type="button" class="tour-btn tour-skip" @click="emit('close', false)">
            {{ t("app.tourSkip") }}
          </button>
          <div class="tour-nav">
            <button
              v-if="index > 0"
              type="button"
              class="tour-btn"
              @click="prev"
            >
              {{ t("app.tourPrev") }}
            </button>
            <button ref="nextEl" type="button" class="tour-btn tour-btn--primary" @click="next">
              {{ isLast ? t("app.tourDone") : t("app.tourNext") }}
            </button>
          </div>
        </div>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.tour-layer {
  position: fixed;
  inset: 0;
  z-index: 4000;
}

.tour-layer--dim {
  background: rgba(5, 8, 12, 0.66);
}

.tour-spotlight {
  position: fixed;
  border-radius: 10px;
  border: 1.5px solid var(--accent);
  box-shadow: 0 0 0 9999px rgba(5, 8, 12, 0.62);
  pointer-events: none;
  transition:
    top 180ms ease,
    left 180ms ease,
    width 180ms ease,
    height 180ms ease;
}

@media (prefers-reduced-motion: no-preference) {
  .tour-spotlight::after {
    content: "";
    position: absolute;
    inset: -4px;
    border: 1px solid var(--accent);
    border-radius: 14px;
    animation: tour-pulse 1.8s ease-in-out infinite;
  }
}

@keyframes tour-pulse {
  0%,
  100% {
    opacity: 0.25;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(1.02);
  }
}

.tour-card {
  position: fixed;
  z-index: 1;
  width: min(360px, calc(100vw - 24px));
  padding: 15px 16px 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 18px 50px rgba(0, 0, 0, 0.38);
}

.tour-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.tour-count {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--faint);
}

.tour-dots {
  display: inline-flex;
  gap: 4px;
}

.tour-dot {
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--line);
}

.tour-dot.on {
  background: var(--accent);
}

.tour-card h2 {
  margin: 0 0 6px;
  font-size: 15px;
  font-weight: 600;
}

.tour-card p {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--muted);
}

.tour-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 14px;
}

.tour-nav {
  display: inline-flex;
  gap: 6px;
}

.tour-btn {
  padding: 6px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.2;
}

.tour-btn:hover {
  border-color: var(--line-strong, var(--line));
  color: var(--text);
}

.tour-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.tour-btn--primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-foreground);
  font-weight: 500;
}

.tour-btn--primary:hover {
  color: var(--accent-foreground);
  filter: brightness(1.04);
}

.tour-skip {
  border-color: transparent;
  color: var(--faint);
}

.tour-skip:hover {
  border-color: transparent;
  color: var(--text-secondary);
}
</style>
