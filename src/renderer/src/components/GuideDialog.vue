<script setup lang="ts">
import { ArrowLeft, ArrowRight, Check, X } from "lucide-vue-next";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { GUIDE_PAGES, type GuideScene } from "../onboarding/guide";
import AppButton from "./ui/AppButton.vue";
import SceneAiActs from "./guide/SceneAiActs.vue";
import SceneCompare from "./guide/SceneCompare.vue";
import SceneDevtools from "./guide/SceneDevtools.vue";
import SceneHeadless from "./guide/SceneHeadless.vue";
import SceneIsolation from "./guide/SceneIsolation.vue";
import SceneMcp from "./guide/SceneMcp.vue";
import SceneReopen from "./guide/SceneReopen.vue";
import SceneSystems from "./guide/SceneSystems.vue";

/**
 * The guide: a paginated tour, one idea per page, each with a looping diagram.
 *
 * ## Why this shape
 *
 * The previous version was a two-column dialog with a table of contents: correct
 * and complete, and it made the product look like a settings screen. A person
 * opening this app for the first time is deciding whether to spend an afternoon
 * on it, and a page that looks like configuration software answers "no" before
 * they read a word.
 *
 * So it is now a tour: one window, one page at a time, a diagram that moves on
 * the left and at most three bullets on the right. The motion is not decoration
 * — each diagram animates the sentence it sits beside, because a still picture
 * of "three isolated tabs" says "three tabs" while a fence drawing itself around
 * each one says "isolated".
 *
 * ## Why pagination rather than a list
 *
 * A section list lets a reader skip to what they want. That is the right shape
 * for reference material and the wrong shape for an introduction: on first open
 * nobody knows which section they want, and a list answers a question they do
 * not have yet. The tour answers the question in the order it gets asked. The
 * way back into it is the app menu, which is what the last page shows.
 *
 * ## Keyboard
 *
 * Left/right move between pages, Escape closes. A tour that only responds to the
 * mouse is a tour people abandon; the arrow keys are what a reader already has
 * their hands on.
 */
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

/** The scene component for each page id. Kept here so `guide.ts` stays data-only. */
const SCENES: Record<GuideScene, unknown> = {
  isolation: SceneIsolation,
  twoSystems: SceneSystems,
  compare: SceneCompare,
  mcp: SceneMcp,
  aiActs: SceneAiActs,
  headless: SceneHeadless,
  devtools: SceneDevtools,
  reopen: SceneReopen,
};

const index = ref(0);
const last = computed(() => GUIDE_PAGES.length - 1);
const page = computed(() => GUIDE_PAGES[index.value]!);
const isFirst = computed(() => index.value === 0);
const isLast = computed(() => index.value === last.value);

/**
 * The direction of the last move, used to pick the transition.
 *
 * Going back should feel like going back — the same slide in reverse. Without
 * this every page entered from the same side, and the "previous" button looked
 * like it had done nothing but swap the text.
 */
const direction = ref<"forward" | "back">("forward");

function go(next: number): void {
  const clamped = Math.min(last.value, Math.max(0, next));
  if (clamped === index.value) return;
  direction.value = clamped > index.value ? "forward" : "back";
  index.value = clamped;
}

function next(): void {
  if (isLast.value) {
    emit("close");
    return;
  }
  go(index.value + 1);
}

function prev(): void {
  go(index.value - 1);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    next();
    return;
  }
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    prev();
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

/** Scroll the text pane back to the top when the page changes: on a short
 *  window the previous page may have been scrolled, and the new one must not
 *  open halfway down. */
const textPane = ref<HTMLElement | null>(null);
watch(index, () => {
  textPane.value?.scrollTo({ top: 0 });
});

const transitionName = computed(() =>
  direction.value === "forward" ? "page-forward" : "page-back",
);
</script>

<template>
  <div class="guide-backdrop" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="guide" :data-guide-page="page.id">
      <header class="guide-head">
        <span class="guide-mark">{{ t("app.guideTitle") }}</span>
        <button
          type="button"
          class="guide-skip"
          :aria-label="t('app.close')"
          @click="emit('close')"
        >
          <X :size="14" />
        </button>
      </header>

      <div class="guide-body">
        <!-- The diagram half. A fresh page mounts the scene, which restarts its
             animation from the top — that is why the scenes are mounted per page
             rather than kept alive: a diagram caught mid-loop on arrival reads as
             broken. -->
        <div class="guide-visual">
          <Transition :name="transitionName" mode="out-in">
            <component :is="SCENES[page.id]" :key="page.id" />
          </Transition>
        </div>

        <!-- The words half. -->
        <div ref="textPane" class="guide-copy">
          <Transition :name="transitionName" mode="out-in">
            <div :key="page.id" class="copy-block">
              <p class="copy-kicker mono">
                {{ String(index + 1).padStart(2, "0") }} / {{ String(GUIDE_PAGES.length).padStart(2, "0") }}
              </p>
              <h1 class="copy-title">{{ t(page.titleKey) }}</h1>
              <p class="copy-body">{{ t(page.bodyKey) }}</p>

              <ul v-if="page.bullets?.length" class="copy-bullets">
                <li v-for="bullet in page.bullets" :key="bullet.titleKey">
                  <Check :size="13" class="bullet-mark" />
                  <span>
                    <span class="bullet-title">{{ t(bullet.titleKey) }}</span>
                    <span v-if="bullet.hintKey" class="bullet-hint">
                      {{ t(bullet.hintKey) }}
                    </span>
                  </span>
                </li>
              </ul>
            </div>
          </Transition>
        </div>
      </div>

      <footer class="guide-foot">
        <!-- Progress dots double as navigation: eight pages is few enough that
             every one can be a target, and it gives a reader a sense of how much
             is left without a "3 of 8" label. -->
        <div class="dots" role="tablist" :aria-label="t('app.guideTitle')">
          <button
            v-for="(item, i) in GUIDE_PAGES"
            :key="item.id"
            type="button"
            role="tab"
            class="dot"
            :class="{ on: i === index, done: i < index }"
            :aria-selected="i === index"
            :aria-label="t(item.titleKey)"
            :data-guide-dot="item.id"
            @click="go(i)"
          />
        </div>

        <div class="foot-actions">
          <!-- The left button is either Skip or Back, and the two have different
               labels. Slots keep "Next" from shifting sideways as the tour moves:
               a button that slides under the pointer between pages invites a
               misclick. -->
          <span class="foot-left">
            <AppButton v-if="!isFirst" data-guide-prev @click="prev">
              <ArrowLeft :size="12" />
              {{ t("app.guidePrev") }}
            </AppButton>
            <AppButton v-else data-guide-skip @click="emit('close')">
              {{ t("app.guideSkip") }}
            </AppButton>
          </span>
          <AppButton variant="primary" data-guide-next @click="next">
            {{ isLast ? t("app.guideStartNow") : t("app.guideNext") }}
            <ArrowRight v-if="!isLast" :size="12" />
          </AppButton>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.guide-backdrop {
  position: fixed;
  inset: 0;
  /* Shared overlay scale: scrim 70, dialog content 71. */
  z-index: 70;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--frame) 72%, transparent);
  backdrop-filter: blur(6px);
}

/*
 * Wider than a dialog, shorter than a full screen.
 *
 * The tour wants a stage: the diagram needs room to be worth looking at, and the
 * copy beside it needs a readable measure. The height is tuned to the diagrams
 * rather than to the copy — all eight scenes share a 520×380 viewBox, so a body
 * taller than about 1.4× the visual column's width just adds air above and below
 * the art. At 600px the diagram fills its half at 1120px wide, and the window is
 * still visibly the app's own rather than a takeover.
 */
.guide {
  position: relative;
  z-index: 71;
  width: min(1120px, calc(100vw - 96px));
  height: min(600px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--bg);
  box-shadow: var(--shadow-dialog);
  overflow: hidden;
}

.guide-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}

.guide-mark {
  font-size: 11px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--faint);
}

.guide-skip {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.guide-skip:hover {
  background: var(--surface-2);
  color: var(--text);
}

.guide-body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
}

/* The visual half is a stage, not a card: the diagram floats on the dialog's own
   background and the copy sits on a slightly recessed panel, so the eye lands on
   the art first and then reads right.
   The scene is sized by height, not width: all eight diagrams share a 520×380
   viewBox, so letting height lead makes every page fill the same stage, and the
   width follows from the aspect ratio. Sizing by width instead left the shorter
   diagrams floating in the middle of the pane with air above and below. */
.guide-visual {
  position: relative;
  display: grid;
  place-items: center;
  padding: 24px;
  min-width: 0;
  overflow: hidden;
}

.guide-visual :deep(.scene) {
  width: auto;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
}

.guide-copy {
  min-width: 0;
  overflow-y: auto;
  /* Centred, not top-aligned: the diagram beside it is vertically centred in its
     own half, and a copy block pinned to the top of a 600px pane left the two
     halves visibly out of register. `margin: auto 0` on the block does the work
     while still allowing the pane to scroll when the copy is taller than it. */
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 34px 34px 24px 18px;
}

.copy-block {
  max-width: 46ch;
  margin-block: auto;
}

.copy-kicker {
  margin: 0 0 10px;
  font-size: 10px;
  letter-spacing: 0.12em;
  color: var(--faint);
}

.copy-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 25px;
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--text);
}

.copy-body {
  margin: 12px 0 0;
  font-size: 13px;
  line-height: 1.75;
  color: var(--muted);
}

.copy-bullets {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 20px 0 0;
  padding: 0;
  list-style: none;
}

.copy-bullets li {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  font-size: 12px;
  line-height: 1.55;
}

.bullet-mark {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--green);
}

.bullet-title {
  color: var(--text-secondary);
}

.bullet-hint {
  display: block;
  color: var(--faint);
}

.guide-foot {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 18px;
  border-top: 1px solid var(--line-soft);
}

.dots {
  display: flex;
  align-items: center;
  gap: 7px;
}

/* Dots grow into a pill for the current page: position is a shape, not a colour,
   so the marker survives both themes without borrowing the accent. */
.dot {
  width: 7px;
  height: 7px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--line);
  cursor: pointer;
  transition:
    width var(--motion-base) var(--ease-out),
    background var(--motion-base) var(--ease-out);
}

.dot.done {
  background: var(--faint);
}

.dot.on {
  width: 22px;
  background: var(--text);
}

.dot:hover {
  background: var(--muted);
}

.dot.on:hover {
  background: var(--text);
}

.foot-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

/* A fixed-width slot, right-aligned, so the Back/Skip swap does not move the
   primary button. 76px is the wider of the two labels plus its arrow. */
.foot-left {
  display: flex;
  justify-content: flex-end;
  min-width: 76px;
}

/* --- page transition ------------------------------------------------------ */

.page-forward-enter-active,
.page-forward-leave-active,
.page-back-enter-active,
.page-back-leave-active {
  transition:
    opacity var(--motion-base) var(--ease-out),
    transform var(--motion-base) var(--ease-out);
}

.page-forward-enter-from {
  opacity: 0;
  transform: translateX(14px);
}

.page-forward-leave-to {
  opacity: 0;
  transform: translateX(-14px);
}

.page-back-enter-from {
  opacity: 0;
  transform: translateX(-14px);
}

.page-back-leave-to {
  opacity: 0;
  transform: translateX(14px);
}

@media (prefers-reduced-motion: reduce) {
  .page-forward-enter-active,
  .page-forward-leave-active,
  .page-back-enter-active,
  .page-back-leave-active {
    transition: none;
  }
}

/* A narrow window stacks the two halves instead of squeezing the measure. */
@media (max-width: 900px) {
  .guide {
    width: calc(100vw - 32px);
    height: calc(100vh - 32px);
  }

  .guide-body {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) minmax(0, auto);
    overflow-y: auto;
  }

  .guide-visual {
    padding: 16px;
  }

  .guide-copy {
    padding: 16px 20px 20px;
    overflow: visible;
  }

  .copy-title {
    font-size: 20px;
  }
}
</style>
