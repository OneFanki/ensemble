<script setup lang="ts">
/**
 * "There is nothing here yet, and here is what to do about it."
 *
 * One shape for every empty list in the console: a centred icon, one sentence,
 * an optional second line, and the action. Six pages drew their own and three of
 * them left the action up in the page header — far from the message that
 * explains why there is nothing to see.
 *
 * The default slot is the action row rather than a `label`/`icon` prop, because
 * what goes there differs: sometimes one button, sometimes two, sometimes a
 * button that navigates to another page. What does not differ is the frame.
 *
 * No dashed box around it. It began as one, and an outline drawn around content
 * that does not exist turns "empty" into "a container you have not filled" —
 * the opposite of what the message says.
 */
defineProps<{
  /** One sentence. Say what is missing, not that the list is empty. */
  text: string;
  /** A second, quieter line. Copy the page passes in when it has something. */
  note?: string;
}>();
</script>

<template>
  <div class="empty">
    <slot name="icon" />
    <p>{{ text }}</p>
    <p v-if="note" class="empty-note">{{ note }}</p>
    <div v-if="$slots.default" class="empty-actions">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.empty {
  margin: auto;
  padding: var(--space-8) var(--space-6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  color: var(--muted);
  font-size: var(--fs-base);
  text-align: center;
  width: min(560px, 100%);
}

.empty :slotted(svg) {
  color: var(--faint);
}

/* Balanced, not greedy. Chinese has no word breaks, so the default line breaker
   packs the first line to the last possible character and drops whatever is
   left onto the second — the message reads as a sentence, so it should break
   like one. */
.empty p {
  margin: 0;
  max-width: 340px;
  line-height: 1.6;
  text-wrap: balance;
}

.empty-note {
  font-size: var(--fs-sm);
  color: var(--faint);
}

.empty-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  margin-top: var(--space-1);
}
</style>
