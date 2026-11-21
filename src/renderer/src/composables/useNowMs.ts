/**
 * A coarse clock for state that has to *degrade* on its own.
 *
 * The AI dot is the case this exists for: "breathing" means the last action was
 * within seconds, "steady" means within half an hour, and nothing means older.
 * Those boundaries have to be crossed while the user is looking at the row, with
 * no state push to hang the recompute off — so something has to tick.
 *
 * Five seconds is the resolution the boundaries need; a per-second clock would
 * recompute every row and every tab sixty times a minute for a dot that changes
 * at most twice per action. The interval only runs while the component is
 * mounted, so a closed window costs nothing.
 */
import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

export function useNowMs(intervalMs = 5_000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;

  onMounted(() => {
    timer = setInterval(() => {
      now.value = Date.now();
    }, intervalMs);
  });

  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
  });

  return now;
}
