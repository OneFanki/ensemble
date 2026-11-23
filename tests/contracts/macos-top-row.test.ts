import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * macOS 的红绿灯画在窗口首行左端，悬浮在应用自己的内容之上。
 *
 * 主进程用 `titleBarStyle: "hidden"` 收掉系统标题栏，再用
 * `trafficLightPosition` 把三颗原生按钮钉回内容区左上角——渲染层看到的
 * 全窗口都是可绘制区域，红绿灯叠在它的 (x, y) 处。整条链路里有四个只有
 * 跨文件才看得出来的约定，断开任何一环，红绿灯都会压在内容上且无法点击
 * （原生按钮永远吃掉它覆盖区域的指针事件）：
 *
 * 1. 红绿灯整颗落在首行带内（y + 按钮高 ≤ --titlebar-height）。「首行留白」
 *    这个模型成立的前提；红绿灯伸进第二行的话，需要让位的就不止首行了。
 * 2. `.top-row` 的第一个子元素——首行最左元素——带着不小于红绿灯整组右缘
 *    加最小间隙的 macOS 留白。留白必须写在**它**身上：写在首行任何其他
 *    元素上，红绿灯下面压着的还是最左元素自己的内容。这也是一次真实回归
 *    的形状：留白写在了第二个子元素上，第一个子元素的入口按钮被压住。
 * 3. `--window-controls-width` 在 macOS 固定为 0：红绿灯在左侧，右上角
 *    没有原生控件。这个变量是全部右上角留白的唯一来源，钉住它防止有人
 *    把「量不到就回退 138px」的 Windows 路径误套到 macOS 上。
 * 4. 设置页整窗替换浏览器页，它的头部是另一个「首行最左元素」，同样要留白。
 *
 * 断言的是下界（≥ 红绿灯右缘 + 间隙）与结构（留白属于谁），不是具体数字：
 * 实现可以按视觉调整留白，只要不让到红绿灯底下。按钮几何（12px、间隙
 * 8px）取 macOS 系统在标准标题栏里的红绿灯布局（AppKit 标准值，未在
 * macOS 实机复核过）。
 */
const ROOT = process.cwd();
const MAIN = readFileSync(join(ROOT, "src", "main", "index.ts"), "utf8");
const TOKENS = readFileSync(join(ROOT, "src", "renderer", "src", "styles", "tokens.css"), "utf8");
const BROWSER = readFileSync(
  join(ROOT, "src", "renderer", "src", "components", "BrowserPage.vue"),
  "utf8",
);
const SETTINGS = readFileSync(
  join(ROOT, "src", "renderer", "src", "components", "SettingsPage.vue"),
  "utf8",
);
const CONTROLS = readFileSync(
  join(ROOT, "src", "renderer", "src", "composables", "windowControls.ts"),
  "utf8",
);

/** macOS 标准红绿灯按钮的直径（逻辑像素）。 */
const LIGHT_WIDTH = 12;
/** 相邻两颗红绿灯之间的间隙。 */
const LIGHT_GAP = 8;
/** 留白右缘与红绿灯整组右缘之间要求的最小间隙。 */
const CLEARANCE = 8;

const light = /trafficLightPosition:\s*\{\s*x:\s*(\d+),\s*y:\s*(\d+)/.exec(MAIN);
const LIGHT_X = Number(light?.[1]);
const LIGHT_Y = Number(light?.[2]);
/** 红绿灯整组的右缘：x + 三颗按钮 + 两段间隙。 */
const LIGHTS_RIGHT = LIGHT_X + 3 * LIGHT_WIDTH + 2 * LIGHT_GAP;
/** 首行最左元素必须提供的 macOS 左侧留白下界。 */
const MIN_LEFT_RESERVE = LIGHTS_RIGHT + CLEARANCE;

/** 去掉 CSS 注释再扫规则体，注释里的花括号不会截断扫描。 */
function cssRules(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 模板里第一个带指定类名的元素的开标签。
 *
 * 模板先剥掉 HTML 注释；返回整个开标签文本，供调用方检查属性。
 */
function openTagOf(source: string, className: string): string | null {
  const template = source.slice(source.indexOf("<template>"), source.lastIndexOf("</template>"));
  const bare = template.replace(/<!--[\s\S]*?-->/g, "");
  const match = new RegExp(`<([a-z][\\w-]*)\\b[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`).exec(
    bare,
  );
  return match?.[0] ?? null;
}

/**
 * 类名的 `[data-platform="darwin"]` 规则里的 padding-left 像素值。
 *
 * 没有这条规则返回 null；有规则但没有像素值也返回 null。
 */
function darwinPaddingLeft(source: string, className: string): number | null {
  const rule = new RegExp(`\\.${className}\\[data-platform="darwin"\\]\\s*\\{([^}]*)`).exec(
    cssRules(source),
  );
  if (!rule) return null;
  const value = /padding-left:\s*(\d+(?:\.\d+)?)px/.exec(rule[1] ?? "");
  return value ? Number(value[1]) : null;
}

/** `.top-row` 的第一个子元素：标签名，原生元素时连同类名。 */
function firstTopRowChild(): { tag: string; className: string | null } {
  const match = /<div class="top-row"[^>]*>\s*<([\w-]+)(?:\s+class="([^"\s]+))?/.exec(BROWSER);
  expect(match, "模板里必须存在 .top-row 及其第一个子元素").not.toBeNull();
  return { tag: match![1]!, className: match![2] ?? null };
}

/** 组件模板根元素的第一个类名（darwin 留白的锚点）。 */
function rootClassOf(source: string, componentName: string): string {
  const template = source.slice(source.indexOf("<template>"), source.lastIndexOf("</template>"));
  const bare = template.replace(/<!--[\s\S]*?-->/g, "");
  const match = /<[a-z][\w-]*\b[^>]*class="([^"\s]+)/.exec(bare);
  expect(match, `${componentName} 的模板根元素必须带类名`).not.toBeNull();
  return match![1]!;
}

describe("macOS 的红绿灯与首行留白", () => {
  it("主进程声明了红绿灯位置，且整颗按钮落在首行带内", () => {
    expect(light, "主进程没有声明 trafficLightPosition，红绿灯回到了系统默认位置").not.toBeNull();
    const titlebar = /--titlebar-height:\s*(\d+)px/.exec(TOKENS)?.[1];
    expect(titlebar, "tokens 里没有 --titlebar-height").toBeDefined();
    expect(LIGHT_Y + LIGHT_WIDTH).toBeLessThanOrEqual(Number(titlebar));
  });

  it("首行最左元素带着避开红绿灯的 macOS 留白", () => {
    const { tag, className } = firstTopRowChild();
    let source: string;
    let anchor: string;
    if (/^[A-Z]/.test(tag)) {
      // 组件：留白写在组件根类上，文件就是组件自己。
      source = readFileSync(join(ROOT, "src", "renderer", "src", "components", `${tag}.vue`), "utf8");
      anchor = rootClassOf(source, tag);
      const rootOpen = openTagOf(source, anchor);
      expect(rootOpen, `${tag} 的根元素缺少 :data-platform 绑定，darwin 规则会静默失效`).toMatch(
        /:data-platform=/,
      );
    } else {
      // 原生元素：开标签与样式都在 BrowserPage 自身。
      source = BROWSER;
      anchor = className ?? "";
      expect(anchor, "首行最左元素是原生元素时必须带类名，否则留白规则没有锚点").toBeTruthy();
      const open = openTagOf(source, anchor);
      expect(open, `.${anchor} 缺少 :data-platform 绑定，darwin 规则会静默失效`).toMatch(
        /:data-platform=/,
      );
    }
    const padding = darwinPaddingLeft(source, anchor);
    expect(
      padding,
      `.${anchor} 缺少 [data-platform="darwin"] 的 padding-left，红绿灯会压住首行最左元素`,
    ).not.toBeNull();
    expect(padding!).toBeGreaterThanOrEqual(MIN_LEFT_RESERVE);
  });

  it("窗口控件宽度变量在 macOS 固定为 0", () => {
    expect(CONTROLS).toMatch(/if \(platform === "darwin"\)\s*\{\s*publish\(0\);\s*return;/);
  });

  it("设置页头部保留避开红绿灯的 macOS 留白", () => {
    const open = openTagOf(SETTINGS, "settings-head");
    expect(open, ".settings-head 缺少 :data-platform 绑定，darwin 规则会静默失效").toMatch(
      /:data-platform=/,
    );
    const padding = darwinPaddingLeft(SETTINGS, "settings-head");
    expect(padding, ".settings-head 缺少 [data-platform=\"darwin\"] 的 padding-left").not.toBeNull();
    expect(padding!).toBeGreaterThanOrEqual(MIN_LEFT_RESERVE);
  });
});
