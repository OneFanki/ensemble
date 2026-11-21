<script setup lang="ts">
/**
 * 管理浮层的壳：左侧一张宽面板 + 一层承接点击的透明遮罩。
 *
 * 它不是 `Modal`：模态会锁 `body { pointer-events: none }`，而这里的页面里
 * 还有自己开的下拉（站点/账号表单里的选择器），锁掉之后它们点不动。它也不
 * 抢焦点——浮层打开时用户可能还要看右半边的页面。
 *
 * 三件事必须由壳统一做，缺一件都会让浮层「关不掉」或「被挡」：
 *
 * 1. **透明遮罩必须存在。** 舞台上是 `<webview>` guest，它 `pointer-events: auto`
 *    时会把指针事件吃掉，事件不会冒泡到 document——没有遮罩时「点空白关闭」
 *    在页面区域根本不触发。
 * 2. **走 `useFloatingLayer`。** 它让顶栏的拖拽区在浮层打开时交出角色（否则
 *    点标题带空白处的事件根本进不了页面），并让原生 DevTools 面板让位——面板
 *    是原生表面，会盖在 HTML 之上。
 * 3. **Esc 关闭。** 焦点在应用壳里时由 window 监听处理；页面自己（webview）里
 *    的 Esc 仍然属于页面。
 *
 * 同一族浮层之间切换不叠加由调用方保证：同一时刻只挂载一个 `FloatingPane`，
 * 切换就是改那个 `layer` 的值（见 `ManageLayer.vue`）。
 */
import { X } from "lucide-vue-next";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useFloatingLayer } from "../../composables/floatingLayer";
import IconButton from "./IconButton.vue";

const props = withDefaults(
  defineProps<{
    /** 无障碍名称；面板本身不重复画标题，页面自己有。 */
    label: string;
    /** 是否打开。调用方通常用 `v-if` 挂载，这里仍按状态登记浮层。 */
    open?: boolean;
  }>(),
  { open: true },
);

const emit = defineEmits<{
  /** 遮罩被点、Esc 被按，或右上角关闭按钮被点。 */
  close: [];
}>();

const { t } = useI18n();

const isOpen = computed(() => props.open);
/*
 * 打开到关闭动画结束之间，浮层都算「在台上」。
 *
 * `useFloatingLayer` 管的是顶栏拖拽区与原生 DevTools 让位；关窗动画期间就把它
 * 撤掉的话，最后 160ms 里顶栏会提前夺回拖拽角色，页面也会在浮层还没消失时就
 * 被重新盖上来——动画看着像闪了一下。所以登记用 `rendered`，它比 `isOpen`
 * 晚一步落下。
 */
const rendered = ref(props.open);
useFloatingLayer(computed(() => rendered.value));

watch(
  isOpen,
  (open) => {
    if (open) rendered.value = true;
  },
  { immediate: true },
);

function onAfterLeave(): void {
  rendered.value = false;
}

const panel = ref<HTMLElement | null>(null);

/**
 * Esc closes the pane, unless something inner owns the key.
 *
 * Three guards, all observed rather than coordinated:
 *
 * - **A modal is up.** reka-ui marks that by locking `body { pointer-events:
 *   none }`; the Escape belongs to the dialog on top (its own handler closes
 *   it). Without this, one Escape closed the form *and* the pane behind it.
 * - **The key went to a field.** A text field's Escape reverts what was typed;
 *   dismissing the pane at the same time would take the user out of the form.
 * - **A dropdown is open.** A select or an anchored menu closes its own list on
 *   Escape; closing the pane too would skip the choice the user was making.
 *
 * The listener is on the window in the bubble phase, so an inner focusable
 * layer that stops propagation (a message detail does) keeps the key to itself.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (getComputedStyle(document.body).pointerEvents === "none") return;
  const target = event.target;
  if (
    target instanceof Element &&
    target.closest('input, textarea, select, [contenteditable="true"]')
  ) {
    return;
  }
  if (document.querySelector('[role="listbox"], [role="menu"], [data-launch-panel]')) return;
  emit("close");
}

/*
 * 遮罩用 `pointerdown` 而不是 `click`：按下即关，和页面上其它浮层一致；用
 * click 的话，按下与松开之间指针移到面板上就会漏掉这一次关闭。
 */
function onScrimPointerDown(event: PointerEvent): void {
  const target = event.target;
  // 只有遮罩本身算「外面」；面板内部的事件不应到这里，双保险。
  if (target instanceof Node && panel.value?.contains(target)) return;
  emit("close");
}

watch(
  isOpen,
  async (open) => {
    if (open) {
      window.addEventListener("keydown", onKeydown);
      // 焦点落到面板上，Esc 不必先点一下才有反应；也避免焦点留在刚点过的
      // 左栏按钮上，键盘用户不知道该往哪走。
      await nextTick();
      panel.value?.focus({ preventScroll: true });
    } else {
      window.removeEventListener("keydown", onKeydown);
    }
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <!--
    Teleported to the body: the pane reaches the window's edges and must not be
    clipped by the account column's overflow. The scrim is the element that
    makes "click anywhere else" work while a page is behind it.
  -->
  <Teleport to="body">
    <Transition name="floating-pane" appear @after-leave="onAfterLeave">
      <div v-if="isOpen" class="floating-layer" data-floating-pane-layer>
        <div class="floating-scrim" data-floating-scrim @pointerdown="onScrimPointerDown"></div>
        <section
          ref="panel"
          class="floating-pane"
          role="dialog"
          aria-modal="false"
          :aria-label="label"
          tabindex="-1"
          data-floating-pane
        >
          <header class="pane-head">
            <!--
              The title is drawn, not hidden.

              The head holds one close button, and a band with a lone "×" in the
              far corner reads as a strip that lost its content — the user cannot
              tell what the pane is called or why it ends there. The heading is
              the answer, and it costs the height the band already had.
            -->
            <h2 class="pane-title">{{ label }}</h2>
            <div class="pane-head-actions">
              <!-- The caller's own controls sit in the head too: they act on the
                   pane as a whole (which face to show), not on its content. -->
              <slot name="head" />
              <IconButton
                :ariaLabel="t('app.close')"
                :title="t('app.close')"
                size="sm"
                data-pane-close
                @click="emit('close')"
              >
                <X :size="13" />
              </IconButton>
            </div>
          </header>
          <div class="pane-body">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/*
 * Teleported to `<body>`: nothing here may rely on a parent, and the layer
 * must sit above the guest nodes (they are fixed at z-index 1) but below the
 * toast stack (100). Both numbers are the AGENTS.md contract: 70 mask, 71
 * content.
 */
.floating-layer {
  position: fixed;
  inset: 0;
  z-index: 70;
}

/*
 * The scrim covers the whole window, not just the page area.
 *
 * Clicking anywhere outside the pane closes it — including the account bar and
 * the address row. Those used to be left clear so a click there could switch
 * accounts or type an address while the pane stayed open. In practice the pane is
 * 60% of the window and the user's aim when dismissing is "not on the pane", not
 * "on the page area specifically"; leaving live strips around it made dismissal
 * fail exactly where the pointer was most likely to land.
 *
 * It has to be a real element rather than a document listener: a `<webview>`
 * guest takes the pointer for itself, so a document-level listener would never
 * hear the click the user aimed at the page.
 */
.floating-scrim {
  position: absolute;
  inset: 0;
  background: transparent;
}

/*
 * The pane: 60% of the window, capped so a 4K window does not produce a
 * kilometre-wide list. It starts at the window's left edge — the account column
 * is gone, so the page area is the whole width — and ends at the bottom edge.
 */
.floating-pane {
  position: absolute;
  top: calc(var(--titlebar-height) + var(--address-row-height));
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  /*
   * Narrower than it was (720px), but not by as much as the first attempt.
   *
   * The pane's contents became collapsible: sites are folded rows and an account
   * is a tile inside one, so a folded list no longer needs a wide surface. The
   * edit face still draws a four-column table while a site is open, though, and
   * at 560px the role and password chips truncated to one character each —
   * folded lists read fine narrow, an open table does not.
   */
  width: min(760px, 62vw);
  max-width: 100vw;
  /*
   * The edge is drawn, not implied by a shadow.
   *
   * The pane runs from just under the address row to the window's bottom, so
   * there is no room on two of its four sides for a shadow to be seen — a
   * `box-shadow` alone left it reading as "the page has been cut here", because a
   * blurred, slightly-transparent surface with no hard boundary looks like the
   * page continuing into a different colour. The hairline plus a real drop
   * shadow on the side that does have room is what makes it a panel lying on
   * top.
   */
  border-right: 1px solid var(--line);
  /*
   * Frosted glass, not an opaque sheet.
   *
   * The pane floats over a live page; an opaque rectangle makes the page read as
   * gone rather than covered. A blur keeps the page's colours moving under the
   * surface while the pane's own text stays legible on the tint.
   *
   * Measured before adopting it, because the carrier is a `<webview>` guest and
   * whether the compositor samples it is not obvious: a blur over a hard
   * black/white stripe page turned into a soft vertical gradient, and the frame
   * differed byte-for-byte from the same overlay without the filter. The control
   * over the app's own HTML differed as well, so the method itself was sound.
   *
   * Two consequences of that measurement:
   *
   * 1. **The tint carries the legibility.** Fields, rows and buttons inside stay
   *    fully opaque — glass is only the pane's own backdrop — and the tint is
   *    strong enough (78%) that a white page underneath cannot wash out muted
   *    text on top.
   * 2. **A filtered element becomes the containing block for `position: fixed`
   *    descendants.** Every popover inside the pane (`ComboBox`, `SelectField`)
   *    teleports to `<body>`, so none is a layout descendant and none measures
   *    its coordinates against this box. That is why this is safe here and was
   *    deliberately avoided on the bookmark bar, which had fixed panels as real
   *    descendants.
   */
  /*
   * The tint, and why it is this strong.
   *
   * 78% was measured on a saturated page and it was not enough: four strong
   * colour fields put visible red and green wash across the face switch, the
   * search field and the table's header row — every one of those is text the user
   * is trying to read, and the page underneath was competing with it. The blur is
   * what makes this read as glass; the tint is what keeps the pane readable, and
   * legibility wins. At 90% the colour drift is still visible along the pane's
   * empty areas and edges, and it no longer crosses any glyph.
   */
  background: color-mix(in srgb, var(--content) 90%, transparent);
  -webkit-backdrop-filter: blur(22px) saturate(1.5);
  backdrop-filter: blur(22px) saturate(1.5);
  /*
   * No `overflow: hidden` here.
   *
   * The body already clips its own scroll area, and this box has no rounded
   * corners to protect. Keeping it would clip the drop shadow to nothing — and
   * the shadow is doing real work now: a blurred, 90%-opaque surface that ends
   * flush against the page reads as "the page was cut here" without one.
   */
  box-shadow: var(--shadow-menu);
  z-index: 71;
  outline: none;
  transform-origin: left center;
}

/*
 * The head and body sit above the blurred backdrop, which they need to for
 * stacking — but they add no fill of their own. Every surface inside the pane
 * (the head's band, cards, fields, the filter row's buttons) states its own
 * background, and a second translucent layer here would double-tint the gaps
 * between them into a flat wash.
 */
.pane-head,
.pane-body {
  position: relative;
  z-index: 1;
}

/*
 * Open and close are the same motion in two directions.
 *
 * The pane used to animate in and then disappear in a single frame on close,
 * which read as a glitch rather than a dismissal: the eye follows the panel in
 * and then it is simply gone. A `Transition` (not an enter-only `animation`) is
 * what makes both directions share a curve, and the leave has to be *faster*
 * than the enter — dismissal should feel like getting out of the way, not like
 * watching the panel reverse itself.
 *
 * `transform` and `opacity` only: both are compositor properties, so the blur
 * underneath is never re-rasterised per frame.
 */
.floating-pane-enter-active {
  transition:
    opacity var(--motion-slow) var(--ease-out),
    transform var(--motion-slow) var(--ease-out);
}

.floating-pane-leave-active {
  transition:
    opacity calc(var(--motion-base) * 0.75) var(--ease-out),
    transform calc(var(--motion-base) * 0.75) var(--ease-out);
}

.floating-pane-enter-from,
.floating-pane-leave-to {
  opacity: 0;
  transform: translateX(calc(-1 * var(--motion-shift))) scaleX(var(--motion-pop-scale));
}

/* The scrim fades with the pane; it has no motion of its own. */
.floating-pane-enter-active .floating-scrim,
.floating-pane-leave-active .floating-scrim {
  transition: opacity var(--motion-slow) var(--ease-out);
}

.floating-pane-leave-active .floating-scrim {
  transition-duration: calc(var(--motion-base) * 0.75);
}

.floating-pane-enter-from .floating-scrim,
.floating-pane-leave-to .floating-scrim {
  opacity: 0;
}

/*
 * The head sits in the pane, not on top of it.
 *
 * It used to draw its own band: a raised fill and a hairline under it. On a
 * glass surface that reads as a second window stacked on the first — two
 * surfaces and two edges, when the whole point of the blur is that the pane is
 * one object lying over the page. The title and the controls now simply sit at
 * the top of the same surface.
 */
.pane-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: var(--space-4);
  /* A floor, not a height: the head's controls can grow taller than the title. */
  min-height: 40px;
  padding: 4px 10px 0 14px;
  background: none;
  border-bottom: 0;
}

.pane-title {
  margin: 0;
  min-width: 0;
  font-family: var(--font-display);
  font-size: var(--fs-md);
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pane-head-actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  flex: 0 0 auto;
}

/*
 * The page inside is a `.page` frame (`flex: 1 1 auto`, `overflow: hidden`),
 * so the body has to be a flex column that can shrink: otherwise the page's
 * own `min-height: 0` never bites and the pane grows past the window.
 */
.pane-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.pane-body > :deep(*) {
  min-height: 0;
}
</style>
