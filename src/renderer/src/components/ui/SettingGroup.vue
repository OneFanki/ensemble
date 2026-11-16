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
  padding: 12px 16px 6px;
  /* One column, not the full window. A label column of 132px followed by a
     170px control left roughly 1100px of nothing on every row, so the eye had to
     cross the whole screen to pair a label with its value. 820px fits label +
     control at a readable measure. */
  max-width: 820px;
}

/*
 * The heading is a band, not the first row.
 *
 * It used to sit 2px above the first setting with no line between them, in a
 * weight and size one step off the labels below it. The eye had no reason to
 * read "外观" as a title: it was the same block of text as "主题  [深色]
 * [浅色]", so every card looked like a list whose first entry happened to be
 * unstyled. The hairline is what turns the title into a header — it says the
 * rows under it are its contents, and the rule already exists once per card
 * boundary, so it reads as the same idea applied inside the card.
 *
 * The bottom padding is the gap the line needs to not touch the first label;
 * the row below brings its own 10px of top padding, and its `:first-of-type`
 * rule drops only the border (double rules would print one seam twice).
 */
.setting-group-head {
  display: flex;
  align-items: center;
  gap: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line-soft);
}

.setting-group-head h2 {
  margin: 0;
  font-size: var(--fs-md);
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
}

.setting-group-actions {
  margin-left: auto;
  display: flex;
  gap: 7px;
  flex: 0 0 auto;
}
</style>
