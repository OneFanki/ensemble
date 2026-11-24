#!/usr/bin/env node
/**
 * End-to-end check of element reads and clipped screenshots.
 *
 * The point of these tools is that a caller stops writing DOM code to answer
 * "what is this thing". So the assertions are about facts a page-level script
 * would have to be re-derived for:
 *
 * - `read_browser_element` reports state (`disabled` / `aria-expanded` / value)
 *   that is not in the visible text.
 * - `read_browser_attribute` distinguishes "attribute absent" from "element
 *   absent" — the difference between `null` and an error.
 * - A clipped screenshot is smaller than the viewport and matches the element's
 *   own area, which is what proves the rectangle was applied rather than ignored.
 *   The pixels are also checked: a capture that "succeeds" as a black or
 *   transparent frame answers no question at all, and size alone cannot see it.
 * - A target outside the viewport is refused instead of quietly returning the
 *   full page.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";
import { analyzePngFile, contentProblem } from "./lib/png-content.mjs";

const PAGE_PORT = await freePort();
const MCP_PORT = await freePort();
const TOKEN = "e2e-element-token-123456789";
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-element-"));

/*
 * One page with the four shapes the tools have to answer about:
 *
 * 1. A button whose disabled state and `aria-expanded` are the whole point —
 *    neither is in its text.
 * 2. A link with an href, to prove attribute reads return the value.
 * 3. A field with a value that only `value` (not `textContent`) can report.
 * 4. A box far down the page, for the "not in the viewport" refusal.
 */
const server = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>元素读取</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  section { margin: 20px; }
  #target-box { width: 200px; height: 80px; background: #2a6; }
  #spacer { height: 3000px; }
  #far-box { width: 200px; height: 80px; background: #a26; }
</style></head><body>
<section><button id="opener" aria-expanded="false" aria-label="展开菜单">菜单</button></section>
<section><button id="blocked" disabled>已提交</button></section>
<section><a id="link" href="/detail/42" data-testid="detail-link">查看详情</a></section>
<section><label for="name-field">名称</label><input id="name-field" type="text" value="初始值"></section>
<section><label for="frozen-field">锁定</label><input id="frozen-field" type="text" value="锁死" readonly></section>
<section><button id="icon-only" title="关闭面板" onclick="this.dataset.clicked='1'"><svg width="16" height="16"></svg></button></section>
<section><input id="submit-btn" type="submit" value="提交表单" onclick="this.dataset.clicked='1'"></section>
<section><label>记住我 <input id="remember" type="checkbox"></label></section>
<section><label for="secret-field">口令</label><input id="secret-field" type="password" value="e2e-secret-field-value"></section>
<section><div id="target-box"></div></section>
<div id="spacer"></div>
<section><div id="far-box"></div></section>
</body></html>`);
});
await new Promise((resolve) => server.listen(PAGE_PORT, "127.0.0.1", resolve));
const PAGE_URL = `http://127.0.0.1:${PAGE_PORT}/`;

mkdirSync(userData, { recursive: true });
writeFileSync(
  join(userData, "mcp.json"),
  JSON.stringify({
    enabled: true,
    port: MCP_PORT,
    token: TOKEN,
    allowWrite: true,
    allowRun: true,
    allowDelete: false,
  }),
  { mode: 0o600 },
);

const electron = join(
  process.cwd(),
  "node_modules",
  "electron",
  "dist",
  process.platform === "win32" ? "electron.exe" : "electron",
);
const app = spawn(electron, [join(process.cwd(), "out", "main", "index.js")], {
  env: { ...process.env, ENSEMBLE_USER_DATA: userData, ENSEMBLE_HEADLESS: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
async function call(name, args = {}) {
  const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const json = await response.json();
  if (json.error) throw new Error(`${name}: ${json.error.message}`);
  if (json.result?.isError) throw new Error(`${name}: ${json.result.content[0].text}`);
  const text = json.result.content[0].text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

async function waitForMcp() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
      });
      if (response.ok) return true;
    } catch {
      // Still starting.
    }
    await wait(400);
  }
  return false;
}

/** Reads a PNG's pixel size from its IHDR chunk, without an image library. */
function pngSize(path) {
  try {
    const stat = analyzePngFile(path);
    return { width: stat.width, height: stat.height };
  } catch {
    return null;
  }
}

try {
  const ready = await waitForMcp();
  check("app started and MCP answered", ready, ready ? undefined : appLog.slice(-800));
  if (!ready) throw new Error("MCP never came up");

  const tab = await call("open_browser_tab", { url: PAGE_URL });
  const tabId = tab.id ?? tab.tabId ?? tab.tabs?.at(-1)?.id;
  check("a page was opened", Boolean(tabId), { tabId });
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const visible = await call("check_browser_element_visible", { tabId, selector: "#opener" });
    if (visible.visible) break;
    await wait(200);
  }

  // --- element info: state that the visible text does not carry --------------
  const opener = await call("read_browser_element", { tabId, selector: "#opener" });
  check(
    "an element's role, name and state are reported",
    opener.ok === true &&
      opener.role === "button" &&
      opener.name === "展开菜单" &&
      opener.state?.enabled === true &&
      opener.attributes?.["aria-expanded"] === "false",
    opener,
  );

  // The page flips the attribute; the next read has to see the new value. This is
  // the "poll for a state change" case the tool exists for.
  await call("click_browser_element", { tabId, selector: "#opener" }).catch(() => undefined);
  await call("evaluate_browser_page", {
    tabId,
    expression: `document.getElementById('opener').setAttribute('aria-expanded', 'true')`,
  });
  const expanded = await call("read_browser_attribute", {
    tabId,
    selector: "#opener",
    names: ["aria-expanded"],
  });
  check(
    "an attribute read sees the value the page just wrote",
    expanded.attributes?.["aria-expanded"] === "true",
    expanded,
  );

  // A missing attribute is `null`, not an error: distinct from "no such element".
  const missing = await call("read_browser_attribute", {
    tabId,
    selector: "#opener",
    names: ["data-nothing-here", "aria-expanded"],
  });
  check(
    "an absent attribute is null while the present one is returned",
    missing.attributes?.["data-nothing-here"] === null &&
      missing.attributes?.["aria-expanded"] === "true",
    missing,
  );

  const blocked = await call("read_browser_element", { tabId, selector: "#blocked" });
  check(
    "a disabled button reports itself as not enabled",
    blocked.state?.enabled === false && blocked.attributes?.["disabled"] !== undefined,
    blocked,
  );

  const link = await call("read_browser_element", { tabId, selector: "#link" });
  check(
    "a link reports its href and its test id",
    link.attributes?.href === "/detail/42" &&
      link.attributes?.["data-testid"] === "detail-link" &&
      link.role === "link",
    link,
  );

  // `value` is the only one of the two that knows what is in a field.
  const field = await call("read_browser_element", { tabId, selector: "#name-field" });
  check(
    "a field's current value is reported separately from its text",
    field.value === "初始值" && field.inputType === "text",
    field,
  );
  // A plain text input is editable: not contenteditable, but a control that
  // accepts input, and reporting it as not-editable while readOnly:false is a
  // contradiction the caller cannot act on.
  check(
    "a plain text input reports itself as editable",
    field.state?.editable === true && field.state?.readOnly === false,
    field.state,
  );
  const frozen = await call("read_browser_element", { tabId, selector: "#frozen-field" });
  check(
    "a readonly input reports editable false with readOnly true",
    frozen.state?.editable === false && frozen.state?.readOnly === true,
    frozen.state,
  );
  const fieldValue = await call("read_browser_attribute", { tabId, selector: "#name-field" });
  check(
    "reading with no attribute name answers the field's value",
    fieldValue.value === "初始值",
    fieldValue,
  );

  // A target that is not on the page is an error with a reason, not an empty object.
  let missingElement = null;
  try {
    await call("read_browser_element", { tabId, selector: "#does-not-exist" });
    missingElement = "no-error";
  } catch (error) {
    missingElement = String(error);
  }
  check(
    "a missing element is an error naming the reason",
    /not-found/.test(missingElement),
    { missingElement },
  );

  // --- clipped screenshot ---------------------------------------------------
  const full = await call("screenshot_browser_tab", { tabId });
  const fullSize = pngSize(full.path);
  check(
    "a viewport screenshot is saved and readable",
    typeof full.path === "string" && full.bytes > 0 && fullSize !== null,
    { path: full.path, bytes: full.bytes, fullSize },
  );
  /*
   * The page is white with dark text and coloured boxes, so a real capture has
   * tonal spread and many colours; a black or transparent frame has neither.
   * This is the assertion the size check could not make — the historical
   * failure was a capture that came back the right size with every label gone.
   */
  const fullStat = analyzePngFile(full.path);
  check(
    "the viewport screenshot carries real content, not a black or empty frame",
    contentProblem(fullStat, { minUniqueColors: 16, minLuminanceStd: 10 }) === null,
    fullStat,
  );

  const clipped = await call("screenshot_browser_tab", { tabId, selector: "#target-box" });
  const clippedSize = pngSize(clipped.path);
  /*
   * The box is 200×80 CSS pixels. The clip is therefore near that — not the full
   * viewport — and that is the assertion: a tool that ignored the target would
   * return an image the size of the window.
   */
  check(
    "a clipped screenshot matches the element's own size",
    clippedSize !== null &&
      Math.abs(clippedSize.width - 200) <= 2 &&
      Math.abs(clippedSize.height - 80) <= 2,
    { clippedSize, expected: { width: 200, height: 80 } },
  );
  /*
   * The box is solid green, so the correct picture is almost single-coloured —
   * a flat green area with nothing else in it. What must hold is that green
   * dominates (a mis-framed clip brings page background or a scrollbar in),
   * nothing is transparent (an unrasterised region reads back alpha-0 and
   * viewers fill it with black), and the frame is not flat black. Tonal spread
   * and colour count would punish exactly the shape a correct capture has.
   */
  const clippedStat = analyzePngFile(clipped.path);
  check(
    "the clipped screenshot shows the element itself, not a black or empty frame",
    clippedStat.transparentFraction <= 0.01 &&
      clippedStat.greenFraction >= 0.5 &&
      clippedStat.meanLuminance > 4,
    clippedStat,
  );
  check(
    "the clipped image is much smaller than the viewport capture",
    clipped.bytes < full.bytes,
    { clippedBytes: clipped.bytes, fullBytes: full.bytes },
  );

  /*
   * An element below the fold cannot be captured by a viewport clip: the
   * rectangle would fall outside it. Refusing is the honest answer — the
   * alternative is a transparent image that looks like a successful capture.
   */
  let offscreen = null;
  try {
    await call("screenshot_browser_tab", { tabId, selector: "#far-box" });
    offscreen = "no-error";
  } catch (error) {
    offscreen = String(error);
  }
  check(
    "an element outside the viewport is refused instead of silently returning the page",
    /不在可视区域/.test(offscreen),
    { offscreen },
  );

  /*
   * A name in the snapshot has to work as `text` when handed straight back.
   * Three shapes used to break that chain: an icon-only button named by its
   * `title` (its name came back empty), a submit input (its name came back as
   * its type, "submit"), and a label wrapped around its control (the tie went
   * to the label, so there was nothing to type into).
   */
  const snapshot = await call("read_browser_page", { tabId });
  const nameInSnapshot = (selector) =>
    snapshot?.nodes?.find((node) => node.selector === selector)?.name;
  const iconName = nameInSnapshot("#icon-only");
  const submitName = nameInSnapshot("#submit-btn");
  check("an icon-only button is named by its title", iconName === "关闭面板", { iconName });
  check("a submit input is named by its value", submitName === "提交表单", { submitName });
  const clicked = async (selector) =>
    call("evaluate_browser_page", {
      tabId,
      expression: `document.querySelector(${JSON.stringify(selector)}).dataset.clicked`,
    });
  await call("click_browser_element", { tabId, text: "关闭面板" });
  check("handing that name back as text clicks the icon-only button", (await clicked("#icon-only")) === "1");
  await call("click_browser_element", { tabId, text: "提交表单" });
  check("handing that name back as text clicks the submit input", (await clicked("#submit-btn")) === "1");
  const remember = await call("click_browser_element", { tabId, text: "记住我" });
  check(
    "a text that names both a label and its control resolves to the control",
    remember?.tag === "input",
    remember,
  );

  /*
   * A password field's content is a credential: the main process typed it in, or
   * the person did. Both read tools are in the read tier, so echoing it handed
   * the vault's password to a client that was only allowed to read. They say the
   * field is a password and nothing more, and a flow's `read` step refuses it,
   * because a flow's variables come back in `run_flow`'s result. The field's
   * `value` attribute is set on purpose: a bound field carries it too.
   */
  const SECRET = "e2e-secret-field-value";
  const secretInfo = await call("read_browser_element", { tabId, selector: "#secret-field" });
  check(
    "read_browser_element says a password field is one and returns nothing of it",
    secretInfo?.secret === true &&
      secretInfo?.inputType === "password" &&
      secretInfo?.value === undefined &&
      !JSON.stringify(secretInfo).includes(SECRET),
    secretInfo,
  );
  const secretValue = await call("read_browser_attribute", { tabId, selector: "#secret-field" });
  check(
    "read_browser_attribute returns nothing of a password field",
    secretValue?.secret === true && secretValue?.value === undefined,
    secretValue,
  );
  const plainField = await call("read_browser_element", { tabId, selector: "#name-field" });
  check(
    "an ordinary field still reads back its value",
    typeof plainField?.value === "string" && plainField?.secret === undefined,
    plainField?.value,
  );
  const flowSite = await call("create_site", {
    name: "元素读取站点",
    baseUrl: PAGE_URL,
    loginPath: "/",
  });
  const secretFlow = await call("save_flow", {
    siteId: flowSite.id,
    name: "读取密码框的流程",
    steps: [{ action: "read", selector: "#secret-field", as: "secret" }],
  });
  const flowRead = await call("run_flow", { flowId: secretFlow.id, tabId }).then(
    (value) => ({ text: JSON.stringify(value) }),
    (error) => ({ text: String(error) }),
  );
  check(
    "a flow's read step refuses a password field instead of capturing it",
    flowRead.text.includes("密码框") && !flowRead.text.includes(SECRET),
    flowRead.text.slice(0, 300),
  );
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  server.close();
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
