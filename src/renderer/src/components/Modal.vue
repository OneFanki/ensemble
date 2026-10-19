<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from "reka-ui";
import { X } from "lucide-vue-next";

defineProps<{ open: boolean; title: string; description?: string; width?: string }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <DialogRoot :open="open" @update:open="(value) => !value && emit('close')">
    <DialogPortal>
      <DialogOverlay class="overlay" />
      <DialogContent class="content" :style="{ width: width ?? '560px' }">
        <header class="head">
          <div class="copy">
            <DialogTitle class="title">{{ title }}</DialogTitle>
            <DialogDescription v-if="description" class="description">
              {{ description }}
            </DialogDescription>
          </div>
          <DialogClose class="close" :aria-label="$t('app.close')">
            <X :size="14" />
          </DialogClose>
        </header>
        <div class="body">
          <slot />
        </div>
        <footer class="foot">
          <slot name="footer" />
        </footer>
        <DialogClose class="sr-only">{{ $t("app.close") }}</DialogClose>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 55%);
  backdrop-filter: blur(2px);
  z-index: 70;
}

.content {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line);
  border-radius: 11px;
  background: var(--surface);
  box-shadow: 0 30px 80px rgb(0 0 0 / 55%);
  z-index: 71;
  overflow: hidden;
}

.head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 15px 16px 12px;
  border-bottom: 1px solid var(--line-soft);
  flex: 0 0 auto;
}

.copy {
  min-width: 0;
}

.title {
  margin: 0;
  font-size: 14px;
  font-weight: 500;
}

.description {
  margin: 5px 0 0;
  font-size: 11.5px;
  color: var(--faint);
  line-height: 1.5;
}

.close {
  margin-left: auto;
  width: 24px;
  height: 24px;
  display: grid;
  place-items: center;
  border-radius: 5px;
  color: var(--faint);
  flex: 0 0 24px;
}

.close:hover {
  background: var(--surface-3);
  color: var(--text-secondary);
}

.body {
  padding: 15px 16px;
  overflow-y: auto;
  min-height: 0;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line-soft);
  background: var(--bg-elevated);
  flex: 0 0 auto;
}
</style>
