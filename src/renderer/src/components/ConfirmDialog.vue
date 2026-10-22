<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import Modal from "./Modal.vue";

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
      <button type="button" class="btn" @click="close">
        {{ confirm.current?.cancelLabel ?? t("app.cancel") }}
      </button>
      <button
        type="button"
        class="btn"
        :class="confirm.current?.tone === 'danger' ? 'danger' : 'primary'"
        @click="confirm.answer(true)"
      >
        {{ confirm.current?.confirmLabel ?? t("app.confirm") }}
      </button>
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

.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: var(--radius);
  padding: 7px 13px;
  font-size: 11.5px;
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  white-space: nowrap;
}

.btn:hover {
  background: var(--surface-3);
}

.btn.primary {
  background: linear-gradient(180deg, var(--accent-strong), color-mix(in srgb, var(--accent) 88%, black));
  border-color: color-mix(in srgb, var(--accent) 80%, black);
  color: var(--accent-foreground);
  font-weight: 500;
}

.btn.primary:hover {
  filter: brightness(1.07);
}

.btn.danger {
  background: color-mix(in srgb, var(--red) 16%, var(--surface-2));
  border-color: color-mix(in srgb, var(--red) 45%, var(--line));
  color: var(--red);
}

.btn.danger:hover {
  background: color-mix(in srgb, var(--red) 24%, var(--surface-2));
}
</style>
