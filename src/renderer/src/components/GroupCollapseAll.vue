<script setup lang="ts">
/**
 * The page-level "fold everything / open everything" switch.
 *
 * A grouped list with fifteen groups is fifteen clicks to tidy up; this is the
 * one click. Same component in all three grouped pages so the wording and the
 * direction rule stay identical.
 */
import { ChevronsDown, ChevronsUp } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import AppButton from "./ui/AppButton.vue";

defineProps<{ allCollapsed: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { t } = useI18n();
</script>

<template>
  <AppButton
    size="sm"
    data-group-collapse-all
    :title="allCollapsed ? t('app.expandAll') : t('app.collapseAll')"
    @click="emit('toggle')"
  >
    <ChevronsDown v-if="allCollapsed" :size="12" />
    <ChevronsUp v-else :size="12" />
    {{ allCollapsed ? $t("app.expandAll") : $t("app.collapseAll") }}
  </AppButton>
</template>
