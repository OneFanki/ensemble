<script setup lang="ts">
import { ArrowRight, Bot, Check, X } from "lucide-vue-next";
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { GUIDE_PATH_STEPS, GUIDE_SECTIONS } from "../onboarding/guide";
import AppButton from "./ui/AppButton.vue";

/**
 * The guide: what this is, and the shortest path to using it.
 *
 * Deliberately picture-first. A person who skips onboarding is not going to read
 * paragraphs — so the first screen is one diagram of three boxes, one sentence
 * per box, and then the single most important fact about the whole app: none of
 * it has to be done by hand, because an AI client can do all of it.
 *
 * The optional sections are behind the list on the left rather than below the
 * fold. Someone who wants to know what a view is can go and read that one page;
 * someone who just opened the app should not have to scroll past five
 * explanations of things they have not needed yet. The list is the only
 * navigation: no back links or cross-link chips inside the page — they repeated
 * what the never-scrolling list already does.
 *
 * The diagrams are inline SVG on purpose: no image to load, no asset to keep in
 * sync with the layout, both languages fit because the text is HTML.
 */
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
/** `null` means the first screen; a section id shows that section. */
const section = ref<string | null>(null);

const core = computed(() => GUIDE_SECTIONS.filter((item) => item.group === "core"));
const optional = computed(() => GUIDE_SECTIONS.filter((item) => item.group === "optional"));
const active = computed(() => GUIDE_SECTIONS.find((item) => item.id === section.value));
</script>

<template>
  <div class="guide-backdrop" role="dialog" aria-modal="true" @click.self="emit('close')">
    <div class="guide">
      <header class="guide-head">
        <span class="guide-title">{{ t("app.guideTitle") }}</span>
        <button type="button" class="guide-close" :aria-label="t('app.close')" @click="emit('close')">
          <X :size="14" />
        </button>
      </header>

      <div class="guide-body">
        <!-- Section list. On the first screen it doubles as the table of
             contents for the optional half, so nothing is hidden and nothing is
             in the way either. -->
        <nav class="guide-nav">
          <button
            type="button"
            class="nav-entry"
            :class="{ active: section === null }"
            @click="section = null"
          >
            {{ t("app.guideStart") }}
          </button>
          <p class="nav-group">{{ t("app.guideGroupCore") }}</p>
          <button
            v-for="item in core"
            :key="item.id"
            type="button"
            class="nav-entry"
            :class="{ active: section === item.id }"
            @click="section = item.id"
          >
            {{ t(item.titleKey) }}
          </button>
          <p class="nav-group">{{ t("app.guideGroupOptional") }}</p>
          <button
            v-for="item in optional"
            :key="item.id"
            type="button"
            class="nav-entry"
            :class="{ active: section === item.id }"
            @click="section = item.id"
          >
            {{ t(item.titleKey) }}
          </button>
        </nav>

        <div class="guide-main">
          <!-- First screen: the diagram, then the AI turn. -->
          <template v-if="section === null">
            <h1 class="guide-h1">{{ t("app.guideH1") }}</h1>
            <p class="guide-lead">{{ t("app.guideLead") }}</p>

            <!-- Arrows live BETWEEN the boxes, not inside them: the flow reads
                 left to right as boxes connected by steps, and the boxes stay
                 equal width because the separators take their own slots. -->
            <ol class="path">
              <template v-for="(step, index) in GUIDE_PATH_STEPS" :key="step.titleKey">
                <li class="path-step">
                  <span class="path-no mono">{{ index + 1 }}</span>
                  <span class="path-copy">
                    <span class="path-title">{{ t(step.titleKey) }}</span>
                    <span class="path-hint">{{ t(step.hintKey) }}</span>
                  </span>
                </li>
                <li
                  v-if="index < GUIDE_PATH_STEPS.length - 1"
                  class="path-sep"
                  aria-hidden="true"
                >
                  <ArrowRight :size="15" />
                </li>
              </template>
            </ol>

            <!-- The turn. This is the one thing that changes how the app is
                 used, so it gets its own block rather than a footnote. -->
            <div class="ai-turn">
              <Bot :size="20" class="ai-icon" />
              <div class="ai-copy">
                <p class="ai-title">{{ t("app.guideAiTurnTitle") }}</p>
                <p class="ai-body">{{ t("app.guideAiTurnBody") }}</p>
                <ul class="ai-list">
                  <li v-for="n in 3" :key="n">
                    <Check :size="12" />
                    {{ t(`app.guideAiCan${n}`) }}
                  </li>
                </ul>
              </div>
            </div>

            <div class="guide-actions">
              <AppButton variant="primary" @click="section = 'ai'">
                {{ t("app.guideHowToConnect") }}
              </AppButton>
              <AppButton @click="emit('close')">{{ t("app.guideGotIt") }}</AppButton>
            </div>
          </template>

          <!-- One section. Just a heading and a short body: the optional
               half is reference material, and reading it should be quick. The
               left list is the navigation, so there is no back link here. -->
          <template v-else-if="active">
            <h1 class="guide-h1">{{ t(active.titleKey) }}</h1>

            <!-- The views section gets the one diagram worth drawing: a 2x2 grid
                 of accounts is the idea, and four boxes say it faster than a
                 sentence about layouts. -->
            <svg
              v-if="active.id === 'views'"
              class="diagram"
              viewBox="0 0 240 92"
              role="img"
              :aria-label="t('app.guideViewsDiagramAlt')"
            >
              <rect x="2" y="10" width="112" height="36" rx="5" class="d-cell" />
              <rect x="126" y="10" width="112" height="36" rx="5" class="d-cell" />
              <rect x="2" y="52" width="112" height="36" rx="5" class="d-cell" />
              <rect x="126" y="52" width="112" height="36" rx="5" class="d-cell" />
              <text x="16" y="33" class="d-label">{{ t("app.guideViewsCellA") }}</text>
              <text x="140" y="33" class="d-label">{{ t("app.guideViewsCellB") }}</text>
              <text x="16" y="75" class="d-label">{{ t("app.guideViewsCellC") }}</text>
              <text x="140" y="75" class="d-label">{{ t("app.guideViewsCellD") }}</text>
            </svg>

            <svg
              v-else-if="active.id === 'tabs'"
              class="diagram"
              viewBox="0 0 260 74"
              role="img"
              :aria-label="t('app.guideTabsDiagramAlt')"
            >
              <rect x="2" y="6" width="256" height="26" rx="5" class="d-cell" />
              <text x="14" y="23" class="d-label">{{ t("app.guideTabsRow") }}</text>
              <rect x="2" y="38" width="256" height="26" rx="5" class="d-cell muted" />
              <text x="14" y="55" class="d-label muted">{{ t("app.guideTabsRow2") }}</text>
            </svg>

            <p class="guide-body-copy">{{ t(active.bodyKey) }}</p>
          </template>
        </div>
      </div>
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
  background: rgb(0 0 0 / 62%);
  backdrop-filter: blur(2px);
}

.guide {
  position: relative;
  z-index: 71;
  width: min(880px, calc(100vw - 64px));
  height: min(620px, calc(100vh - 80px));
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
  padding: 12px 16px;
  border-bottom: 1px solid var(--line-soft);
}

.guide-title {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  color: var(--muted);
  text-transform: uppercase;
}

.guide-close {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
}

.guide-close:hover {
  background: var(--surface-2);
  color: var(--text);
}

.guide-body {
  display: flex;
  min-height: 0;
  flex: 1 1 auto;
}

.guide-nav {
  display: flex;
  flex-direction: column;
  gap: 2px;
  width: 190px;
  flex: none;
  padding: 12px 8px;
  border-right: 1px solid var(--line-soft);
  overflow-y: auto;
}

.nav-group {
  margin: 12px 8px 4px;
  font-size: 9.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.nav-entry {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 6px 9px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}

.nav-entry:hover {
  background: var(--surface-2);
  color: var(--text-secondary);
}

.nav-entry.active {
  background: var(--surface-3);
  color: var(--text);
}

.guide-main {
  flex: 1 1 auto;
  min-width: 0;
  padding: 24px 28px 28px;
  overflow-y: auto;
}

.guide-h1 {
  margin: 0;
  font-size: 19px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--text);
}

.guide-lead {
  margin: 8px 0 20px;
  max-width: 56ch;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted);
}

/* ---- the three-box path ---- */

.path {
  display: flex;
  align-items: stretch;
  gap: 0;
  margin: 0 0 22px;
  padding: 0;
  list-style: none;
}

.path-step {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
  gap: 8px;
  padding: 12px 10px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
}

/* The connector between two boxes: its own slot in the row, vertically
   centered, so the flow reads box → box → box. */
.path-sep {
  display: flex;
  align-items: center;
  flex: none;
  padding: 0 4px;
  color: var(--faint);
}

.path-no {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 20%, transparent);
  color: var(--accent);
  font-size: 10px;
}

.path-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.path-title {
  font-size: 12.5px;
  color: var(--text);
}

.path-hint {
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--faint);
}

/* ---- the AI turn ---- */

.ai-turn {
  display: flex;
  gap: 14px;
  padding: 16px 18px;
  border: 1px solid color-mix(in srgb, var(--line) 50%, var(--accent));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--accent) 6%, var(--surface));
}

.ai-icon {
  flex: none;
  /* No top offset: the 20px icon centered against the title's ~19px line box
     needs none, and an optical nudge read as floating above the text. */
  color: var(--accent);
}

.ai-copy {
  min-width: 0;
}

.ai-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.ai-body {
  margin: 0 0 10px;
  font-size: 12px;
  line-height: 1.7;
  color: var(--muted);
}

.ai-list {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ai-list li {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 11.5px;
  color: var(--text-secondary);
}

.ai-list svg {
  flex: none;
  color: var(--green);
}

/* ---- sections ---- */


.guide-body-copy {
  margin: 0;
  max-width: 58ch;
  font-size: 12.5px;
  line-height: 1.8;
  color: var(--muted);
  white-space: pre-line;
}

.diagram {
  width: 100%;
  max-width: 320px;
  margin: 0 0 18px;
  overflow: visible;
}

.d-cell {
  fill: var(--surface);
  stroke: var(--line);
  stroke-width: 1;
}

.d-cell.muted {
  fill: transparent;
  stroke-dasharray: 3 3;
}

.d-label {
  fill: var(--text-secondary);
  font-size: 10px;
  font-family: var(--font-sans);
}

.d-label.muted {
  fill: var(--faint);
}

.guide-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 20px;
}

</style>
