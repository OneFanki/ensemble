<script setup lang="ts">
import { CircleAlert, CircleCheck, Info } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div
      v-for="toast in store.toasts"
      :key="toast.id"
      class="toast"
      :class="toast.tone"
      :role="toast.tone === 'error' ? 'alert' : 'status'"
    >
      <CircleAlert v-if="toast.tone === 'error'" :size="13" />
      <CircleCheck v-else-if="toast.tone === 'success'" :size="13" />
      <Info v-else :size="13" />
      <span>{{ toast.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 18px;
  bottom: 44px;
  /* Above dialogs (overlay 70 / content 71) so errors stay readable while editing. */
  z-index: 100;
  display: flex;
  flex-direction: column;
  gap: 7px;
  max-width: 380px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 9px 11px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  background: var(--surface-2);
  color: var(--text-secondary);
  font-size: 11.5px;
  line-height: 1.5;
  box-shadow: var(--shadow-menu);
  animation: toast-in 0.16s ease-out;
}

.toast svg {
  flex: 0 0 13px;
  margin-top: 1px;
  color: var(--muted);
}

.toast.success {
  border-color: color-mix(in srgb, var(--green) 34%, var(--line));
}

.toast.success svg {
  color: var(--green);
}

.toast.error {
  border-color: color-mix(in srgb, var(--red) 38%, var(--line));
}

.toast.error svg {
  color: var(--red);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
