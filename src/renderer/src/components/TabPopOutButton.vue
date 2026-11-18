<script setup lang="ts">
/**
 * 页面标签行上的「拆出窗口」按钮（独立小组件）。
 *
 * 一个页面拆到自己的 OS 窗口里（配合系统分屏并排观察），再次点击收回主舞台。
 * 拆出与否从页面描述里的 `popout` 标记读出，主进程是唯一裁决者——点击只发
 * 一个 toggle 动作，不等结果：新状态经常规广播到达，图标随之切换。
 *
 * 独立成文件是为了把拆窗的入口与标签行的其余改动隔开：这里只依赖 store 的
 * 一个方法与一个状态标记，不掺页面切换、拖拽等标签行自己的逻辑。
 */
import type { EmbeddedTab } from "@shared/embedded";
import { PictureInPicture2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useEmbeddedStore } from "../stores/embedded";

const props = defineProps<{
  /** 这颗按钮属于哪个页面。 */
  page: EmbeddedTab;
}>();

const store = useEmbeddedStore();
const { t } = useI18n();

function toggle(): void {
  void store.popOutTab(props.page.id);
}
</script>

<template>
  <button
    type="button"
    class="slot-tab-popout"
    :aria-label="page.popout ? t('app.tabPopIn') : t('app.tabPopOut')"
    :data-popout="page.popout ? 'out' : 'in'"
    v-tooltip="page.popout ? t('app.tabPopIn') : t('app.tabPopOut')"
    @click.stop="toggle"
    @mousedown.stop
  >
    <PictureInPicture2 :size="9" />
  </button>
</template>

<style scoped>
.slot-tab-popout {
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: var(--faint);
  opacity: 0.6;
  flex: 0 0 14px;
}

.slot-tab-popout:hover {
  background: var(--surface-3);
  color: var(--text);
  opacity: 1;
}

/* 已拆出的页面：图标常亮，标记「页面此刻不在舞台上」。 */
.slot-tab-popout[data-popout="out"] {
  color: var(--accent-text);
  opacity: 1;
}
</style>
