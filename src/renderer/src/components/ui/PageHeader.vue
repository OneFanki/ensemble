<script setup lang="ts">
/**
 * The header every console page wears.
 *
 * Seven pages had grown their own copy of this: six used `.head` + `.head-copy`
 * + `.head-note` + `.head-actions` with the same flex rules, and the bookmarks
 * page used `.page-head` with a different title size. Six identical copies is
 * not a style choice, it is six places to change when the type scale moves — and
 * the odd one out is what makes a page look like it belongs to another app.
 *
 * The title is `h1` so a page still has a heading; the console's own navigation
 * says which section, and this says what the page is called.
 */
defineProps<{
  title: string;
  /** One line under the title: what this page is for. */
  note?: string;
  /**
   * Render the note in the monospace face.
   *
   * For notes that are live numbers rather than prose ("12 accounts · 3 running"):
   * digits line up with the rest of the technical data, and the style follows
   * from what the text *is* instead of being passed in as a class.
   */
  numeric?: boolean;
}>();
</script>

<template>
  <header class="page-head">
    <div class="page-head-copy">
      <h1>{{ title }}</h1>
      <p v-if="note || $slots.note" class="page-head-note" :class="{ mono: numeric }">
        <slot name="note">{{ note }}</slot>
      </p>
    </div>
    <!-- Actions are opt-in and sit at the far right, aligned to the title's
         baseline rather than the note's, so a page with no note looks the same
         as one with a note. -->
    <div v-if="$slots.actions" class="page-head-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-head {
  display: flex;
  align-items: flex-start;
  gap: var(--space-6);
  flex: 0 0 auto;
  padding-bottom: var(--space-6);
  /*
   * No inset for the window's own buttons, deliberately.
   *
   * The shell already reserves their band with a 34px strip above the page, so
   * this row starts below the caption whatever the page's own padding is. An
   * earlier version subtracted the caption width here as well — that kept the
   * action clear of buttons it could no longer reach, and pushed it 110px left
   * of the content below: every page's primary action floated in the middle of
   * the width while its list ran to the pane edge.
   *
   * The subtraction also quietly assumed the page's side padding was 28px, so
   * on the messages page (20px) it was wrong by 8px even when it applied.
   * Reserving the band once, in the shell, is what makes this row align with
   * the content at every padding.
   */
}

/* Let the copy shrink so buttons keep their intrinsic width. Without this the
   flex item shrinks below the sum of its buttons and their inline-flex children
   wrap onto two lines at the default window size. */
.page-head-copy {
  min-width: 0;
}

h1 {
  margin: 0;
  font-family: var(--font-display);
  font-size: var(--fs-xl);
  font-weight: 500;
  letter-spacing: -0.02em;
  line-height: 1.25;
  color: var(--text);
}

.page-head-note {
  margin: var(--space-1) 0 0;
  font-size: var(--fs-sm);
  line-height: 1.5;
  color: var(--muted);
}

.page-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 0 0 auto;
}
</style>
