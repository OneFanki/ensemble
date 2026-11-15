<script setup lang="ts">
/**
 * An input container whose outline is an SVG stroke with a one-shot focus trace.
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
 * state. A CSS border cannot: it is a second line with its own width, so the
 * moving 2px dash travelled over a 1px frame and the settled accent line looked
 * thinner than the one that had just drawn it. Everything here is therefore an
 * SVG rect: a 1px resting hairline, a 2px accent stroke for the settled focus,
 * and the 2px dash that runs one lap between them. The field inside is
 * borderless and transparent.
 *
 * ## The trace
 *
 * A dash animated by `stroke-dashoffset` from one lap to the next. A dash is
 * what makes the line travel at a constant speed along the *outline*; a
 * rotating conic gradient moves at wildly different speeds across a wide box
 * and, with a glow clipped inside it, washed the content area on every focus.
 *
 * `pathLength="100"` turns the dash numbers into percentages of the perimeter,
 * so the same 12-unit head looks right on the 32px omnibox and the 46px hero
 * box without measuring either.
 *
 * The animation is triggered by `:focus-within` in pure CSS. Losing focus stops
 * matching the rule, which resets the animation, so focusing again replays it —
 * no state, no timers, nothing to leak. It runs once and ends: the resting
 * focused state is the same 2px accent stroke the dash travelled on. A ring
 * that kept moving while somebody types would be motion in the corner of the
 * eye for as long as the page is open.
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
    <!-- The dash travels on the outline itself. No glow layer: light inside the
         field read as a second, rotating sweep over the content. -->
    <svg class="sweep" aria-hidden="true">
      <rect class="shell-outline" />
      <rect class="shell-focus" />
      <rect class="sweep-line" pathLength="100" />
    </svg>
  </component>
</template>

<style scoped>
.input-shell {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  /* No CSS border. The resting edge is an SVG stroke on the same geometry as the
     sweep: a border is a second line at a different width, so the 2px dash
     travelled over a 1px frame and the settled accent line looked thinner than
     the one that had just drawn it. */
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

/* A flat shell groups fields on a surface that already has an edge; the focus
   state is a neutral line, not the accent frame. */
.input-shell.flat:focus-within .shell-outline {
  stroke: var(--line);
}

.input-shell.flat .shell-focus {
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

/*
 * Focused: one accent stroke, and nothing else changes size.
 *
 * No outer ring. There used to be a 3px `--accent-soft` glow, which on the dark
 * chrome read as a fuzzy halo around a 30px field — the heaviest decoration in
 * the toolbar — and on light turned into a smear of tinted gold over white.
 */
.input-shell:focus-within {
  background: var(--chrome);
}

/* The settled stroke arrives under the dash's tail. Without the delay it is the
   same gold the moment the dash starts, and a 2px dash over a 2px line of one
   colour is invisible; arriving only after the lap would flash a gap. The
   undelayed transition on the base rule is the way out: losing focus drops the
   line at once instead of making it linger. */
.input-shell:focus-within .shell-focus {
  opacity: 1;
  transition: opacity 150ms var(--ease-out) 350ms;
}

.input-shell.flat:focus-within {
  background: transparent;
}

/* The global reduced-motion rule shortens durations but leaves delays alone;
   with the dash gone in an instant, the settled stroke must not wait for it. */
@media (prefers-reduced-motion: reduce) {
  .input-shell:focus-within .shell-focus {
    transition-delay: 0s;
  }
}

/*
 * The trace.
 *
 * The SVG fills the shell exactly, and the rects draw the whole outline: a
 * resting hairline, the settled accent stroke, and the dash that travels once.
 * The three share coordinates, so the line the dash rides and the line left
 * behind it are the same line — no border underneath at a different width.
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
   the box covers exactly 0–1px, the same weight the old border had. */
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

/* The settled focus state and the dash, on identical geometry: a 2px accent
   stroke sitting 1px inside the box, covering the outer edge plus one pixel of
   the field. The dash overlaps the settled line exactly, and the final line is
   as thick as the one that travelled. */
.shell-focus,
.sweep-line {
  x: 1px;
  y: 1px;
  width: calc(100% - 2px);
  height: calc(100% - 2px);
  rx: calc(var(--shell-radius, var(--radius)) - 1px);
  fill: none;
  stroke: var(--accent);
  stroke-width: 2px;
}

.shell-focus {
  opacity: 0;
  /* Leaving focus: no delay, so the frame does not sit lit for a third of a
     second after the caret went elsewhere. */
  transition: opacity 120ms var(--ease-out);
}

.sweep-line {
  stroke-linecap: round;
  /* 12 units of the perimeter, expressed relative to the element's own length
     by `pathLength="100"`; one dash per lap. */
  stroke-dasharray: 12 88;
  stroke-dashoffset: 0;
  opacity: 0;
}

/*
 * One lap, then gone.
 *
 * The head enters at the top-left corner and leaves where it started, so the
 * field reads as being drawn once rather than as a light orbiting the centre.
 * Linear speed: an eased dash slows down along the bottom edge, which is the
 * one part of the lap nobody is looking at. Half a second is quick enough to
 * feel like a response to the click; the first version's 800ms felt like
 * waiting for the field to finish something.
 *
 * Triggered by `:focus-within` in pure CSS: losing focus stops matching the
 * rule, which resets the animation, so focusing again replays it. No state, no
 * timers, nothing to leak.
 */
.input-shell:focus-within .sweep-line {
  animation: sweep-border 500ms linear both;
}

@keyframes sweep-border {
  0% {
    stroke-dashoffset: 0;
    opacity: 0;
  }
  8% {
    opacity: 1;
  }
  88% {
    opacity: 1;
  }
  100% {
    /* A full lap: one lap is 100 units because of `pathLength`. */
    stroke-dashoffset: -100;
    opacity: 0;
  }
}
</style>
