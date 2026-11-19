<script setup lang="ts">
/**
 * An input container whose focus state is drawn by two CSS gradients, not a
 * border.
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
 * ## The focus state: one outline, wiped in from the left
 *
 * The whole perimeter lights up as a single 2px accent outline. The animation is
 * a clip wipe — the overlay is clipped to `inset(0 100% 0 0)` at rest and opens
 * to `inset(0)`, which reveals the left edge first, then both horizontal edges
 * running rightward, then the right edge. Nothing travels around the perimeter,
 * no keyframes for position, and 170ms linear is the whole thing.
 *
 * It *is* the settled state: when the wipe finishes there is nothing left to
 * swap in. That is the point — the version before this one ran a dash a full lap
 * (500ms) and then faded a second stroke in behind it (another 350ms), so a
 * click took almost a second to look finished.
 *
 * The two-strip version that briefly replaced it drew only the horizontal edges,
 * inset by the corner radius. On a real window that read as a broken outline —
 * the left and right sides never lit and the corners were simply missing. A
 * closed shape is what "this is the field you are typing in" looks like.
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
    <!-- The resting edge only. The focus outline is a pseudo-element: one
         overlay whose clip opens left to right, which a static stroke cannot
         express. -->
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
     two rules on the horizontal edges. A border would be a third line nobody
     asked for. */
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
   state is a neutral line rather than the accent rules. */
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

/*
 * Focused: the fill lifts one step and the two horizontal rules draw.
 *
 * No outer ring. There used to be a 3px `--accent-soft` glow, which on the dark
 * chrome read as a fuzzy halo around a 30px field — the heaviest decoration in
 * the toolbar — and on light turned into a smear of tinted gold over white.
 */
.input-shell:focus-within {
  background: var(--chrome);
}

.input-shell.flat:focus-within {
  background: transparent;
}

/*
 * The focus state.
 *
 * One overlay carries the whole outline — all four edges and the rounded
 * corners — and the animation is a wipe from the left end to the right one: the
 * clip is opened from `inset(0 100% 0 0)` to `inset(0)`, so the left vertical
 * edge appears first, both horizontal edges run rightward, and the right
 * vertical edge arrives last. 170ms, linear.
 *
 * Why the whole perimeter instead of two horizontal strips: strips inset by the
 * corner radius leave the left and right edges unlit and cut the corners off
 * completely, which reads as a broken outline rather than a focused field. The
 * wipe gives the same "draws itself leftward to rightward" motion while ending
 * on a closed shape.
 *
 * `linear`, not eased: the revealed width *is* the progress, so an ease would
 * read as the field hesitating and then rushing. 170ms is short enough to be a
 * response to the click and long enough to see the direction.
 *
 * The overlay is 2px on a `border`, so it lands a pixel inside the shell's edge
 * and covers the resting hairline instead of sitting a second line beside it.
 */
.input-shell::after {
  content: "";
  position: absolute;
  inset: 0;
  border: 2px solid var(--accent);
  border-radius: var(--shell-radius, var(--radius));
  clip-path: inset(0 100% 0 0);
  opacity: 0;
  pointer-events: none;
}

.input-shell:focus-within::after {
  clip-path: inset(0 0 0 0);
  opacity: 1;
  transition:
    clip-path 170ms linear,
    opacity 90ms linear;
}

/* Leaving focus drops the outline at once: a line that unwound for as long as
   it took to draw would still be visible after the caret moved on. */
.input-shell:not(:focus-within)::after {
  transition: opacity 90ms var(--ease-out);
}

/*
 * The resting edge.
 *
 * The SVG fills the shell exactly and draws one hairline on the same geometry
 * the rules ride, so there is no second edge at a different width underneath.
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
</style>
