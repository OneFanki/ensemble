import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * One global answer, one per-site escape hatch.
 *
 * Filling without submitting parks every account one click short of signed in,
 * so the global default is on. A site may still say "never submit this one" —
 * a captcha or an account that locks after a couple of attempts — and that
 * override has to win without touching the global setting for everything else.
 */
let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-auto-submit-"));
  service = new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function site(autoSubmit?: boolean) {
  return service.saveSite({
    name: "提交检查",
    baseUrl: "http://127.0.0.1:1",
    loginPath: "/login",
    ...(autoSubmit === undefined ? {} : { autoSubmit }),
    extraFields: [],
  });
}

describe("auto-submit resolution", () => {
  it("is on by default, because a filled form is not a session", () => {
    expect(service.settingsSnapshot().autoSubmitLogin).toBe(true);
  });

  it("follows the global setting when the site has no opinion", () => {
    const created = site(undefined);
    expect(service.effectiveAutoSubmit(created)).toBe(true);
    service.saveSettings({ autoSubmitLogin: false });
    expect(service.effectiveAutoSubmit(created)).toBe(false);
  });

  it("lets a site opt out even while the global default is on", () => {
    const created = site(false);
    expect(service.effectiveAutoSubmit(created)).toBe(false);
  });

  it("lets a site opt in even while the global default is off", () => {
    service.saveSettings({ autoSubmitLogin: false });
    const created = site(true);
    expect(service.effectiveAutoSubmit(created)).toBe(true);
  });

  it("does not store an opinion when the dialog leaves it on the default", () => {
    const created = site(undefined);
    // The stored record must not carry a copy of the global answer: a `false`
    // sitting in a site would survive a later change to the global setting and
    // look like a deliberate choice nobody made.
    expect(created.autoSubmit).toBeUndefined();
    const stored = service.snapshot().sites.find((item) => item.id === created.id);
    expect(stored?.autoSubmit).toBeUndefined();
  });
});
