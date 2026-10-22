import { defineStore } from "pinia";
import { ref } from "vue";

export interface ConfirmRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

/**
 * One confirm dialog for the whole renderer.
 *
 * Native `window.confirm` looks nothing like the rest of the app and cannot be
 * styled or translated consistently; this keeps the promise-based call shape but
 * renders the app's own modal. Only one question can be open at a time, which is
 * also true of the native dialog.
 */
export const useConfirmStore = defineStore("confirm", () => {
  const current = ref<ConfirmRequest | null>(null);
  let resolveCurrent: ((accepted: boolean) => void) | null = null;

  function ask(request: ConfirmRequest): Promise<boolean> {
    // A second question replaces the first rather than stacking modals; the
    // replaced one resolves as "no" so its caller never hangs forever.
    resolveCurrent?.(false);
    current.value = request;
    return new Promise<boolean>((resolve) => {
      resolveCurrent = resolve;
    });
  }

  function answer(accepted: boolean): void {
    current.value = null;
    resolveCurrent?.(accepted);
    resolveCurrent = null;
  }

  return { current, ask, answer };
});
