<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-vue-next";
import { useEmbeddedStore } from "../stores/embedded";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();
// The dock's width bounds the stack: a native page view paints over everything
// on the stage, so any part of a toast that hangs past the dock's left edge is
// simply not painted (2026-10-31 — the cards were missing their first characters).
const embedded = useEmbeddedStore();
</script>

<template>
  <!--
    Teleported to body, same as the other floaters: position:fixed is only
    viewport-relative while no ancestor carries a transform (or contain /
    will-change). One such ancestor anywhere between here and the shell root
    silently turns the viewport anchor into that element. Body is the end of
    the chain, so the anchor cannot be stolen.
  -->
  <Teleport to="body">
    <div
      class="toast-stack"
      aria-live="polite"
      :style="{ '--dock-w': `${embedded.dockWidth}px` }"
    >
      <div
        v-for="toast in store.toasts"
        :key="toast.id"
        class="toast"
        :class="toast.tone"
        :role="toast.tone === 'error' ? 'alert' : 'status'"
      >
        <CircleAlert v-if="toast.tone === 'error'" :size="13" />
        <CircleCheck v-else-if="toast.tone === 'success'" :size="13" />
        <TriangleAlert v-else-if="toast.tone === 'warning'" :size="13" />
        <Info v-else :size="13" />
        <span>{{ toast.text }}</span>
      </div>
    </div>
  </Teleport>
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
  /* Never leave the dock: the stage's native page view paints over every HTML
     layer, so a card wider than the dock has its left part unpainted. 18px in
     from each edge keeps the stack floating inside the dock's own rectangle. */
  max-width: min(380px, calc(var(--dock-w, 292px) - 36px));
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
  animation: toast-in var(--motion-fast) var(--ease-out);
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

.toast.warning {
  border-color: color-mix(in srgb, var(--amber) 38%, var(--line));
}

.toast.warning svg {
  color: var(--amber);
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(var(--motion-shift));
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
