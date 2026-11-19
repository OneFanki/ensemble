<script setup lang="ts">
import { useI18n } from "vue-i18n";
import SiteGroupsEditor from "./SiteGroupsEditor.vue";
import PageHeader from "./ui/PageHeader.vue";

/**
 * The settings tab for site groups.
 *
 * Grouping is configuration — which filings sites have is decided once and then
 * applied — so it lives with the other settings. The editing controls are
 * `SiteGroupsEditor`, shared with the inline panel on the account page where the
 * same groups are applied to sites.
 */
const { t } = useI18n();
</script>

<template>
  <section class="page site-groups">
    <PageHeader :title="t('app.siteGroups')" />
    <div class="page-body">
      <SiteGroupsEditor />
    </div>
  </section>
</template>
