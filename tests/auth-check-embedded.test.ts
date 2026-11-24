import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretBox } from "@core/credentials/vault";
import { WorkspaceService } from "@core/service";
import { afterEach, describe, expect, it } from "vitest";

/*
 * 登录检测先看内置浏览器里已经打开的页面。
 *
 * 内置页面与外部窗口是两套互不相干的登录状态。AI 的页面都开在内置浏览器里，
 * 检测却只去外部浏览器里问，答的就是另一套登录状态的状况：内置页面明明已经
 * 掉线，工具回「已登录」。这里守的是三件事：有内置页面就看它；页面开着但问
 * 不到时如实说检测不了（换一套登录状态去给答案更糟）；没有内置页面才走外部。
 */

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rmSync(dir, { recursive: true, force: true })));
});

type ProbeOutcome = { httpStatus: number; signedOut: boolean } | "unavailable" | undefined;

/**
 * `probe` 为 null：宿主没有内置浏览器，连探测函数都没有。
 * `probe` 为 undefined 或返回 undefined：有内置浏览器，但这个账号在里面没开页面。
 */
async function setup(probe: ProbeOutcome | (() => ProbeOutcome) | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "ensemble-auth-embedded-"));
  created.push(dir);
  const service = new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
    // 外部那条路需要一个真实浏览器：关掉它，走到那里只会得到「未在运行」。
    headlessAuthCheck: false,
    ...(probe === null
      ? {}
      : {
          embeddedAuthProbe: async () =>
            typeof probe === "function" ? (probe as () => ProbeOutcome)() : probe,
        }),
  });
  await service.initialize();
  const site = await service.saveSite({
    name: "被测站点",
    baseUrl: "https://app.example.test",
    loginPath: "/login",
    authCheckPath: "/api/me",
    autoSubmit: false,
  });
  const identity = await service.saveIdentity({
    siteId: site.id,
    name: "示例账号",
    username: "user-a",
    role: "member",
    color: "teal",
    passwordMode: "inherit",
  });
  return { service, site, identity };
}

describe("登录检测先看内置浏览器里的页面", () => {
  it("账号在内置浏览器里开着页面时，就在那个页面里检测", async () => {
    const { service, identity } = await setup({ httpStatus: 200, signedOut: false });
    const result = await service.checkAuth(identity.id);
    expect(result).toMatchObject({
      identityId: identity.id,
      status: "signed-in",
      surface: "embedded",
    });
    expect(result.detail).toContain("HTTP 200");
  });

  it("接口回了 200 但响应体里带着未登录标记时，算未登录", async () => {
    const { service, identity } = await setup({ httpStatus: 200, signedOut: true });
    const result = await service.checkAuth(identity.id);
    expect(result).toMatchObject({ status: "expired", surface: "embedded" });
    expect(result.detail).toContain("signed-out marker");
  });

  it("页面开着但问不到时如实说检测不了，不换一套登录状态去给答案", async () => {
    const { service, identity } = await setup("unavailable");
    const result = await service.checkAuth(identity.id);
    expect(result.status).toBe("unknown");
    // 没有查到任何一套登录状态，所以不报 surface。
    expect(result.surface).toBeUndefined();
    expect(result.detail).toContain("应用内浏览器");
  });

  it("账号在内置浏览器里没有打开页面时，走外部浏览器那条路", async () => {
    const { service, identity } = await setup(() => undefined);
    // 没有内置页面，也没有外部窗口，且外部那条路在测试里被关掉了。
    const result = await service.checkAuth(identity.id);
    expect(result.status).toBe("unknown");
    expect(result.surface).toBeUndefined();
  });

  it("宿主没有内置浏览器时，检测照旧只看外部", async () => {
    // `undefined` 在上一条里表示「这个账号没有内置页面」；这里连探测函数都没有。
    const { service, identity } = await setup();
    const result = await service.checkAuth(identity.id);
    expect(result.status).toBe("unknown");
  });

  it("站点没有配置登录检测路径时，内置页面也不会被问", async () => {
    const asked: string[] = [];
    const dir = mkdtempSync(join(tmpdir(), "ensemble-auth-embedded-"));
    created.push(dir);
    const service = new WorkspaceService({
      userDataDir: dir,
      profileRoot: join(dir, "profiles"),
      platform: "win32",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
      headlessAuthCheck: false,
      embeddedAuthProbe: async (identityId) => {
        asked.push(identityId);
        return { httpStatus: 200, signedOut: false };
      },
    });
    await service.initialize();
    const site = await service.saveSite({
      name: "没配检测的站点",
      baseUrl: "https://plain.example.test",
      loginPath: "/login",
      autoSubmit: false,
    });
    const identity = await service.saveIdentity({
      siteId: site.id,
      name: "账号",
      username: "user-b",
      role: "member",
      color: "slate",
      passwordMode: "inherit",
    });
    const result = await service.checkAuth(identity.id);
    expect(result.status).toBe("unknown");
    expect(asked).toEqual([]);
  });
});
