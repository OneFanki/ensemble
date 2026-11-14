<script setup lang="ts">
import type { BookmarkDraft, BookmarkFolder } from "@shared/types";
import { reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import FolderTreePicker from "./FolderTreePicker.vue";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";
import FormField from "./ui/FormField.vue";
import TextField from "./ui/TextField.vue";

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
      <FormField :label="$t('app.bookmarkNameLabel')">
        <TextField
          v-model="form.name"
          :placeholder="$t('app.bookmarkNamePlaceholder')"
          maxlength="120"
        />
      </FormField>
      <FormField :label="$t('app.bookmarkUrlLabel')">
        <TextField
          v-model="form.url"
          mono
          placeholder="https://example.com"
          spellcheck="false"
        />
      </FormField>
      <FormField as="div" :label="$t('app.bookmarkFolderLabel')">
        <FolderTreePicker
          v-model="form.folderId"
          :folders="folders"
          :root-label="$t('app.bookmarkFolderNone')"
        />
      </FormField>
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

.error {
  margin: 0;
  font-size: 11px;
  color: var(--red);
}
</style>
