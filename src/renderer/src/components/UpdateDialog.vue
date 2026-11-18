<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { Download, ExternalLink, RefreshCw, ShieldCheck } from "lucide-vue-next";
import {
  RELEASES_PAGE_URL,
  selectUpdateNotes,
  type UpdateCheckResult,
  type UpdateProgress,
} from "@shared/update";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * The update prompt.
 *
 * Two rules shape this dialog:
 * - It only ever shows the short release summary. The full changelog lives in
 *   CHANGELOG.md; a wall of text is exactly what makes people dismiss updates
 *   without reading them.
 * - Downloading and installing both start from a click. The app verifies the
 *   file's SHA-256 before anything is executed, and says so.
 *
 * An install that skipped several versions gets one section per release,
 * oldest first, so it reads as what accumulated since the last update.
 */
const props = defineProps<{ result: UpdateCheckResult }>();
const emit = defineEmits<{ close: []; dismissed: [version: string] }>();

const phase = ref<"idle" | "downloading" | "verifying" | "ready" | "installing" | "error">("idle");
const progress = ref<UpdateProgress | null>(null);
const errorText = ref<string | null>(null);
let disposeProgress: (() => void) | undefined;

const latest = computed(() => props.result.latest ?? "");
const omitted = computed(() => props.result.omittedReleases ?? 0);
const sections = computed(() => {
  const listed = (props.result.releases ?? []).map((release) => ({
    version: release.version,
    body: selectUpdateNotes(release.notes, currentLocale()),
  }));
  if (listed.length > 0) return listed;
  // A result without a range summary still has the latest release's own notes.
  const body = selectUpdateNotes(props.result.notes, currentLocale());
  return latest.value ? [{ version: latest.value, body }] : [];
});
const percent = computed(() => {
  const current = progress.value;
  if (!current?.total || current.received <= 0) return 0;
  return Math.min(100, Math.round((current.received / current.total) * 100));
});
const sizeLabel = computed(() => {
  const total = progress.value?.total ?? props.result.asset?.size ?? 0;
  if (!total) return "";
  return `${Math.round(total / (1024 * 1024))} MB`;
});

const canAutoInstall = computed(() => Boolean(props.result.asset?.sha256));

function currentLocale(): "zh" | "en" {
  // The dialog follows the app language set on <html>; reading it here avoids
  // threading a locale prop through every caller.
  return document.documentElement.lang.startsWith("zh") ? "zh" : "en";
}

async function startDownload() {
  if (phase.value === "downloading" || phase.value === "verifying") return;
  errorText.value = null;
  phase.value = "downloading";
  try {
    await window.ensemble.downloadUpdate();
    phase.value = "ready";
  } catch (error) {
    phase.value = "error";
    errorText.value = (error as Error).message;
  }
}

async function install() {
  phase.value = "installing";
  try {
    await window.ensemble.installUpdate();
  } catch (error) {
    phase.value = "error";
    errorText.value = (error as Error).message;
  }
}

function later() {
  emit("dismissed", latest.value);
  emit("close");
}

function openReleasePage() {
  void window.ensemble.openExternal(props.result.url ?? RELEASES_PAGE_URL);
}

onMounted(() => {
  disposeProgress = window.ensemble.onUpdateProgress((next) => {
    progress.value = next;
    if (next.phase === "error") {
      phase.value = "error";
      errorText.value = next.message ?? null;
    } else if (next.phase === "ready") {
      phase.value = "ready";
    } else if (next.phase === "installing") {
      phase.value = "installing";
    } else if (next.phase === "verifying") {
      phase.value = "verifying";
    }
  });
});

onUnmounted(() => disposeProgress?.());

watch(
  () => props.result.latest,
  () => {
    // A different version arrived while the dialog was open: forget the previous
    // download state so the dialog cannot offer to install the wrong build.
    phase.value = "idle";
    progress.value = null;
    errorText.value = null;
  },
);
</script>

<template>
  <Modal
    :open="true"
    :title="$t('app.updateDialogTitle', { version: latest })"
    :description="$t('app.updateDialogDesc', { current: result.current, latest })"
    width="520px"
    @close="later"
  >
    <div class="summary">
      <p v-if="omitted > 0" class="omitted mono">
        {{ $t("app.updateOmitted", { count: omitted }) }}
      </p>
      <div class="releases">
        <section v-for="release in sections" :key="release.version" class="release">
          <h4 class="release-version mono">{{ release.version }}</h4>
          <!-- Short and scannable: a release summary, not the changelog. -->
          <ul v-if="release.body" class="notes">
            <li
              v-for="(line, index) in release.body.split('\n').filter((item) => item.trim())"
              :key="index"
            >
              {{ line.replace(/^[-*]\s*/, "") }}
            </li>
          </ul>
          <p v-else class="no-notes">{{ $t("app.updateNoNotes") }}</p>
        </section>
      </div>
      <button type="button" class="more" @click="openReleasePage">
        <ExternalLink :size="11" />
        {{ $t("app.updateFullNotes") }}
      </button>
    </div>

    <p v-if="!canAutoInstall" class="warn">{{ $t("app.updateNoChecksum") }}</p>

    <div v-if="phase === 'downloading' || phase === 'verifying'" class="progress-block">
      <div class="track">
        <div class="bar" :style="{ width: `${phase === 'verifying' ? 100 : percent}%` }"></div>
      </div>
      <p class="progress-text mono">
        <template v-if="phase === 'verifying'">{{ $t("app.updateVerifying") }}</template>
        <template v-else>
          {{ $t("app.updateDownloading", { percent }) }}
          <span v-if="sizeLabel">· {{ sizeLabel }}</span>
        </template>
      </p>
    </div>

    <p v-else-if="phase === 'ready'" class="ready">
      <ShieldCheck :size="13" />
      <span>{{ $t("app.updateReady") }}</span>
    </p>

    <p v-else-if="phase === 'installing'" class="ready">
      <RefreshCw :size="13" class="spinning" />
      <span>{{ $t("app.updateInstalling") }}</span>
    </p>

    <p v-else-if="phase === 'error'" class="error">
      {{ $t("app.updateError") }}<template v-if="errorText"> · {{ errorText }}</template>
    </p>

    <p v-if="result.asset" class="meta mono">
      {{ result.asset.name }} · {{ sizeLabel }}
    </p>

    <template #footer>
      <AppButton :disabled="phase === 'installing'" @click="later">
        {{ $t("app.updateLater") }}
      </AppButton>
      <AppButton :disabled="phase === 'downloading' || phase === 'verifying' || phase === 'installing'"
        @click="startDownload">
        <Download :size="12" />
        {{ phase === 'error' ? $t("app.updateRetry") : $t("app.updateDownload") }}
      </AppButton>
      <AppButton variant="primary" :disabled="phase !== 'ready' || !canAutoInstall"
        @click="install">
        {{ $t("app.updateInstall") }}
      </AppButton>
    </template>
  </Modal>
</template>

<style scoped>
.summary {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  padding: 10px 12px;
}

/* The range summary scrolls as a whole instead of pushing the buttons off the
   dialog; each version is a bordered-off section inside it. */
.releases {
  max-height: 190px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.release {
  min-width: 0;
}

.release + .release {
  border-top: 1px solid var(--line-soft);
  padding-top: 10px;
}

.release-version {
  margin: 0 0 5px;
  font-size: 11px;
  color: var(--text-primary);
}

.omitted {
  margin: 0 0 8px;
  font-size: 10.5px;
  color: var(--faint);
}

.notes {
  margin: 0;
  padding-left: 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-secondary);
}

.more {
  margin-top: 7px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  color: var(--accent-text);
}

.more:hover {
  text-decoration: underline;
}

.no-notes {
  margin: 0;
  font-size: 11.5px;
  color: var(--faint);
}

.warn {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--accent-text);
}

.progress-block {
  margin-top: 12px;
}

.track {
  height: 5px;
  border-radius: 999px;
  background: var(--surface-3);
  overflow: hidden;
}

.bar {
  height: 100%;
  border-radius: 999px;
  background: var(--accent);
  transition: width var(--motion-base) var(--ease-out);
}

.progress-text {
  margin: 6px 0 0;
  font-size: 10.5px;
  color: var(--faint);
}

.ready,
.error {
  margin: 12px 0 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
}

.ready {
  color: var(--green);
}

.error {
  color: var(--red);
}

.meta {
  margin: 10px 0 0;
  font-size: 10px;
  color: var(--dim);
  word-break: break-all;
}

.spinning {
  animation: spin var(--motion-slow) linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
