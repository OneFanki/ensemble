<script setup lang="ts">
/**
 * The console's title bar: one drag band, with the way back.
 *
 * The navigation used to live here as a second row of chrome across the top.
 * It is now the rail in `ConsoleSidebar.vue`, which is what the mockup draws and
 * what makes the console read as an application surface rather than as a website
 * with a sub-nav. What remains here is the part a window cannot do without: a
 * region to drag, and an exit.
 *
 * The band keeps `--titlebar-height` and the right-hand padding the browser's
 * tab strip uses, because the native window buttons are painted over that area
 * by the main process and must not move when the user switches between browsing
 * and managing.
 */
import { ArrowLeft } from "lucide-vue-next";
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useWorkspaceStore } from "../stores/workspace";

const emit = defineEmits<{ back: [] }>();

const store = useWorkspaceStore();
const { t } = useI18n();
const platform = computed(() => store.snapshot?.platform ?? "win32");
</script>

<template>
  <header class="console-head drag-region" :data-platform="platform">
    <button
      type="button"
      class="back no-drag"
      :title="t('app.consoleBack')"
      :aria-label="t('app.consoleBack')"
      @click="emit('back')"
    >
      <ArrowLeft :size="14" />
      <span class="back-label">{{ t("app.consoleBack") }}</span>
    </button>
  </header>
</template>

<style scoped>
.console-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  height: var(--titlebar-height);
  padding: 0 148px 0 8px;
  background: var(--frame);
}

.console-head[data-platform="darwin"] {
  padding-left: 86px;
}

.back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 9px 0 7px;
  border-radius: var(--radius);
  color: var(--muted);
  font-size: var(--fs-sm);
  flex: 0 0 auto;
}

.back:hover {
  background: var(--chrome);
  color: var(--text);
}

@media (max-width: 1000px) {
  .back-label {
    display: none;
  }
}
</style>
