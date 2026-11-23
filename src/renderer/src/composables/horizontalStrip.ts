import { onBeforeUnmount, ref, watch } from "vue";

/**
 * 横向溢出列表的滚动配套：滚动条被隐藏之后，两件必须补上的事。
 *
 * 1. **边界指示**。没有滚动条，用户就读不出「后面还有没有」，所以暴露
 *    `canLeft` / `canRight`，由调用方画成两端的小箭头。这个事实会随内容增删、
 *    标题宽度、窗口宽度变化，所以除了 scroll 事件外还挂着 MutationObserver
 *    （子节点增删与文本变化）和 ResizeObserver（容器自身变宽变窄）。
 * 2. **滚轮横滚，且是平滑的**。纵向滚轮落在横向列表上时转为横向滚动；滚动
 *    用 rAF 指数逼近实现——每次滚动的增量叠加到同一个目标值上，逐帧逼近，
 *    连续滚动是连续的滑行而不是一格一格地跳。
 *
 * 调用方把 `scroller` 绑到滚动元素上即可；列表被整棵替换（如按实例 key 换表）
 * 时 ref 会指向新节点，观察器随之重挂。
 */
export function useHorizontalStrip() {
  const scroller = ref<HTMLElement | null>(null);
  /** 左端还有内容（已向右滚过）。 */
  const canLeft = ref(false);
  /** 右端还有内容（没滚到底）。 */
  const canRight = ref(false);

  function update(): void {
    const el = scroller.value;
    if (!el) return;
    canLeft.value = el.scrollLeft > 1;
    canRight.value = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
  }

  /** 平滑滚动的目标值；空闲时与实际位置同步，避免外来滚动后基准漂移。 */
  let target = 0;
  let raf = 0;

  function step(): void {
    raf = 0;
    const el = scroller.value;
    if (!el) return;
    const diff = target - el.scrollLeft;
    if (Math.abs(diff) <= 1) {
      el.scrollLeft = target;
      update();
      return;
    }
    el.scrollLeft += diff * 0.28;
    update();
    raf = requestAnimationFrame(step);
  }

  /** 向 `delta` 像素处平滑滚动；动画进行中连续调用会把增量叠到同一目标上。 */
  function glide(delta: number): void {
    const el = scroller.value;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    const max = el.scrollWidth - el.clientWidth;
    const base = raf ? target : el.scrollLeft;
    target = Math.max(0, Math.min(max, base + delta));
    if (!raf) raf = requestAnimationFrame(step);
  }

  /**
   * 滚轮转横滚。绑在模板的 `@wheel` 上。
   *
   * 触控板的横向分量（`deltaX`）本身就在横滚，交给默认行为；只接管纯纵向
   * 滚轮，且只在真的有横向溢出时——没有溢出的列表上不能把滚轮吃掉。
   */
  function onWheel(event: WheelEvent): void {
    const el = scroller.value;
    if (!el || el.scrollWidth <= el.clientWidth) return;
    if (event.deltaX !== 0 || event.deltaY === 0) return;
    event.preventDefault();
    // 行模式的 delta 单位是「行」，按常见行高折算成像素。
    const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    glide(delta);
  }

  /** 边界箭头的动作：一次滚约七成视口，和浏览器的横向步进一个量级。 */
  function nudge(direction: -1 | 1): void {
    const el = scroller.value;
    if (!el) return;
    glide(direction * el.clientWidth * 0.7);
  }

  function onScroll(): void {
    const el = scroller.value;
    // 动画进行中的 scroll 事件是自己写的，不动目标；空闲时同步基准。
    if (el && !raf) target = el.scrollLeft;
    update();
  }

  let mo: MutationObserver | undefined;
  let ro: ResizeObserver | undefined;

  watch(scroller, (el, old) => {
    mo?.disconnect();
    ro?.disconnect();
    if (old) target = 0;
    if (!el) return;
    // 子节点增删（开新标签、关标签）与标题文本变化都会改 scrollWidth。
    mo = new MutationObserver(update);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    // 容器宽度变化（窗口缩放、账号条被挤）改 clientWidth。
    ro = new ResizeObserver(update);
    ro.observe(el);
    target = el.scrollLeft;
    update();
  });

  onBeforeUnmount(() => {
    if (raf) cancelAnimationFrame(raf);
    mo?.disconnect();
    ro?.disconnect();
  });

  return { scroller, canLeft, canRight, onWheel, onScroll, nudge };
}
