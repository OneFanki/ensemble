<script setup lang="ts">
import type { BookmarkFolder, BookmarkFolderDraft } from "@shared/types";
import { computed, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import FolderTreePicker from "./FolderTreePicker.vue";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";

/**
 * Creates a folder, or renames and moves an existing one.
 *
 * One dialog covers all three because the tree model makes them the same
 * write: name and parent are the only fields a folder has. Moving under the
 * folder's own descendant is refused by the service and lands here as a toast
 * from the parent, never as a silently wrong tree.
 */
const props = defineProps<{
  draft: BookmarkFolderDraft;
  folders: BookmarkFolder[];
  /** The folder being edited, so the picker can exclude it and its subtree. */
  self?: BookmarkFolder;
}>();

const emit = defineEmits<{
  close: [];
  save: [draft: BookmarkFolderDraft];
}>();

const { t } = useI18n();

const form = reactive({ ...props.draft, parentId: props.draft.parentId ?? "" });
watch(
  () => props.draft,
  (next) => Object.assign(form, next, { parentId: next.parentId ?? "" }),
);

const error = ref("");

/**
 * The folder itself and everything under it are not valid parents — the picker
 * hides that subtree rather than letting the service reject it after the fact.
 */
const pickableFolders = computed(() => {
  if (!props.self) return props.folders;
  const blocked = new Set<string>([props.self.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const folder of props.folders) {
      if (folder.parentId && blocked.has(folder.parentId) && !blocked.has(folder.id)) {
        blocked.add(folder.id);
        grew = true;
      }
    }
  }
  return props.folders.filter((folder) => !blocked.has(folder.id));
});

function submit(): void {
  error.value = "";
  if (!form.name.trim()) {
    error.value = t("app.bookmarkFolderNeedsName");
    return;
  }
  emit("save", {
    id: form.id,
    name: form.name.trim(),
    parentId: form.parentId || undefined,
  });
}
</script>

<template>
  <Modal
    :open="true"
    :title="form.id ? $t('app.bookmarkFolderDialogTitleEdit') : $t('app.bookmarkFolderDialogTitleNew')"
    width="420px"
    @close="emit('close')"
  >
    <div class="form">
      <label class="field">
        <span class="label">{{ $t("app.bookmarkFolderNameLabel") }}</span>
        <input v-model="form.name" class="input" maxlength="60" />
      </label>
      <div class="field">
        <span class="label">{{ $t("app.bookmarkFolderParentLabel") }}</span>
        <FolderTreePicker
          v-model="form.parentId"
          :folders="pickableFolders"
          :root-label="$t('app.bookmarkFolderRoot')"
        />
        <p class="hint">{{ $t("app.bookmarkFolderParentHint") }}</p>
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

.hint {
  margin: 0;
  font-size: 10.5px;
  line-height: 1.5;
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
