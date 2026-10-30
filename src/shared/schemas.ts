import { z } from "zod";

const httpUrl = z
  .string()
  .trim()
  .min(1)
  .refine((value) => /^https?:\/\/[^\s]+$/i.test(value), "必须是 http(s) 地址");

const pathValue = z
  .string()
  .trim()
  .refine((value) => value === "" || value.startsWith("/"), "路径必须以 / 开头");

const localPath = z.string().trim().startsWith("/");

const loginFieldSchema = z.object({
  label: z.string().trim().max(60),
  value: z.string().trim().max(200),
});

const slotRectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.05).max(1),
    height: z.number().min(0.05).max(1),
  })
  .refine((slot) => slot.x + slot.width <= 1.001 && slot.y + slot.height <= 1.001, {
    message: "窗口必须落在屏幕范围内",
  });

export const siteDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: httpUrl,
  loginPath: localPath,
  authCheckPath: pathValue.optional(),
  /** Body substring that reads as "signed out" on a 200 response. */
  authCheckSignedOut: z.string().trim().min(1).max(200).optional(),
  defaultEngineId: z.string().optional(),
  autoSubmit: z.boolean().optional(),
  tagIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  // Capped so a paste of the wrong thing cannot be stored as a "password"; no
  // minimum, because a site may genuinely use a short one.
  password: z.string().max(512).optional(),
  clearSitePassword: z.boolean().optional(),
});

export const tagDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(40),
  color: z.enum(["amber", "teal", "violet", "rose", "blue", "slate"]),
});

export const identityDraftSchema = z.object({
  id: z.string().optional(),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  username: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(60),
  color: z.enum(["amber", "teal", "violet", "rose", "blue", "slate"]),
  engineId: z.string().optional(),
  startPath: pathValue.optional(),
  passwordMode: z.enum(["inherit", "custom", "reference"]),
  credentialFrom: z.string().min(1).optional(),
  password: z.string().max(500).optional(),
  captureToken: z.string().min(1).max(80).optional(),
  extraFields: z.array(loginFieldSchema).max(6).optional(),
  tagIds: z.array(z.string().min(1).max(64)).max(20).optional(),
  note: z.string().max(1000).optional(),
});

export const viewDraftSchema = z.object({
  id: z.string().optional(),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  identityIds: z.array(z.string().min(1)).min(1).max(8),
  layoutId: z.string().min(1).max(64),
  slotAssignments: z.record(z.string(), z.number().int().min(0).max(15)),
  paths: z.record(z.string(), pathValue),
  tagIds: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const layoutPresetDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  slots: z.array(slotRectSchema).min(1).max(12),
});

const flowTargetShape = {
  selector: z.string().max(500).optional(),
  label: z.string().max(120).optional(),
  text: z.string().max(200).optional(),
  role: z.string().max(40).optional(),
  exact: z.boolean().optional(),
};

/**
 * One flow step.
 *
 * The shape is deliberately flat: a discriminated union of eight variants would
 * read better in code and be worse for the one consumer that matters — a model
 * writing these steps from a tool schema. Every field is optional here and the
 * cross-field rules live in `validateFlow`, so a missing `value` produces
 * "第 2 步（fill）需要 value" instead of a zod path nobody can act on.
 */
export const flowStepSchema = z.object({
  action: z.enum(["navigate", "fill", "click", "select", "press", "login", "wait", "read"]),
  ...flowTargetShape,
  note: z.string().max(200).optional(),
  value: z.string().max(4000).optional(),
  url: z.string().max(2000).optional(),
  option: z.string().max(200).optional(),
  key: z.string().max(20).optional(),
  condition: z.enum(["visible", "hidden", "text", "url", "value"]).optional(),
  expect: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
  optional: z.boolean().optional(),
  as: z.string().max(60).optional(),
});

export const flowParamSchema = z.object({
  name: z.string().trim().min(1).max(60),
  label: z.string().trim().min(1).max(80),
  required: z.boolean().optional(),
  secret: z.boolean().optional(),
  default: z.string().max(2000).optional(),
  description: z.string().max(300).optional(),
});

export const flowDraftSchema = z.object({
  id: z.string().optional(),
  siteId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(1000).optional(),
  params: z.array(flowParamSchema).max(20).optional(),
  steps: z.array(flowStepSchema).min(1).max(100),
});

/**
 * A bookmark is a name and an address.
 *
 * The address is left permissive here — a bare `example.com` is what people
 * paste — and normalised in `saveBookmark`, which is also where the http(s)
 * rule lives for every other caller.
 */
export const bookmarkDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().max(120),
  url: z.string().trim().min(1).max(2000),
  // Empty string means "unfiled", which is the same as omitting it.
  folderId: z.string().trim().max(80).optional(),
});

export const bookmarkFolderDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  // Empty string means "top level", which is the same as omitting it.
  parentId: z.string().trim().max(80).optional(),
});

export const settingsPatchSchema = z.object({
  theme: z.enum(["dark", "light", "system"]).optional(),
  locale: z.enum(["zh", "en"]).optional(),
  lastSiteId: z.string().optional(),
  lastView: z.enum(["browser", "sites", "identities", "views", "flows", "tags"]).optional(),
  lastViewId: z.string().optional(),
  restoreLastView: z.boolean().optional(),
  overlayEnabled: z.boolean().optional(),
  headlessCheckUa: z.enum(["desktop", "headless"]).optional(),
  focusLabelEnabled: z.boolean().optional(),
  launchIntervalMs: z.number().int().min(0).max(5000).optional(),
  layout: z.string().min(1).max(64).optional(),
  launchTarget: z.enum(["embedded", "external"]).optional(),
  defaultEngineId: z.string().optional(),
  autoFillOnLaunch: z.boolean().optional(),
  autoSubmitLogin: z.boolean().optional(),
  browserZoom: z.number().int().min(50).max(200).optional(),
  /**
   * Only http(s) templates with `%s` are accepted. A custom engine is stored
   * data that later becomes a navigation target, so the shape is checked at the
   * write boundary rather than when it is used.
   */
  searchEngineId: z.string().min(1).max(64).optional(),
  customSearchEngines: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().min(1).max(40),
        urlTemplate: z
          .string()
          .min(1)
          .max(1000)
          .refine((value) => /^https?:\/\//i.test(value) && value.includes("%s")),
      }),
    )
    .max(20)
    .optional(),
  /**
   * Preset id, not a URL. The new-tab surface must paint before any fetch, so
   * the set is closed and validated here; an unknown id falls back to the
   * default at render time rather than breaking the page.
   */
  newTabBackground: z.string().min(1).max(32).optional(),
  newTabBookmarks: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  onboardingVersion: z.number().int().min(0).max(999).optional(),
  guideVersion: z.number().int().min(0).max(999).optional(),
  autoCheckUpdates: z.boolean().optional(),
  dismissedUpdateVersion: z.string().max(32).optional(),
  proxyMode: z.enum(["system", "off", "manual"]).optional(),
  /**
   * Validated when saved, while the user is still looking at the field, rather
   * than at startup where an unusable value would silently do nothing. A
   * trailing slash is accepted because that is what people paste.
   */
  proxyUrl: z
    .string()
    .trim()
    .max(256)
    .refine((value) => value === "" || /^(https?|socks[45]?):\/\/[^\s/]+\/?$/i.test(value), {
      message: "代理地址形如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080",
    })
    .optional(),
  proxyBypass: z.string().max(512).optional(),
});

export const passwordOwnerSchema = z.object({
  kind: z.enum(["site", "identity"]),
  id: z.string().min(1),
});
