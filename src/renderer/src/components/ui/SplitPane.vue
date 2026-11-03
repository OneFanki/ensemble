<script setup lang="ts">
/**
 * The list-beside-detail layout, as one thing.
 *
 * Views and Flows each wrote this: a fixed-width column on the left, a detail
 * pane on the right, both scrolling independently, and both collapsing to one
 * column at roughly the same breakpoint. The two copies had already drifted —
 * 260–340px against 240–320px — so the same window width gave the list two
 * different widths depending on which page you were on.
 *
 * `--split-list-width` is the single knob. Widths stay in CSS rather than props:
 * a page that needs a wider list should change the token, not pass a pixel value
 * that then drifts from the other page again.
 */
defineProps<{
  /** Narrow the list column; the flows list is denser than the views list. */
  dense?: boolean;
}>();
</script>

<template>
  <div class="split" :class="{ dense }">
    <div class="split-list">
      <slot name="list" />
    </div>
    <div class="split-detail">
      <slot name="detail" />
    </div>
  </div>
</template>

<style scoped>
.split {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: var(--space-6);
  overflow: hidden;
}

.split.dense {
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
}

/* Each column owns its scroll: a long list must not carry the detail pane with
   it, and a long detail pane must not scroll the list off screen. */
.split-list,
.split-detail {
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.split-list {
  overflow-y: auto;
}

/* One column below this width: two panes at 400px each is worse than one after
   another, and the detail pane is what the user came for. */
@media (max-width: 1080px) {
  .split,
  .split.dense {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(120px, 40%) minmax(0, 1fr);
  }

  .split-list {
    border-bottom: 1px solid var(--line-soft);
    padding-bottom: var(--space-4);
  }
}
</style>
