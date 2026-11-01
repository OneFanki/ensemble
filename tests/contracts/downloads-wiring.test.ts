import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const browser = readFileSync(join(process.cwd(), "src/main/embedded/browser.ts"), "utf8");
const downloads = readFileSync(join(process.cwd(), "src/main/downloads.ts"), "utf8");
const main = readFileSync(join(process.cwd(), "src/main/index.ts"), "utf8");

describe("download wiring contract", () => {
  it("hooks every session the embedded surface configures", () => {
    // Downloads are session state: a partition that is configured but never
    // handed to the manager downloads without appearing anywhere.
    expect(browser).toMatch(/this\.options\.onSessionReady\?\.\(target\)/);
    expect(downloads).toMatch(/"will-download"/);
  });

  it("keeps one manager in the main process, not one per surface", () => {
    // The list has to survive the browser being closed and reopened, so it
    // cannot live inside EmbeddedBrowser.
    expect(main).toMatch(/const downloads = new DownloadManager\(broadcastDownloads\)/);
    expect(main).toMatch(/onSessionReady: \(ses\) => downloads\.attach\(ses\)/);
  });

  it("routes every toolbar action through one IPC call", () => {
    expect(main).toMatch(/handle\(IPC\.downloadsAct/);
    expect(main).toMatch(/shell\.openPath/);
    expect(main).toMatch(/shell\.showItemInFolder/);
  });
});
