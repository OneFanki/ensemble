<script setup lang="ts">
import { TriangleAlert } from "lucide-vue-next";
import {
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogOverlay,
  AlertDialogPortal,
  AlertDialogRoot,
  AlertDialogTitle,
} from "reka-ui";
import { useI18n } from "vue-i18n";
import { useConfirmStore } from "../stores/confirm";
import AppButton from "./ui/AppButton.vue";

const confirm = useConfirmStore();
const { t } = useI18n();
</script>

<template>
  <!--
    A confirmation is not a form, and it should not look like one.

    This used to be the generic `Modal`: header, an empty body band, footer. With
    no body content the dialog read as a panel that had failed to load — a title,
    a gap, then buttons. An alert has its own shape: mark, question, answer. It is
    also an AlertDialog rather than a Dialog on purpose — a destructive question
    must not be dismissable by clicking the backdrop, where the answer is
    ambiguous.
  -->
  <AlertDialogRoot
    :open="Boolean(confirm.current)"
    @update:open="(value) => !value && confirm.answer(false)"
  >
    <AlertDialogPortal>
      <AlertDialogOverlay class="overlay" />
      <AlertDialogContent class="content">
        <span class="mark" :class="{ danger: confirm.current?.tone === 'danger' }">
          <TriangleAlert :size="16" />
        </span>
        <div class="copy">
          <AlertDialogTitle class="title">{{ confirm.current?.title ?? "" }}</AlertDialogTitle>
          <AlertDialogDescription v-if="confirm.current?.body" class="body">
            {{ confirm.current.body }}
          </AlertDialogDescription>
        </div>
        <div class="actions">
          <AppButton @click="confirm.answer(false)">
            {{ confirm.current?.cancelLabel ?? t("app.cancel") }}
          </AppButton>
          <AppButton
            :variant="confirm.current?.tone === 'danger' ? 'danger' : 'primary'"
            @click="confirm.answer(true)"
          >
            {{ confirm.current?.confirmLabel ?? t("app.confirm") }}
          </AppButton>
        </div>
      </AlertDialogContent>
    </AlertDialogPortal>
  </AlertDialogRoot>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 55%);
  backdrop-filter: blur(2px);
  z-index: 70;
  /* Same layer stack as `Modal`; a confirm can open over a form. */
  display: grid;
  place-items: center;
}

.content {
  position: fixed;
  z-index: 71;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 32px));
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--surface);
  box-shadow: var(--shadow-dialog);
}

/* The mark carries the tone. A red ring around the whole dialog (the earlier
   design) read as an error state rather than as "this deletes something". */
.mark {
  display: grid;
  place-items: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
  flex: 0 0 30px;
}

.mark.danger {
  background: color-mix(in srgb, var(--red) 16%, transparent);
  color: var(--red);
}

.copy {
  min-width: 0;
  padding-top: 4px;
}

.title {
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.4;
}

.body {
  margin: 5px 0 0;
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
  white-space: pre-line;
}

.actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}
</style>
