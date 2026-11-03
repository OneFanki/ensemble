import { defineStore } from "pinia";
import { ref } from "vue";

/**
 * Where the app's own pages are, for components that need to jump there.
 *
 * Navigation used to be threaded through props and events from `App.vue` down
 * into leaf components, which worked while the leaf was a direct child. The AI
 * entry in the toolbar is three levels deep and is also the only place the
 * endpoint's status is reported, so it needs to reach Settings — passing a
 * handler down through two components that do not care about it would be the
 * wrong shape.
 */
export const useNavigationStore = defineStore("navigation", () => {
  /** Set by `App.vue`; the leaf calls it without knowing what it does. */
  const goTo = ref<((view: string, tab?: string) => void) | null>(null);

  function bind(handler: (view: string, tab?: string) => void): void {
    goTo.value = handler;
  }

  function navigate(view: string, tab?: string): void {
    goTo.value?.(view, tab);
  }

  return { bind, navigate };
});
