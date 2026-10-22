<script setup lang="ts">
import type { IdentityDraft, LayoutPreset, SiteDraft, SlotRect, ViewDraft } from "@shared/types";
import type { UpdateCheckResult } from "@shared/update";
import { computed, onMounted, onUnmounted, ref } from "vue";
import BrowserPage from "./components/BrowserPage.vue";
import ConfirmDialog from "./components/ConfirmDialog.vue";
import IdentitiesPage from "./components/IdentitiesPage.vue";
import IdentityDialog from "./components/IdentityDialog.vue";
import LayoutEditor from "./components/LayoutEditor.vue";
import Logo from "./components/Logo.vue";
import RunDock from "./components/RunDock.vue";
import SessionHealthDialog from "./components/SessionHealthDialog.vue";
import SettingsPage from "./components/SettingsPage.vue";
import SideRail from "./components/SideRail.vue";
import SiteDialog from "./components/SiteDialog.vue";
import SitesPage from "./components/SitesPage.vue";
import SpotlightTour from "./components/SpotlightTour.vue";
import TitleBar from "./components/TitleBar.vue";
import ToastStack from "./components/ToastStack.vue";
import UpdateDialog from "./components/UpdateDialog.vue";
import ViewDialog from "./components/ViewDialog.vue";
import ViewsPage from "./components/ViewsPage.vue";
import { type Locale, setLocale, tr } from "./i18n";
import {
  shouldAutoStartTour,
  TOUR_STEPS,
  TOUR_VERSION,
  type TourView,
} from "./onboarding/tourSteps";
import { useConfirmStore } from "./stores/confirm";
import { useEmbeddedStore } from "./stores/embedded";
import { useWorkspaceStore } from "./stores/workspace";

type View = "browser" | "sites" | "identities" | "views" | "settings";

const store = useWorkspaceStore();
const embedded = useEmbeddedStore();
const confirm = useConfirmStore();
const view = ref<View>("browser");
const siteDraft = ref<SiteDraft | null>(null);
const identityDraft = ref<IdentityDraft | null>(null);
const viewDraft = ref<ViewDraft | null>(null);
const layoutEditor = ref<{ preset?: LayoutPreset; seed?: SlotRect[]; viewId?: string } | null>(
  null,
);
const tourOpen = ref(false);
const tourOriginView = ref<View>("browser");
/** Remount the tour on replay so it cannot keep the previous step index. */
const tourSession = ref(0);
const healthOpen = ref(false);
/** True while an HTML overlay covers the browser stage. */
const stageObscured = ref(false);
/** Set by a background check, or by the manual check in Settings. */
const updatePrompt = ref<UpdateCheckResult | null>(null);

const platform = computed(() => store.snapshot?.platform ?? "win32");

/**
 * Native pages paint above every piece of app HTML, so any modal that covers
 * the stage has to freeze it first. Missing one dialog is not a cosmetic bug:
 * the dialog renders behind a live page and looks broken.
 */
const overlayOpen = computed(
  () =>
    stageObscured.value ||
    Boolean(
      confirm.current ||
        siteDraft.value ||
        identityDraft.value ||
        viewDraft.value ||
        layoutEditor.value ||
        healthOpen.value ||
        updatePrompt.value ||
        tourOpen.value,
    ),
);

onMounted(async () => {
  await store.init();
  await embedded.init();
  applyTheme(store.settings.theme);
  setLocale(store.settings.locale as Locale);
  const saved = store.settings.lastView;
  // The browser is the default page; returning to where the user left off beats
  // resetting them to a management page they only visited once.
  view.value =
    saved === "sites" || saved === "identities" || saved === "views" || saved === "browser"
      ? saved
      : "browser";
  // The main process asks for the browser page when a tool or a shortcut opens a
  // page in it, so the result is never hidden behind a management page.
  window.ensemble.onEmbeddedPage(() => {
    switchView("browser");
  });
  if (shouldAutoStartTour(store.settings)) {
    tourOriginView.value = view.value;
    window.setTimeout(() => {
      tourOpen.value = true;
    }, 350);
  }
  // The main process restores the last view itself; the renderer only reports it
  // so the user knows why several windows just appeared.
  window.ensemble.onViewRestored((outcome) => {
    if (outcome.restored) {
      store.notify(tr("app.toastViewRestored", { name: outcome.viewName ?? "" }), "success");
    } else if (outcome.reason) {
      store.notify(tr("app.toastViewRestoreFailed", { reason: outcome.reason }), "error");
    }
  });
  // Background checks stay silent until they find something; the dialog also
  // opens from the manual check in Settings, which emits the same event.
  window.ensemble.onUpdateAvailable((result) => {
    updatePrompt.value = result;
  });
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

/**
 * `prefers-color-scheme` changes when the OS switches appearance while the
 * setting is "system". Re-resolve it here so the window follows without a
 * restart; explicit dark/light settings must ignore the event.
 */
function handleSystemThemeChange() {
  if (store.settings.theme === "system") applyTheme("system");
}

const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
systemTheme.addEventListener("change", handleSystemThemeChange);
onUnmounted(() => systemTheme.removeEventListener("change", handleSystemThemeChange));

function switchView(next: View) {
  view.value = next;
  if (next !== "settings") {
    void store.saveSettings({ lastView: next });
  }
}
function startTour() {
  tourOriginView.value = view.value;
  tourSession.value += 1;
  tourOpen.value = true;
}

async function finishTour(completed: boolean) {
  tourOpen.value = false;
  if (!completed) view.value = tourOriginView.value;
  if ((store.settings.onboardingVersion ?? 0) < TOUR_VERSION) {
    await store.saveSettings({ onboardingVersion: TOUR_VERSION });
  }
}

function handleTourNavigate(next: TourView) {
  view.value = next;
}

function openNewSite() {
  siteDraft.value = {
    name: "",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    authCheckPath: "",
    defaultEngineId: store.defaultEngine?.id,
    autoSubmit: false,
    extraFields: [],
    tagIds: store.activeSite?.tagIds ?? [],
  };
}

function openEditSite(siteId?: string) {
  const env = siteId ? store.sites.find((item) => item.id === siteId) : store.activeSite;
  if (!env) return;
  siteDraft.value = {
    id: env.id,
    name: env.name,
    baseUrl: env.baseUrl,
    loginPath: env.loginPath,
    authCheckPath: env.authCheckPath ?? "",
    defaultEngineId: env.defaultEngineId,
    autoSubmit: env.autoSubmit,
    extraFields: env.extraFields ? env.extraFields.map((field) => ({ ...field })) : [],
    tagIds: env.tagIds ? [...env.tagIds] : [],
  };
}

function openNewIdentity() {
  const env = store.activeSite;
  if (!env) {
    store.notify(tr("app.toastNeedSite"), "error");
    view.value = "sites";
    return;
  }
  identityDraft.value = {
    siteId: env.id,
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
    siteId: identity.siteId,
    name: identity.name,
    username: identity.username,
    role: identity.role,
    color: identity.color,
    engineId: identity.engineId,
    startPath: identity.startPath,
    passwordMode: identity.passwordMode,
    ...(identity.credentialFrom ? { credentialFrom: identity.credentialFrom } : {}),
    extraFields: identity.extraFields ? identity.extraFields.map((field) => ({ ...field })) : [],
    note: identity.note,
  };
}

function openNewView() {
  const env = store.activeSite;
  if (!env) {
    store.notify(tr("app.toastNeedSite"), "error");
    view.value = "sites";
    return;
  }
  viewDraft.value = {
    siteId: env.id,
    name: "",
    identityIds: store.siteIdentities.slice(0, 3).map((identity) => identity.id),
    layoutId: store.settings.layout,
    slotAssignments: {},
    paths: {},
  };
}
function openEditView(viewId: string) {
  const view = store.views.find((item) => item.id === viewId);
  if (!view) return;
  viewDraft.value = {
    id: view.id,
    siteId: view.siteId,
    name: view.name,
    identityIds: [...view.identityIds],
    layoutId: view.layoutId,
    slotAssignments: { ...view.slotAssignments },
    paths: { ...view.paths },
  };
}

async function saveSite(draft: SiteDraft) {
  const result = await store.saveSite(draft);
  if (result) {
    siteDraft.value = null;
    const saved = draft.id
      ? result.sites.find((env) => env.id === draft.id)
      : result.sites.find((env) => env.name === draft.name);
    if (saved) store.setActiveSite(saved.id);
  }
}

async function saveIdentity(draft: IdentityDraft) {
  const result = await store.saveIdentity(draft);
  if (result) identityDraft.value = null;
}

async function saveView(draft: ViewDraft) {
  const result = await store.saveView(draft);
  if (result) viewDraft.value = null;
}

async function deleteView(viewId: string) {
  const accepted = await confirm.ask({
    title: tr("app.delete"),
    body: tr("app.deleteViewConfirm"),
    confirmLabel: tr("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteView(viewId);
}

async function deleteSite(siteId: string) {
  await store.deleteSite(siteId);
  siteDraft.value = null;
}

function openLayoutEditor(preset?: LayoutPreset, viewId?: string) {
  // Built-in presets cannot be edited in place, so customizing one seeds a new
  // preset with its geometry instead of cloning the id.
  const editablePreset = preset && !preset.builtin ? preset : undefined;
  const seed = preset?.slots.map((slot) => ({ ...slot }));
  layoutEditor.value = {
    ...(editablePreset ? { preset: editablePreset } : {}),
    ...(viewId ? { viewId } : {}),
    seed:
      seed && seed.length > 0
        ? seed
        : store.presetById(store.settings.layout).slots.map((slot) => ({ ...slot })),
  };
}

async function saveLayout(draft: { id?: string; name: string; slots: SlotRect[] }) {
  const viewId = layoutEditor.value?.viewId;
  const saved = await store.saveLayoutPreset(draft);
  if (!saved) return;
  layoutEditor.value = null;
  // When the editor was opened from a view, switch that view to the new preset
  // right away; otherwise the user would save a layout and see nothing change.
  if (viewId) await store.setViewLayout(viewId, saved.id);
}

async function deleteLayout(preset: LayoutPreset) {
  const accepted = await confirm.ask({
    title: tr("app.delete"),
    body: tr("app.confirmDeleteLayout", { name: preset.name }),
    confirmLabel: tr("app.delete"),
    tone: "danger",
  });
  if (!accepted) return;
  await store.deleteLayoutPreset(preset.id);
  layoutEditor.value = null;
}

async function handleTheme(theme: "dark" | "light" | "system") {
  // Switch the native source before resolving "system": until the main process
  // updates themeSource, prefers-color-scheme still reflects the old forced theme.
  await window.ensemble.setTheme(theme);
  await store.saveSettings({ theme });
  applyTheme(theme);
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
      @manage-sites="switchView('sites')"
      @open-browser="switchView('browser')"
      @menu-open="(open) => (stageObscured = open)"
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
        <BrowserPage v-if="view === 'browser'" :obscured="overlayOpen" />
        <SitesPage
          v-else-if="view === 'sites'"
          @new-site="openNewSite"
          @edit-site="openEditSite"
        />
        <IdentitiesPage
          v-else-if="view === 'identities'"
          @new-identity="openNewIdentity"
          @edit-identity="openEditIdentity"
          @session-health="healthOpen = true"
        />
        <ViewsPage
          v-else-if="view === 'views'"
          @new-view="openNewView"
          @edit-view="openEditView"
          @delete-view="deleteView"
          @edit-layout="openLayoutEditor"
        />
        <SettingsPage
          v-else
          @theme="handleTheme"
          @locale="handleLocale"
          @start-tour="startTour"
          @update-found="(result) => (updatePrompt = result)"
        />
      </main>

      <RunDock v-if="view !== 'settings'" />
    </div>

    <footer class="statusbar mono">
      <span class="status-group">
        <span class="led" :class="{ idle: !store.instances.length && !embedded.tabs.length }"></span>
        {{
          store.instances.length || embedded.tabs.length
            ? $t("app.statusConnected")
            : $t("app.statusReady")
        }}
      </span>
      <span>{{ $t("app.instancesCount", { count: store.instances.length + embedded.tabs.length }) }}</span>
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
    <ConfirmDialog />

    <SiteDialog
      v-if="siteDraft"
      :draft="siteDraft"
      :engines="store.engines"
      :tags="store.snapshot?.siteTags ?? []"
      @close="siteDraft = null"
      @save="saveSite"
      @delete="deleteSite(siteDraft!.id!)"
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

    <ViewDialog
      v-if="viewDraft"
      :draft="viewDraft"
      :identities="store.identities"
      :sites="store.sites"
      :presets="store.viewLayoutPresets"
      @close="viewDraft = null"
      @save="saveView"
      @delete="store.deleteView(viewDraft!.id!); viewDraft = null"
    />

    <SessionHealthDialog v-if="healthOpen" @close="healthOpen = false" />

    <UpdateDialog
      v-if="updatePrompt"
      :result="updatePrompt"
      @dismissed="(version) => store.saveSettings({ dismissedUpdateVersion: version })"
      @close="updatePrompt = null"
    />

    <LayoutEditor
      v-if="layoutEditor"
      :preset="layoutEditor.preset"
      :seed="layoutEditor.seed"
      @close="layoutEditor = null"
      @save="saveLayout"
      @delete="layoutEditor.preset ? deleteLayout(layoutEditor.preset) : null"
    />

    <SpotlightTour
      :key="tourSession"
      :open="tourOpen"
      :steps="TOUR_STEPS"
      @navigate="handleTourNavigate"
      @close="finishTour"
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
  /* The rail collapses to an icon strip and the dock to a badge, so both sides
     size to their own content instead of to a fixed column. */
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.app-body.settings-mode {
  grid-template-columns: auto minmax(0, 1fr);
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
  /* Below this width the browser still needs room for two panes, so the dock
     gives up its fixed width first. */
  .app-body {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
}

@media (max-width: 900px) {
  .app-body {
    grid-template-columns: auto minmax(0, 1fr);
  }
}
</style>
