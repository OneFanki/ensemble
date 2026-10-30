<script setup lang="ts">
import type { BookmarkDraft, BookmarkFolder } from "@shared/types";
import { reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import FolderTreePicker from "./FolderTreePicker.vue";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * Creates or edits one bookmark.
 *
 * A bookmark is a name, an address and a place in the tree, so the dialog owns
 * all three — the row-level controls stay one-click actions (open, delete) and
 * anything that needs typing happens here. The parent performs the save: both
 * callers react to it differently (the browser page attaches the tab's favicon,
 * the management page just closes), and service errors surface as toasts.
 */
const props = defineProps<{
  draft: BookmarkDraft;
  folders: BookmarkFolder[];
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: BookmarkDraft];
}>();

const { t } = useI18n();

const form = reactive({ ...props.draft, folderId: props.draft.folderId ?? "" });
watch(
  () => props.draft,
  (next) => Object.assign(form, next, { folderId: next.folderId ?? "" }),
);

const error = ref("");

function submit(): void {
  error.value = "";
  // Only the check the service cannot make for itself: an empty address has no
  // meaning, while everything else (scheme, folder id) has a specific error.
  if (!form.url.trim()) {
    error.value = t("app.bookmarkNeedsUrl");
    return;
  }
  emit("save", {
    id: form.id,
    name: form.name.trim(),
    url: form.url.trim(),
    folderId: form.folderId || undefined,
  });
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? $t('app.bookmarkDialogTitleEdit') : $t('app.bookmarkDialogTitleNew')"
    width="460px"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span class="label">{{ $t("app.bookmarkNameLabel") }}</span>
        <input
          v-model="form.name"
          class="input"
          :placeholder="$t('app.bookmarkNamePlaceholder')"
          maxlength="120"
        />
      </label>
      <label class="field">
        <span class="label">{{ $t("app.bookmarkUrlLabel") }}</span>
        <input v-model="form.url" class="input mono" placeholder="https://example.com" spellcheck="false" />
      </label>
      <div class="field">
        <span class="label">{{ $t("app.bookmarkFolderLabel") }}</span>
        <FolderTreePicker
          v-model="form.folderId"
          :folders="folders"
          :root-label="$t('app.bookmarkFolderNone')"
        />
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
    <template #footer>
      <span class="spacer"></span>
      <AppButton @click="emit('close')">{{ $t("app.cancel") }}</AppButton>
      <AppButton variant="primary" @click="submit">{{ $t("app.save") }}</AppButton>
    </template>
  </Modal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: 13px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.label {
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}

.spacer {
  flex: 1;
}
</style>
