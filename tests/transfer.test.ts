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
  const environment = service.saveEnvironment({
    name: "订单服务-测试环境",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    autoSubmit: true,
    extraFields: [{ label: "租户名", value: "acme" }],
  });
  service.setPassword({ kind: "environment", id: environment.id }, "env-secret");
  const identity = service.saveIdentity({
    environmentId: environment.id,
    name: "管理员 · 主账号",
    username: "admin",
    role: "admin",
    color: "amber",
    passwordMode: "inherit",
    startPath: "/",
  });
  const scene = service.saveScene({
    environmentId: environment.id,
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
  return { environment, identity, scene };
}

describe("workspace export", () => {
  it("exports workspace data without secrets by default", () => {
    const { identity } = seed();
    const { file, counts, secretsIncluded } = service.exportWorkspace();
    expect(file.format).toBe(EXPORT_FORMAT);
    expect(secretsIncluded).toBe(false);
    expect(file.secrets).toBeUndefined();
    expect(counts).toEqual({ environments: 1, identities: 1, scenes: 1, layoutPresets: 1 });
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
    expect(parsed.scenes[0]?.slotAssignments).toBeTruthy();
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
    expect(snapshot.environments).toHaveLength(1);
    expect(snapshot.identities).toHaveLength(1);
    expect(snapshot.scenes).toHaveLength(1);
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
    expect(service.snapshot().environments).toHaveLength(0);
  });

  it("updates entries with the same id instead of duplicating them", () => {
    const { environment } = seed();
    const { file } = service.exportWorkspace();
    file.environments[0] = { ...file.environments[0]!, name: "改名后的环境" };
    const result = service.importWorkspace(parseExportFile(JSON.parse(JSON.stringify(file))));
    expect(result.updated).toBeGreaterThan(0);
    expect(service.snapshot().environments).toHaveLength(1);
    expect(service.snapshot().environments[0]?.name).toBe("改名后的环境");
    expect(service.snapshot().environments[0]?.id).toBe(environment.id);
  });

  it("skips identities whose environment is missing from the file", () => {
    seed();
    const { file } = service.exportWorkspace();
    const identity = file.identities[0]!;
    const orphan = {
      ...file,
      environments: [],
      scenes: [],
      identities: [{ ...identity, id: "orphan", environmentId: "missing-env" }],
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
    expect(() => parseExportFile({ format: EXPORT_FORMAT, version: 99, environments: [] })).toThrow(
      /版本/,
    );
  });

  it("requires environments to be present", () => {
    expect(() => parseExportFile({ format: EXPORT_FORMAT, version: 1 })).toThrow(/environments/);
  });
});
