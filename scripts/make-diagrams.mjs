/**
 * Generates the README / landing-page diagrams.
 *
 * Two scenes here cannot be photographed: edge-to-edge tiling (a screenshot would
 * look like any window arrangement) and a transient overlay that only exists for
 * two seconds. They are drawn as SVG so they stay sharp at any width and stay
 * editable when the UI changes.
 *
 * Both languages are emitted from one source so the landing page can swap them
 * with its existing data-zh-src / data-en-src mechanism:
 *
 *   pnpm diagrams   (or: node scripts/make-diagrams.mjs)
 *
 * Writes docs/diagrams/<name>.svg (English) and <name>.zh.svg (Chinese).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUTPUT_DIR = "docs/diagrams";

const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";

function layoutGrid(t) {
  const win = (x, y, color, title, rows) => `
    <rect x="${x}" y="${y}" width="470" height="252" fill="#0d1014"/>
    <rect x="${x}" y="${y}" width="470" height="30" fill="url(#chrome)"/>
    <circle cx="${x + 16}" cy="${y + 15}" r="4" fill="${color}"/>
    <text x="${x + 27}" y="${y + 20}" font-family="${FONT}" font-size="12" fill="#c9ced6">${title}</text>
    <g fill="#171b21">
      ${rows}
    </g>`;
  const lines = (x, y, widths) =>
    widths
      .map((width, index) => `<rect x="${x}" y="${y + index * 20}" width="${width}" height="10" rx="3"/>`)
      .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720" width="1200" height="720" role="img" aria-label="${t.aria}">
  <title>${t.title}</title>
  <defs>
    <linearGradient id="stage" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12151a"/>
      <stop offset="1" stop-color="#0b0d10"/>
    </linearGradient>
    <linearGradient id="chrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b212a"/>
      <stop offset="1" stop-color="#151a21"/>
    </linearGradient>
  </defs>

  <rect width="1200" height="720" rx="18" fill="url(#stage)"/>
  <rect x="0.5" y="0.5" width="1199" height="719" rx="17.5" fill="none" stroke="#232a33"/>

  <g font-family="${FONT}">
    <text x="130" y="62" font-size="22" fill="#eef0f3" font-weight="600">${t.headline}</text>
    <text x="${t.headlineX}" y="62" font-size="13" fill="#a3abb8">${t.subline}</text>
    <text x="130" y="86" font-size="12" fill="#828c9a">${t.note}</text>
  </g>

  <rect x="130" y="108" width="940" height="504" fill="#0b0d10" stroke="#303844" stroke-width="1.5"/>
${win(130, 108, "#e0a44e", t.accounts[0], `${lines(150, 158, [190, 300, 248])}
      <rect x="150" y="222" width="120" height="22" rx="5" fill="#1f2733"/>
      <rect x="283" y="222" width="86" height="22" rx="5" fill="#1a212a"/>`)}
${win(600, 108, "#5cc8b6", t.accounts[1], `${lines(620, 158, [164, 280, 212])}
      <rect x="620" y="222" width="86" height="22" rx="5" fill="#1a212a"/>`)}
${win(130, 360, "#a396ff", t.accounts[2], `${lines(150, 410, [220, 286])}
      <rect x="150" y="454" width="104" height="22" rx="5" fill="#1f2733"/>`)}
${win(600, 360, "#98a2b0", t.accounts[3], lines(620, 410, [182, 256, 210]))}

  <path d="M600 108V612M130 360H1070" stroke="#303844" stroke-width="1.5"/>

  <g font-family="${FONT}">
    <g transform="translate(130 652)">
      <rect x="0" y="0" width="34" height="26" fill="none" stroke="#e0a44e" stroke-width="1.2"/>
      <path d="M17 0v26" stroke="#e0a44e" stroke-width="1.2"/>
      <rect x="15" y="10" width="4" height="6" fill="#e0a44e"/>
    </g>
    <text x="176" y="669" font-size="12" fill="#c9ced6">
      <tspan fill="#e0a44e" font-weight="600">${t.gutterStrong}</tspan>
      <tspan fill="#828c9a">${t.gutterRest}</tspan>
    </text>

    <g transform="translate(130 690)">
      <circle cx="4" cy="0" r="4" fill="#e0a44e"/>
      <circle cx="18" cy="0" r="4" fill="#5cc8b6"/>
      <circle cx="32" cy="0" r="4" fill="#a396ff"/>
      <circle cx="46" cy="0" r="4" fill="#98a2b0"/>
      <text x="62" y="4" font-size="12" fill="#828c9a">${t.legend}</text>
    </g>
  </g>
</svg>
`;
}

function overlaySwitch(t) {
  const chrome = (x, y, width, title, color) => `
    <rect x="${x}" y="${y}" width="${width}" height="26" fill="url(#chrome2)"/>
    <circle cx="${x + 17}" cy="${y + 13}" r="4.5" fill="${color}"/>
    <text x="${x + 29}" y="${y + 17}" font-size="12" fill="#eef0f3" font-family="${FONT}">${title}</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 720" width="1200" height="720" role="img" aria-label="${t.aria}">
  <title>${t.title}</title>
  <defs>
    <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12151a"/>
      <stop offset="1" stop-color="#0b0d10"/>
    </linearGradient>
    <linearGradient id="chrome2" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b212a"/>
      <stop offset="1" stop-color="#151a21"/>
    </linearGradient>
    <linearGradient id="pill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#242c36" stop-opacity="0.94"/>
      <stop offset="1" stop-color="#151a21" stop-opacity="0.94"/>
    </linearGradient>
    <filter id="shadow" x="-30%" y="-30%" width="160%" height="180%">
      <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="#000" flood-opacity="0.55"/>
    </filter>
    <filter id="soft" x="-40%" y="-40%" width="180%" height="200%">
      <feDropShadow dx="0" dy="6" stdDeviation="10" flood-color="#000" flood-opacity="0.5"/>
    </filter>
    <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0L10 5L0 10z" fill="#e0a44e"/>
    </marker>
  </defs>

  <rect width="1200" height="720" rx="18" fill="url(#bg2)"/>
  <rect x="0.5" y="0.5" width="1199" height="719" rx="17.5" fill="none" stroke="#232a33"/>

  <g font-family="${FONT}">
    <text x="80" y="58" font-size="22" fill="#eef0f3" font-weight="600">${t.headline}</text>
    <text x="${t.sublineX}" y="58" font-size="13" fill="#a3abb8">${t.subline}</text>
  </g>

  <rect x="80" y="88" width="1040" height="540" fill="#0b0d10" stroke="#303844" stroke-width="1.5"/>

  <!-- Background windows, dimmed: identical pages give no clue which account they hold -->
  <g opacity="0.38">
    <rect x="120" y="120" width="440" height="220" fill="#0d1014" stroke="#303844"/>
    <rect x="120" y="120" width="440" height="26" fill="url(#chrome2)"/>
    <g fill="#171b21">
      <rect x="140" y="164" width="180" height="9" rx="3"/>
      <rect x="140" y="182" width="300" height="9" rx="3"/>
      <rect x="140" y="200" width="240" height="9" rx="3"/>
    </g>
    <rect x="700" y="120" width="380" height="220" fill="#0d1014" stroke="#303844"/>
    <rect x="700" y="120" width="380" height="26" fill="url(#chrome2)"/>
    <g fill="#171b21">
      <rect x="720" y="164" width="150" height="9" rx="3"/>
      <rect x="720" y="182" width="270" height="9" rx="3"/>
    </g>
    <rect x="120" y="400" width="440" height="200" fill="#0d1014" stroke="#303844"/>
    <rect x="120" y="400" width="440" height="26" fill="url(#chrome2)"/>
    <g fill="#171b21">
      <rect x="140" y="444" width="210" height="9" rx="3"/>
      <rect x="140" y="462" width="280" height="9" rx="3"/>
    </g>
  </g>

  <!-- The window that was just raised -->
  <g filter="url(#shadow)">
    <rect x="620" y="286" width="470" height="320" fill="#0d1014" stroke="#4b5665"/>
    ${chrome(620, 286, 470, t.window, "#5cc8b6")}
    <g fill="#1a212a">
      <rect x="642" y="340" width="200" height="10" rx="3"/>
      <rect x="642" y="362" width="330" height="10" rx="3"/>
      <rect x="642" y="384" width="268" height="10" rx="3"/>
      <rect x="642" y="412" width="120" height="24" rx="5" fill="#232c38"/>
      <rect x="774" y="412" width="92" height="24" rx="5" fill="#1a212a"/>
    </g>
  </g>

  <!-- Transient account pill, sitting over the page of that window. Its 10px
       corners match the app: a capsule made the identity dot look off-centre. -->
  <g filter="url(#soft)">
    <rect x="742" y="470" width="252" height="54" rx="10" fill="url(#pill)" stroke="#3a434f"/>
    <circle cx="768" cy="497" r="4" fill="#5cc8b6"/>
    <text x="782" y="494" font-size="13.5" fill="#eef0f3" font-weight="500" font-family="${FONT}">${t.account}</text>
    <text x="782" y="510" font-size="10.5" fill="#a3abb8" font-family="${FONT}">${t.meta}</text>
  </g>
  <!-- Fade hint: the same pill dissolving, drawn inside the window it sits on -->
  <g filter="url(#soft)" opacity="0.28">
    <rect x="770" y="536" width="196" height="42" rx="10" fill="url(#pill)" stroke="#5cc8b6" stroke-dasharray="4 5"/>
    <circle cx="788" cy="557" r="3.5" fill="#5cc8b6"/>
    <text x="800" y="561" font-size="12" fill="#eef0f3" font-family="${FONT}">${t.account}</text>
  </g>
  <text x="1006" y="500" font-size="10" fill="#5cc8b6" font-family="${FONT}">${t.fades}</text>

  <!-- Floating switcher -->
  <g filter="url(#shadow)">
    <rect x="96" y="150" width="196" height="214" rx="9" fill="#12151a" stroke="#303844"/>
    <path d="M96 159a9 9 0 0 1 9-9h178a9 9 0 0 1 9 9v25H96z" fill="#171b21"/>
    <g fill="#5a6270">
      <circle cx="110" cy="167" r="1.6"/>
      <circle cx="116" cy="167" r="1.6"/>
      <circle cx="122" cy="167" r="1.6"/>
    </g>
    <text x="134" y="171" font-size="10.5" fill="#a3abb8" letter-spacing="0.4" font-family="${FONT}">${t.running}</text>
    <rect x="248" y="160" width="14" height="14" rx="4" fill="#1d232b"/>
    <rect x="270" y="160" width="14" height="14" rx="4" fill="#1d232b"/>

    <g font-size="11.5" font-family="${FONT}">
      <circle cx="112" cy="196" r="2.6" fill="#e0a44e"/>
      <text x="124" y="200" fill="#a3abb8">${t.rows[0]}</text>

      <!-- active row: tinted background plus a ring that follows the row radius,
           exactly what the app draws. The ring is a full outline on purpose: an
           edge-only bar gets its ends clipped by the rounded corner. -->
      <rect x="100" y="206" width="188" height="26" rx="5" fill="#5cc8b6" opacity="0.13" stroke="#5cc8b6" stroke-opacity="0.5"/>
      <circle cx="112" cy="220" r="3.4" fill="#5cc8b6"/>
      <circle cx="112" cy="220" r="7.5" fill="#5cc8b6" opacity="0.22"/>
      <text x="124" y="224" fill="#eef0f3">${t.rows[1]}</text>

      <circle cx="112" cy="244" r="2.6" fill="#a396ff"/>
      <text x="124" y="248" fill="#a3abb8">${t.rows[2]}</text>

      <circle cx="112" cy="268" r="2.6" fill="#98a2b0"/>
      <text x="124" y="272" fill="#a3abb8">${t.rows[3]}</text>
    </g>

    <line x1="104" y1="288" x2="284" y2="288" stroke="#232a33"/>
    <text x="110" y="308" font-size="10.5" fill="#828c9a" font-family="${FONT}">${t.highlightNote}</text>
  </g>

  <!-- Mouse pointer on the active row -->
  <g transform="translate(252 226)">
    <path d="M0 0l0 17 4.5-4.6 3.2 7 3.4-1.6-3.2-6.8 6.1-0.6z" fill="#eef0f3" stroke="#0b0d10" stroke-width="1.2"/>
  </g>

  <!-- Click to raise arrow, leaving the panel and landing on the raised window -->
  <path d="M196 246 C 330 268, 470 300, 612 330" fill="none" stroke="#e0a44e" stroke-width="1.6" stroke-dasharray="5 5" marker-end="url(#arrow)"/>
  <g font-family="${FONT}">
    <rect x="300" y="248" width="${t.raiseWidth}" height="24" rx="12" fill="#1a2029" stroke="#3a434f"/>
    <text x="${300 + t.raiseWidth / 2}" y="264" font-size="11" fill="#e0a44e" text-anchor="middle">${t.raise}</text>
  </g>

  <text x="96" y="676" font-size="12" fill="#828c9a" font-family="${FONT}">${t.caption}</text>
</svg>
`;
}

const LAYOUT_GRID = {
  en: {
    aria: "Four browser windows tiled edge to edge in a 2x2 grid",
    title: "2x2 tiling without gaps",
    headline: "2 × 2",
    headlineX: 196,
    subline: "four accounts, one screen",
    note: "Each window is its own profile; the layout is a preset, not a manual arrangement.",
    accounts: ["Admin", "Reviewer", "Operator", "Viewer"],
    gutterStrong: "0 px",
    gutterRest: " gutter — window frames touch; the only line between them is the frame itself.",
    legend: "identity colour — the same dot appears next to the name in the switcher",
  },
  zh: {
    aria: "四个浏览器窗口以 2×2 平铺，边到边贴合",
    title: "2×2 平铺，没有间隙",
    headline: "2 × 2",
    headlineX: 196,
    subline: "四个账号，一块屏幕",
    note: "每个窗口一个独立 Profile；布局是预设，不是手工摆出来的。",
    accounts: ["管理员", "审核员", "运营", "只读"],
    gutterStrong: "0 px",
    gutterRest: " 间隙——窗口边框互相贴合，两者之间唯一的线就是边框本身。",
    legend: "身份色——悬浮条里名字前面的圆点也是它",
  },
};

const OVERLAY_SWITCH = {
  en: {
    aria: "Clicking a row in the floating switcher raises that browser window and briefly shows its account name over the window",
    title: "Switch from the overlay and see who you landed on",
    headline: "Click to switch",
    sublineX: 264,
    subline: "and know exactly which account you landed on",
    window: "Reviewer",
    account: "Reviewer",
    meta: "reviewer · Order service",
    fades: "fades after ~2 s",
    running: "RUNNING",
    runningWidth: 58,
    rows: ["Admin", "Reviewer", "Operator", "Viewer"],
    highlightNote: "Focused window is highlighted",
    raise: "raise window",
    raiseWidth: 134,
    caption:
      "No relaunch, no reload. The pill is click-through and never takes focus, so the window you just raised stays focused.",
  },
  zh: {
    aria: "点击悬浮条中的一行，唤起对应浏览器窗口，并在窗口上短暂显示账号名",
    title: "从悬浮条切换窗口，并看到切到了谁",
    headline: "点击切换",
    sublineX: 220,
    subline: "并且确切知道切到了哪个账号",
    window: "审核员",
    account: "审核员",
    meta: "审核 · 订单服务",
    fades: "约 2 秒后淡出",
    running: "运行中",
    runningWidth: 34,
    rows: ["管理员", "审核员", "运营", "只读"],
    highlightNote: "当前前台窗口会高亮",
    raise: "唤起窗口",
    raiseWidth: 118,
    caption: "不重启、不重载。浮层点击穿透、不抢焦点，所以刚唤起的窗口会保持在前台。",
  },
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const outputs = [
  ["layout-grid", LAYOUT_GRID, layoutGrid],
  ["overlay-switch", OVERLAY_SWITCH, overlaySwitch],
];
for (const [name, strings, build] of outputs) {
  for (const [locale, t] of Object.entries(strings)) {
    const file = join(OUTPUT_DIR, locale === "zh" ? `${name}.zh.svg` : `${name}.svg`);
    writeFileSync(file, build(t), "utf8");
    console.log(`wrote ${file}`);
  }
}
