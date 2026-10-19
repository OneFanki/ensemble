<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import TitleBar from "./components/TitleBar.vue";
import Logo from "./components/Logo.vue";
import SideRail from "./components/SideRail.vue";
import EnvironmentsView from "./components/EnvironmentsView.vue";
import IdentitiesView from "./components/IdentitiesView.vue";
import ScenesView from "./components/ScenesView.vue";
import SettingsView from "./components/SettingsView.vue";
import RunDock from "./components/RunDock.vue";
import ToastStack from "./components/ToastStack.vue";
import EnvironmentDialog from "./components/EnvironmentDialog.vue";
import IdentityDialog from "./components/IdentityDialog.vue";
import SceneDialog from "./components/SceneDialog.vue";
import LayoutEditor from "./components/LayoutEditor.vue";
import { useWorkspaceStore } from "./stores/workspace";
import { setLocale, tr, type Locale } from "./i18n";
import type {
  EnvironmentDraft,
  IdentityDraft,
  LayoutPreset,
  SceneDraft,
  SlotRect,
} from "@shared/types";

type View = "environments" | "identities" | "scenes" | "settings";

const store = useWorkspaceStore();
const view = ref<View>("identities");
const environmentDraft = ref<EnvironmentDraft | null>(null);
const identityDraft = ref<IdentityDraft | null>(null);
const sceneDraft = ref<SceneDraft | null>(null);
const layoutEditor = ref<{ preset?: LayoutPreset; seed?: SlotRect[]; sceneId?: string } | null>(
  null,
);

const platform = computed(() => store.snapshot?.platform ?? "win32");

onMounted(async () => {
  await store.init();
  applyTheme(store.settings.theme);
  setLocale(store.settings.locale as Locale);
  const saved = store.settings.lastView;
  view.value = saved === "scenes" || saved === "environments" ? saved : "identities";
});

function applyTheme(theme: "dark" | "light" | "system") {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: light)").matches
        ? "light"
        : "dark"
      : theme;
  document.documentElement.dataset["theme"] = resolved;
}

function switchView(next: View) {
  view.value = next;
  if (next !== "settings") {
    void store.saveSettings({ lastView: next });
  }
}

function openNewEnvironment() {
  environmentDraft.value = {
    name: "",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    authCheckPath: "",
    defaultEngineId: store.defaultEngine?.id,
    autoSubmit: false,
    extraFields: [],
  };
}

function openEditEnvironment(environmentId?: string) {
  const env = environmentId
    ? store.environments.find((item) => item.id === environmentId)
    : store.activeEnvironment;
  if (!env) return;
  environmentDraft.value = {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    loginPath: env.loginPath,
    authCheckPath: env.authCheckPath ?? "",
    defaultEngineId: env.defaultEngineId,
    autoSubmit: env.autoSubmit,
    extraFields: env.extraFields ? env.extraFields.map((field) => ({ ...field })) : [],
  };
}

function openNewIdentity() {
  const env = store.activeEnvironment;
  if (!env) {
    store.notify(tr("app.toastNeedEnvironment"), "error");
    view.value = "environments";
    return;
  }
  identityDraft.value = {
    environmentId: env.id,
    name: "",
    username: "",
    role: "admin",
    color: "amber",
    passwordMode: "inherit",
    startPath: "/",
    extraFields: [],
  };
}

function openEditIdentity(identityId: string) {
  const identity = store.identities.find((item) => item.id === identityId);
  if (!identity) return;
  identityDraft.value = {
    id: identity.id,
    environmentId: identity.environmentId,
    name: identity.name,
    username: identity.username,
    role: identity.role,
    color: identity.color,
    engineId: identity.engineId,
    startPath: identity.startPath,
    passwordMode: identity.passwordMode,
    extraFields: identity.extraFields ? identity.extraFields.map((field) => ({ ...field })) : [],
    note: identity.note,
  };
}

function openNewScene() {
  const env = store.activeEnvironment;
  if (!env) {
    store.notify(tr("app.toastNeedEnvironment"), "error");
    view.value = "environments";
    return;
  }
  sceneDraft.value = {
    environmentId: env.id,
    name: "",
    identityIds: store.environmentIdentities.slice(0, 3).map((identity) => identity.id),
    layoutId: store.settings.layout,
    slotAssignments: {},
    paths: {},
  };
}

function openEditScene(sceneId: string) {
  const scene = store.scenes.find((item) => item.id === sceneId);
  if (!scene) return;
  sceneDraft.value = {
    id: scene.id,
    environmentId: scene.environmentId,
    name: scene.name,
    identityIds: [...scene.identityIds],
    layoutId: scene.layoutId,
    slotAssignments: { ...scene.slotAssignments },
    paths: { ...scene.paths },
  };
}

async function saveEnvironment(draft: EnvironmentDraft) {
  const result = await store.saveEnvironment(draft);
  if (result) {
    environmentDraft.value = null;
    const saved = draft.id
      ? result.environments.find((env) => env.id === draft.id)
      : result.environments.find((env) => env.name === draft.name);
    if (saved) store.setActiveEnvironment(saved.id);
  }
}

async function saveIdentity(draft: IdentityDraft) {
  const result = await store.saveIdentity(draft);
  if (result) identityDraft.value = null;
}

async function saveScene(draft: SceneDraft) {
  const result = await store.saveScene(draft);
  if (result) sceneDraft.value = null;
}

async function deleteScene(sceneId: string) {
  if (!window.confirm(tr("app.deleteSceneConfirm"))) return;
  await store.deleteScene(sceneId);
}

async function deleteEnvironment(environmentId: string) {
  await store.deleteEnvironment(environmentId);
  environmentDraft.value = null;
}

function openLayoutEditor(preset?: LayoutPreset, sceneId?: string) {
  // Built-in presets cannot be edited in place, so customizing one seeds a new
  // preset with its geometry instead of cloning the id.
  const editablePreset = preset && !preset.builtin ? preset : undefined;
  const seed = preset?.slots.map((slot) => ({ ...slot }));
  layoutEditor.value = {
    ...(editablePreset ? { preset: editablePreset } : {}),
    ...(sceneId ? { sceneId } : {}),
    seed:
      seed && seed.length > 0
        ? seed
        : store.presetById(store.settings.layout).slots.map((slot) => ({ ...slot })),
  };
}

async function saveLayout(draft: { id?: string; name: string; slots: SlotRect[] }) {
  const sceneId = layoutEditor.value?.sceneId;
  const saved = await store.saveLayoutPreset(draft);
  if (!saved) return;
  layoutEditor.value = null;
  // When the editor was opened from a scene, switch that scene to the new preset
  // right away; otherwise the user would save a layout and see nothing change.
  if (sceneId) await store.setSceneLayout(sceneId, saved.id);
}

async function deleteLayout(preset: LayoutPreset) {
  if (!window.confirm(tr("app.confirmDeleteLayout", { name: preset.name }))) return;
  await store.deleteLayoutPreset(preset.id);
  layoutEditor.value = null;
}

async function handleTheme(theme: "dark" | "light" | "system") {
  applyTheme(theme);
  await store.saveSettings({ theme });
  await window.ensemble.setTheme(theme);
}

async function handleLocale(locale: "zh" | "en") {
  setLocale(locale);
  await store.saveSettings({ locale });
}
</script>

<template>
  <div class="app-shell" :data-platform="platform">
    <TitleBar
      :view="view"
      @manage-environments="switchView('environments')"
    />

    <div v-if="store.loading" class="boot">
      <Logo :size="30" />
      <span class="boot-copy">
        <span class="boot-name">Ensemble</span>
        <span class="boot-hint">{{ $t("app.bootHint") }}</span>
      </span>
    </div>

    <div v-else class="app-body" :class="{ 'settings-mode': view === 'settings' }">
      <SideRail :view="view" @navigate="switchView" />

      <main class="main-pane">
        <EnvironmentsView
          v-if="view === 'environments'"
          @new-environment="openNewEnvironment"
          @edit-environment="openEditEnvironment"
        />
        <IdentitiesView
          v-else-if="view === 'identities'"
          @new-identity="openNewIdentity"
          @edit-identity="openEditIdentity"
        />
        <ScenesView
          v-else-if="view === 'scenes'"
          @new-scene="openNewScene"
          @edit-scene="openEditScene"
          @delete-scene="deleteScene"
          @edit-layout="openLayoutEditor"
        />
        <SettingsView
          v-else
          @theme="handleTheme"
          @locale="handleLocale"
        />
      </main>

      <RunDock v-if="view !== 'settings'" />
    </div>

    <footer class="statusbar mono">
      <span class="status-group">
        <span class="led" :class="{ idle: !store.instances.length }"></span>
        {{ store.instances.length ? $t("app.statusConnected") : $t("app.statusReady") }}
      </span>
      <span>{{ $t("app.instancesCount", { count: store.instances.length }) }}</span>
      <span class="status-engines">
        <template v-for="(engine, index) in store.engines.slice(0, 4)" :key="engine.id">
          <span v-if="index > 0" class="sep">·</span>
          {{ engine.brand }} {{ engine.version ?? "" }}
        </template>
        <span v-if="!store.engines.length">{{ $t("app.noBrowserFound") }}</span>
      </span>
      <span class="status-right">
        <span>{{ $t("app.singleUser") }}</span>
        <span>v{{ store.snapshot?.appVersion ?? "0.1.0" }}</span>
      </span>
    </footer>

    <ToastStack />

    <EnvironmentDialog
      v-if="environmentDraft"
      :draft="environmentDraft"
      :engines="store.engines"
      @close="environmentDraft = null"
      @save="saveEnvironment"
      @delete="deleteEnvironment(environmentDraft!.id!)"
    />

    <IdentityDialog
      v-if="identityDraft"
      :draft="identityDraft"
      :engines="store.engines"
      :password-set="identityDraft.id ? store.identityPasswordSet(store.identities.find(i => i.id === identityDraft!.id)!) : false"
      @close="identityDraft = null"
      @save="saveIdentity"
      @delete="store.deleteIdentity(identityDraft!.id!); identityDraft = null"
    />

    <SceneDialog
      v-if="sceneDraft"
      :draft="sceneDraft"
      :identities="store.environmentIdentities"
      :presets="store.layoutPresets"
      @close="sceneDraft = null"
      @save="saveScene"
      @delete="store.deleteScene(sceneDraft!.id!); sceneDraft = null"
    />

    <LayoutEditor
      v-if="layoutEditor"
      :preset="layoutEditor.preset"
      :seed="layoutEditor.seed"
      @close="layoutEditor = null"
      @save="saveLayout"
      @delete="layoutEditor.preset ? deleteLayout(layoutEditor.preset) : null"
    />
  </div>
</template>

<style scoped>
.app-shell {
  height: 100%;
  display: grid;
  grid-template-rows: var(--titlebar-height) minmax(0, 1fr) 30px;
  background:
    radial-gradient(1100px 420px at 78% -12%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 62%),
    radial-gradient(800px 380px at 12% 105%, color-mix(in srgb, var(--green) 5%, transparent), transparent 60%),
    var(--bg);
}

.boot {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--muted);
  font-size: 12px;
}

.boot-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.boot-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.boot-hint {
  font-size: 10.5px;
  color: var(--faint);
}

.app-body {
  min-height: 0;
  display: grid;
  grid-template-columns: var(--rail-width) minmax(0, 1fr) var(--dock-width);
}

.app-body.settings-mode {
  grid-template-columns: var(--rail-width) minmax(0, 1fr);
}

.main-pane {
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.statusbar {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 13px;
  border-top: 1px solid var(--line-soft);
  background: color-mix(in srgb, var(--bg) 88%, black);
  color: var(--faint);
  font-size: 10.5px;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
}

.status-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.led {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 6px color-mix(in srgb, var(--green) 70%, transparent);
}

.led.idle {
  background: var(--faint);
  box-shadow: none;
}

.status-engines {
  overflow: hidden;
  text-overflow: ellipsis;
}

.sep {
  margin: 0 5px;
  color: var(--line);
}

.status-right {
  margin-left: auto;
  display: flex;
  gap: 14px;
  overflow: hidden;
}

@media (max-width: 1180px) {
  .app-body {
    grid-template-columns: var(--rail-width) minmax(0, 1fr);
  }
}

@media (max-width: 900px) {
  .app-body {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
