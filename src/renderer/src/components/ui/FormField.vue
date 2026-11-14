<script setup lang="ts">
/**
 * One labelled control: a caption above, the control inside the body.
 *
 * It owns the caption's typography and the gap between the two, and nothing
 * else — the field can be a text input, a select, a checkbox row, a colour
 * swatch strip or a tag picker, so the body is a slot.
 *
 * `as="label"` is the default and the common case: clicking the caption focuses
 * the control. It is wrong when the body holds more than one focusable element
 * (a tag picker, a row of swatches), because then clicking anywhere in the
 * caption jumps to whichever control comes first. Those pass `as="div"`.
 *
 * `hint` renders the info glyph rather than a paragraph: an explanation that
 * sits permanently under a field turns a form into documentation. Only text that
 * changes what the user does — and cannot fit in the caption — earns the glyph.
 */
import HintIcon from "./HintIcon.vue";

withDefaults(
  defineProps<{
    /** The caption. Omit it and use the `label` slot for mixed content. */
    label?: string;
    /** Shown on hover/focus beside the caption. */
    hint?: string;
    /** `div` when the body has more than one focusable control. */
    as?: "label" | "div";
    /** Fill the remaining width of a row of fields. */
    grow?: boolean;
    /**
     * Sentence-case caption in body colour, for a field that is one line in a
     * short run of fields (the auth prompt, the device panel) rather than part
     * of a form's structure. The default is the small tracked caption.
     */
    plain?: boolean;
  }>(),
  { as: "label", grow: false, plain: false },
);
</script>

<template>
  <component :is="as" class="field" :class="{ grow, plain }">
    <span v-if="label || $slots.label || hint" class="label">
      <slot name="label">{{ label }}</slot>
      <HintIcon v-if="hint" :text="hint" />
    </span>
    <slot />
  </component>
</template>

<style scoped>
.field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.field.grow {
  flex: 1 1 0;
}

/*
 * The caption is upper-case with wide tracking.
 *
 * It reads as a caption rather than as the first line of the form: at 10.5px
 * with 0.1em tracking it is unmistakably a label, which is what lets the field
 * below it need no other decoration.
 */
.label {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--faint);
}

/* A field that is one line in a short run of them — an auth prompt, a device
   panel — reads as a form of two questions rather than as a structured form.
   Sentence case at body colour, and a tighter gap than the default. */
.field.plain {
  gap: 4px;
}

.field.plain .label {
  font-size: var(--fs-sm);
  letter-spacing: 0;
  text-transform: none;
  color: var(--text-secondary);
}
</style>
