<script setup lang="ts">
/**
 * The full AI activity log as a floating layer.
 *
 * The address bar's AI button opens a panel that shows only the newest sites;
 * "all of it" is the same log without the cut. It is a layer rather than a page
 * because it is a continuation of that panel — the browser stays where it is
 * behind it, and closing it costs nothing.
 *
 * The body is `AiActivityPage` itself: the panel's rows and this list come from
 * the same components, so a refused call cannot look different in two places.
 */
import { useI18n } from "vue-i18n";
import AiActivityPage from "./AiActivityPage.vue";
import FloatingPane from "./ui/FloatingPane.vue";

const props = defineProps<{
  /**
   * Site to open on, when the opener knows one.
   *
   * "查看全部" on the address-bar panel passes the origin that panel was showing:
   * that panel always describes the page in front, so its "all of it" means all
   * of *that* site's records. Any other entrance leaves this empty and the page
   * lists everything.
   */
  origin?: string | null;
}>();

const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
</script>

<template>
  <FloatingPane :label="t('app.aiActivityTitle')" @close="emit('close')">
    <AiActivityPage :origin="props.origin ?? null" />
  </FloatingPane>
</template>
