import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceService } from "@core/service";
import { MemorySecretBox } from "@core/credentials/vault";
import { EXPORT_FORMAT, parseExportFile } from "@shared/transfer";

let dir: string;
let service: WorkspaceService;

function makeService(): WorkspaceService {
  return new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-transfer-"));
  service = makeService();
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed() {
  const site = service.saveSite({
    name: "订单服务-测试环境",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    autoSubmit: true,
    extraFields: [{ label: "租户名", value: "acme" }],
  });
  service.setPassword({ kind: "site", id: site.id }, "env-secret");
  const identity = service.saveIdentity({
    siteId: site.id,
    name: "管理员 · 主账号",
    username: "admin",
    role: "admin",
    color: "amber",
    passwordMode: "inherit",
    startPath: "/",
  });
  const view = service.saveView({
    siteId: site.id,
    name: "权限矩阵",
    identityIds: [identity.id],
    layoutId: "2x2",
    slotAssignments: { [identity.id]: 1 },
    paths: {},
  });
  service.saveLayoutPreset({
    name: "左大右小",
    slots: [
      { x: 0, y: 0, width: 0.6, height: 1 },
      { x: 0.6, y: 0, width: 0.4, height: 1 },
    ],
  });
  return { site, identity, view };
}

describe("workspace export", () => {
  it("exports workspace data without secrets by default", () => {
    const { identity } = seed();
    const { file, counts, secretsIncluded } = service.exportWorkspace();
    expect(file.format).toBe(EXPORT_FORMAT);
    expect(secretsIncluded).toBe(false);
    expect(file.secrets).toBeUndefined();
    expect(counts).toEqual({ sites: 1, identities: 1, views: 1, flows: 0, layoutPresets: 1 });
    // Session state belongs to this machine and must not travel.
    expect(file.identities[0]?.status).toBe("unknown");
    expect(file.identities[0]?.id).toBe(identity.id);
  });

  it("seals secrets with the supplied passphrase", () => {
    seed();
    const { file, secretsIncluded } = service.exportWorkspace("correct horse battery");
    expect(secretsIncluded).toBe(true);
    expect(file.secrets?.payload.startsWith("gcm2:")).toBe(true);
    // The plaintext password must not appear anywhere in the exported document.
    expect(JSON.stringify(file)).not.toContain("env-secret");
  });

  it("produces a file that parses back through the public validator", () => {
    seed();
    const { file } = service.exportWorkspace("correct horse battery");
    const parsed = parseExportFile(JSON.parse(JSON.stringify(file)));
    expect(parsed.identities).toHaveLength(1);
    expect(parsed.views[0]?.slotAssignments).toBeTruthy();
  });
});

describe("workspace import", () => {
  it("merges a file from another machine into an empty workspace", () => {
    seed();
    const { file } = service.exportWorkspace("correct horse battery");

    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "ensemble-transfer-target-"));
    service = makeService();
    void service.initialize();

    const result = service.importWorkspace(
      parseExportFile(JSON.parse(JSON.stringify(file))),
      "correct horse battery",
    );
    expect(result.added).toBeGreaterThan(0);
    expect(result.importedSecrets).toBe(1);
    const snapshot = service.snapshot();
    expect(snapshot.sites).toHaveLength(1);
    expect(snapshot.identities).toHaveLength(1);
    expect(snapshot.views).toHaveLength(1);
    expect(snapshot.layoutPresets).toHaveLength(1);
  });

  it("rejects a wrong passphrase instead of importing partial data", () => {
    seed();
    const { file } = service.exportWorkspace("correct horse battery");
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "ensemble-transfer-wrong-"));
    service = makeService();
    void service.initialize();
    expect(() =>
      service.importWorkspace(parseExportFile(JSON.parse(JSON.stringify(file))), "wrong"),
    ).toThrow(/口令/);
    expect(service.snapshot().sites).toHaveLength(0);
  });

  it("can be retried with the right passphrase after a wrong one", () => {
    seed();
    const { file } = service.exportWorkspace("correct horse battery");
    rmSync(dir, { recursive: true, force: true });
    dir = mkdtempSync(join(tmpdir(), "ensemble-transfer-retry-"));
    service = makeService();
    void service.initialize();
    const parsed = parseExportFile(JSON.parse(JSON.stringify(file)));

    // The caller keeps the parsed file between attempts, so a failed merge must
    // leave no state behind that blocks the retry.
    expect(() => service.importWorkspace(parsed, "wrong")).toThrow(/口令/);
    const result = service.importWorkspace(parsed, "correct horse battery");
    expect(result.importedSecrets).toBe(1);
    expect(service.snapshot().identities).toHaveLength(1);
  });

  it("updates entries with the same id instead of duplicating them", () => {
    const { site } = seed();
    const { file } = service.exportWorkspace();
    file.sites[0] = { ...file.sites[0]!, name: "改名后的环境" };
    const result = service.importWorkspace(parseExportFile(JSON.parse(JSON.stringify(file))));
    expect(result.updated).toBeGreaterThan(0);
    expect(service.snapshot().sites).toHaveLength(1);
    expect(service.snapshot().sites[0]?.name).toBe("改名后的环境");
    expect(service.snapshot().sites[0]?.id).toBe(site.id);
  });

  it("skips identities whose site is missing from the file", () => {
    seed();
    const { file } = service.exportWorkspace();
    const identity = file.identities[0]!;
    const orphan = {
      ...file,
      sites: [],
      views: [],
      identities: [{ ...identity, id: "orphan", siteId: "missing-env" }],
    };
    const result = service.importWorkspace(parseExportFile(JSON.parse(JSON.stringify(orphan))));
    expect(result.skipped).toBe(1);
    expect(service.snapshot().identities.find((item) => item.id === "orphan")).toBeUndefined();
  });
});

describe("parseExportFile", () => {
  it("rejects files that are not Ensemble exports", () => {
    expect(() => parseExportFile({ format: "something-else" })).toThrow(/Ensemble/);
  });

  it("rejects a version from the future", () => {
    expect(() => parseExportFile({ format: EXPORT_FORMAT, version: 99, sites: [] })).toThrow(
      /版本/,
    );
  });

  it("requires sites to be present", () => {
    expect(() => parseExportFile({ format: EXPORT_FORMAT, version: 1 })).toThrow(/sites/);
  });
});
