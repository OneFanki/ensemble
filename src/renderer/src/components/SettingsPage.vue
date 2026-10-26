<script setup lang="ts">
import type { ImportPreview, ImportResult } from "@shared/transfer";
import type { BundleImportResult, BundlePreview } from "@shared/accounts-transfer";
import { RELEASES_PAGE_URL, REPOSITORY_URL, type UpdateCheckResult } from "@shared/update";
import {
  Bot,
  Copy,
  Database,
  Download,
  ExternalLink,
  Github,
  Info,
  Monitor,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
} from "lucide-vue-next";
import type { Component } from "vue";
import { computed, onMounted, ref, watch } from "vue";
import { storeToRefs } from "pinia";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import { useWorkspaceStore } from "../stores/workspace";
import SelectField from "./SelectField.vue";
import AppButton from "./ui/AppButton.vue";

type SettingsTab = "general" | "engines" | "vault" | "data" | "mcp" | "about";

const tabs: Array<{ id: SettingsTab; labelKey: string; icon: Component }> = [
  { id: "general", labelKey: "app.settingsTabGeneral", icon: SlidersHorizontal },
  { id: "engines", labelKey: "app.settingsTabEngines", icon: Monitor },
  { id: "vault", labelKey: "app.settingsTabVault", icon: ShieldCheck },
  { id: "data", labelKey: "app.settingsTabData", icon: Database },
  { id: "mcp", labelKey: "app.settingsTabMcp", icon: Bot },
  { id: "about", labelKey: "app.settingsTabAbout", icon: Info },
];

const activeTab = ref<SettingsTab>("general");

/**
 * A tab requested from outside (the status bar's AI entry).
 *
 * Keyed on the request counter, not the tab id: the settings page stays mounted,
 * so returning to the requested tab after a manual change has to be a new
 * request even though the prop still names the same tab.
 */
const props = defineProps<{ tab?: SettingsTab; tabSeq?: number }>();
watch(
  () => props.tabSeq,
  () => {
    if (props.tab) activeTab.value = props.tab;
  },
  { immediate: true },
);

const emit = defineEmits<{
  theme: [theme: "dark" | "light" | "system"];
  locale: [locale: "zh" | "en"];
  startTour: [];
  updateFound: [result: UpdateCheckResult];
}>();

const store = useWorkspaceStore();
const confirm = useConfirmStore();
const { t } = useI18n();

const scanning = computed(() => store.busy === "scan");
const engines = computed(() => store.engines);

const unlockPassword = ref("");
const masterForm = ref<"set" | "change" | null>(null);
const currentPassword = ref("");
const nextPassword = ref("");
const confirmPassword = ref("");
const masterError = ref<string | null>(null);

// ---- data transfer ----
const includeSecrets = ref(false);
const exportPassphrase = ref("");
const importPreview = ref<{ path: string; preview: ImportPreview } | null>(null);
const importPassphrase = ref("");
const importResult = ref<ImportResult | null>(null);
const transferError = ref<string | null>(null);

// ---- MCP ----
// `storeToRefs`, not destructuring: a plain `const { mcp } = store` snapshots the
// value, so toggling the endpoint updated the main process while the segmented
// control kept rendering the old state.
const { mcp } = storeToRefs(store);
const portDraft = ref("");
const showToken = ref(false);

// ---- update check ----
const update = ref<UpdateCheckResult | null>(null);
const checkingUpdate = ref(false);

const updateTone = computed(() => {
  if (!update.value) return "muted";
  if (update.value.status === "available") return "warn";
  if (update.value.status === "error") return "error";
  return "ok";
});

const updateText = computed(() => {
  if (!update.value) return t("app.updateIdle");
  if (update.value.status === "current") {
    return t("app.updateCurrent", { version: update.value.current });
  }
  if (update.value.status === "available") {
    return t("app.updateAvailable", {
      current: update.value.current,
      latest: update.value.latest,
    });
  }
  return t("app.updateFailed");
});

async function checkUpdate() {
  checkingUpdate.value = true;
  try {
    const result = await window.ensemble.checkUpdate();
    update.value = result;
    // A manual check asks "is there one?" — the answer belongs in the update
    // dialog, not in a line of text the user then has to act on elsewhere.
    if (result.status === "available") emit("updateFound", result);
  } finally {
    checkingUpdate.value = false;
  }
}

async function openExternal(url: string) {
  await window.ensemble.openExternal(url);
}

const mcpSnippet = computed(() => {
  if (!mcp.value) return "";
  return JSON.stringify(
    {
      mcpServers: {
        ensemble: {
          type: "http",
          url: mcp.value.url,
          headers: { Authorization: `Bearer ${mcp.value.token}` },
        },
      },
    },
    null,
    2,
  );
});

onMounted(async () => {
  await store.mcpStatus();
  portDraft.value = String(mcp.value?.port ?? "");
});

async function refreshMcp(patch: Parameters<typeof store.updateMcp>[0]) {
  await store.updateMcp(patch);
}

async function updatePort() {
  const port = Number.parseInt(portDraft.value, 10);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    store.notify(t("app.mcpBadPort"), "error");
    return;
  }
  await refreshMcp({ port });
}

async function copyText(text: string, successKey = "app.toastCopied") {
  await navigator.clipboard.writeText(text);
  store.notify(t(successKey), "success");
}

async function doExport() {
  transferError.value = null;
  if (includeSecrets.value && exportPassphrase.value.length < 8) {
    transferError.value = t("app.exportPassphraseShort");
    return;
  }
  const outcome = await store.exportWorkspace({
    includeSecrets: includeSecrets.value,
    ...(includeSecrets.value ? { passphrase: exportPassphrase.value } : {}),
  });
  if (!outcome) return;
  if (outcome.canceled) return;
  exportPassphrase.value = "";
  store.notify(
    t("app.toastExportDone", {
      identities: outcome.counts?.identities ?? 0,
      secrets: outcome.secretsIncluded ? t("app.exportWithSecrets") : t("app.exportNoSecrets"),
    }),
    "success",
  );
}

async function doPickImport() {
  transferError.value = null;
  importResult.value = null;
  const picked = await store.pickImport();
  if (!picked || picked.canceled || !picked.preview) return;
  importPreview.value = { path: picked.path ?? "", preview: picked.preview };
}

async function doApplyImport() {
  transferError.value = null;
  if (importPreview.value?.preview.hasSecrets && importPassphrase.value.length === 0) {
    transferError.value = t("app.importNeedsPassphrase");
    return;
  }
  const result = await store.applyImport(
    importPreview.value?.preview.hasSecrets ? importPassphrase.value : undefined,
  );
  if (!result) return;
  importResult.value = result;
  importPreview.value = null;
  importPassphrase.value = "";
}

/* ---- account bundles: a colleague's shared logins, not a whole workspace ---- */
const accountsPreview = ref<{ path: string; preview: BundlePreview } | null>(null);
const accountsPassphrase = ref("");
const accountsResult = ref<BundleImportResult | null>(null);

async function pickAccountsImport(): Promise<void> {
  transferError.value = null;
  accountsResult.value = null;
  const picked = await window.ensemble.pickAccountsImport();
  if (picked.canceled || !picked.preview) return;
  accountsPreview.value = { path: picked.path ?? "", preview: picked.preview };
}

async function applyAccountsImport(): Promise<void> {
  transferError.value = null;
  if (accountsPreview.value?.preview.hasSecrets && accountsPassphrase.value.length === 0) {
    transferError.value = t("app.importNeedsPassphrase");
    return;
  }
  try {
    const outcome = await window.ensemble.applyAccountsImport(
      accountsPreview.value?.preview.hasSecrets ? accountsPassphrase.value : undefined,
    );
    accountsResult.value = outcome.result;
    accountsPreview.value = null;
    accountsPassphrase.value = "";
  } catch (error) {
    transferError.value = (error as Error).message;
  }
}

async function quitApp() {
  const accepted = await confirm.ask({
    title: t("app.confirmQuitTitle"),
    body: t("app.quitConfirm"),
    confirmLabel: t("app.confirmQuitAction"),
    tone: "danger",
  });
  if (!accepted) return;
  await window.ensemble.quitApp();
}

const canSubmitMaster = computed(
  () =>
    nextPassword.value.length >= 8 &&
    nextPassword.value === confirmPassword.value &&
    (masterForm.value === "set" || currentPassword.value.length > 0),
);

function statusLabel(status: string): string {
  if (status === "ready") return t("app.available");
  if (status === "blocked") return t("app.unavailable");
  return t("app.unverified");
}

/**
 * Choices for the one browser external launches use.
 *
 * "Automatic" is first and is the default, so a fresh install launches without
 * anyone opening this page. A blocked engine stays listed but disabled: hiding
 * it would make a launch fail with "no browser" while the browser sits right
 * there in the same list.
 */
const defaultBrowserOptions = computed(() => [
  { value: "__auto__", label: t("app.autoPickEngine") },
  ...engines.value.map((engine) => ({
    value: engine.id,
    label: `${engine.brand} ${engine.version ?? ""}`.trim(),
    hint:
      engine.status === "blocked"
        ? t("app.engineBlockedSuffix").trim()
        : !engine.cdp
          ? t("app.engineExternalSuffix").trim()
          : t("app.cdpMode"),
    disabled: engine.status === "blocked",
  })),
]);

async function submitUnlock() {
  const unlocked = await store.unlockVault(unlockPassword.value);
  if (unlocked) unlockPassword.value = "";
}

function toggleMasterForm(mode: "set" | "change") {
  masterForm.value = masterForm.value === mode ? null : mode;
  currentPassword.value = "";
  nextPassword.value = "";
  confirmPassword.value = "";
  masterError.value = null;
}

function resetMasterForm() {
  masterForm.value = null;
  currentPassword.value = "";
  nextPassword.value = "";
  confirmPassword.value = "";
  masterError.value = null;
}

async function submitMaster() {
  masterError.value = null;
  if (nextPassword.value !== confirmPassword.value) {
    masterError.value = t("app.masterMismatch");
    return;
  }
  if (masterForm.value === "set") {
    await store.setMasterPassword(nextPassword.value);
    resetMasterForm();
    return;
  }
  const changed = await store.changeMasterPassword(currentPassword.value, nextPassword.value);
  if (changed) resetMasterForm();
  else masterError.value = t("app.wrongMaster");
}
</script>

<template>
  <section class="settings">
    <header class="head">
      <div>
        <h1>{{ $t("app.settings") }}</h1>
        <p class="head-note">{{ $t("app.settingsSubtitle") }}</p>
      </div>
    </header>

    <nav class="tabs" role="tablist" :aria-label="$t('app.settings')">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        role="tab"
        class="tab"
        :class="{ active: activeTab === tab.id }"
        :aria-selected="activeTab === tab.id"
        @click="activeTab = tab.id"
      >
        <component :is="tab.icon" :size="13" />
        <span>{{ $t(tab.labelKey) }}</span>
      </button>
    </nav>

    <div class="scroll">
      <section v-if="activeTab === 'engines'" class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.engineList") }}</h2>
            <p>{{ $t("app.engineHint") }}</p>
          </div>
          <div class="block-actions">
            <AppButton :disabled="scanning" @click="store.addManualEngine()">
              <Plus :size="12" />
              {{ $t("app.addManual") }}
            </AppButton>
            <AppButton :disabled="scanning" @click="store.scanEngines()">
              <RefreshCw :size="12" :class="{ spin: scanning }" />
              {{ scanning ? $t("app.scanning") : $t("app.scanAgain") }}
            </AppButton>
          </div>
        </div>

        <!-- The one browser external launches use. It replaced a per-site field:
             the title bar shows a single browser, so the setting behind it has
             to be single too, or the same switch routes differently per account. -->
        <div class="option-row">
          <span class="option-label">{{ $t("app.defaultBrowser") }}</span>
          <div class="select-slot wide-select">
            <SelectField
              :model-value="store.settings.defaultEngineId ?? '__auto__'"
              :options="defaultBrowserOptions"
              @update:model-value="
                store.saveSettings({
                  defaultEngineId: $event === '__auto__' ? undefined : $event,
                })
              "
            />
          </div>
        </div>
        <p class="fineprint">{{ $t("app.defaultBrowserNote") }}</p>

        <div class="engine-table">
          <div class="engine-head">
            <span>{{ $t("app.tableBrowser") }}</span>
            <span>{{ $t("app.tableVersion") }}</span>
            <span>{{ $t("app.tableCapability") }}</span>
            <span>{{ $t("app.tableSource") }}</span>
            <span></span>
          </div>
          <div v-for="engine in engines" :key="engine.id" class="engine-row">
            <span class="e-brand">
              <span class="e-dot" :class="{ blocked: engine.status === 'blocked' }"></span>
              {{ engine.brand }}
            </span>
            <span class="mono e-version">{{ engine.version ?? "—" }}</span>
            <span class="e-capability">
              <span v-if="engine.status === 'blocked'" class="cap blocked">{{ statusLabel(engine.status) }}</span>
              <span v-else-if="engine.cdp" class="cap cdp">CDP</span>
              <span v-else class="cap external">{{ $t("app.externalOnly") }}</span>
            </span>
            <span class="mono e-source">{{ engine.source }}</span>
            <span class="e-actions">
              <button
                v-if="engine.source === 'manual'"
                class="link"
                type="button"
                @click="store.removeManualEngine(engine.exePath)"
              >
                ▲
              </button>
            </span>
          </div>
          <div v-if="!engines.length && !store.enginesReady" class="engine-empty">
            <RefreshCw :size="18" class="spin" />
            <span>{{ $t("app.scanningInstalled") }}</span>
          </div>
          <div v-else-if="!engines.length" class="engine-empty">
            <Monitor :size="18" />
            <span>{{ $t("app.noBrowsersHint") }}</span>
            <div class="links">
              <a href="https://www.google.com/chrome/" target="_blank" rel="noreferrer">
                <Download :size="11" /> Chrome
              </a>
              <a href="https://www.microsoft.com/edge" target="_blank" rel="noreferrer">
                <Download :size="11" /> Edge
              </a>
              <a href="https://brave.com/download/" target="_blank" rel="noreferrer">
                <Download :size="11" /> Brave
              </a>
            </div>
          </div>
        </div>

        <p class="fineprint">
          {{ $t("app.engineCapabilityNote") }}
        </p>
      </section>

      <section v-if="activeTab === 'general'" class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.appearanceTitle") }}</h2>
            <p>{{ $t("app.appearanceNote") }}</p>
          </div>
        </div>
        <div class="option-row">
          <span class="option-label">{{ $t("app.theme") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.theme === 'dark' }"
              @click="emit('theme', 'dark')"
            >
              {{ $t("app.themeDark") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.theme === 'light' }"
              @click="emit('theme', 'light')"
            >
              {{ $t("app.themeLight") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.theme === 'system' }"
              @click="emit('theme', 'system')"
            >
              {{ $t("app.themeSystem") }}
            </button>
          </div>
        </div>
        <div class="option-row">
          <span class="option-label">{{ $t("app.language") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.locale === 'zh' }"
              @click="emit('locale', 'zh')"
            >
              {{ $t("app.languageZh") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.locale === 'en' }"
              @click="emit('locale', 'en')"
            >
              English
            </button>
          </div>
        </div>
        <div class="option-row">
          <span class="option-label">{{ $t("app.defaultLayout") }}</span>
          <div class="select-slot">
            <SelectField
              :model-value="store.settings.layout"
              :options="
                store.layoutPresets.map((preset) => ({
                  value: preset.id,
                  label: store.presetName(preset),
                }))
              "
              @update:model-value="
                store.saveSettings({ layout: $event ?? store.settings.layout })
              "
            />
          </div>
        </div>
        <p class="fineprint">{{ $t("app.defaultLayoutNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.browserZoomSetting") }}</span>
          <div class="interval">
            <input
              class="input mono interval-input"
              type="number"
              min="50"
              max="200"
              step="5"
              :value="store.settings.browserZoom"
              @change="
                store.saveSettings({
                  browserZoom: Math.min(
                    200,
                    Math.max(
                      50,
                      Math.round(Number(($event.target as HTMLInputElement).value)) || 100,
                    ),
                  ),
                })
              "
            />
            <span class="unit mono">%</span>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.browserZoomNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.searchEngineSetting") }}</span>
          <div class="select-slot">
            <SelectField
              :model-value="store.settings.searchEngineId"
              :options="
                store.searchEngines.map((engine) => ({ value: engine.id, label: engine.name }))
              "
              @update:model-value="
                store.saveSettings({
                  searchEngineId: $event ?? store.settings.searchEngineId,
                })
              "
            />
          </div>
        </div>
        <p class="fineprint">{{ $t("app.searchEngineNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.bookmarkShowTitle") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.newTabBookmarks }"
              @click="store.saveSettings({ newTabBookmarks: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.newTabBookmarks }"
              @click="store.saveSettings({ newTabBookmarks: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.bookmarkShowHint") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.launchInterval") }}</span>
          <div class="interval">
            <input
              class="input mono interval-input"
              type="number"
              min="0"
              max="5000"
              step="50"
              :value="store.settings.launchIntervalMs"
              @change="
                store.saveSettings({
                  launchIntervalMs: Math.min(
                    5000,
                    Math.max(0, Number(($event.target as HTMLInputElement).value) || 0),
                  ),
                })
              "
            />
            <span class="unit mono">ms</span>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.launchIntervalNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.autoFillLaunch") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.autoFillOnLaunch }"
              @click="store.saveSettings({ autoFillOnLaunch: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.autoFillOnLaunch }"
              @click="store.saveSettings({ autoFillOnLaunch: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">
          {{ $t("app.autoFillLaunchNote") }}
        </p>
        <!--
          Auto-submit is its own switch, next to autofill but not part of it:
          "type my password in" and "press the button for me" are two decisions,
          and someone may want the first without the second (a site with a
          captcha, or one that locks the account after a couple of tries). A site
          can override this in its own dialog; that override is the exception, so
          the normal answer belongs here.
        -->
        <div class="option-row">
          <span class="option-label">{{ $t("app.autoSubmitLabel") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.autoSubmitLogin }"
              @click="store.saveSettings({ autoSubmitLogin: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.autoSubmitLogin }"
              @click="store.saveSettings({ autoSubmitLogin: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">
          {{ $t("app.autoSubmitNote") }}
        </p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.restoreView") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.restoreLastView }"
              @click="store.saveSettings({ restoreLastView: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.restoreLastView }"
              @click="store.saveSettings({ restoreLastView: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.restoreViewNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.autoUpdateSetting") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.autoCheckUpdates }"
              @click="store.saveSettings({ autoCheckUpdates: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.autoCheckUpdates }"
              @click="store.saveSettings({ autoCheckUpdates: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.autoUpdateNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.overlaySetting") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.overlayEnabled }"
              @click="store.saveSettings({ overlayEnabled: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.overlayEnabled }"
              @click="store.saveSettings({ overlayEnabled: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.overlaySettingNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.focusLabelSetting") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.focusLabelEnabled }"
              @click="store.saveSettings({ focusLabelEnabled: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.focusLabelEnabled }"
              @click="store.saveSettings({ focusLabelEnabled: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.focusLabelSettingNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.headlessUaSetting") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.headlessCheckUa === 'desktop' }"
              @click="store.saveSettings({ headlessCheckUa: 'desktop' })"
            >
              {{ $t("app.headlessUaDesktop") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.headlessCheckUa === 'headless' }"
              @click="store.saveSettings({ headlessCheckUa: 'headless' })"
            >
              {{ $t("app.headlessUaHeadless") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.headlessUaNote") }}</p>
        <div class="option-row">
          <span class="option-label">{{ $t("app.tourLabel") }}</span>
          <AppButton @click="emit('startTour')">
            {{ $t("app.tourReplay") }}
          </AppButton>
        </div>
        <p class="fineprint">{{ $t("app.tourReplayNote") }}</p>
      </section>

      <section v-if="activeTab === 'vault'" class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.vaultTitle") }}</h2>
            <p>{{ $t("app.vaultNote") }}</p>
          </div>
        </div>
        <div class="vault-row">
          <ShieldCheck v-if="store.credentials?.secure" :size="16" class="vault-icon ok" />
          <ShieldAlert v-else :size="16" class="vault-icon warn" />
          <div class="vault-copy">
            <span class="vault-title">
              {{ store.credentials?.secure ? $t("app.secure") : $t("app.insecure") }}
            </span>
            <span class="mono vault-backend">{{ store.credentials?.backend ?? "unknown" }}</span>
          </div>
          <span v-if="store.credentials?.warning" class="vault-warning">
            {{ store.credentials.warning }}
          </span>
        </div>

        <div v-if="store.credentials?.locked" class="vault-unlock">
          <input
            v-model="unlockPassword"
            type="password"
            class="input mono"
            :placeholder="$t('app.vaultUnlockPlaceholder')"
            autocomplete="current-password"
            @keyup.enter="submitUnlock"
          />
          <AppButton variant="primary" :disabled="!unlockPassword" @click="submitUnlock">
            {{ $t("app.unlock") }}
          </AppButton>
        </div>

        <div v-else-if="store.credentials?.mode === 'master'" class="vault-actions">
          <AppButton @click="toggleMasterForm('change')">{{ $t("app.changeMaster") }}</AppButton>
          <AppButton @click="store.lockVault()">{{ $t("app.lockNow") }}</AppButton>
          <AppButton v-if="store.credentials.canManageMaster"
            @click="store.removeMasterPassword()">
            {{ $t("app.backToKeychain") }}
          </AppButton>
        </div>

        <div v-else-if="store.credentials?.canManageMaster" class="vault-actions">
          <AppButton @click="toggleMasterForm('set')">{{ $t("app.setMaster") }}</AppButton>
        </div>

        <div v-if="masterForm" class="master-form">
          <input
            v-if="masterForm === 'change'"
            v-model="currentPassword"
            type="password"
            class="input mono"
            :placeholder="$t('app.currentMaster')"
            autocomplete="current-password"
          />
          <input
            v-model="nextPassword"
            type="password"
            class="input mono"
            :placeholder="masterForm === 'set' ? $t('app.setMasterPlaceholder') : $t('app.newMaster')"
            autocomplete="new-password"
          />
          <input
            v-model="confirmPassword"
            type="password"
            class="input mono"
            :placeholder="$t('app.repeatPassword')"
            autocomplete="new-password"
          />
          <div class="vault-actions">
            <AppButton variant="primary" :disabled="!canSubmitMaster" @click="submitMaster">
              {{ masterForm === "set" ? $t("app.enableMaster") : $t("app.saveNewMaster") }}
            </AppButton>
            <AppButton @click="resetMasterForm">{{ $t("app.cancel") }}</AppButton>
          </div>
          <p v-if="masterError" class="error" role="alert">{{ masterError }}</p>
        </div>

        <p class="fineprint">
          {{ $t("app.vaultExplainer") }}
        </p>
      </section>

      <section v-if="activeTab === 'data'" class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.dataTitle") }}</h2>
            <p>{{ $t("app.dataNote") }}</p>
          </div>
        </div>

        <div class="option-row">
          <span class="option-label">{{ $t("app.closeToTray") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: store.settings.closeToTray }"
              @click="store.saveSettings({ closeToTray: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: !store.settings.closeToTray }"
              @click="store.saveSettings({ closeToTray: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.closeToTrayNote") }}</p>

        <div class="transfer">
          <div class="transfer-col">
            <h3>{{ $t("app.exportTitle") }}</h3>
            <label class="check">
              <input v-model="includeSecrets" type="checkbox" />
              <span>{{ $t("app.exportIncludeSecrets") }}</span>
            </label>
            <input
              v-if="includeSecrets"
              v-model="exportPassphrase"
              type="password"
              class="input mono"
              :placeholder="$t('app.exportPassphrasePlaceholder')"
              autocomplete="new-password"
            />
            <AppButton variant="primary" :disabled="store.busy === 'transfer'" @click="doExport">
              <Download :size="12" />
              {{ $t("app.exportAction") }}
            </AppButton>
            <p class="fineprint">{{ $t("app.exportNote") }}</p>
          </div>

          <div class="transfer-col">
            <h3>{{ $t("app.importTitle") }}</h3>
            <div v-if="importPreview" class="preview-box">
              <p class="preview-name mono">{{ importPreview.path }}</p>
              <dl class="preview-counts">
                <div><dt>{{ $t("app.sites") }}</dt><dd class="mono">{{ importPreview.preview.sites }}</dd></div>
                <div><dt>{{ $t("app.identities") }}</dt><dd class="mono">{{ importPreview.preview.identities }}</dd></div>
                <div><dt>{{ $t("app.views") }}</dt><dd class="mono">{{ importPreview.preview.views }}</dd></div>
                <div><dt>{{ $t("app.layoutPresets") }}</dt><dd class="mono">{{ importPreview.preview.layoutPresets }}</dd></div>
              </dl>
              <input
                v-if="importPreview.preview.hasSecrets"
                v-model="importPassphrase"
                type="password"
                class="input mono"
                :placeholder="$t('app.importPassphrasePlaceholder')"
                autocomplete="current-password"
              />
              <div class="vault-actions">
                <AppButton variant="primary" :disabled="store.busy === 'transfer'"
                  @click="doApplyImport">
                  {{ $t("app.importApply") }}
                </AppButton>
                <AppButton @click="importPreview = null">
                  {{ $t("app.cancel") }}
                </AppButton>
              </div>
            </div>
            <AppButton v-else :disabled="store.busy === 'transfer'" @click="doPickImport">
              <Upload :size="12" />
              {{ $t("app.importPick") }}
            </AppButton>
            <p v-if="importResult" class="fineprint">
              {{
                $t("app.importResult", {
                  added: importResult.added,
                  updated: importResult.updated,
                  skipped: importResult.skipped,
                })
              }}
            </p>
            <p class="fineprint">{{ $t("app.importNote") }}</p>
          </div>

          <!-- A colleague's shared logins. Not a workspace file: it lands by
               site URL and username, and carries only the accounts they chose. -->
          <div class="transfer-col">
            <h3>{{ $t("app.accountsImportTitle") }}</h3>
            <div v-if="accountsPreview" class="preview-box">
              <p class="preview-name mono">{{ accountsPreview.path }}</p>
              <dl class="preview-counts">
                <div><dt>{{ $t("app.sites") }}</dt><dd class="mono">{{ accountsPreview.preview.sites }}</dd></div>
                <div><dt>{{ $t("app.identities") }}</dt><dd class="mono">{{ accountsPreview.preview.accounts }}</dd></div>
                <div>
                  <dt>{{ $t("app.accountsImportWithPasswords") }}</dt>
                  <dd class="mono">{{ accountsPreview.preview.withPasswords }}</dd>
                </div>
              </dl>
              <p v-if="accountsPreview.preview.matchingSites.length" class="fineprint">
                {{ $t("app.accountsImportMatching", { names: accountsPreview.preview.matchingSites.join("、") }) }}
              </p>
              <input
                v-if="accountsPreview.preview.hasSecrets"
                v-model="accountsPassphrase"
                type="password"
                class="input mono"
                :placeholder="$t('app.importPassphrasePlaceholder')"
                autocomplete="current-password"
              />
              <div class="vault-actions">
                <AppButton variant="primary" @click="applyAccountsImport">
                  {{ $t("app.importApply") }}
                </AppButton>
                <AppButton @click="accountsPreview = null">
                  {{ $t("app.cancel") }}
                </AppButton>
              </div>
            </div>
            <AppButton v-else @click="pickAccountsImport">
              <Upload :size="12" />
              {{ $t("app.accountsImportPick") }}
            </AppButton>
            <p v-if="accountsResult" class="fineprint">
              {{
                $t("app.accountsImportResult", {
                  added: accountsResult.accountsAdded,
                  updated: accountsResult.accountsUpdated,
                  passwords: accountsResult.passwordsWritten,
                })
              }}
            </p>
            <p class="fineprint">{{ $t("app.accountsImportNote") }}</p>
          </div>
        </div>
        <p v-if="transferError" class="error" role="alert">{{ transferError }}</p>
      </section>

      <section v-if="activeTab === 'mcp'" class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.mcpTitle") }}</h2>
            <p>{{ $t("app.mcpNote") }}</p>
          </div>
          <div class="block-actions">
            <span class="status-chip" :class="{ on: mcp?.running }">
              {{ mcp?.running ? $t("app.mcpRunning") : $t("app.mcpStopped") }}
            </span>
          </div>
        </div>

        <div class="option-row">
          <span class="option-label">{{ $t("app.mcpEnable") }}</span>
          <div class="segmented">
            <button
              type="button"
              class="seg"
              :class="{ on: mcp?.enabled }"
              @click="refreshMcp({ enabled: true })"
            >
              {{ $t("app.on") }}
            </button>
            <button
              type="button"
              class="seg"
              :class="{ on: mcp ? !mcp.enabled : false }"
              @click="refreshMcp({ enabled: false })"
            >
              {{ $t("app.off") }}
            </button>
          </div>
        </div>

        <div class="option-row">
          <span class="option-label">{{ $t("app.mcpPort") }}</span>
          <input v-model="portDraft" class="input mono port-input" inputmode="numeric" />
          <AppButton @click="updatePort">{{ $t("app.mcpApplyPort") }}</AppButton>
        </div>

        <div class="option-row">
          <span class="option-label">{{ $t("app.mcpPermissions") }}</span>
          <div class="perm-row">
            <label class="check">
              <input
                type="checkbox"
                :checked="mcp?.allowWrite"
                @change="refreshMcp({ allowWrite: ($event.target as HTMLInputElement).checked })"
              />
              <span>{{ $t("app.mcpAllowWrite") }}</span>
            </label>
            <label class="check">
              <input
                type="checkbox"
                :checked="mcp?.allowRun"
                @change="refreshMcp({ allowRun: ($event.target as HTMLInputElement).checked })"
              />
              <span>{{ $t("app.mcpAllowRun") }}</span>
            </label>
            <label class="check danger">
              <input
                type="checkbox"
                :checked="mcp?.allowDelete"
                @change="refreshMcp({ allowDelete: ($event.target as HTMLInputElement).checked })"
              />
              <span>{{ $t("app.mcpAllowDelete") }}</span>
            </label>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.mcpPermissionNote") }}</p>

        <!--
          Origins where the AI may act inside the daily profile. Listed here as
          well as in the browser toolbar because this is where the user thinks
          about what the AI is allowed to do; the toolbar entry exists because
          that is where they notice it needs granting.
        -->
        <div v-if="mcp" class="origin-block">
          <span class="origin-label">{{ $t("app.mcpAiOrigins") }}</span>
          <div class="origin-list">
            <span v-if="!mcp.aiOrigins.length" class="origin-empty">
              {{ $t("app.mcpAiOriginsEmpty") }}
            </span>
            <span v-for="origin in mcp.aiOrigins" :key="origin" class="origin-chip mono">
              {{ origin }}
              <button
                type="button"
                class="origin-remove"
                :aria-label="$t('app.mcpAiOriginRevoke')"
                @click="refreshMcp({ aiOrigin: { origin, allowed: false } })"
              >
                <X :size="10" />
              </button>
            </span>
          </div>
        </div>
        <p class="fineprint">{{ $t("app.mcpAiOriginsNote") }}</p>

        <div v-if="mcp" class="mcp-endpoint">
          <p class="fineprint">{{ $t("app.mcpEndpoint") }}</p>
          <div class="copy-row">
            <code class="mono">{{ mcp.url }}</code>
            <AppButton @click="copyText(mcp.url)">
              <Copy :size="11" />
              {{ $t("app.copyUrl") }}
            </AppButton>
          </div>
          <div class="copy-row">
            <code class="mono token">{{ showToken ? mcp.token : "•".repeat(28) }}</code>
            <AppButton @click="showToken = !showToken">
              {{ showToken ? $t("app.hide") : $t("app.show") }}
            </AppButton>
            <AppButton @click="copyText(mcp.token, 'app.toastTokenCopied')">
              <Copy :size="11" />
              {{ $t("app.copyToken") }}
            </AppButton>
            <AppButton variant="danger" @click="refreshMcp({ rotateToken: true })">
              {{ $t("app.mcpRotate") }}
            </AppButton>
          </div>
          <p class="fineprint">{{ $t("app.mcpTokenNote") }}</p>

          <details class="snippet">
            <summary>{{ $t("app.mcpConfigTitle") }}</summary>
            <pre class="mono">{{ mcpSnippet }}</pre>
            <AppButton @click="copyText(mcpSnippet, 'app.toastSnippetCopied')">
              <Bot :size="11" />
              {{ $t("app.mcpCopyConfig") }}
            </AppButton>
          </details>
        </div>
        <p v-if="mcp?.error" class="error" role="alert">{{ mcp.error }}</p>
      </section>

      <section v-if="activeTab === 'about'" class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.about") }}</h2>
            <p>{{ $t("app.aboutTagline") }}</p>
          </div>
          <div class="block-actions">
            <AppButton variant="danger" @click="quitApp">{{ $t("app.quitApp") }}</AppButton>
          </div>
        </div>
        <dl class="about">
          <div><dt>{{ $t("app.version") }}</dt><dd class="mono">{{ store.snapshot?.appVersion }}</dd></div>
          <div><dt>{{ $t("app.platform") }}</dt><dd class="mono">{{ store.snapshot?.platform }}</dd></div>
          <div><dt>{{ $t("app.dataDir") }}</dt><dd class="mono">{{ store.snapshot?.userDataDir }}</dd></div>
          <div><dt>{{ $t("app.profileRoot") }}</dt><dd class="mono">{{ store.snapshot?.userDataDir }}\profiles</dd></div>
        </dl>

        <div class="update-row">
          <div class="update-copy">
            <p class="update-state" :class="updateTone">
              {{ updateText }}
            </p>
            <p v-if="update?.status === 'available'" class="update-hint">
              {{ $t("app.updateManualHint") }}
            </p>          </div>
          <div class="update-actions">
            <AppButton :disabled="checkingUpdate"
              @click="checkUpdate">
              <RefreshCw :size="12" :class="{ spinning: checkingUpdate }" />
              {{ checkingUpdate ? $t("app.updateChecking") : $t("app.updateCheck") }}
            </AppButton>
            <AppButton @click="openExternal(update?.url ?? RELEASES_PAGE_URL)">
              <ExternalLink :size="12" />
              {{ $t("app.openReleases") }}
            </AppButton>
            <AppButton @click="openExternal(REPOSITORY_URL)">
              <Github :size="12" />
              {{ $t("app.openRepository") }}
            </AppButton>
          </div>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
.settings {
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 18px 20px 12px;
  overflow: hidden;
}

.head h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 500;
  letter-spacing: -0.015em;
}

.head p {
  margin: 6px 0 0;
  font-size: 11.5px;
  color: var(--faint);
}

/*
 * No `overflow` here on purpose: `overflow-x: auto` also computes overflow-y to
 * auto, and the 1px negative margin used to overlap the active underline made
 * the row 1px taller than its box — enough to render a vertical scrollbar that
 * covered the bottom rule. Wrapping keeps every tab reachable on narrow windows.
 */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  margin-top: 14px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
  overflow: visible;
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 11px;
  border-bottom: 1px solid transparent;
  margin-bottom: -1px;
  color: var(--faint);
  font-size: 11.5px;
  white-space: nowrap;
}

.tab:hover {
  color: var(--text-secondary);
}

/*
 * The active tab is marked by the underline plus color, not by a filled pill:
 * with six tabs a pill per item made the row look like a button bar.
 */
.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.scroll {
  margin-top: 14px;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-right: 2px;
}

.block {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 14px 16px;
}

.block-head {
  display: flex;
  align-items: flex-start;
  gap: 14px;
}

.block-head h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 500;
}

.block-head p {
  margin: 5px 0 0;
  font-size: 11.5px;
  color: var(--faint);
  line-height: 1.55;
  max-width: 620px;
}

.block-actions {
  margin-left: auto;
  display: flex;
  gap: 7px;
  flex: 0 0 auto;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.engine-table {
  margin-top: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  overflow: hidden;
}

.engine-head,
.engine-row {
  display: grid;
  grid-template-columns: minmax(0, 1.4fr) 76px 110px 90px 28px;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
}

.engine-head {
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--faint);
  background: var(--bg-elevated);
  border-bottom: 1px solid var(--line-soft);
}

.engine-row {
  font-size: 11.5px;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--line-soft);
}

.engine-row:last-child {
  border-bottom: 0;
}

.engine-row:hover {
  background: var(--surface-2);
}

.e-brand {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.e-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--green);
  flex: 0 0 5px;
}

.e-dot.blocked {
  background: var(--faint);
}

.e-version,
.e-source {
  font-size: 11px;
  color: var(--muted);
}

.cap {
  font-size: 10.5px;
  border: 1px solid var(--line);
  border-radius: 3px;
  padding: 2px 5px;
}

.cap.cdp {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 36%, var(--line));
}

.cap.external {
  color: var(--accent);
  border-color: color-mix(in srgb, var(--accent) 32%, var(--line));
}

.cap.blocked {
  color: var(--faint);
}

.e-actions {
  display: flex;
  justify-content: flex-end;
}

.link {
  color: var(--faint);
  font-size: 11px;
}

.link:hover {
  color: var(--red);
}

.engine-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 9px;
  padding: 26px 16px;
  color: var(--muted);
  font-size: 11px;
  text-align: center;
}

.links {
  display: flex;
  gap: 10px;
}

.links a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
}

.fineprint {
  margin: 10px 0 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--faint);
}

.option-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 12px;
}

.option-label {
  font-size: 11px;
  color: var(--muted);
  /* Wide enough for the longest label ("Restore last view on start") so the
     switch column stays aligned instead of every row drifting. */
  flex: 0 0 132px;
}

.select-slot {
  width: 170px;
}

/* The engine list carries versions ("Microsoft Edge 155.0.4283.62"), which do
   not fit 170px and would truncate the part that tells two installs apart. */
.wide-select {
  width: 280px;
}

.interval {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.interval-input {
  width: 90px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 6px 8px;
  outline: 0;
}

.interval-input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.unit {
  font-size: 10.5px;
  color: var(--faint);
}

.segmented {
  display: flex;
  gap: 2px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 2px;
}

.seg {
  padding: 5px 10px;
  border-radius: 3px;
  font-size: 11px;
  color: var(--muted);
}

.seg.on {
  background: var(--surface-3);
  color: var(--text);
}

.vault-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 10px 12px;
}

.vault-icon.ok {
  color: var(--green);
}

.vault-icon.warn {
  color: var(--accent);
}

.vault-copy {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.vault-title {
  font-size: 11.5px;
}

.vault-backend {
  font-size: 10.5px;
  color: var(--faint);
}

.vault-warning {
  margin-left: auto;
  max-width: 55%;
  font-size: 11px;
  line-height: 1.5;
  color: var(--accent);
}

.vault-unlock,
.vault-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.vault-unlock .input {
  flex: 1 1 220px;
}

.master-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 10px;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 10px 12px;
}

.master-form .input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 6px 9px;
  font-size: 11px;
  color: var(--text);
  outline: 0;
}

.master-form .input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

/* ---- data transfer ---- */

.transfer {
  display: grid;
  /* Three groups now (workspace export, workspace import, account import), but
     they wrap rather than squeeze: each column has a form in it. */
  grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
  gap: 12px;
  margin-top: 12px;
}

.transfer-col {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 11px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.transfer-col h3 {
  margin: 0;
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-secondary);
}

.transfer-col .input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface);
  padding: 6px 9px;
  font-size: 11px;
  color: var(--text);
  outline: 0;
}

.transfer-col .input:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
}

.check {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  font-size: 11px;
  color: var(--muted);
  line-height: 1.5;
  cursor: pointer;
}

.check input {
  margin-top: 2px;
}

.check.danger {
  color: color-mix(in srgb, var(--red) 80%, var(--text));
}

.preview-box {
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--line));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--accent) 5%, var(--surface));
  padding: 9px 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.preview-name {
  margin: 0;
  font-size: 10px;
  color: var(--faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-counts {
  margin: 0;
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
}

.preview-counts dt {
  font-size: 9.5px;
  color: var(--faint);
}

.preview-counts dd {
  margin: 2px 0 0;
  font-size: 11.5px;
  color: var(--text-secondary);
}

/* ---- MCP ---- */

.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  color: var(--faint);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 3px 9px;
}

.status-chip::before {
  content: "";
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--faint);
}

.status-chip.on {
  color: var(--green);
  border-color: color-mix(in srgb, var(--green) 40%, var(--line));
}

.status-chip.on::before {
  background: var(--green);
}

.port-input {
  width: 100px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 5px 8px;
  font-size: 11px;
  color: var(--text-secondary);
  outline: 0;
}

.perm-row {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}

/* One chip per authorized origin; the cross is the revoke, so the list itself
   doubles as the place a mistake gets undone. The label sits above the chips
   rather than beside them: it is a sentence, not a one-word field name, and
   squeezing it into the 132px label column wrapped it into two lines. */
.origin-block {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 14px;
}

/* Its own class rather than `.option-label`: that one carries a 132px
   `flex-basis` that aligns a row's switch column, and inside this column it
   would apply to the height, leaving a large empty band above the chips. */
.origin-label {
  font-size: 11px;
  color: var(--muted);
}

.origin-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}

.origin-empty {
  font-size: 11px;
  color: var(--faint);
}

.origin-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 4px 0 8px;
  border: 1px solid var(--line-soft);
  border-radius: 999px;
  background: var(--surface-2);
  font-size: 10.5px;
  color: var(--text-secondary);
}

.origin-remove {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  color: var(--faint);
}

.origin-remove:hover {
  background: color-mix(in srgb, var(--red) 18%, transparent);
  color: var(--red);
}

.mcp-endpoint {
  margin-top: 12px;
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.copy-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}

.copy-row code {
  flex: 0 1 auto;
  max-width: 100%;
  border: 1px solid var(--line-soft);
  border-radius: 4px;
  background: var(--bg-elevated);
  padding: 4px 8px;
  font-size: 10.5px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-row code.token {
  min-width: 200px;
  letter-spacing: 0.04em;
}

.snippet {
  margin-top: 4px;
}

.snippet summary {
  font-size: 10.5px;
  color: var(--faint);
  cursor: pointer;
}

.snippet pre {
  margin: 7px 0;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 9px 10px;
  font-size: 10.5px;
  line-height: 1.55;
  color: var(--text-secondary);
  overflow-x: auto;
  user-select: text;
}

.about {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px 18px;
  margin: 12px 0 0;
}

.about div {
  display: flex;
  gap: 10px;
  align-items: baseline;
  min-width: 0;
}

.about dt {
  font-size: 10.5px;
  color: var(--faint);
  letter-spacing: 0.06em;
  min-width: 70px;
}

.about dd {
  margin: 0;
  font-size: 11px;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.update-row {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line-soft);
  display: flex;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}

.update-copy {
  min-width: 0;
  flex: 1 1 260px;
}

.update-state {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.6;
}

.update-state.muted {
  color: var(--faint);
}

.update-state.ok {
  color: var(--green);
}

.update-state.warn {
  color: var(--accent);
}

.update-state.error {
  color: var(--red);
}

.update-hint {
  margin: 4px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--faint);
}

.update-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  flex-wrap: wrap;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@media (max-width: 1000px) {
  .about {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
