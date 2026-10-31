<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * Imports bookmarks from a browser installed on this machine.
 *
 * The source list is detected by the main process (it knows the file paths);
 * this dialog only ever sees opaque ids, so the renderer cannot be coaxed into
 * reading an arbitrary path. Import merges into one top-level folder named
 * after the browser and skips addresses that already exist, which the outcome
 * toast reports honestly — including the skipped column, because "it imported
 * nothing" must read as dedupe, not as silence.
 */
const emit = defineEmits<{ close: [] }>();

const workspace = useWorkspaceStore();
const { t } = useI18n();

const picked = ref("");

async function submit(): Promise<void> {
  if (!picked.value) return;
  const outcome = await workspace.importBookmarks(picked.value);
  if (!outcome) return;
  workspace.notify(
    t("app.importDone", {
      bookmarks: outcome.bookmarks,
      folders: outcome.folders,
      skipped: outcome.skipped,
    }),
    "success",
  );
  emit("close");
}
</script>

<template>
  <Modal
    :open="true"
    :title="$t('app.importTitle')"
    :description="$t('app.bookmarkImportHint')"
    width="480px"
    @close="emit('close')"
  >
    <div class="form">
      <p class="sources-label">{{ $t("app.bookmarkImportPick") }}</p>
      <div v-if="workspace.bookmarkImportSources.length" class="sources">
        <button
          v-for="source in workspace.bookmarkImportSources"
          :key="source.id"
          type="button"
          class="source"
          :class="{ on: picked === source.id }"
          @click="picked = source.id"
        >
          <span class="copy">
            <span class="name">{{ source.browser }} · {{ source.profile }}</span>
            <span class="count mono">
              {{
                source.count >= 0
                  ? $t("app.importCount", { count: source.count })
                  : $t("app.importCountUnknown")
              }}
            </span>
          </span>
        </button>
      </div>
      <p v-else class="none">{{ $t("app.importNone") }}</p>
    </div>
    <template #footer>
      <span class="spacer"></span>
      <AppButton @click="emit('close')">{{ $t("app.cancel") }}</AppButton>
      <AppButton variant="primary" :disabled="!picked" @click="submit">
        {{ $t("app.importNow") }}
      </AppButton>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.sources-label {
  margin: 0;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.sources {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source {
  display: flex;
  align-items: center;
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  padding: 8px 10px;
  text-align: left;
  min-width: 0;
}

.source:hover {
  border-color: var(--line);
}

.source.on {
  border-color: color-mix(in srgb, var(--accent) 55%, var(--line));
  background: color-mix(in srgb, var(--accent) 9%, var(--bg-elevated));
}

.copy {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.name {
  font-size: 11.5px;
  color: var(--text-secondary);
}

.count {
  margin-left: auto;
  font-size: 10px;
  color: var(--faint);
}

.none {
  margin: 6px 0;
  font-size: 11.5px;
  color: var(--faint);
}

.spacer {
  flex: 1;
}
</style>
