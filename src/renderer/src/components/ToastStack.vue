<script setup lang="ts">
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-vue-next";
import { useWorkspaceStore } from "../stores/workspace";

const store = useWorkspaceStore();
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
    <!-- A group, not a list: a toast's exit has to keep the element mounted for
         the animation, and the survivors glide into the freed slot instead of
         jumping when one leaves. -->
    <TransitionGroup name="toast" tag="div" class="toast-stack" aria-live="polite">
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
    </TransitionGroup>
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
  /*
   * Wide enough for a sentence, never wider than the window.
   *
   * This used to be capped at the dock's width because a native `WebContentsView`
   * painted over every HTML layer: anything hanging past the dock's left edge was
   * simply not drawn. The carrier is a `<webview>` guest now, which is an ordinary
   * composited layer, so the stack can sit where a browser puts it — bottom right,
   * over the page, at its own width.
   */
  max-width: min(380px, calc(100vw - 36px));
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
}

/*
 * Enter and exit are a pair, like every other floater. The exit runs at the
 * faster token and drops toward the stack's own corner — the toast leaves the
 * way it arrived, in reverse. `forwards` holds the last frame until the group
 * removes the element.
 */
.toast-enter-active {
  animation: toast-in var(--motion-fast) var(--ease-out);
}

.toast-leave-active {
  animation: toast-out var(--motion-fast) var(--ease-in) forwards;
}

.toast-move {
  transition: transform var(--motion-base) var(--ease-out);
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

@keyframes toast-out {
  to {
    opacity: 0;
    transform: translateY(var(--motion-shift));
  }
}
</style>
