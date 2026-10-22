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
  defaultEngineId: z.string().optional(),
  autoSubmit: z.boolean(),
  extraFields: z.array(loginFieldSchema).max(6).optional(),
  tagIds: z.array(z.string().min(1).max(64)).max(20).optional(),
});

export const siteTagDraftSchema = z.object({
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
  extraFields: z.array(loginFieldSchema).max(6).optional(),
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
});

export const layoutPresetDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(60),
  slots: z.array(slotRectSchema).min(1).max(12),
});

export const settingsPatchSchema = z.object({
  theme: z.enum(["dark", "light", "system"]).optional(),
  locale: z.enum(["zh", "en"]).optional(),
  lastSiteId: z.string().optional(),
  lastView: z.enum(["browser", "sites", "identities", "views"]).optional(),
  lastViewId: z.string().optional(),
  restoreLastView: z.boolean().optional(),
  overlayEnabled: z.boolean().optional(),
  headlessCheckUa: z.enum(["desktop", "headless"]).optional(),
  focusLabelEnabled: z.boolean().optional(),
  launchIntervalMs: z.number().int().min(0).max(5000).optional(),
  layout: z.string().min(1).max(64).optional(),
  autoFillOnLaunch: z.boolean().optional(),
  closeToTray: z.boolean().optional(),
  onboardingVersion: z.number().int().min(0).max(999).optional(),
  autoCheckUpdates: z.boolean().optional(),
  dismissedUpdateVersion: z.string().max(32).optional(),
});

export const passwordOwnerSchema = z.object({
  kind: z.enum(["site", "identity"]),
  id: z.string().min(1),
});
