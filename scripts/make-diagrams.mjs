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

/**
 * The front-page figure.
 *
 * A single picture has to carry the whole product: one scene orchestrated on the
 * left, four isolated profiles tiled edge to edge on the right, the switcher
 * floating over them with the current window highlighted, and the account name
 * confirming the switch. Numbered markers tie each part to a caption instead of
 * scattering paragraphs across the drawing.
 */
function hero(t) {
  const CHROME = "url(#heroChrome)";

  const windowMock = (x, y, color, name, buttons, readOnly) => {
    const sidebar = Array.from({ length: 5 }, (_, index) => {
      const width = [34, 28, 32, 26, 30][index];
      return `<rect x="${x + 10}" y="${y + 52 + index * 20}" width="${width}" height="5" rx="2.5" fill="${index === 0 ? "#2b3440" : "#1b222c"}"/>`;
    }).join("");

    const cards = [0, 1, 2]
      .map(
        (index) =>
          `<rect x="${x + 66 + index * 84}" y="${y + 62}" width="76" height="26" rx="4" fill="#151b23"/>`,
      )
      .join("");

    const rows = Array.from({ length: 4 }, (_, index) => {
      const rowY = y + 118 + index * 19;
      return `<rect x="${x + 66}" y="${rowY}" width="${130 - index * 12}" height="6" rx="3" fill="#1b222c"/>
        <rect x="${x + 214}" y="${rowY}" width="${44 + (index % 2) * 18}" height="6" rx="3" fill="#171d25"/>`;
    }).join("");

    let buttonX = x + 66;
    const buttonMarkup = readOnly
      ? `<rect x="${x + 66}" y="${y + 204}" width="150" height="22" rx="5" fill="none" stroke="#2b3440" stroke-dasharray="3 3"/>
         <text x="${x + 141}" y="${y + 219}" font-size="9.5" fill="#5c6675" text-anchor="middle" font-family="${FONT}">${t.noActions}</text>`
      : buttons
          .map((button) => {
            // The admin's delete button is tinted rather than ringed: a dashed
            // outline reads as another numbered marker, and the point here is
            // "this account sees an action the others do not".
            const markup = `<rect x="${buttonX}" y="${y + 204}" width="${button.w}" height="22" rx="5" fill="${button.hot ? "#2a2115" : "#1a212a"}" stroke="${button.hot ? "#8a6720" : "#2b3440"}"/>
             <text x="${buttonX + button.w / 2}" y="${y + 219}" font-size="9.5" fill="${button.hot ? "#e0a44e" : "#a3abb8"}" text-anchor="middle" font-family="${FONT}">${button.label}</text>`;
            buttonX += button.w + 6;
            return markup;
          })
          .join("");

    return `
    <rect x="${x}" y="${y}" width="360" height="300" fill="#0d1014"/>
    <rect x="${x}" y="${y}" width="360" height="30" fill="${CHROME}"/>
    <circle cx="${x + 14}" cy="${y + 15}" r="3.6" fill="${color}"/>
    <text x="${x + 24}" y="${y + 19.5}" font-size="11.5" fill="#c9ced6" font-family="${FONT}">${name}</text>
    <rect x="${x}" y="${y + 30}" width="54" height="270" fill="#10141a"/>
    ${sidebar}
    <text x="${x + 66}" y="${y + 52}" font-size="12" fill="#c9ced6" font-family="${FONT}">${t.pageTitle}</text>
    ${cards}
    <rect x="${x + 66}" y="${y + 100}" width="280" height="94" rx="4" fill="#11161d"/>
    <rect x="${x + 66}" y="${y + 100}" width="280" height="18" fill="#171e26"/>
    ${rows}
    ${buttonMarkup}
    <text x="${x + 346}" y="${y + 283}" font-size="9" fill="#5c6675" text-anchor="end" font-family="${FONT}">1 / 24</text>`;
  };

  const memberRows = t.members
    .map((member, index) => {
      const rowY = 206 + index * 28;
      return `<rect x="164" y="${rowY}" width="236" height="26" rx="5" fill="#0d1014" stroke="#232a33"/>
        <circle cx="176" cy="${rowY + 13}" r="3.4" fill="${member.color}"/>
        <text x="188" y="${rowY + 17}" font-size="10.5" fill="#c9ced6" font-family="${FONT}">${member.name}</text>
        <circle cx="388" cy="${rowY + 13}" r="7" fill="#1b222c"/>
        <text x="388" y="${rowY + 16.5}" font-size="8.5" fill="#828c9a" text-anchor="middle" font-family="${FONT}">${index + 1}</text>`;
    })
    .join("");

  // Chips are laid out left to right by their own width: the first label is much
  // wider than "1×1", and a fixed step made them overlap.
  let chipX = 164;
  const layoutChips = t.layouts
    .map((label, index) => {
      const width = label.length > 3 ? 42 : 28;
      const x = chipX;
      chipX += width + 6;
      const on = index === 4;
      return `<rect x="${x}" y="342" width="${width}" height="22" rx="5" fill="${on ? "#e0a44e" : "#0d1014"}" stroke="${on ? "#e0a44e" : "#232a33"}"/>
        <text x="${x + width / 2}" y="357.5" font-size="9" fill="${on ? "#1a1305" : "#828c9a"}" text-anchor="middle" font-family="${FONT}">${label}</text>`;
    })
    .join("");

  const preview = t.members
    .map((member, index) => {
      const x = 164 + (index % 2) * 124;
      const y = 376 + Math.floor(index / 2) * 66;
      return `<rect x="${x}" y="${y}" width="124" height="66" fill="${index === 1 ? "#3a2f1e" : "#0f1319"}" stroke="#2b3440" stroke-width="0.8"/>
        <circle cx="${x + 12}" cy="${y + 14}" r="3" fill="${member.color}"/>
        <text x="${x + 21}" y="${y + 17.5}" font-size="9" fill="${index === 1 ? "#e0a44e" : "#828c9a"}" font-family="${FONT}">${member.short}</text>`;
    })
    .join("");

  const overlayRows = t.members
    .map((member, index) => {
      const rowY = 526 + index * 30;
      const active = index === 1;
      return `${active ? `<rect x="460" y="${rowY}" width="156" height="28" rx="5" fill="#5cc8b6" fill-opacity="0.13" stroke="#5cc8b6" stroke-opacity="0.5"/>` : ""}
        <circle cx="472" cy="${rowY + 14}" r="3" fill="${member.color}"/>
        <text x="482" y="${rowY + 18}" font-size="10.5" fill="${active ? "#eef0f3" : "#a3abb8"}" font-family="${FONT}">${member.short}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 760" width="1200" height="760" role="img" aria-label="${t.aria}">
  <title>${t.title}</title>
  <defs>
    <linearGradient id="heroBg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#12151a"/>
      <stop offset="1" stop-color="#0a0c0f"/>
    </linearGradient>
    <linearGradient id="heroChrome" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1b212a"/>
      <stop offset="1" stop-color="#151a21"/>
    </linearGradient>
    <linearGradient id="heroPill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#242c36" stop-opacity="0.96"/>
      <stop offset="1" stop-color="#151a21" stop-opacity="0.96"/>
    </linearGradient>
    <filter id="heroShadow" x="-40%" y="-40%" width="180%" height="200%">
      <feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000" flood-opacity="0.55"/>
    </filter>
    <filter id="heroPanelShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000" flood-opacity="0.45"/>
    </filter>
  </defs>

  <rect width="1200" height="760" rx="18" fill="url(#heroBg)"/>
  <rect x="0.5" y="0.5" width="1199" height="759" rx="17.5" fill="none" stroke="#232a33"/>

  <g font-family="${FONT}">
    <text x="56" y="64" font-size="25" fill="#eef0f3" font-weight="600">${t.headline}</text>
    <text x="56" y="90" font-size="12.5" fill="#828c9a">${t.subline}</text>
  </g>

  <!-- Environment chip: the scope every window below belongs to -->
  <g>
    <rect x="1006" y="46" width="138" height="26" rx="13" fill="#12151a" stroke="#303844"/>
    <circle cx="1020" cy="59" r="3" fill="#e0a44e"/>
    <text x="1030" y="63" font-size="10.5" fill="#a3abb8" font-family="${FONT}">${t.env}</text>
  </g>

  <!-- ============ left: the scene that defines the group ============ -->
  <g filter="url(#heroPanelShadow)">
    <rect x="56" y="110" width="360" height="600" rx="10" fill="#12151a" stroke="#303844"/>
    <path d="M56 120a10 10 0 0 1 10-10h340a10 10 0 0 1 10 10v22H56z" fill="#171b21"/>
  </g>
  <g fill="#5a6270">
    <circle cx="70" cy="126" r="1.7"/>
    <circle cx="76" cy="126" r="1.7"/>
    <circle cx="82" cy="126" r="1.7"/>
  </g>
  <text x="94" y="130" font-size="11" fill="#a3abb8" font-family="${FONT}">Ensemble</text>

  <!-- rail -->
  <path d="M56 142h92v568H66a10 10 0 0 1-10-10z" fill="#10141a"/>
  <path d="M148 142v568" stroke="#232a33"/>
  <rect x="60" y="214" width="84" height="26" rx="5" fill="#e0a44e" fill-opacity="0.13"/>
  <rect x="60" y="214" width="2" height="26" rx="1" fill="#e0a44e"/>
  ${t.rail
    .map((label, index) => {
      const itemY = 158 + index * 32;
      const active = index === 2;
      return `<g>
        <rect x="68" y="${itemY - 4}" width="9" height="9" rx="2" fill="${active ? "#e0a44e" : "#3a434f"}" fill-opacity="${active ? 0.9 : 0.5}"/>
        <text x="86" y="${itemY + 4}" font-size="10.5" fill="${active ? "#eef0f3" : "#828c9a"}" font-family="${FONT}">${label}</text>
      </g>`;
    })
    .join("")}

  <!-- scene detail -->
  <text x="164" y="174" font-size="13.5" fill="#eef0f3" font-weight="500" font-family="${FONT}">${t.sceneName}</text>
  <text x="164" y="192" font-size="10" fill="#828c9a" font-family="${FONT}">${t.sceneMeta}</text>
  ${memberRows}

  <text x="164" y="332" font-size="9" fill="#5c6675" letter-spacing="0.8" font-family="${FONT}">${t.layoutLabel}</text>
  ${layoutChips}
  ${preview}

  <rect x="164" y="560" width="118" height="34" rx="7" fill="#e0a44e"/>
  <text x="223" y="582" font-size="12" fill="#1a1305" text-anchor="middle" font-weight="500" font-family="${FONT}">${t.run}</text>
  <text x="164" y="616" font-size="10" fill="#828c9a" font-family="${FONT}">${t.panelNote1}</text>
  <text x="164" y="634" font-size="10" fill="#828c9a" font-family="${FONT}">${t.panelNote2}</text>

  <!-- marker 1: the scene launches the group -->
  <circle cx="300" cy="577" r="9" fill="#e0a44e"/>
  <text x="300" y="580.5" font-size="10" fill="#1a1305" text-anchor="middle" font-weight="600" font-family="${FONT}">1</text>

  <!-- ============ right: four isolated windows, tiled edge to edge ============ -->
  ${windowMock(440, 110, "#e0a44e", t.windows[0].name, t.windows[0].buttons, false)}
  ${windowMock(800, 110, "#5cc8b6", t.windows[1].name, t.windows[1].buttons, false)}
  ${windowMock(440, 410, "#a396ff", t.windows[2].name, t.windows[2].buttons, false)}
  ${windowMock(800, 410, "#98a2b0", t.windows[3].name, t.windows[3].buttons, true)}

  <!-- The only lines between windows are the frames themselves. -->
  <path d="M800 110V710M440 410H1160" stroke="#303844" stroke-width="1.2"/>

  <!-- ============ switcher floating over the desktop ============ -->
  <g filter="url(#heroShadow)">
    <rect x="452" y="480" width="172" height="196" rx="8" fill="#12151a" stroke="#3a434f"/>
    <path d="M452 488a8 8 0 0 1 8-8h156a8 8 0 0 1 8 8v24H452z" fill="#171b21"/>
  </g>
  <g fill="#5a6270">
    <circle cx="464" cy="492" r="1.5"/>
    <circle cx="469" cy="492" r="1.5"/>
    <circle cx="474" cy="492" r="1.5"/>
  </g>
  <text x="484" y="496" font-size="9.5" fill="#a3abb8" font-family="${FONT}">${t.running}</text>
  <circle cx="${484 + t.runningWidth + 12}" cy="492" r="7.5" fill="#1d232b" stroke="#3a434f"/>
  <text x="${484 + t.runningWidth + 12}" y="495.5" font-size="8.5" fill="#a3abb8" text-anchor="middle" font-family="${FONT}">4</text>
  ${overlayRows}
  <text x="464" y="660" font-size="9" fill="#5c6675" font-family="${FONT}">${t.switchHint}</text>

  <!-- marker 2: switching raises a window and highlights its row -->
  <circle cx="638" cy="488" r="9" fill="#e0a44e"/>
  <text x="638" y="491.5" font-size="10" fill="#1a1305" text-anchor="middle" font-weight="600" font-family="${FONT}">2</text>

  <!-- ============ switch receipt over the raised window (centred near its top) ============ -->
  <g filter="url(#heroShadow)">
    <rect x="934" y="150" width="140" height="44" rx="8" fill="url(#heroPill)" stroke="#3a434f"/>
    <circle cx="952" cy="172" r="4" fill="#5cc8b6"/>
    <text x="964" y="170" font-size="12" fill="#eef0f3" font-weight="500" font-family="${FONT}">${t.receiptName}</text>
    <text x="964" y="184" font-size="9.5" fill="#a3abb8" font-family="${FONT}">${t.receiptRole}</text>
  </g>
  <rect x="952" y="204" width="104" height="28" rx="8" fill="none" stroke="#5cc8b6" stroke-opacity="0.4" stroke-dasharray="4 4"/>

  <!-- marker 3: the label is transient, not a permanent badge -->
  <circle cx="1092" cy="172" r="9" fill="#e0a44e"/>
  <text x="1092" y="175.5" font-size="10" fill="#1a1305" text-anchor="middle" font-weight="600" font-family="${FONT}">3</text>

  <!-- ============ captions ============ -->
  <g font-family="${FONT}" font-size="11.5" fill="#828c9a">
    ${t.legend
      .map(
        (item, index) => `<circle cx="${[62, 468, 806][index]}" cy="737" r="8" fill="#e0a44e"/>
      <text x="${[62, 468, 806][index]}" y="740.5" font-size="9.5" fill="#1a1305" text-anchor="middle" font-weight="600">${index + 1}</text>
      <text x="${[80, 486, 824][index]}" y="741" font-size="11" fill="#828c9a">${item}</text>`,
      )
      .join("")}
  </g>
</svg>
`;
}

const HERO = {
  en: {
    aria: "One view on the left launches four isolated browser profiles tiled edge to edge on the right, with a floating switcher highlighting the current window and a brief account label over it",
    title: "Four accounts, four profiles, one screen",
    headline: "Four accounts, four profiles, one screen",
    subline: "One system · four accounts · four isolated profiles",
    env: "Order service · test",
    rail: ["Sites", "Identities", "Views", "Settings"],
    sceneName: "Permission matrix · main flow",
    sceneMeta: "4 members · 2 × 2",
    layoutLabel: "WINDOW LAYOUT",
    layouts: ["Free", "1×1", "2×1", "1×2", "2×2"],
    run: "Run view",
    panelNote1: "Drag a member onto a cell to place it.",
    panelNote2: "Launch order = member order.",
    pageTitle: "Orders",
    windows: [
      { name: "Admin · primary", buttons: [{ label: "New", w: 38 }, { label: "Edit", w: 40 }, { label: "Delete", w: 52, hot: true }] },
      { name: "Reviewer", buttons: [{ label: "Approve", w: 58 }, { label: "Reject", w: 52 }] },
      { name: "Operator", buttons: [{ label: "Export", w: 52 }] },
      { name: "Read-only", buttons: [{ label: "New", w: 38 }, { label: "Edit", w: 40 }, { label: "Delete", w: 52 }] },
    ],
    running: "RUNNING",
    // Measured text widths at 9.5px; the count badge sits right after the label.
    runningWidth: 47,
    switchHint: "Click to switch",
    receiptName: "Reviewer",
    receiptRole: "review · Order service",
    members: [
      { name: "Admin · primary", short: "Admin", color: "#e0a44e" },
      { name: "Reviewer", short: "Reviewer", color: "#5cc8b6" },
      { name: "Operator", short: "Operator", color: "#a396ff" },
      { name: "Read-only", short: "Read-only", color: "#98a2b0" },
    ],
    legend: [
      "A view launches the group",
      "The switcher highlights the window in front",
      "The account name confirms the switch",
    ],
    noActions: "no actions",
  },
  zh: {
    aria: "左侧一个视图拉起右侧四个独立 Profile 的浏览器窗口，边到边平铺；悬浮条浮在上方并高亮当前窗口，切换后窗口上短暂显示账号名",
    title: "四个账号，四个 Profile，一屏",
    headline: "四个账号，四个 Profile，一屏",
    subline: "同一套系统 · 四个账号 · 四个独立 Profile",
    env: "订单服务 · 测试环境",
    rail: ["站点", "身份", "视图", "设置"],
    sceneName: "权限矩阵 · 主流程",
    sceneMeta: "4 个成员 · 2 × 2",
    layoutLabel: "窗口布局",
    layouts: ["无布局", "1×1", "2×1", "1×2", "2×2"],
    run: "一键启动",
    panelNote1: "把成员拖到格子 = 指定位置",
    panelNote2: "启动顺序 = 成员顺序",
    pageTitle: "订单列表",
    windows: [
      { name: "管理员 · 主账号", buttons: [{ label: "新建", w: 44 }, { label: "编辑", w: 44 }, { label: "删除", w: 44, hot: true }] },
      { name: "审核员", buttons: [{ label: "通过", w: 44 }, { label: "驳回", w: 44 }] },
      { name: "运营", buttons: [{ label: "导出", w: 44 }] },
      { name: "只读账号", buttons: [{ label: "新建", w: 44 }, { label: "编辑", w: 44 }, { label: "删除", w: 44 }] },
    ],
    running: "运行中",
    runningWidth: 30,
    switchHint: "点击切换",
    receiptName: "审核员",
    receiptRole: "审核 · 订单服务",
    members: [
      { name: "管理员 · 主账号", short: "管理员", color: "#e0a44e" },
      { name: "审核员", short: "审核员", color: "#5cc8b6" },
      { name: "运营", short: "运营", color: "#a396ff" },
      { name: "只读账号", short: "只读", color: "#98a2b0" },
    ],
    legend: [
      "视图一键拉起一组窗口",
      "悬浮条高亮当前窗口",
      "切换后账号名短暂浮现",
    ],
    noActions: "无可用操作",
  },
};

mkdirSync(OUTPUT_DIR, { recursive: true });
const outputs = [
  ["hero", HERO, hero],
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
