# Ensemble

**Many identities. One stage.** A local multi-account browser workbench: keep several identities present in the same system at once, work in parallel and compare side by side, to confirm that each one sees and can do what it should.

[中文](README.md) · [Architecture](docs/architecture.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/OneFanki/ensemble/actions/workflows/ci.yml/badge.svg)](https://github.com/OneFanki/ensemble/actions/workflows/ci.yml)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Vue](https://img.shields.io/badge/Vue-3.5-42B883?logo=vue.js&logoColor=white)](https://vuejs.org/)

![Ensemble overview: a view on the left, four isolated browser profiles tiled edge to edge on the right](docs/diagrams/hero.svg)

In one sentence: **one view brings a group of accounts on stage, each with its own browser profile** — inside the app they share one screen, in real browsers they tile edge to edge, and switching never leaves you guessing which account you are looking at.

## Why

The same system looks different depending on who is signed in: an admin gets a delete button, tenant A must never see tenant B's data, a feature flag reaches only part of the accounts, and the free and paid plans stop at different boundaries. Confirming those differences means keeping several windows open at once — and logging out, clearing cookies and hunting passwords in between. Multiple windows of the same browser often leak sessions into each other.

Ensemble turns those windows into a stage you can arrange: every account gets its own browser profile, and you launch a whole group at once, tiled automatically and reclaimed on close. It has two browser surfaces:

- **Built-in browser (the main surface)**: pages run inside the app window, so nothing pops up as a system window. One screen can show several identities at once (1×1 up to 3×1, or a custom layout), and an AI client can read, click, type and screenshot through MCP while you watch and take over at any moment.
- **External real browser**: when you need to confirm “it behaves the same for a real user”, launch the same group in the Chrome, Edge, Brave or Firefox installed on your machine. Cookies, extensions, downloads and the native password manager behave exactly as they would for a human.

Both surfaces share the same sites, accounts, credentials and views. Switching surfaces means signing in again — each keeps its own sessions.

## Typical scenarios

Permissions are only the easiest example. Any case with one system, several identities and a difference to confirm fits:

| Scenario | The question it answers |
| --- | --- |
| **Roles and permissions** | Is the delete button really admin-only? Is a regular member actually blocked? |
| **Tenants and data isolation** | Can tenant A's account see tenant B's data — in search, in exports, on detail pages? |
| **Feature flags and rollouts** | Is the feature on for the rollout list and genuinely off for everyone else? |
| **Plan and tier differences** | Do the free and paid boundaries match the pricing page, and change on upgrade? |
| **Multi-account collaboration** | After A submits, does B receive it; after approval, does C see the right state? |

What these have in common: **they can only be verified with the identities present at the same time**. Logging out and back in is slow and hides anything that only appears once you switch.

## Concepts

| Concept | Meaning | Isolated |
| --- | --- | --- |
| **Site** | The target under test: base URL, login path, auth-check path, default credentials; groupable with tags | No — it is a scope |
| **Identity** | One login plus one dedicated browser profile; may reference an identity on another site | Yes, fully |
| **View** | One shared screen region: which accounts appear together, in which layout | No — it is orchestration |

Site 1—N identities, site 1—N views. A view is optional: without one the surface behaves like a plain browser, and views are created explicitly from the running dock. Switching sites switches what the identities and views pages show — the clearest signal of the isolation boundary.

<p align="center">
  <img src="docs/screenshots/browser-en.png" alt="Browser page: a 2×2 view and the running dock" width="900" />
</p>

**The browser is the default page.** The address bar and slot headers sit on top, live pages below, and the running dock on the right lists which accounts are open and in which slot — on every page, always. The left rail collapses to an icon strip by default and expands when the pointer reaches the left edge.

The identities page is where most of the day is spent: one card per identity with its role, login, session status and running state. Clicking a running identity switches to it; stopping has its own button.

<p align="center">
  <img src="docs/screenshots/identities-en.png" alt="Identity list" width="900" />
</p>

## Features

- **Running-instances overlay**: a small always-on-top strip on the desktop lists every running identity, grouped by site. One click raises that browser window, restoring it if minimized — no relaunch, no reload. The row of the window that actually owns the OS foreground is highlighted live, so taskbar and Alt+Tab switches follow too. When you do not need it, it collapses into a small square showing only the window count, and snaps to the screen edge after a drag
- **One-click cleanup**: close every instance at once from the bottom of the overlay, the running dock, or the tray menu; stopping a view closes only the tabs it launched, never hand-made or AI-added pages
- **Batch launch**: a selection mode on the identities page opens several identities at once in the default layout, instead of clicking one by one while every new window covers the next card
- **Switch receipt**: after switching from the overlay, the account name floats briefly (~2 s) over the window that was raised, so the right account is obvious even when every page looks the same. The pill is click-through, never takes focus, and injects nothing into the page
- **Fill on launch**: credentials are typed in as soon as the login form appears; the app names any input still unconfigured
- **Fields beyond username and password**: tenant or company codes are matched by label, defined per site and overridable per identity
- **Built-in browser**: pages live inside the app window, so nothing pops up; several identities share one screen, and an AI client can read, click, type and screenshot while you watch and take over
- **A view is one shared screen region**: create one from the running dock, then drag tabs into it (the drop point decides side by side or stacked), switch layouts, drag the seams to re-proportion slots; only one view is on stage at a time and the rest keep running off screen
- **One slot = one browser instance**: a page opened from a page (`target="_blank"`, an OAuth popup) stays inside the same instance and just becomes the page that slot shows — it never takes an extra slot. The dock lists one row per instance, with that instance's other pages indented beneath it
- **On stage / off stage / focused**: a view shows only as many instances as it has slots; one click on an off-stage instance swaps it into the focused slot, and clicking again swaps back. Slot numbers make “which pages are on screen right now” a readable fact; an empty slot is a dashed cell with an “add a page here” button that drops a focused tab straight into that cell
- **Running dock**: views, loose tabs and external instances in one place; views are blocks, instances are rows, collapsible as a whole; one click brings the page or window to the front
- **Two browser surfaces**: the built-in one is the main surface, the external real browser is the fidelity check; both share the same accounts, credentials and layouts
- **Identity references**: an identity can reference one on another site — username, password, display name and role stay in sync while sessions and profiles stay independent; detach when they need to differ
- **Address-change detection**: a site remembers the address that last signed in successfully; if it changes, filling the password requires one explicit confirmation
- **Copy a view to another site**: members that already exist there are reused, the rest become reference identities
- **Real browser isolation**: each identity has its own profile, so sessions, cookies and extensions never mix
- **View orchestration**: launch a group of identities, tiled edge to edge with no wasted margin
- **Place windows by role**: drag a member onto a slot to decide who sits where; open windows move with it
- **Custom layouts**: external windows use the built-in `No layout / 1×1 / 2×1 / 1×2 / 2×2 / 3×1`; the built-in browser uses `No layout (= 1×1) / 2×1 / 1×2 / 2×2 / 3×1` and lets you drag the seams between slots. Either way you can draw your own layout and save it as a preset; boxes snap to the stage edges and to each other, with alignment guides
- **No-layout mode**: on a small screen, every window opens full size and overlaps — switch with the taskbar instead of shrinking four windows into tiles too small to use
- **Reopen a single member**: closed one identity by mistake? Reopen just that window from the view detail instead of relaunching the whole group
- **Session health**: one screen shows who is signed in, who expired and who is unconfirmed in the current site; check everyone with one click, or open the login page and fill credentials for every expired account. Accounts with no window open are checked in a hidden browser that reads their own profile and closes again
- **Restore last view**: when enabled in Settings, a cold start reopens the last view in its saved layout inside the built-in browser
- **Credential protection**: OS keychain encryption (DPAPI / Keychain / keyring), optionally hardened with an app master password
- **Clean sessions**: throwaway windows that never log in and are deleted on close; the sites page can also open a blank one that belongs to no site
- **Process reclamation**: on quit, only browsers launched against Ensemble's own profile root are stopped
- **One entry per job**: the rail navigates browser / sites / identities / views / settings; the title bar only switches sites
- **Let an AI do the data entry**: a built-in MCP endpoint receives sites, identities and views from your AI client, and drives the built-in browser directly
- **Portable config**: export the whole workspace to JSON, including encrypted passwords
- **Tray mode**: closing the window keeps browsers and the AI endpoint running; only an explicit quit stops them
- **Automatic updates**: the app checks for a new version in the background, shows a short summary when one exists, and downloads, verifies and installs it in one click — then restarts itself. No manual GitHub download, and no browser download warning to get past

<p align="center">
  <img src="docs/screenshots/settings-en.png" alt="Settings and credential storage" width="900" />
</p>

With a dozen windows open there is no need to hunt through the taskbar: the running-instances overlay stays on top, and one click raises the window for that account.
When it is in the way, collapse it into a small square that shows only the window count, takes almost no room, and snaps to the screen edge after you drag it; click it to expand again. "Close all" at the bottom of the list closes every window at once.

<p align="center">
  <img src="docs/screenshots/overlay-en.png" alt="Running-instances overlay" width="340" />
  <img src="docs/screenshots/overlay-ball.png" alt="The collapsed square" width="48" />
</p>

**When every page looks identical, how do you know you switched to the right account?** That is the practical problem with multiple accounts. The overlay highlights the row that actually owns the OS foreground, so raising a window from the taskbar or Alt+Tab moves the highlight too. After a click, the account name briefly floats over the window that was raised and fades after two seconds:

<p align="center">
  <img src="docs/diagrams/overlay-switch.svg" alt="Switching from the overlay, with the account name over the target window" width="900" />
</p>

The pill is click-through, never takes focus, and injects nothing into the page under test, so the system behaves exactly as it does for a real user.

An expired session no longer requires opening each window: the session health panel groups the current site into signed in / expired / unconfirmed, checks everyone at once, and can sign every expired identity back in. An identity with no window open is still checkable — a hidden browser reads its own profile, answers, and closes, so no extra windows pile up.

<p align="center">
  <img src="docs/screenshots/session-health-en.png" alt="Session health" width="820" />
</p>

The views page is a list on the left and a detail pane on the right: select a view to see its members and layout; adjusting the tiling never launches anything. The primary action opens it in the built-in browser, laid out into slots; the secondary action uses real browser windows as a fidelity check.

Tiling really is edge to edge: no gutter between windows, the only line between them is the window frame itself. Each account is marked by the colour dot at the top left, the same dot used in the dock and the overlay:

<p align="center">
  <img src="docs/diagrams/layout-grid.svg" alt="2×2 tiling with no gaps between windows" width="900" />
</p>

<p align="center">
  <img src="docs/screenshots/views-en.png" alt="View orchestration and window layout" width="900" />
</p>

Site switching lives in a single title-bar menu: it only changes the current scope, while managing and creating sites lives on the sites page.

<p align="center">
  <img src="docs/screenshots/env-menu.png" alt="Site switcher" width="640" />
</p>

The light theme matches the dark one, down to the native title-bar buttons:

<p align="center">
  <img src="docs/screenshots/light-en.png" alt="Light theme" width="900" />
</p>

## AI access

Have your AI create the accounts in a container, then record them in Ensemble without typing a single form:

1. Turn on "AI access" in settings to get the loopback URL and a Bearer token;
2. Paste the config snippet into any MCP-capable client (Claude Code, ZCode, …);
3. The AI calls `create_site`, `create_identities`, `create_view`, then `open_browser_view` (built-in browser) or `launch_view` (external windows).

The server is plain local HTTP + JSON-RPC (a subset of MCP 2025-06-18), bound to `127.0.0.1`.
It validates `Host`/`Origin` against DNS rebinding, and every request needs the Bearer token.
The default port is 47821 and it can be changed.

Permissions are three switches in settings:

| Permission | Tools | Default |
| --- | --- | --- |
| Read | List sites / identities / views / layouts, workspace summary | Always on |
| Write | Create and edit sites, identities, views, layouts; store passwords | On |
| Run | Launch / stop windows, check sessions | On |
| Delete | Delete sites / identities / views | Off |

Hard boundaries:

- **Passwords are write-only.** No tool reads, copies or returns a password; once stored it is only decrypted inside the main process for filling.
- Delete tools additionally require an explicit `confirm: true`. Launch tools are gated only by the Run permission: opening a window changes no data.
- Every call appends one line to `mcp-audit.log`; passwords, passphrases and tokens are replaced with `[redacted]`.
- On quit the MCP server stops before browsers are reclaimed, so the port is released with the process.

<p align="center">
  <img src="docs/screenshots/settings-data.png" alt="Data and AI access" width="900" />
</p>

## Import and export

The migration path for a local-first app: settings → Data → export one JSON file with sites,
identities, views and layout presets. Browser profiles and sessions are never exported.

- Passwords are excluded by default. With "include passwords", they are sealed with your passphrase
  (scrypt + AES-256-GCM) inside the same file. Importing requires the same passphrase; a wrong one
  rejects the whole file instead of importing half of it.
- Import merges by id: same id overwrites, new entries are appended, and identities or views whose
  site is missing are skipped and counted.
- Running instances and login status are never part of an export.

## Tray mode

On by default: the window's close button only hides it, so browsers and the AI endpoint keep running
while an AI client is mid-task. Quit from the tray menu or the "Quit completely" button in settings;
quitting stops the MCP server first, then reclaims every browser.

## Credential security

Test databases are often copies of production data, so passwords must not sit on disk in plaintext.

- By default, credentials are encrypted with Electron `safeStorage`: Windows DPAPI, macOS Keychain, or the system keyring on Linux
- You can set an **app master password**: a scrypt-derived key (N=32768, r=8, p=1) encrypts each secret with AES-256-GCM, a random IV and an authentication tag; the vault file stores only the salt, KDF parameters and ciphertext
- In master mode the vault starts locked and decrypts only after you unlock it. You can change the password, lock immediately, or switch back to the OS keychain
- Plaintext entries left by older versions are re-encrypted on startup
- Passwords are decrypted only in the main process — never sent to the renderer, never logged. Clipboard copies clear after 30 seconds

An OS keychain stops offline reads but not a program running as your user. A master password closes that gap, which is why this behaves more like a password manager than a config file.

## Engines

| Platform | Full support (CDP) | External mode | Detected, unsupported |
| --- | --- | --- | --- |
| Windows | Edge / Chrome / Brave / Vivaldi / Chromium | Firefox | — |
| macOS | Chrome / Edge / Brave / Vivaldi / Chromium | Firefox | Safari |
| Linux | Chrome / Chromium / Edge / Brave / Vivaldi (incl. Flatpak, Snap) | Firefox | — |

CDP engines support autofill, session checks and window tiling. Firefox runs in external mode: multiple windows, layout and password copy, but no page control. Browsers are installed and updated by the OS; Ensemble never bundles or distributes a browser engine.

## Install

Download the installer for your platform from [Releases](https://github.com/OneFanki/ensemble/releases),
or visit the landing page at <https://onefanki.github.io/ensemble/>.

Release artifacts are **not code-signed** (a personal open-source project does not buy certificates).
The system warning on first launch is expected:

- **Windows**: in the SmartScreen dialog choose More info → Run anyway; the browser may need a manual "keep"
- **macOS**: right-click the app → Open, or run
  `xattr -dr com.apple.quarantine /Applications/Ensemble.app`

> This is 0.x software; interfaces and data formats may change.

## Development

Requires Node.js >= 22.12 and pnpm 12.

```bash
pnpm install
pnpm dev        # development mode
pnpm verify     # typecheck + unit tests + structural contracts + build
pnpm test       # unit tests
pnpm test:e2e   # real-browser end-to-end (needs an installed Chromium browser)
pnpm build      # build to out/
pnpm screenshots # regenerate the README screenshots (needs a prior build)
pnpm diagrams    # regenerate the SVG diagrams (both languages, no build needed)
pnpm dist       # package the installer into release/
```

Electron downloads its runtime on first install. If `node_modules/electron/dist` is missing afterwards, rerun the download step:

```bash
node node_modules/electron/install.js
```

## Architecture

```
src/core/       Pure Node: engine discovery, CDP client, launcher, credentials, process registry
src/main/       Electron main process: window, IPC, safeStorage, OS integration
src/preload/    Narrow IPC bridge
src/renderer/   Vue 3 control panel
```

The control panel renders in Electron's own window; pages under test live in real, separate browser processes. `src/core` never imports Electron and can be tested under plain Node.

The primary path talks to browsers over CDP directly rather than hosting human-driven windows through Playwright, which by default takes over dialogs, downloads and extensions and would distort what you are testing. The trade-offs are recorded in the [ADRs](docs/architecture/adr/).

## Non-goals

- No fingerprint spoofing, anti-detection or account farming
- No bundled browser engine
- No test-case management, reporting or CI platform
- No multi-account Safari (it has no per-profile directory model)

## Documentation

| Topic | Location |
| --- | --- |
| Architecture and data model | [docs/architecture.md](docs/architecture.md) |
| Architecture decision records | [docs/architecture/adr/](docs/architecture/adr/) |
| CDP playbook | [docs/engineering/cdp-playbook.md](docs/engineering/cdp-playbook.md) |
| Pitfall library | [docs/engineering/踩坑库.md](docs/engineering/踩坑库.md) |
| Release process | [docs/engineering/release.md](docs/engineering/release.md) |

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Report security problems privately as described in [SECURITY.md](SECURITY.md). By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 OneFanki
