<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { Download, Monitor, Plus, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

const emit = defineEmits<{
  theme: [theme: "dark" | "light" | "system"];
  locale: [locale: "zh" | "en"];
}>();

const store = useWorkspaceStore();
const { t } = useI18n();

const scanning = computed(() => store.busy === "scan");
const engines = computed(() => store.engines);

const unlockPassword = ref("");
const masterForm = ref<"set" | "change" | null>(null);
const currentPassword = ref("");
const nextPassword = ref("");
const confirmPassword = ref("");
const masterError = ref<string | null>(null);

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

    <div class="scroll">
      <section class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.engineList") }}</h2>
            <p>{{ $t("app.engineHint") }}</p>
          </div>
          <div class="block-actions">
            <button class="btn" type="button" :disabled="scanning" @click="store.addManualEngine()">
              <Plus :size="12" />
              {{ $t("app.addManual") }}
            </button>
            <button class="btn" type="button" :disabled="scanning" @click="store.scanEngines()">
              <RefreshCw :size="12" :class="{ spin: scanning }" />
              {{ scanning ? $t("app.scanning") : $t("app.scanAgain") }}
            </button>
          </div>
        </div>

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

      <section class="block">
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
          <select
            class="input select-inline"
            :value="store.settings.layout"
            @change="store.saveSettings({ layout: ($event.target as HTMLSelectElement).value })"
          >
            <option v-for="preset in store.layoutPresets" :key="preset.id" :value="preset.id">
              {{ store.presetName(preset) }}
            </option>
          </select>
        </div>
        <p class="fineprint">{{ $t("app.defaultLayoutNote") }}</p>
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
      </section>

      <section class="block">
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
          <button class="btn primary" type="button" :disabled="!unlockPassword" @click="submitUnlock">
            {{ $t("app.unlock") }}
          </button>
        </div>

        <div v-else-if="store.credentials?.mode === 'master'" class="vault-actions">
          <button class="btn" type="button" @click="toggleMasterForm('change')">{{ $t("app.changeMaster") }}</button>
          <button class="btn" type="button" @click="store.lockVault()">{{ $t("app.lockNow") }}</button>
          <button
            v-if="store.credentials.canManageMaster"
            class="btn"
            type="button"
            @click="store.removeMasterPassword()"
          >
            {{ $t("app.backToKeychain") }}
          </button>
        </div>

        <div v-else-if="store.credentials?.canManageMaster" class="vault-actions">
          <button class="btn" type="button" @click="toggleMasterForm('set')">{{ $t("app.setMaster") }}</button>
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
            <button class="btn primary" type="button" :disabled="!canSubmitMaster" @click="submitMaster">
              {{ masterForm === "set" ? $t("app.enableMaster") : $t("app.saveNewMaster") }}
            </button>
            <button class="btn" type="button" @click="resetMasterForm">{{ $t("app.cancel") }}</button>
          </div>
          <p v-if="masterError" class="error" role="alert">{{ masterError }}</p>
        </div>

        <p class="fineprint">
          {{ $t("app.vaultExplainer") }}
        </p>
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.about") }}</h2>
            <p>{{ $t("app.aboutTagline") }}</p>
          </div>
        </div>
        <dl class="about">
          <div><dt>{{ $t("app.version") }}</dt><dd class="mono">{{ store.snapshot?.appVersion }}</dd></div>
          <div><dt>{{ $t("app.platform") }}</dt><dd class="mono">{{ store.snapshot?.platform }}</dd></div>
          <div><dt>{{ $t("app.dataDir") }}</dt><dd class="mono">{{ store.snapshot?.userDataDir }}</dd></div>
          <div><dt>{{ $t("app.profileRoot") }}</dt><dd class="mono">{{ store.snapshot?.userDataDir }}\profiles</dd></div>
        </dl>
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

.scroll {
  margin-top: 16px;
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

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 6px 10px;
  font-size: 11px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  background: var(--surface-3);
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
  width: 70px;
}

.select-inline {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text-secondary);
  font-size: 11px;
  padding: 5px 8px;
  min-width: 170px;
  outline: 0;
}

.select-inline:focus {
  border-color: color-mix(in srgb, var(--line) 55%, var(--accent));
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

@media (max-width: 1000px) {
  .about {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
