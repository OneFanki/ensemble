import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isTrustedUpdateUrl } from "@shared/update";

/**
 * Downloads one release asset and refuses to keep it unless its SHA-256 matches
 * the digest GitHub published for that asset.
 *
 * The checksum is not optional: the file being downloaded is an installer that
 * the app will execute, so a missing digest is treated as "cannot verify" rather
 * than "trust it anyway". Writes go to `<file>.part` first, so an interrupted
 * download can never be mistaken for a complete installer.
 */
export interface DownloadUpdateOptions {
  expectedSha256: string;
  /** Called as bytes arrive; `total` is absent when no content-length was sent. */
  onProgress?: (received: number, total?: number) => void;
  signal?: AbortSignal;
  /**
   * Network implementation. Only tests inject one; production always uses the
   * global fetch, and the URL trust checks run the same way either way.
   */
  fetchImpl?: typeof fetch;
}

export async function downloadUpdateAsset(
  url: string,
  destination: string,
  options: DownloadUpdateOptions,
): Promise<{ bytes: number; sha256: string }> {
  if (!isTrustedUpdateUrl(url)) {
    throw new Error("更新地址不受信任，已停止下载。");
  }
  const expected = options.expectedSha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new Error("该版本没有提供校验值，无法安全下载。");
  }

  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  await rm(partial, { force: true });

  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(url, {
    headers: { accept: "application/octet-stream", "user-agent": "ensemble-updater" },
    redirect: "follow",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  // A redirect can land anywhere; the final URL is what actually gets downloaded.
  if (!isTrustedUpdateUrl(response.url)) {
    throw new Error("更新下载被重定向到不受信任的地址，已停止。");
  }
  if (!response.ok || !response.body) {
    throw new Error(`下载失败：HTTP ${response.status}`);
  }

  const declared = Number(response.headers.get("content-length") ?? "");
  const total = Number.isFinite(declared) && declared > 0 ? declared : undefined;
  const hash = createHash("sha256");
  let received = 0;

  try {
    // Hash and count in a Transform rather than a "data" listener: attaching a
    // listener switches the source to flowing mode, and pipeline would then see
    // an already-drained stream.
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        hash.update(chunk);
        options.onProgress?.(received, total);
        callback(null, chunk);
      },
    });
    const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
    await pipeline(source, counter, createWriteStream(partial, { mode: 0o600 }));
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }

  const actual = hash.digest("hex");
  if (actual !== expected) {
    await rm(partial, { force: true }).catch(() => {});
    throw new Error("下载文件的校验值与发布记录不一致，已删除，未执行安装。");
  }
  if (total !== undefined && received !== total) {
    await rm(partial, { force: true }).catch(() => {});
    throw new Error("下载不完整，已删除，未执行安装。");
  }

  await rename(partial, destination);
  return { bytes: received, sha256: actual };
}
