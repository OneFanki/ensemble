<script setup lang="ts">
/**
 * One card on a settings page: a heading and the settings that share it.
 *
 * Settings used to be a single card per tab, so "外观" sat above "网络代理" with
 * only a hairline between them and the tab looked like one long form. Grouping
 * them into cards is what makes the sections visible as sections; the heading is
 * the group's name and nothing else, because a subtitle under every heading was
 * the redundancy this page is being cleared of.
 */
defineProps<{ title: string }>();
</script>

<template>
  <section class="setting-group">
    <header class="setting-group-head">
      <h2>{{ title }}</h2>
      <div class="setting-group-actions">
        <slot name="actions" />
      </div>
    </header>
    <slot />
  </section>
</template>

<style scoped>
.setting-group {
  border: 1px solid var(--line-soft);
  border-radius: var(--radius-lg);
  background: var(--surface);
  padding: 14px 16px 6px;
  /* One column, not the full window. A label column of 132px followed by a
     170px control left roughly 1100px of nothing on every row, so the eye had to
     cross the whole screen to pair a label with its value. 820px fits label +
     control at a readable measure. */
  max-width: 820px;
}

.setting-group-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 2px;
}

.setting-group-head h2 {
  margin: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
}

.setting-group-actions {
  margin-left: auto;
  display: flex;
  gap: 7px;
  flex: 0 0 auto;
}
</style>
