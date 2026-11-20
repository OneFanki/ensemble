<script setup lang="ts">
/**
 * The page-level "fold everything / open everything" switch.
 *
 * A grouped list with fifteen groups is fifteen clicks to tidy up; this is the
 * one click. Same component in all three grouped pages so the wording and the
 * direction rule stay identical.
 *
 * Icon-only. It used to be a labelled 60px button, which broke the row it sits
 * in: every other control there is a 26px glyph, so the label made the row read
 * as two groups at two different heights. The chevrons-up/down pair says "all
 * sections" on its own — the label was repeating what the direction already
 * says — and it is still the accessible name and the tooltip, where it costs no
 * width.
 */
import { ChevronsDown, ChevronsUp } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

defineProps<{ allCollapsed: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
</script>

<template>
  <button
    type="button"
    class="bar-icon"
    data-group-collapse-all
    :aria-label="allCollapsed ? t('app.expandAll') : t('app.collapseAll')"
    :title="allCollapsed ? t('app.expandAll') : t('app.collapseAll')"
    @click="emit('toggle')"
  >
    <ChevronsDown v-if="allCollapsed" :size="13" />
    <ChevronsUp v-else :size="13" />
  </button>
</template>

<style scoped>
/* Same 26px target and same quiet hover as the other icon buttons on the row.
   Stated here as well as on the pages because this component is mounted by
   three of them, and a page that styled `.bar-icon` differently would otherwise
   leave this one control at a different size than its neighbours. */
.bar-icon {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  color: var(--faint);
}

.bar-icon:hover {
  background: color-mix(in srgb, var(--text) 8%, transparent);
  color: var(--text);
}
</style>
