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

export const environmentDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: httpUrl,
  loginPath: localPath,
  authCheckPath: pathValue.optional(),
  kind: z.enum(["local", "staging", "prod"]),
  defaultEngineId: z.string().optional(),
  autoSubmit: z.boolean(),
  extraFields: z.array(loginFieldSchema).max(6).optional(),
});

export const identityDraftSchema = z.object({
  id: z.string().optional(),
  environmentId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  username: z.string().trim().min(1).max(200),
  role: z.string().trim().min(1).max(60),
  color: z.enum(["amber", "teal", "violet", "rose", "blue", "slate"]),
  engineId: z.string().optional(),
  startPath: pathValue.optional(),
  passwordMode: z.enum(["inherit", "custom"]),
  password: z.string().max(500).optional(),
  extraFields: z.array(loginFieldSchema).max(6).optional(),
  note: z.string().max(1000).optional(),
});

export const sceneDraftSchema = z.object({
  id: z.string().optional(),
  environmentId: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  identityIds: z.array(z.string().min(1)).min(1).max(8),
  layout: z.enum(["1x1", "2x1", "2x2", "3x1"]),
  paths: z.record(z.string(), pathValue),
});

export const settingsPatchSchema = z.object({
  theme: z.enum(["dark", "light", "system"]).optional(),
  locale: z.enum(["zh", "en"]).optional(),
  lastEnvironmentId: z.string().optional(),
  lastView: z.enum(["identities", "scenes"]).optional(),
  layout: z.enum(["1x1", "2x1", "2x2", "3x1"]).optional(),
  autoFillOnLaunch: z.boolean().optional(),
});

export const passwordOwnerSchema = z.object({
  kind: z.enum(["environment", "identity"]),
  id: z.string().min(1),
});
