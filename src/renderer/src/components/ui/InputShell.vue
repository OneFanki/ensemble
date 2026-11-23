<script setup lang="ts">
/**
 * An input container whose focus state is one 1px accent outline fading in.
 *
 * Two surfaces need this exact thing: the omnibox in the browser toolbar and
 * the search box on the new-tab page. They had drifted — one drew a 3px glow
 * ring, the other a border in a mixed colour, and the address bar's ended up a
 * dirty olive line on the light theme (`--accent-text` there is a deep brown
 * gold meant for text on white). Same control, two opinions.
 *
 * ## Why the container and the input is borderless
 *
 * The outline has to follow the corner radius and be one geometry in every
 * state. A CSS border cannot hold that, and the field inside is borderless too
 * — it draws nothing of its own, so the shell is the only thing with an edge.
 *
 * ## The focus state: a 1px outline that fades in
 *
 * An opacity fade, nothing else. The outline is the same closed shape at every
 * moment — it only gets quieter and louder — so there is no reveal to follow
 * and no settled state to swap into at the end. The wipe this replaced made a
 * click the loudest event on the toolbar for 170ms; the fade answers it in the
 * same motion the fill's colour change already uses.
 */
withDefaults(
  defineProps<{
    /**
     * `toolbar` is the 32px omnibox; `hero` is the 46px box that owns the
     * new-tab page. Only the height, radius and padding differ.
     */
    size?: "toolbar" | "hero";
    /**
     * `form` when the field is its own submit target — both search boxes are,
     * because Enter with no explicit button still has to go somewhere. `div`
     * for a shell that only groups.
     */
    as?: "div" | "form";
    /**
     * Borderless fill, for an input that sits on an already-drawn surface.
     * Not used by the two search boxes; kept because a shell without it would
     * be re-implemented for the next one.
     */
    flat?: boolean;
  }>(),
  { size: "toolbar", as: "div", flat: false },
);
</script>

<template>
  <component :is="as" class="input-shell" :class="[size, { flat }]">
    <slot />
    <!-- The resting edge only. The focus outline is the `::after` overlay. -->
    <svg class="sweep" aria-hidden="true">
      <rect class="shell-outline" />
    </svg>
  </component>
</template>

<style scoped>
.input-shell {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  /* No CSS border: the resting edge is an SVG hairline, and the focus state is
     the `::after` outline. A border would be a third line nobody asked for. */
  background: var(--field);
  transition: background var(--motion-base) var(--ease-out);
}

.input-shell.toolbar {
  gap: 4px;
  height: var(--control-lg);
  padding: 0 4px 0 10px;
  --shell-radius: var(--radius);
  border-radius: var(--shell-radius);
}

.input-shell.hero {
  gap: 4px;
  height: 46px;
  padding: 0 6px 0 14px;
  /* A rounded rectangle, not a pill: height/2 radius on a 46px box is the
     search pill of a phone home screen. */
  --shell-radius: var(--radius-lg);
  border-radius: var(--shell-radius);
  background: var(--surface);
}

.input-shell.flat {
  background: transparent;
}

.input-shell.flat .shell-outline {
  stroke: transparent;
}

/* A flat shell groups fields on a surface that already has an edge; its focus
   state is a neutral line rather than the accent outline. */
.input-shell.flat:focus-within .shell-outline {
  stroke: var(--line);
}

.input-shell.flat::after {
  display: none;
}

/* The field inside is only the text area: the shell already drew the outline,
   the fill and the focus state, so an input that also painted them would draw a
   field inside a field. `:slotted` because the input is written by the caller —
   that is what lets each search box keep its own v-model and key handlers
   without either of them owning the frame.

   `stretch`, not `height: 100%`: the field should fill the row exactly rather
   than resolve its own height against the content box, whatever padding the
   shell carries. The toolbar's one-height check compares the two. */
.input-shell :slotted(input) {
  flex: 1 1 auto;
  align-self: stretch;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--text);
  font-size: var(--fs-base);
  outline: none;
}

/* Focused: the fill lifts one step; the outline is the `::after` overlay. */
.input-shell:focus-within {
  background: var(--chrome);
}

.input-shell.flat:focus-within {
  background: transparent;
}

/*
 * The focus outline: one 1px accent line around the whole perimeter, and the
 * only animation is its opacity.
 *
 * All four edges and the rounded corners ride one overlay, and the only
 * animation is its opacity. It used to be a 2px stroke wiped in from the left
 * (170ms); that made a click the loudest thing on screen. 1px is the weight the
 * resting hairline already carries, and a fade is the same answer the fill's
 * colour change gives.
 *
 * The 1px border on an `inset: 0` overlay lands exactly over the resting
 * hairline, covering it instead of sitting a second line beside it.
 */
.input-shell::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 1px solid var(--accent);
  border-radius: var(--shell-radius, var(--radius));
  opacity: 0;
  pointer-events: none;
}

.input-shell:focus-within::after {
  opacity: 1;
  transition: opacity var(--motion-base) var(--ease-out);
}

/* Leaving focus drops the outline quickly: a slow unwind would still be
   visible after the caret moved on. */
.input-shell:not(:focus-within)::after {
  transition: opacity 90ms var(--ease-out);
}

/*
 * The resting edge.
 *
 * The SVG fills the shell exactly and draws one hairline on the same geometry
 * the focus outline covers, so there is no second edge at a different width
 * underneath.
 */
.sweep {
  position: absolute;
  inset: 0;
  /* An absolutely positioned SVG is a replaced element: with `inset` alone it
     keeps its intrinsic 300×150 box and the rect is drawn at that size in the
     corner. The explicit size makes the viewport the shell's box. */
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}

/* Resting edge, flush with the shell: a 1px stroke centred half a pixel inside
   the box covers exactly 0–1px, the same weight the focus outline carries. */
.shell-outline {
  /* Geometry as CSS so the radius can follow the shell's variant, including the
     find bar's smaller override. */
  x: 0.5px;
  y: 0.5px;
  width: calc(100% - 1px);
  height: calc(100% - 1px);
  rx: calc(var(--shell-radius, var(--radius)) - 0.5px);
  fill: none;
  stroke: var(--line);
  stroke-width: 1px;
}
</style>
