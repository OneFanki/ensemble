import { sameOrigin } from "./url";

/**
 * 「按地址归属选择账号」的输入。
 *
 * 只依赖站点与账号的结构化形状，不依赖完整数据模型：调用方（MCP 工具、
 * 日志定位）拿到的通常就是快照数组。
 */
export interface ResolveIdentityForUrlInput {
  /** 要打开的地址；无法解析成 http(s) 时视作匹配不到站点。 */
  url?: string;
  /** 显式给出的站点 id；URL 匹配不到站点时作为后备。 */
  siteId?: string;
  /** 已录入站点，按工作区顺序。 */
  sites: ReadonlyArray<{ id: string; baseUrl: string }>;
  /** 已录入账号，按工作区顺序；同站点多个账号时取第一个。 */
  identities: ReadonlyArray<{ id: string; siteId?: string }>;
}

/**
 * 解析结果。
 *
 * `reason` 回答「为什么用了这个账号」；`matchedSiteId` 在 URL 命中了站点
 * 却没有可用账号时仍然给出，让日志能区分「地址不属于任何站点」和
 * 「站点存在但还没录账号」这两种没有复用成功的情况。
 */
export interface ResolveIdentityForUrlResult {
  /** 解析到的账号 id；没有解析到时缺省。 */
  identityId?: string;
  /** 账号所属站点 id；没有解析到时缺省。 */
  siteId?: string;
  /** URL 同源命中的站点 id，即使该站点没有可用账号。 */
  matchedSiteId?: string;
  reason: "explicit-url-match" | "explicit-site" | "none";
}

/**
 * 在显式 siteId 指向的站点里找第一个账号。
 *
 * 单独成函数是因为 URL 命中的站点没有账号时要接着试它：站点 A 没录账号
 * 不该挡住调用方明确指定的站点 B。
 */
function firstIdentityOfSite(
  siteId: string | undefined,
  sites: ResolveIdentityForUrlInput["sites"],
  identities: ResolveIdentityForUrlInput["identities"],
): ResolveIdentityForUrlResult | undefined {
  if (!siteId) return undefined;
  const site = sites.find((item) => item.id === siteId);
  if (!site) return undefined;
  const identity = identities.find((item) => item.siteId === site.id);
  if (!identity) return undefined;
  return { identityId: identity.id, siteId: site.id, reason: "explicit-site" };
}

/**
 * 按地址归属为一次打开选择已录入的账号。
 *
 * 优先级：URL 同源命中的站点 → 显式 siteId 指向的站点 → 都没有则不解析
 * （调用方按自己的回落路径处理）。同源判断用 {@link sameOrigin} 而不是
 * 字符串前缀：`http://a.test:9527` 与 `http://a.test`、`http://a.test` 与
 * `http://a.b.test` 互不相同源，前缀比较会把它们误判成同一个站点。
 */
export function resolveIdentityForUrl(
  input: ResolveIdentityForUrlInput,
): ResolveIdentityForUrlResult {
  const url = input.url;
  if (url) {
    const matched = input.sites.find((site) => sameOrigin(url, site.baseUrl));
    if (matched) {
      const identity = input.identities.find((item) => item.siteId === matched.id);
      if (identity) {
        return {
          identityId: identity.id,
          siteId: matched.id,
          reason: "explicit-url-match",
        };
      }
      const fallback = firstIdentityOfSite(input.siteId, input.sites, input.identities);
      return fallback ? { ...fallback, matchedSiteId: matched.id } : { reason: "none", matchedSiteId: matched.id };
    }
  }
  return firstIdentityOfSite(input.siteId, input.sites, input.identities) ?? { reason: "none" };
}
