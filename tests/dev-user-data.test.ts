import { describe, expect, it } from "vitest";
import { DEV_APP_NAME, DEV_USER_DATA_DIR_NAME, devUserDataDir, userDataDirArg } from "../src/main/user-data";

/**
 * A development build and an installed build must never share a workspace.
 *
 * They used to: `electron .` reads the same `package.json`, so both resolved
 * userData to `appData/ensemble`. `pnpm dev` then rewrote the workspace the
 * installed app was using, fought over the MCP port, and — because the
 * single-instance lock lives inside userData — a second copy refused to start at
 * all and just revealed the other window.
 */
const APPDATA = "C:\\Users\\someone\\AppData\\Roaming";

describe("development workspace directory", () => {
  it("gives a development build a directory beside the installed app", () => {
    expect(
      devUserDataDir({ packaged: false, appDataDir: APPDATA, argv: [] }),
    ).toBe(`${APPDATA}\\${DEV_USER_DATA_DIR_NAME}`);
  });

  it("leaves a packaged build on Electron's default path", () => {
    // Renaming the packaged directory would move an existing installation's
    // workspace out from under it — every saved account would look lost.
    expect(devUserDataDir({ packaged: true, appDataDir: APPDATA, argv: [] })).toBeUndefined();
  });

  it("does not override a directory the caller chose", () => {
    // The e2e suites and the screenshot pass each pass their own throwaway
    // directory. Overriding that would send every test run into real user data.
    expect(
      devUserDataDir({
        packaged: false,
        appDataDir: APPDATA,
        argv: [".", `--user-data-dir=${APPDATA}\\throwaway`],
      }),
    ).toBeUndefined();
    expect(
      devUserDataDir({ packaged: false, appDataDir: APPDATA, argv: [], envOverride: "D:\\tmp\\ws" }),
    ).toBeUndefined();
  });

  it("names the development build differently so the windows can be told apart", () => {
    expect(DEV_APP_NAME).not.toBe("Ensemble");
    expect(DEV_APP_NAME.length).toBeGreaterThan(0);
  });
});

describe("--user-data-dir parsing", () => {
  it("accepts both the joined and the separate form", () => {
    expect(userDataDirArg(["--user-data-dir=D:\\a"])).toBe("D:\\a");
    expect(userDataDirArg(["--user-data-dir", "D:\\b"])).toBe("D:\\b");
  });

  it("reports nothing when the flag carries no path", () => {
    expect(userDataDirArg([])).toBeUndefined();
    expect(userDataDirArg(["--user-data-dir="])).toBeUndefined();
    expect(userDataDirArg(["--user-data-dir"])).toBeUndefined();
    // A following flag is not a path; treating it as one used to point the app
    // at a directory named after the next argument.
    expect(userDataDirArg(["--user-data-dir", "--remote-debugging-port=0"])).toBeUndefined();
  });

  it("ignores unrelated arguments", () => {
    expect(userDataDirArg([".", "--remote-debugging-port=0"])).toBeUndefined();
  });
});
