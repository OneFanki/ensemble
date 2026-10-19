import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/** scrypt parameters chosen for an interactive unlock: ~100ms on a modern laptop. */
export interface KdfParams {
  salt: string;
  n: number;
  r: number;
  p: number;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SALT_BYTES = 16;
const MAX_MEMORY = 96 * 1024 * 1024;

export const DEFAULT_KDF = { n: 32_768, r: 8, p: 1 } as const;

export function createKdfParams(): KdfParams {
  const salt = randomBytes(SALT_BYTES).toString("base64");
  return { salt, ...DEFAULT_KDF };
}

export function deriveKey(password: string, params: KdfParams): Buffer {
  return scryptSync(password.normalize("NFKC"), Buffer.from(params.salt, "base64"), KEY_BYTES, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: MAX_MEMORY,
  });
}

/** AES-256-GCM with a random IV per value; the tag makes tampering detectable. */
export function seal(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm2:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function open(key: Buffer, payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== "gcm2") {
    throw new Error("Unsupported credential payload");
  }
  const iv = Buffer.from(parts[1] as string, "base64");
  const tag = Buffer.from(parts[2] as string, "base64");
  const ciphertext = Buffer.from(parts[3] as string, "base64");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Malformed credential payload");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function timingSafeEqualText(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isSealedPayload(payload: string): boolean {
  return payload.startsWith("gcm2:");
}
