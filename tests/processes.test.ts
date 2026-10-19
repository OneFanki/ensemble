import { describe, expect, it } from "vitest";
import {
  normalizeForCompare,
  parseWindowsProcessList,
  profileDirFromCommandLine,
  sanitizeWorkspace,
} from "@core/processes/registry";
import { parseDevToolsActivePort } from "@core/cdp/browser";

describe("process registry", () => {
  it("extracts --user-data-dir with and without quotes", () => {
    expect(
      profileDirFromCommandLine(
        'msedge.exe --user-data-dir="C:\\Users\\me\\AppData\\Roaming\\Ensemble\\profiles\\env\\id"',
      ),
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\Ensemble\\profiles\\env\\id");
    expect(profileDirFromCommandLine("/usr/bin/chrome --user-data-dir=/home/me/.config/x")).toBe(
      "/home/me/.config/x",
    );
    expect(profileDirFromCommandLine("/usr/bin/chrome --no-first-run")).toBeUndefined();
  });

  it("normalizes separators and case for comparison", () => {
    expect(normalizeForCompare("C:\\Users\\ME\\Profiles\\")).toBe("c:/users/me/profiles");
    expect(normalizeForCompare("/home/me/profiles/")).toBe("/home/me/profiles");
  });

  it("parses a Windows process list payload", () => {
    const rows = parseWindowsProcessList(
      [
        '{"ProcessId":10,"CommandLine":"msedge.exe --user-data-dir=C:\\\\p\\\\a"}',
        '{"ProcessId":11,"CommandLine":"chrome.exe"}',
        "not json",
      ].join("\n"),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]?.pid).toBe(10);
  });

  it("sanitizes partial workspace data", () => {
    const clean = sanitizeWorkspace({ environments: undefined, manualEngines: undefined });
    expect(clean.environments).toEqual([]);
    expect(clean.manualEngines).toEqual([]);
    expect(clean.version).toBe(1);
  });
});

describe("DevToolsActivePort", () => {
  it("parses the two line format", () => {
    const parsed = parseDevToolsActivePort("51234\n/devtools/browser/abc-123\n");
    expect(parsed).toEqual({ port: 51234, browserPath: "/devtools/browser/abc-123" });
  });

  it("rejects malformed content", () => {
    expect(parseDevToolsActivePort("0\n")).toBeUndefined();
    expect(parseDevToolsActivePort("abc\n/devtools/browser/x")).toBeUndefined();
    expect(parseDevToolsActivePort("51234\n")).toBeUndefined();
  });
});
