#!/usr/bin/env node
/**
 * End-to-end check of login capture on the built-in surface.
 *
 * The contract under test: a login typed by hand in an embedded page produces a
 * prompt that carries a token and the username but never the password, and
 * accepting it creates the account with that password in the vault.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freePort } from "./lib/e2e-ports.mjs";
import { waitForDebugPort } from "./lib/e2e-ports.mjs";
import { GUIDE_SEEN } from "./lib/guide-version.mjs";

const PAGE_PORT = await freePort();
const userData = mkdtempSync(join(tmpdir(), "ensemble-e2e-capture-"));
const electronBinary =
  process.platform === "win32"
    ? resolve("node_modules/electron/dist/electron.exe")
    : resolve("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron");

/*
 * Three shapes of login page, because the capture script has to survive all of
 * them and each one broke it in a different way:
 *
 *  - /login       a plain form with a submit button (the common case)
 *  - /spa         no <form> at all, button type="button", three fields because
 *                 the site is multi-tenant
 *  - /clearing    a single-page form that empties the password box on submit
 */
const spaPage = `<!doctype html><html><head><meta charset="utf-8"><title>SPA 登录</title></head>
<body>
<div class="login">
  <div class="field"><div class="label">租户名</div><input id="tenant" type="text" placeholder="请输入租户名" /></div>
  <div class="field"><div class="label">用户名</div><input id="user" type="text" placeholder="请输入用户名" /></div>
  <div class="field"><div class="label">密码</div><input id="pass" type="password" placeholder="请输入密码" /></div>
  <button id="submit" type="button">登录</button>
</div>
</body></html>`;

const clearingPage = `<!doctype html><html><head><meta charset="utf-8"><title>清空表单</title></head>
<body>
<form id="f">
  <label>账号 <input id="user" name="user" type="text" /></label>
  <label>密码 <input id="pass" name="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
<script>
  document.querySelector('#f').addEventListener('submit', (event) => {
    event.preventDefault();
    // What a lot of real single-page forms do after sending the request.
    document.querySelector('#pass').value = '';
    document.querySelector('#user').value = '';
  });
</script>
</body></html>`;

const page = createServer((req, res) => {
  if (req.url.startsWith("/spa")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(spaPage);
    return;
  }
  if (req.url.startsWith("/clearing")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(clearingPage);
    return;
  }
  if (req.url.startsWith("/console")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><html><body>console</body></html>");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录页</title></head>
<body>
<form id="f" action="/console" method="get">
  <label>账号 <input id="user" name="user" type="text" /></label>
  <label>密码 <input id="pass" name="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
</body></html>`);
});
await new Promise((done) => page.listen(PAGE_PORT, "127.0.0.1", done));
const BASE_URL = `http://127.0.0.1:${PAGE_PORT}`;
const PAGE_URL = `${BASE_URL}/login`;

const now = new Date().toISOString();
const siteId = "11111111-1111-4111-8111-111111111111";

mkdirSync(join(userData, "profiles"), { recursive: true });
writeFileSync(
  join(userData, "workspace.json"),
  JSON.stringify({
    version: 2,
    tags: [],
    sites: [
      {
        id: siteId,
        name: "捕获站点",
        baseUrl: `http://127.0.0.1:${PAGE_PORT}`,
        loginPath: "/login",
        autoSubmit: false,
        tagIds: [],
        extraFields: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    identities: [],
    views: [],
    instances: [],
    manualEngines: [],
    layoutPresets: [],
  }),
);
writeFileSync(
  join(userData, "settings.json"),
  JSON.stringify({ theme: "dark", locale: "zh", lastView: "browser", guideVersion: GUIDE_SEEN }),
);

const app = spawn(
  electronBinary,
  [".", `--user-data-dir=${userData}`, `--remote-debugging-port=0`],
  { env: { ...process.env, ENSEMBLE_HEADLESS: "1" }, stdio: ["ignore", "pipe", "pipe"] },
);
let appLog = "";
app.stdout.on("data", (chunk) => (appLog += chunk));
app.stderr.on("data", (chunk) => (appLog += chunk));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect(url) {
  const socket = new WebSocket(url);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    call(message.result);
  });
  await new Promise((done) => socket.addEventListener("open", done));
  return {
    send(method, params = {}) {
      return new Promise((done) => {
        const id = ++nextId;
        pending.set(id, done);
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    async evaluate(expression) {
      const result = await this.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result?.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result?.result?.value;
    },
    close() {
      socket.close();
    },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(ok ? "PASS" : "FAIL", name, detail === undefined ? "" : JSON.stringify(detail));
}

/**
 * The embedded page's CDP target.
 *
 * Matched by origin, not by the login path: submitting the form navigates to
 * whatever the form's action is, so a path-specific lookup would silently stop
 * finding the page after the first sign-in — and every later assertion would
 * pass because nothing happened at all.
 */
/**
 * The embedded page's CDP target.
 *
 * Matched by origin rather than by path: submitting a form navigates, so the
 * page a test wants is often no longer at the URL it opened. `port` narrows it
 * when the suite runs more than one local server.
 */
async function pageTarget(port = PAGE_PORT) {
  const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
  return list.find((item) => item.url.startsWith(`http://127.0.0.1:${port}`));
}

/** Types a login into the embedded page and submits it. False if the page is gone. */
async function submitLogin(username, password) {
  const target = await pageTarget();
  if (!target) return false;
  const pageClient = await connect(target.webSocketDebuggerUrl);
  await pageClient.evaluate(`(() => {
    const user = document.querySelector('#user');
    const pass = document.querySelector('#pass');
    if (!user || !pass) return false;
    user.value = ${JSON.stringify(username)};
    pass.value = ${JSON.stringify(password)};
    user.dispatchEvent(new Event('input', { bubbles: true }));
    pass.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await wait(300);
  await pageClient.evaluate(`(() => {
    document.querySelector('#f')?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    return true;
  })()`);
  await wait(900);
  pageClient.close();
  return true;
}

try {
  let target;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await wait(250);
    try {
      const list = await (await fetch(`http://127.0.0.1:${await waitForDebugPort(userData)}/json/list`)).json();
      target = list.find(
        (item) =>
          item.type === "page" &&
          item.url.includes("index.html") &&
          !item.url.startsWith("devtools"),
      );
      if (target) break;
    } catch {
      // The window has not opened its debugging port yet.
    }
  }
  check("app window appeared", Boolean(target), target ? undefined : appLog.slice(-600));
  if (!target) throw new Error("no renderer target");

  const client = await connect(target.webSocketDebuggerUrl);
  await wait(3000);

  // Listen before the page types anything, so the event cannot be missed.
  await client.evaluate(`(() => {
    window.__captures = [];
    window.ensemble.onLoginCaptured((notice) => window.__captures.push(notice));
    return true;
  })()`);

  const opened = await client.evaluate(`(async () => {
    const before = (await window.ensemble.getEmbeddedState()).tabs.length;
    const tab = await window.ensemble.openEmbeddedTab({ url: ${JSON.stringify(PAGE_URL)} });
    await new Promise((r) => setTimeout(r, 2500));
    const after = await window.ensemble.getEmbeddedState();
    const page = after.tabs.find((item) => item.id === tab.id);
    return {
      id: tab.id,
      // Relative: launch leaves one blank page, which is not the subject here.
      added: after.tabs.length - before,
      url: page?.url ?? "",
      inInstance: Boolean(page?.instanceId),
    };
  })()`);
  check(
    "login page opened in an embedded tab",
    Boolean(opened?.id) &&
      opened?.added === 1 &&
      String(opened?.url).startsWith("http://127.0.0.1"),
    opened,
  );

  // Type into the real page through CDP input events, then submit the form.
  const typed = await client.evaluate(`(async () => {
    const tabId = ${JSON.stringify(opened?.id ?? "")};
    const setValue = (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    };
    return Boolean(tabId);
  })()`);
  check("renderer can address the tab", typed === true, typed);

  // The embedded page is a separate target; drive it directly over CDP.
  const loginTarget = await pageTarget();
  check("login page is a CDP target", Boolean(loginTarget), loginTarget?.url);

  const typedIn = await submitLogin("admin@example.test", "secret-from-form");
  check("the form can be submitted in the page", typedIn === true);

  const captured = await client.evaluate(`(async () => {
    const list = window.__captures ?? [];
    const notice = list[0];
    return {
      count: list.length,
      notice: notice ?? null,
      hasPassword: notice ? Object.prototype.hasOwnProperty.call(notice, 'password') : null,
      keys: notice ? Object.keys(notice) : [],
    };
  })()`);
  check("submitting the form produces one capture", captured?.count === 1, captured);
  check(
    "the capture carries a token and username but no password",
    Boolean(captured?.notice?.token) &&
      captured?.notice?.username === "admin@example.test" &&
      captured?.hasPassword === false,
    captured,
  );
  check(
    "the capture is matched to the site by origin",
    captured?.notice?.siteId === siteId,
    captured?.notice,
  );

  /*
   * The prompt is transient; the capture is not. Hiding the bar has to leave a
   * way back to the same list, otherwise the only recovery is to sign out and in
   * again — the thing this path exists to avoid.
   *
   * Runs before the account is saved: saving takes the capture out of the list on
   * purpose, so there would be nothing left to reopen.
   */
  /*
   * Closing the bar keeps the capture, and the way back is the message centre.
   *
   * The old shape was a count chip in the bar's place; the history is the same
   * promise done properly — it survives a restart, and it holds the other kinds
   * of news too. What matters here is that hiding the bar neither drops the
   * secret nor leaves the user with no way to reach it.
   */
  const hidden = await client.evaluate(`(async () => {
    document.querySelector('[data-capture-hide]')?.click();
    await new Promise((r) => setTimeout(r, 300));
    const pending = await window.ensemble.pendingLogins();
    const messages = await window.ensemble.listMessages();
    return {
      barGone: !document.querySelector('[data-capture-hide]'),
      pending: pending.length,
      pendingUser: pending[0]?.username ?? '',
      pendingHasPassword: pending[0]
        ? Object.prototype.hasOwnProperty.call(pending[0], 'password')
        : null,
      row: messages.find((item) => item.kind === 'login-capture') ?? null,
    };
  })()`);
  check(
    "closing the prompt keeps the capture and records it in history",
    hidden?.barGone === true &&
      hidden?.pending === 1 &&
      hidden?.pendingUser === "admin@example.test" &&
      hidden?.pendingHasPassword === false &&
      hidden?.row?.action?.type === "login-capture" &&
      hidden?.row?.read === false,
    hidden,
  );

  const fromHistory = await client.evaluate(`(async () => {
    const messages = await window.ensemble.listMessages();
    const row = messages.find((item) => item.kind === 'login-capture');
    return {
      hasAction: Boolean(row?.action),
      titleKey: row?.titleKey ?? '',
      username: row?.titleParams?.user ?? '',
    };
  })()`);
  check(
    "the history row points back at that login",
    fromHistory?.hasAction === true &&
      fromHistory?.username === "admin@example.test" &&
      !String(fromHistory?.titleKey).includes("messages."),
    fromHistory,
  );

  const saved = await client.evaluate(`(async () => {
    const notice = (window.__captures ?? [])[0];
    if (!notice) return { error: 'no notice' };
    // Counted around the save itself: saving must not open anything, and a
    // hardcoded baseline would only be asserting how many tabs this script
    // happened to open before it.
    const tabsBefore = (await window.ensemble.getEmbeddedState()).tabs.length;
    const snapshot = await window.ensemble.saveIdentity({
      siteId: notice.siteId,
      name: '管理员 · 捕获',
      username: notice.username,
      role: 'admin',
      color: 'amber',
      passwordMode: 'custom',
      startPath: '/',
      captureToken: notice.token,
    });
    const saved = snapshot.identities[0];
    return {
      identities: snapshot.identities.length,
      username: saved?.username,
      passwordSet: snapshot.credentials.identity[saved?.id ?? ''] ?? false,
      tabsBefore,
    };
  })()`);
  check(
    "accepting the capture creates one account",
    saved?.identities === 1 && saved?.username === "admin@example.test",
    saved,
  );
  check("the captured password is written to the vault", saved?.passwordSet === true, saved);

  const consumed = await client.evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 300));
    const pending = await window.ensemble.pendingLogins();
    const state = await window.ensemble.getEmbeddedState();
    return {
      pending: pending.length,
      barGone: !document.querySelector('[data-capture-hide]'),
      chipGone: !document.querySelector('[data-capture-bell]'),
      // Saving a captured login must not open a browser: the account was asked
      // for, the window was not. Counted here because "a window appeared" is the
      // exact symptom that was reported.
      tabs: state.tabs.length,
    };
  })()`);
  check(
    "saving takes the capture out of the list",
    consumed?.pending === 0 && consumed?.barGone === true && consumed?.chipGone === true,
    consumed,
  );
  check(
    "saving a captured login does not open a browser",
    consumed?.tabs === saved?.tabsBefore,
    { before: saved?.tabsBefore, after: consumed?.tabs },
  );

  /*
   * The prompt steps aside while a dialog is open.
   *
   * It is a fixed child of `<body>`, and a modal sets `body { pointer-events:
   * none }`; the bar therefore stayed visible over the form but swallowed every
   * click, so it looked stuck. It is the form's own subject, so it also has no
   * business being drawn behind the mask.
   *
   * The save above consumed the last capture, so this signs in once more to have
   * a prompt to open — otherwise the test would be asserting against nothing.
   * Any capture left over is dropped first: this block must not change what the
   * later multi-capture steps see.
   */
  await client.evaluate(`(async () => {
    for (const item of await window.ensemble.pendingLogins()) {
      await window.ensemble.dismissLoginCapture(item.token);
    }
    return true;
  })()`);
  await submitLogin("dialog@example.test", "secret-dialog");
  await wait(600);

  const withDialog = await client.evaluate(`(async () => {
    const before = (await window.ensemble.pendingLogins()).length;
    // Open the account form the same way the prompt does.
    const prompt = document.querySelector('[data-capture-save]');
    prompt?.click();
    await new Promise((r) => setTimeout(r, 400));
    const dialogOpen = Boolean(document.querySelector('.content .body'));
    const insideDialog = {
      // The bar lives outside the dialog portal, at the end of <body>.
      barPresent: Boolean(document.querySelector('[data-capture-hide]')),
      bodyLocked: getComputedStyle(document.body).pointerEvents === 'none',
    };
    // Dismiss the dialog and confirm the prompt is back, unchanged.
    document.querySelector('.content .close')?.click();
    await new Promise((r) => setTimeout(r, 400));
    return {
      hadPrompt: Boolean(prompt),
      dialogOpen,
      ...insideDialog,
      backAfterClose: Boolean(document.querySelector('[data-capture-hide]')),
      pending: { before, after: (await window.ensemble.pendingLogins()).length },
    };
  })()`);
  check(
    "the prompt steps aside while the account form is open and returns after",
    withDialog?.hadPrompt === true &&
      withDialog?.dialogOpen === true &&
      withDialog?.barPresent === false &&
      withDialog?.backAfterClose === true &&
      withDialog?.pending?.before === withDialog?.pending?.after,
    withDialog,
  );

  // Leave the list empty again: the steps below count captures themselves.
  await client.evaluate(`(async () => {
    for (const item of await window.ensemble.pendingLogins()) {
      await window.ensemble.dismissLoginCapture(item.token);
    }
    return true;
  })()`);
  await wait(300);

  const reused = await client.evaluate(`(async () => {
    const notice = (window.__captures ?? [])[0];
    if (!notice) return { error: 'no notice' };
    let rejected = false;
    try {
      await window.ensemble.saveIdentity({
        siteId: notice.siteId,
        name: '重复',
        username: 'other@example.test',
        role: 'member',
        color: 'teal',
        passwordMode: 'custom',
        captureToken: notice.token,
      });
    } catch {
      rejected = true;
    }
    return { rejected };
  })()`);
  check("a capture token cannot be used twice", reused?.rejected === true, reused);

  // Signing in as an account the vault already stores must not offer to save a
  // duplicate: that is the normal "open the tab and log in" path, not a capture.
  const knownCapturesBefore = await client.evaluate(`(window.__captures ?? []).length`);
  const known = await client.evaluate(`(async () => {
    await window.ensemble.saveIdentity({
      siteId: ${JSON.stringify(siteId)},
      name: '已保存账号',
      username: 'known@example.test',
      role: 'member',
      color: 'teal',
      passwordMode: 'custom',
      password: 'known-secret',
      startPath: '/',
    });
    return (await window.ensemble.getWorkspace()).identities.length;
  })()`);
  check("a saved account exists before the second login", known === 2, { identities: known });

  const knownSubmitted = await submitLogin("known@example.test", "known-secret");
  check("the second sign-in reached the page", knownSubmitted === true);
  /*
   * Counting the delta, not the total: earlier steps in this script sign in on
   * purpose (the capture flow, then the dialog check), so a fixed number would
   * only assert "how many logins this script happened to make".
   */
  const afterKnown = await client.evaluate(`(window.__captures ?? []).length`);
  check(
    "logging in as an already-saved account produces no prompt",
    afterKnown === knownCapturesBefore,
    { before: knownCapturesBefore, after: afterKnown },
  );

  /*
   * Two logins, one prompt.

   * The bar shows the newest; the panel is the record. Signing in as a second
   * account used to replace the first prompt outright, and the first password
   * went with it.
   */
  await submitLogin("second@example.test", "secret-two");
  await submitLogin("third@example.test", "secret-three");

  const stacked = await client.evaluate(`(async () => {
    await new Promise((r) => setTimeout(r, 300));
    const pending = await window.ensemble.pendingLogins();
    const head = document.querySelector('.capture .detail')?.textContent?.trim() ?? '';
    document.querySelector('[data-capture-list]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    return {
      pending: pending.map((item) => item.username),
      head,
      rows: [...document.querySelectorAll('.more .row-user')].map((el) => el.textContent.trim()),
      barGone: !document.querySelector('[data-capture-hide]'),
      // Diagnostics: the bar is a computed now, so "gone" can mean a dialog is
      // open or the user hid it. Named separately so a failure says which.
      wrapPresent: Boolean(document.querySelector('.capture-wrap')),
      dialogs: document.querySelectorAll('.overlay').length,
      bodyPointer: getComputedStyle(document.body).pointerEvents,
      // Pinia state, to tell "the list is empty in the renderer" apart from
      // "the bar is hidden by its own flags".
      storePending: (() => {
        const app = document.querySelector('#app')?.__vue_app__;
        const pinia = app?.config?.globalProperties?.$pinia;
        const list = pinia?.state?.value?.workspace?.pendingLogins;
        return Array.isArray(list) ? list.length : null;
      })(),
      // The two flags the template combines, read from the component instance
      // that owns them.
      flags: (() => {
        const probe = document.querySelector('[data-capture-probe]');
        return probe
          ? {
              list: probe.dataset.list,
              shown: probe.dataset.shown,
              covered: probe.dataset.covered,
              what: probe.dataset.what,
            }
          : null;
      })(),
    };
  })()`);
  check(
    "signing in twice keeps both logins, newest in the bar",
    stacked?.head.includes("third@example.test") &&
      stacked?.pending?.[0] === "third@example.test" &&
      stacked?.pending?.[1] === "second@example.test" &&
      stacked?.barGone === true &&
      stacked?.rows?.join(",") === "third@example.test,second@example.test",
    stacked,
  );

  /*
   * An older entry is still saveable — the whole reason the list exists. Saving
   * from the row must use *that* capture's token, not the head's.
   */
  const olderSaved = await client.evaluate(`(async () => {
    // Second row: the first one is the newest, which the bar already offers.
    const rows = [...document.querySelectorAll('.more .row-save')];
    const row = rows[1];
    if (!row) return { error: 'no second row' };
    row.click();
    await new Promise((r) => setTimeout(r, 400));
    // The form has no test hooks; the username field is the only mono input in
    // it whose value comes straight from the capture.
    const values = [...document.querySelectorAll('input[type="text"], input:not([type])')]
      .map((el) => el.value)
      .filter(Boolean);
    return {
      fieldValues: values,
      prefilled: values.includes('second@example.test'),
    };
  })()`);
  check(
    "saving an older entry opens the form for that account",
    olderSaved?.prefilled === true,
    olderSaved,
  );
  // Close it: an open form covers the prompt, and the steps below need the bar.
  await client.evaluate(`(async () => {
    document.querySelector('.content .close')?.click();
    await new Promise((r) => setTimeout(r, 400));
    return true;
  })()`);

  /*
   * The three page shapes, each of which the script got wrong at some point.
   * One suite, because they are the same contract seen from different markup:
   * a submitted credential form always produces exactly one capture.
   */
  await client.evaluate(`(async () => {
    for (const item of await window.ensemble.pendingLogins()) {
      await window.ensemble.dismissLoginCapture(item.token);
    }
    await new Promise((r) => setTimeout(r, 200));
    return true;
  })()`);

  const shapes = [
    {
      name: "a plain form with a submit button",
      path: "/login",
      fields: { "#user": "form@example.test", "#pass": "pw-form" },
      expect: { username: "form@example.test" },
    },
    {
      name: "a form-less component library with a tenant field",
      path: "/spa",
      fields: { "#tenant": "acme", "#user": "spa@example.test", "#pass": "pw-spa" },
      expect: { username: "spa@example.test", tenant: "acme" },
    },
    {
      name: "a form that clears itself on submit",
      path: "/clearing",
      fields: { "#user": "clear@example.test", "#pass": "pw-clear" },
      expect: { username: "clear@example.test" },
    },
  ];

  for (const shape of shapes) {
    const tab = await client.evaluate(
      `window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(`${BASE_URL}${shape.path}`)} })`,
    );
    await wait(1_500);
    const target = await pageTarget();
    if (!target) {
      check(`captures a login from ${shape.name}`, false, { reason: "page target missing" });
      continue;
    }
    const pageClient = await connect(target.webSocketDebuggerUrl);
    await pageClient.evaluate(`(() => {
      const values = ${JSON.stringify(shape.fields)};
      for (const [selector, value] of Object.entries(values)) {
        const el = document.querySelector(selector);
        if (!el) continue;
        const proto = Object.getPrototypeOf(el);
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor && descriptor.set) descriptor.set.call(el, value);
        else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return true;
    })()`);
    await wait(250);
    // A real click, not a synthetic submit event: this is what a person does,
    // and the two take different code paths through the page.
    await pageClient.evaluate(`(() => {
      document.querySelector('#submit').click();
      return true;
    })()`);
    await wait(900);
    pageClient.close();

    const pending = await client.evaluate(`window.ensemble.pendingLogins()`);
    const head = pending?.[0];
    const tenant = head?.extraFields?.find((field) => /租户|tenant/i.test(field.label))?.value;
    check(
      `captures a login from ${shape.name}`,
      head?.username === shape.expect.username &&
        (!shape.expect.tenant || tenant === shape.expect.tenant),
      { pending: pending ?? [], tabId: tab?.id ?? "" },
    );
    if (head) {
      await client.evaluate(`window.ensemble.dismissLoginCapture(${JSON.stringify(head.token)})`);
      await wait(200);
    }
  }

  /*
   * Same username, different tenant: two accounts, so the second sign-in must
   * still be offered. Treating them as one is how a second tenant got no prompt.
   */
  const tenantSite = await client.evaluate(`(async () => {
    const snapshot = await window.ensemble.getWorkspace();
    return snapshot.sites.find((site) => site.baseUrl.includes(${JSON.stringify(String(PAGE_PORT))})) ?? null;
  })()`);
  if (tenantSite) {
    await client.evaluate(`(async () => {
      await window.ensemble.saveIdentity({
        siteId: ${JSON.stringify(tenantSite.id)},
        name: '租户 A 管理员',
        username: 'shared@example.test',
        role: 'admin',
        color: 'teal',
        passwordMode: 'custom',
        password: 'pw-a',
        extraFields: [{ label: '租户名', value: 'tenant-a' }],
      });
      return true;
    })()`);
    const spaUrl = `${BASE_URL}/spa`;
    await client.evaluate(
      `window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(spaUrl)} })`,
    );
    await wait(1_500);
    const target = await pageTarget();
    if (target) {
      const pageClient = await connect(target.webSocketDebuggerUrl);
      await pageClient.evaluate(`(() => {
        const values = { '#tenant': 'tenant-b', '#user': 'shared@example.test', '#pass': 'pw-b' };
        for (const [selector, value] of Object.entries(values)) {
          const el = document.querySelector(selector);
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          descriptor.set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      })()`);
      await wait(250);
      await pageClient.evaluate(`document.querySelector('#submit').click()`);
      await wait(900);
      pageClient.close();
    }
    const pending = await client.evaluate(`window.ensemble.pendingLogins()`);
    const tenantB = pending?.find((item) => item.username === "shared@example.test");
    check(
      "the same username under another tenant is still offered",
      Boolean(tenantB) &&
        tenantB.extraFields?.some((field) => field.value === "tenant-b"),
      { pending: pending ?? [] },
    );
  }

  /*
   * The prompt's own button, on a site the workspace has never seen.
   *
   * Every case above calls `saveIdentity` directly and every one of them is on a
   * site that already exists. Both differences matter: the prompt is the only
   * place the shell has to create the site first, and that path passed blank
   * optional fields to the site schema, so every "save this login" failed while
   * these tests stayed green.
   */
  {
    const strangerPort = await freePort();
    const stranger = createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>陌生站点</title></head>
<body>
<form id="f" action="/done" method="get">
  <label>账号 <input id="user" name="user" type="text" /></label>
  <label>密码 <input id="pass" name="pass" type="password" /></label>
  <button id="submit" type="submit">登录</button>
</form>
</body></html>`);
    });
    await new Promise((done) => stranger.listen(strangerPort, "127.0.0.1", done));
    try {
      const url = `http://127.0.0.1:${strangerPort}/login`;
      await client.evaluate(
        `window.ensemble.openEmbeddedTab({ viewId: null, url: ${JSON.stringify(url)} })`,
      );
      await wait(1_500);
      const target = await pageTarget(strangerPort);
      if (!target) throw new Error("the stranger page never became a CDP target");
      const pageClient = await connect(target.webSocketDebuggerUrl);
      await pageClient.evaluate(`(() => {
        const set = (selector, value) => {
          const el = document.querySelector(selector);
          const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
          descriptor.set.call(el, value);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('#user', 'stranger@example.test');
        set('#pass', 'pw-stranger');
        return true;
      })()`);
      await wait(250);
      await pageClient.evaluate(`document.querySelector('#submit').click()`);
      await wait(1_000);
      pageClient.close();

      const before = await client.evaluate(`(async () => {
        const snapshot = await window.ensemble.getWorkspace();
        return {
          sites: snapshot.sites.length,
          hasSite: snapshot.sites.some((site) => site.baseUrl.includes(${strangerPort})),
        };
      })()`);
      check(
        "a login on an unknown origin has no site yet",
        before?.hasSite === false,
        before,
      );

      const opened = await client.evaluate(`(async () => {
        const probe = document.querySelector('[data-capture-probe]');
        const button = document.querySelector('[data-capture-save]');
        if (!button) {
          return {
            error: 'no save button',
            flags: probe
              ? {
                  list: probe.dataset.list,
                  shown: probe.dataset.shown,
                  covered: probe.dataset.covered,
                  what: probe.dataset.what,
                }
              : null,
            pending: (await window.ensemble.pendingLogins()).length,
          };
        }
        button.click();
        await new Promise((r) => setTimeout(r, 1_200));
        const snapshot = await window.ensemble.getWorkspace();
        const dialog = document.querySelector('.modal, [role="dialog"]');
        return {
          dialogOpen: Boolean(dialog),
          sites: snapshot.sites.length,
          siteCreated: snapshot.sites.some((site) => site.baseUrl.includes(${strangerPort})),
          errorText: dialog?.querySelector('.error, .form-error')?.textContent?.trim() ?? '',
        };
      })()`);
      check(
        "saving a login on an unknown origin creates the site and opens the account form",
        opened?.dialogOpen === true && opened?.siteCreated === true,
        opened,
      );
    } finally {
      stranger.close();
    }
  }

  client.close();
} catch (error) {
  check("run completed", false, String(error));
} finally {
  app.kill();
  await wait(1_200);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    console.log("note: temp dir left behind at", userData);
  }
  page.close();
  const failed = results.filter((item) => !item.ok);
  console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length > 0 ? 1 : 0);
}
