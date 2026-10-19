<script setup lang="ts">
import { computed } from "vue";
import { Download, Monitor, Plus, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

const emit = defineEmits<{
  theme: [theme: "dark" | "light" | "system"];
  locale: [locale: "zh" | "en"];
}>();

const store = useWorkspaceStore();

const scanning = computed(() => store.busy === "scan");
const engines = computed(() => store.engines);

function statusLabel(status: string): string {
  if (status === "ready") return "可用";
  if (status === "blocked") return "不可用";
  return "未验证";
}
</script>

<template>
  <section class="settings">
    <header class="head">
      <div>
        <h1>{{ $t("app.settings") }}</h1>
        <p class="mono">引擎扫描 · 外观 · 凭据存储</p>
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
              {{ scanning ? "扫描中" : $t("app.scanAgain") }}
            </button>
          </div>
        </div>

        <div class="engine-table">
          <div class="engine-head mono">
            <span>浏览器</span>
            <span>版本</span>
            <span>能力</span>
            <span>来源</span>
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
            <span>正在扫描系统中已安装的浏览器…</span>
          </div>
          <div v-else-if="!engines.length" class="engine-empty">
            <Monitor :size="18" />
            <span>没有发现浏览器。请安装 Chrome、Edge、Brave 或 Firefox，或手动指定可执行文件。</span>
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
          只有 CDP 引擎支持自动填充、登录态检测与窗口平铺。Firefox 使用外部模式：可多开、可复制密码，但不接管页面。
          Safari 不支持多账号隔离。
        </p>
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>外观</h2>
            <p>深色适合长时间盯着控制台；浅色适合核对凭据和阅读。</p>
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
              中文
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
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>凭据存储</h2>
            <p>密码只在主进程内解密，用于在登录页填充；不会发送到界面进程。</p>
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
      </section>

      <section class="block">
        <div class="block-head">
          <div>
            <h2>{{ $t("app.about") }}</h2>
            <p>多个身份，同一个舞台。</p>
          </div>
        </div>
        <dl class="about">
          <div><dt>{{ $t("app.version") }}</dt><dd class="mono">{{ store.snapshot?.appVersion }}</dd></div>
          <div><dt>平台</dt><dd class="mono">{{ store.snapshot?.platform }}</dd></div>
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
