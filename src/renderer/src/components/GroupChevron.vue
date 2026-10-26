<script setup lang="ts">
/**
 * The arrow on a group header, for lists that can be folded.
 *
 * It owns its hit area and its rotation so the three grouped lists cannot drift
 * into three slightly different arrows. The header row around it stays each
 * page's own business: the content differs (a tag dot, a site URL, a flow count).
 */
import { ChevronRight } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

withDefaults(
  defineProps<{
    collapsed: boolean;
    /** Group name, used for the accessible label: "折叠 生产环境". */
    name: string;
  }>(),
  {},
);

const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
</script>

<template>
  <button
    type="button"
    class="group-chevron"
    :class="{ collapsed }"
    :aria-expanded="!collapsed"
    :aria-label="`${collapsed ? t('app.expand') : t('app.collapse')} ${name}`"
    :title="collapsed ? t('app.expand') : t('app.collapse')"
    @click.stop="emit('toggle')"
  >
    <ChevronRight :size="12" />
  </button>
</template>

<style scoped>
.group-chevron {
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--faint);
  cursor: pointer;
  transition:
    transform 0.15s ease,
    color 0.15s ease;
}

.group-chevron:hover {
  color: var(--text);
}

/* Open groups point down, collapsed ones point right: the rotation is the state,
   so the arrow does not also need to change colour to be readable. */
.group-chevron:not(.collapsed) {
  transform: rotate(90deg);
}
</style>
