import { describe, expect, it } from "vitest";
import { resolveIdentityForUrl } from "../src/core/util/identity-resolution";

/**
 * 站点与账号的最小形状即可参与解析；解析函数不关心工作区的其余字段。
 * 顺序即数组顺序：同站点多个账号时第一个数组条目就是「第一个账号」。
 */
function fixture() {
  const sites = [
    { id: "site-a", baseUrl: "http://localhost:5173" },
    { id: "site-b", baseUrl: "https://console.example.test" },
    { id: "site-empty", baseUrl: "http://localhost:4000" },
  ];
  const identities = [
    { id: "id-a1", siteId: "site-a" },
    { id: "id-a2", siteId: "site-a" },
    { id: "id-b1", siteId: "site-b" },
  ];
  return { sites, identities };
}

describe("resolveIdentityForUrl", () => {
  it("URL 与站点同源时取该站点的第一个账号", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "http://localhost:5173/app/dashboard?tab=1",
      sites,
      identities,
    });
    expect(result).toEqual({
      identityId: "id-a1",
      siteId: "site-a",
      reason: "explicit-url-match",
    });
  });

  it("URL 命中的站点有多个账号时按录入顺序取第一个，不取后面的", () => {
    const { sites, identities } = fixture();
    const reordered = [{ id: "id-a2", siteId: "site-a" }, ...identities.filter((item) => item.id !== "id-a2")];
    const result = resolveIdentityForUrl({
      url: "http://localhost:5173/",
      sites,
      identities: reordered,
    });
    expect(result.identityId).toBe("id-a2");
  });

  it("URL 命中的站点没有账号且未给 siteId 时回落到 none，但报告命中的站点", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "http://localhost:4000/login",
      sites,
      identities,
    });
    expect(result).toEqual({ reason: "none", matchedSiteId: "site-empty" });
  });

  it("URL 不命中任何站点时回落到 none", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "https://elsewhere.example.test/page",
      sites,
      identities,
    });
    expect(result).toEqual({ reason: "none" });
  });

  it("端口不同不算同源", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "http://localhost:9999/path",
      sites,
      identities,
    });
    expect(result.reason).toBe("none");
  });

  it("端口数字只是另一站点端口的前缀时不算同源", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "http://localhost:51730/x",
      sites,
      identities,
    });
    expect(result.reason).toBe("none");
  });

  it("子域不算同源", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "https://api.console.example.test/page",
      sites,
      identities,
    });
    expect(result.reason).toBe("none");
  });

  it("同源站点拼接出的域名后缀不算同源", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "https://console.example.test.evil.test/page",
      sites,
      identities,
    });
    expect(result.reason).toBe("none");
  });

  it("只有 siteId 时用该站点的第一个账号", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({ siteId: "site-b", sites, identities });
    expect(result).toEqual({ identityId: "id-b1", siteId: "site-b", reason: "explicit-site" });
  });

  it("URL 与站点同源时 siteId 不参与选择", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "https://console.example.test/dashboard",
      siteId: "site-a",
      sites,
      identities,
    });
    expect(result).toEqual({ identityId: "id-b1", siteId: "site-b", reason: "explicit-url-match" });
  });

  it("siteId 指向不存在的站点时回落到 none", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({ siteId: "site-gone", sites, identities });
    expect(result).toEqual({ reason: "none" });
  });

  it("siteId 指向的站点没有账号时回落到 none", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({ siteId: "site-empty", sites, identities });
    expect(result).toEqual({ reason: "none" });
  });

  it("URL 命中的站点没有账号时接着用 siteId 指向的站点", () => {
    const { sites, identities } = fixture();
    const result = resolveIdentityForUrl({
      url: "http://localhost:4000/login",
      siteId: "site-b",
      sites,
      identities,
    });
    expect(result).toEqual({
      identityId: "id-b1",
      siteId: "site-b",
      matchedSiteId: "site-empty",
      reason: "explicit-site",
    });
  });

  it("空 url 与空 siteId 不解析", () => {
    const { sites, identities } = fixture();
    expect(resolveIdentityForUrl({ sites, identities })).toEqual({ reason: "none" });
    expect(resolveIdentityForUrl({ url: "", siteId: "", sites, identities })).toEqual({
      reason: "none",
    });
  });

  it("无法解析的地址视作不命中", () => {
    const { sites, identities } = fixture();
    expect(resolveIdentityForUrl({ url: "not a url", sites, identities })).toEqual({
      reason: "none",
    });
  });
});
