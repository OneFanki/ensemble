<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import Modal from "./Modal.vue";
import AppButton from "./ui/AppButton.vue";

const confirm = useConfirmStore();
const { t } = useI18n();

function close(): void {
  confirm.answer(false);
}
</script>

<template>
  <Modal
    :open="Boolean(confirm.current)"
    :title="confirm.current?.title ?? ''"
    :description="confirm.current?.body"
    width="420px"
    @close="close"
  >
    <div class="spacer"></div>
    <template #footer>
      <span class="grow"></span>
      <AppButton @click="close">
        {{ confirm.current?.cancelLabel ?? t("app.cancel") }}
      </AppButton>
      <AppButton :class="confirm.current?.tone === 'danger' ? 'danger' : 'primary'"
        @click="confirm.answer(true)">
        {{ confirm.current?.confirmLabel ?? t("app.confirm") }}
      </AppButton>
    </template>
  </Modal>
</template>

<style scoped>
.spacer {
  min-height: 4px;
}

.grow {
  flex: 1;
}
</style>
