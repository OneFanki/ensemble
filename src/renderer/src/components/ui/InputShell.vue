<script setup lang="ts">
/**
 * A bordered input container with a one-shot focus sweep.
 *
 * Two surfaces need this exact thing: the omnibox in the browser toolbar and
 * the search box on the new-tab page. They had drifted — one drew a 3px glow
 * ring, the other a border in a mixed colour, and the address bar's ended up a
 * dirty olive line on the light theme (`--accent-text` there is a deep brown
 * gold meant for text on white). Same control, two opinions.
 *
 * ## Why the container and not the input
 *
 * The sweep has to be drawn *on the border*, exactly one pixel thick, following
 * the corner radius. An input cannot do that: `border` is one colour, and a
 * `box-shadow` ring sits outside the field and changes its footprint. So the
 * shell owns the border, and the field inside it is borderless.
 *
 * ## The sweep
 *
 * A conic-gradient ring masked down to the 1px border area. The gradient's angle
 * is a registered custom property (`@property`), which is what makes it
 * animatable at all — an unregistered custom property jumps between keyframes
 * instead of interpolating.
 *
 * The animation is triggered by `:focus-within` in pure CSS. Losing focus stops
 * matching the rule, which resets the animation, so focusing again replays it —
 * no state, no timers, nothing to leak. It runs once and ends: the resting
 * focused state is a clean 1px accent stroke. A ring that kept moving while
 * somebody types would be motion in the corner of the eye for as long as the
 * page is open.
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
    <!-- Light spilling inward. The clip is what keeps it from becoming a halo
         outside the field, which is the one thing a focus state must not be. -->
    <span class="sweep-clip" aria-hidden="true"><span class="sweep-glow"></span></span>
    <span class="sweep" aria-hidden="true"></span>
  </component>
</template>

<style scoped>
/* An angle has to be registered before it can be tweened; without this the
   gradient snaps through the keyframes instead of sweeping. */
@property --sweep {
  syntax: "<angle>";
  inherits: false;
  initial-value: 0deg;
}

.input-shell {
  position: relative;
  display: flex;
  align-items: center;
  min-width: 0;
  border: 1px solid var(--line);
  background: var(--field);
  /* The stroke, the fill and the sweep share one duration so arriving at the
     field reads as a single event rather than three. */
  transition:
    border-color var(--motion-base) var(--ease-out),
    background var(--motion-base) var(--ease-out);
}

.input-shell.toolbar {
  gap: 4px;
  height: var(--control-lg);
  padding: 0 4px 0 10px;
  border-radius: var(--radius);
}

.input-shell.hero {
  gap: 4px;
  height: 46px;
  padding: 0 6px 0 14px;
  /* A rounded rectangle, not a pill: height/2 radius on a 46px box is the
     search pill of a phone home screen. */
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.input-shell.flat {
  border-color: transparent;
  background: transparent;
}

/* The field inside is only the text area: the shell already drew the border,
   the fill and the focus state, so an input that also painted them would draw a
   field inside a field. `:slotted` because the input is written by the caller —
   that is what lets each search box keep its own v-model and key handlers
   without either of them owning the frame.

   `stretch`, not `height: 100%`: the shell is a border-box with a 1px border, so
   `100%` resolves against the *content* box and lands one pixel short on each
   edge — the field measured 30.67px inside a 32px shell, which the toolbar's
   one-height check caught. Stretching the flex item fills the row exactly,
   whatever the border and padding are. */
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
  border-color: var(--accent);
  background: var(--chrome);
}

.input-shell.flat:focus-within {
  border-color: var(--line);
  background: transparent;
}

/*
 * The sweep.
 *
 * A conic gradient whose angle is a registered custom property — that is what
 * makes it interpolate at all; an unregistered property jumps between keyframes.
 *
 * Two layers, because on a field this shape one is not enough. An omnibox is
 * nearly a thousand pixels wide and thirty tall, so a 1px arc along its edge is
 * a hairline that vanishes: the stroke alone was invisible in practice. The head
 * of the sweep therefore also lights the inside of the field for a short arc —
 * a glow travelling along the border, clipped to the box. The clip is the whole
 * point: light inside the field reads as the field lighting up, light outside it
 * reads as a halo, and a halo is what this control is replacing.
 */
.sweep-clip {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  overflow: hidden;
  pointer-events: none;
}

.sweep-glow {
  position: absolute;
  inset: -40%;
  opacity: 0;
  /* Blurred, because the raw conic edge is a hard wedge: on a box this wide the
     rays leaving the centre cross the field as straight grey-gold edges and read
     as a spotlight, not as light moving through. No blur radius wider than the
     field is tall, or the glow stops being directional. */
  filter: blur(9px);
  background: conic-gradient(
    from var(--sweep),
    transparent 0deg 250deg,
    color-mix(in srgb, var(--accent) 16%, transparent) 310deg,
    color-mix(in srgb, var(--accent) 22%, transparent) 330deg,
    transparent 356deg
  );
}

.sweep {
  position: absolute;
  inset: -1px;
  border-radius: inherit;
  pointer-events: none;
  opacity: 0;
  /* A 2px stroke, not 1px: the extra pixel is what makes the arc legible at
     this aspect ratio without turning the resting state into a heavy border —
     the resting state is the shell's own 1px stroke, this only shows while the
     sweep runs. */
  padding: 2px;
  background: conic-gradient(
    from var(--sweep),
    transparent 0deg 200deg,
    color-mix(in srgb, var(--accent) 45%, transparent) 245deg,
    var(--accent) 300deg,
    color-mix(in srgb, var(--accent) 60%, transparent) 330deg,
    transparent 352deg
  );
  /* Two masks composited to exclude: the second keeps the full box, the first
     keeps only the padding-box, so what remains is the ring. */
  mask:
    linear-gradient(#000 0 0) content-box,
    linear-gradient(#000 0 0);
  mask-composite: exclude;
}

/*
 * One pass, then gone.
 *
 * The head starts before the top-left corner and travels past a full turn, so
 * the light enters and leaves instead of appearing mid-border. The tail fades
 * before the animation ends so the ring does not vanish in a single frame.
 *
 * Triggered by `:focus-within` in pure CSS: losing focus stops matching the
 * rule, which resets the animation, so focusing again replays it. No state, no
 * timers, nothing to leak.
 */
.input-shell:focus-within .sweep {
  animation: sweep-border 700ms var(--ease-out) both;
}

.input-shell:focus-within .sweep-glow {
  animation: sweep-inner 700ms var(--ease-out) both;
}

@keyframes sweep-border {
  0% {
    --sweep: -70deg;
    opacity: 0;
  }
  10% {
    opacity: 1;
  }
  74% {
    opacity: 1;
  }
  100% {
    --sweep: 330deg;
    opacity: 0;
  }
}

@keyframes sweep-inner {
  0% {
    --sweep: -70deg;
    opacity: 0;
  }
  16% {
    opacity: 1;
  }
  68% {
    opacity: 1;
  }
  100% {
    --sweep: 330deg;
    opacity: 0;
  }
}

/* Both layers carry the same registered property, so they travel as one light.
   Declared on each layer because `@property` without `inherits` gives every
   element its own copy — inheriting it would let the border lag the glow. */
</style>
