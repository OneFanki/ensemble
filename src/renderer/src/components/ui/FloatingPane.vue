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
useFloatingLayer(isOpen);

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
    <div class="floating-layer" data-floating-pane-layer>
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
          <h2 class="sr-only">{{ label }}</h2>
          <div class="pane-head-actions">
            <IconButton
              :ariaLabel="t('app.close')"
              :title="t('app.close')"
              size="sm"
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
 * Clicking anywhere outside the pane closes it — including the account column
 * and the address row. Those two used to be left clear so a click there could
 * switch accounts or type an address while the pane stayed open. In practice the
 * pane is 60% of the window and the user's aim when dismissing is "not on the
 * pane", not "on the page area specifically"; leaving two live strips around it
 * made dismissal fail exactly where the pointer was most likely to land.
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
 * kilometre-wide list. It starts where the account column ends and where the
 * address row finishes, so both stay reachable, and it ends at the window's
 * bottom edge — the page area, exactly.
 */
.floating-pane {
  position: absolute;
  top: calc(var(--titlebar-height) + var(--address-row-height));
  bottom: 0;
  left: var(--account-rail-width);
  display: flex;
  flex-direction: column;
  width: min(720px, 60vw);
  max-width: calc(100vw - var(--account-rail-width));
  border-right: 1px solid var(--line);
  background: var(--content);
  box-shadow: var(--shadow-menu);
  z-index: 71;
  overflow: hidden;
  outline: none;
  animation: floating-pane-in var(--motion-slow) var(--ease-out);
  transform-origin: left center;
}

@keyframes floating-pane-in {
  from {
    opacity: 0;
    transform: translateX(calc(-1 * var(--motion-shift))) scaleX(var(--motion-pop-scale));
  }
}

/* A slim band with nothing but the close control: the page inside carries its
   own title, and a second heading above it would say the same word twice. */
.pane-head {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  height: 32px;
  padding: 0 6px;
  background: var(--frame);
  border-bottom: 1px solid var(--line-soft);
}

.pane-head-actions {
  display: flex;
  align-items: center;
  gap: 2px;
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
