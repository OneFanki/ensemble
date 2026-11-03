<script setup lang="ts">
/**
 * A collapsible group heading: chevron, optional colour tag, name, count.
 *
 * Sites, accounts and flows all draw this, and all three had written the flex
 * rules themselves. The chevron is nudged left so the group name lines up with
 * the cards below it rather than with the page's padding — that alignment is the
 * reason this is a component and not three copies of five CSS rules.
 *
 * The slots carry what genuinely differs: the accounts page shows the site's
 * address inside the header and a button to add an account there. Slot content
 * is compiled in the parent's scope, so a page still styles its own extras
 * without `:deep()`.
 */
import { ChevronRight } from "lucide-vue-next";

defineProps<{
  name: string;
  count: number;
  collapsed: boolean;
  /** Identity/tag colour for the dot; omitted for an untagged group. */
  color?: string;
}>();

const emit = defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <header
    class="group-head"
    :class="{ collapsed }"
    role="button"
    tabindex="0"
    :aria-expanded="!collapsed"
    @click="emit('toggle')"
    @keydown.enter.prevent="emit('toggle')"
    @keydown.space.prevent="emit('toggle')"
  >
    <ChevronRight :size="13" class="group-chevron" :class="{ open: !collapsed }" />
    <span v-if="color" class="group-dot" :style="{ background: `var(--role-${color})` }"></span>
    <span class="group-name">{{ name }}</span>
    <slot name="meta" />
    <span class="group-count mono">{{ count }}</span>
    <slot name="actions" />
  </header>
</template>

<style scoped>
.group-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--line-soft);
  cursor: pointer;
  /* The arrow is pulled into the page's own padding so the group name keeps the
     alignment the cards below it have. */
  margin-left: -3px;
}

.group-chevron {
  color: var(--faint);
  flex: 0 0 13px;
  transition: transform 0.15s ease;
}

.group-chevron.open {
  transform: rotate(90deg);
}

.group-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: 0 0 6px;
}

.group-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-base);
  color: var(--text-secondary);
}

.group-head:hover .group-name {
  color: var(--text);
}

.group-count {
  font-size: var(--fs-2xs);
  color: var(--faint);
  flex: 0 0 auto;
}
</style>
