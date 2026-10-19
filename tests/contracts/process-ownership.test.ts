import { describe, expect, it } from "vitest";
import { isOwnedProfile } from "@core/processes/registry";

const ROOT_WIN = "C:\\Users\\me\\AppData\\Roaming\\Ensemble\\profiles";
const ROOT_POSIX = "/home/me/.config/Ensemble/profiles";

describe("process ownership contract", () => {
  it("accepts profile directories beneath our own root", () => {
    expect(isOwnedProfile(`${ROOT_WIN}\\env-1\\id-1`, ROOT_WIN)).toBe(true);
    expect(isOwnedProfile(`${ROOT_POSIX}/env-1/id-1`, ROOT_POSIX)).toBe(true);
  });

  it("accepts the root itself and tolerates trailing separators", () => {
    expect(isOwnedProfile(`${ROOT_WIN}\\`, ROOT_WIN)).toBe(true);
    expect(isOwnedProfile(`${ROOT_POSIX}/`, ROOT_POSIX)).toBe(true);
  });

  it("rejects a prefix lookalike that is not actually beneath the root", () => {
    expect(isOwnedProfile(`${ROOT_WIN}-copy\\env\\id`, ROOT_WIN)).toBe(false);
    expect(isOwnedProfile(`${ROOT_POSIX}-backup/env/id`, ROOT_POSIX)).toBe(false);
  });

  it("rejects a normal user browser profile", () => {
    expect(isOwnedProfile("C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data", ROOT_WIN)).toBe(
      false,
    );
    expect(isOwnedProfile("/home/me/.config/google-chrome/Default", ROOT_POSIX)).toBe(false);
  });

  it("rejects an empty root instead of matching everything", () => {
    expect(isOwnedProfile(ROOT_WIN, "")).toBe(false);
  });
});
