<script setup lang="ts">
import type { EmbeddedTab } from "@shared/embedded";
import { NEW_TAB_BACKDROPS, newTabBackdrop } from "@shared/newtab";
import { enginePreview, isValidEngineTemplate, resolveBrowserInput } from "@shared/search";
import { Check, ChevronDown, Palette, Plus, Search, X } from "lucide-vue-next";
import { computed, nextTick, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";
import AppButton from "./ui/AppButton.vue";

/**
 * What a blank page shows instead of an empty white rectangle.
 *
 * One field, one engine picker. It resolves whatever is typed — a domain, an IP,
 * `localhost:3000` or a scheme navigates directly, everything else goes to the
 * selected engine — so it never needs a second input or a row of buttons
 * explaining the rule: the placeholder says both halves and the engine picker
 * sits where a browser puts it, at the left of the field.
 *
 * The backdrop is a preset, not an image file: this surface has to paint before
 * any network call, and the choice is a settings string that survives export.
 */
const props = defineProps<{ tab: EmbeddedTab }>();

const store = useEmbeddedStore();
const workspace = useWorkspaceStore();
const { t } = useI18n();

const query = ref("");
const error = ref("");
const engineOpen = ref(false);
const adding = ref(false);
const draftName = ref("");
const draftTemplate = ref("");
const nameInput = ref<HTMLInputElement | null>(null);
/** The backdrop picker is a temporary overlay state, never persisted. */
const picking = ref(false);

const engine = computed(() => workspace.searchEngine);
const input = computed(() => query.value.trim());
const preview = computed(() => enginePreview(draftTemplate.value, "示例 query"));
const backdrop = computed(() => newTabBackdrop(workspace.settings.newTabBackground));

async function submit(): Promise<void> {
  error.value = "";
  const value = input.value;
  if (!value) return;
  const url = resolveBrowserInput(value, engine.value);
  if (!url) {
    error.value = t("app.newTabBadInput");
    return;
  }
  query.value = "";
  await store.navigate(props.tab.id, url);
}

async function chooseEngine(id: string): Promise<void> {
  engineOpen.value = false;
  if (id === engine.value.id) return;
  await workspace.saveSettings({ searchEngineId: id });
}

async function pickBackdrop(id: string): Promise<void> {
  picking.value = false;
  if (id === backdrop.value.id) return;
  await workspace.saveSettings({ newTabBackground: id });
}

async function startAdding(): Promise<void> {
  engineOpen.value = false;
  adding.value = true;
  draftName.value = "";
  draftTemplate.value = "";
  await nextTick();
  nameInput.value?.focus();
}

async function saveEngine(): Promise<void> {
  const name = draftName.value.trim();
  const template = draftTemplate.value.trim();
  if (!name || !isValidEngineTemplate(template)) {
    error.value = t("app.newTabEngineInvalid");
    return;
  }
  const id = `custom-${Date.now().toString(36)}`;
  const next = [...workspace.settings.customSearchEngines, { id, name, urlTemplate: template }];
  await workspace.saveSettings({ customSearchEngines: next, searchEngineId: id });
  adding.value = false;
  error.value = "";
}
</script>

<template>
  <div class="new-tab">
    <div class="nt-bg" :style="{ background: workspace.newTabBackdropStyle }"></div>
    <div class="nt-inner">
      <form class="nt-box" @submit.prevent="submit">
        <div class="nt-engine">
          <button
            type="button"
            class="nt-engine-btn"
            :aria-label="t('app.newTabEngine')"
            :aria-expanded="engineOpen"
            @click="engineOpen = !engineOpen"
          >
            <span class="nt-engine-name">{{ engine.name }}</span>
            <ChevronDown :size="12" class="chev" :class="{ flip: engineOpen }" />
          </button>
          <div v-if="engineOpen" class="nt-engine-menu" role="listbox">
            <button
              v-for="item in workspace.searchEngines"
              :key="item.id"
              type="button"
              role="option"
              class="nt-engine-item"
              :class="{ active: item.id === engine.id }"
              :aria-selected="item.id === engine.id"
              @click="chooseEngine(item.id)"
            >
              <Check v-if="item.id === engine.id" :size="11" class="nt-check" />
              <span v-else class="nt-check"></span>
              {{ item.name }}
            </button>
            <button type="button" class="nt-engine-item add" @click="startAdding">
              <Plus :size="11" />
              {{ t("app.newTabEngineAdd") }}
            </button>
          </div>
        </div>
        <input
          v-model="query"
          class="nt-input"
          type="text"
          spellcheck="false"
          autocomplete="off"
          :placeholder="t('app.newTabPlaceholder')"
          :aria-label="t('app.newTabPlaceholder')"
          @input="error = ''"
        />
        <button type="submit" class="nt-go" :disabled="!input" :aria-label="t('app.newTabGo')">
          <Search :size="15" />
        </button>
      </form>

      <form v-if="adding" class="nt-custom" @submit.prevent="saveEngine">
        <div class="nt-custom-head">
          <span>{{ t("app.newTabEngineAdd") }}</span>
          <button type="button" class="nt-close" :aria-label="t('app.cancel')" @click="adding = false">
            <X :size="12" />
          </button>
        </div>
        <div class="nt-custom-row">
          <input
            ref="nameInput"
            v-model="draftName"
            type="text"
            :placeholder="t('app.newTabEngineName')"
            :aria-label="t('app.newTabEngineName')"
          />
          <input
            v-model="draftTemplate"
            type="text"
            class="mono"
            spellcheck="false"
            placeholder="https://example.com/search?q=%s"
            :aria-label="t('app.newTabEngineTemplate')"
          />
        </div>
        <p class="nt-custom-note">
          {{ t("app.newTabEngineTemplateHint") }}
          <span v-if="preview" class="mono preview">{{ preview }}</span>
        </p>
        <AppButton size="sm" variant="primary" @click="saveEngine">
          {{ t("app.save") }}
        </AppButton>
      </form>

      <p v-if="error" class="nt-error">{{ error }}</p>
    </div>

    <!--
      Backdrop picker. A corner control rather than a settings row: the choice
      is only interesting while looking at the page it changes, and this keeps
      it out of the way of the search box.
    -->
    <div class="nt-look">
      <div v-if="picking" class="nt-swatches" role="radiogroup" :aria-label="t('app.newTabBackground')">
        <button
          v-for="item in NEW_TAB_BACKDROPS"
          :key="item.id"
          type="button"
          role="radio"
          class="nt-swatch"
          :class="{ active: item.id === backdrop.id }"
          :aria-checked="item.id === backdrop.id"
          :title="t(item.labelKey)"
          :aria-label="t(item.labelKey)"
          :style="{ background: item.swatch }"
          @click="pickBackdrop(item.id)"
        ></button>
      </div>
      <button
        type="button"
        class="nt-look-btn"
        :aria-label="t('app.newTabBackground')"
        :aria-expanded="picking"
        @click="picking = !picking"
      >
        <Palette :size="14" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.new-tab {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 24px;
  overflow: auto;
  background: var(--bg);
}

/* Backdrop layer: the pattern presets are tiled, so they are faded out at the
   edges. It has to be its own layer — a mask on the surface would fade the
   search box with it. */
.nt-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  mask-image: radial-gradient(120% 100% at 50% 45%, #000 55%, transparent 100%);
}

.nt-inner {
  position: relative;
  width: min(560px, 100%);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.nt-box {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: 44px;
  padding: 0 6px 0 4px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: 0 10px 30px rgb(0 0 0 / 28%);
}

.nt-box:focus-within {
  border-color: color-mix(in srgb, var(--line) 45%, var(--accent));
}

.nt-engine {
  position: relative;
  flex: 0 0 auto;
}

.nt-engine-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 11.5px;
  white-space: nowrap;
}

.nt-engine-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}

.nt-engine-name {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chev {
  color: var(--faint);
  transition: transform 0.15s ease;
}

.chev.flip {
  transform: rotate(180deg);
}

.nt-engine-menu {
  position: absolute;
  z-index: 2;
  top: calc(100% + 6px);
  left: 0;
  min-width: 180px;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: 0 14px 32px rgb(0 0 0 / 45%);
}

.nt-engine-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  color: var(--muted);
  font-size: 11.5px;
  text-align: left;
}

.nt-engine-item:hover {
  background: var(--surface-2);
  color: var(--text);
}

.nt-engine-item.active {
  color: var(--accent);
}

.nt-check {
  width: 11px;
  flex: 0 0 11px;
  color: var(--accent);
}

.nt-engine-item.add {
  margin-top: 2px;
  border-top: 1px solid var(--line-soft);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  color: var(--faint);
}

.nt-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 34px;
  padding: 0 4px;
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 13px;
  outline: none;
}

.nt-go {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  flex: 0 0 32px;
}

.nt-go:hover:not(:disabled) {
  background: color-mix(in srgb, var(--accent) 26%, transparent);
}

.nt-go:disabled {
  background: transparent;
  color: var(--faint);
}

.nt-custom {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--surface);
  align-items: flex-start;
}

.nt-custom-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  font-size: 10.5px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--faint);
}

.nt-close {
  margin-left: auto;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  color: var(--faint);
}

.nt-close:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.nt-custom-row {
  display: flex;
  gap: 6px;
  width: 100%;
}

.nt-custom-row input {
  flex: 1 1 0;
  min-width: 0;
  height: 28px;
  padding: 0 9px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 11.5px;
  outline: none;
}

.nt-custom-row input:focus {
  border-color: color-mix(in srgb, var(--line) 50%, var(--accent));
}

.nt-custom-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--faint);
  line-height: 1.5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.nt-custom-note .preview {
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nt-error {
  margin: 0;
  text-align: center;
  font-size: 11px;
  color: var(--red);
}

.nt-look {
  position: absolute;
  right: 14px;
  bottom: 14px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.nt-swatches {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--surface);
  box-shadow: 0 10px 24px rgb(0 0 0 / 35%);
}

.nt-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
  cursor: pointer;
}

.nt-swatch.active {
  box-shadow:
    0 0 0 1px var(--surface),
    0 0 0 2px var(--accent);
}

.nt-look-btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  border: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  color: var(--faint);
}

.nt-look-btn:hover {
  color: var(--text);
  border-color: var(--line);
}
</style>
