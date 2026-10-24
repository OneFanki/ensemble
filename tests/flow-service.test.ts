import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemorySecretBox } from "@core/credentials/vault";
import { sanitizeWorkspace } from "@core/processes/registry";
import { WorkspaceService } from "@core/service";

let dir: string;
let service: WorkspaceService;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "ensemble-flows-"));
  service = new WorkspaceService({
    userDataDir: dir,
    profileRoot: join(dir, "profiles"),
    platform: "win32",
    secretBox: new MemorySecretBox(),
    appVersion: "test",
  });
  await service.initialize();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function site() {
  return service.saveSite({
    name: "多租户后台",
    baseUrl: "http://localhost:3000",
    loginPath: "/login",
    autoSubmit: false,
  });
}

describe("flows", () => {
  it("saves a flow against a site and lists it", () => {
    const target = site();
    const flow = service.saveFlow({
      siteId: target.id,
      name: "创建租户",
      description: "给测试环境建一个租户",
      params: [{ name: "tenant", label: "租户名", required: true }],
      steps: [
        { action: "navigate", url: "/admin" },
        { action: "fill", label: "租户名称", value: "{{tenant}}" },
        { action: "click", text: "创建租户" },
      ],
    });
    expect(flow.id).toBeTruthy();
    expect(service.snapshot().flows).toHaveLength(1);
    expect(service.snapshot().flows[0]?.steps).toHaveLength(3);
  });

  it("refuses a flow whose step has nothing to act on", () => {
    const target = site();
    expect(() =>
      service.saveFlow({
        siteId: target.id,
        name: "坏流程",
        // The validator's message is what an AI sees; it must name the step.
        steps: [{ action: "fill", label: "租户名称" }],
      }),
    ).toThrow(/第 1 步（fill）需要 value/);
    expect(service.snapshot().flows).toHaveLength(0);
  });

  it("refuses a flow that references an undeclared variable", () => {
    const target = site();
    expect(() =>
      service.saveFlow({
        siteId: target.id,
        name: "引用错字",
        params: [{ name: "tenant", label: "租户名" }],
        steps: [{ action: "fill", label: "租户名称", value: "{{tenat}}" }],
      }),
    ).toThrow(/{{tenat}}/);
  });

  it("refuses a flow on a site that does not exist", () => {
    expect(() =>
      service.saveFlow({ siteId: "nope", name: "x", steps: [{ action: "click", text: "x" }] }),
    ).toThrow();
  });

  it("updates an existing flow in place", () => {
    const target = site();
    const flow = service.saveFlow({
      siteId: target.id,
      name: "创建租户",
      steps: [{ action: "click", text: "创建租户" }],
    });
    const updated = service.saveFlow({
      id: flow.id,
      siteId: target.id,
      name: "创建租户（改）",
      steps: [
        { action: "click", text: "创建租户" },
        { action: "wait", condition: "text", expect: "创建成功" },
      ],
    });
    expect(updated.id).toBe(flow.id);
    expect(service.snapshot().flows).toHaveLength(1);
    expect(updated.steps).toHaveLength(2);
  });

  it("deletes a flow without touching the site", () => {
    const target = site();
    const flow = service.saveFlow({
      siteId: target.id,
      name: "创建租户",
      steps: [{ action: "click", text: "创建租户" }],
    });
    service.deleteFlow(flow.id);
    expect(service.snapshot().flows).toHaveLength(0);
    expect(service.snapshot().sites).toHaveLength(1);
  });

  it("removes a site's flows with the site", () => {
    const target = site();
    service.saveFlow({
      siteId: target.id,
      name: "创建租户",
      steps: [{ action: "click", text: "创建租户" }],
    });
    service.deleteSite(target.id);
    // A flow is steps against one site's UI; without the site it can only fail,
    // so it is not left behind as a dead entry.
    expect(service.snapshot().flows).toHaveLength(0);
  });

  it("survives a reload with its steps intact", async () => {
    const target = site();
    service.saveFlow({
      siteId: target.id,
      name: "创建租户",
      params: [{ name: "tenant", label: "租户名" }],
      steps: [
        { action: "fill", label: "租户名称", value: "{{tenant}}" },
        { action: "wait", condition: "visible", label: "创建租户", timeoutMs: 3000 },
      ],
    });
    const reopened = new WorkspaceService({
      userDataDir: dir,
      profileRoot: join(dir, "profiles"),
      platform: "win32",
      secretBox: new MemorySecretBox(),
      appVersion: "test",
    });
    await reopened.initialize();
    const flow = reopened.snapshot().flows[0];
    expect(flow?.params).toEqual([{ name: "tenant", label: "租户名" }]);
    expect(flow?.steps[1]).toMatchObject({ action: "wait", condition: "visible", timeoutMs: 3000 });
  });
});

describe("flow sanitising", () => {
  const siteId = "11111111-1111-4111-8111-111111111111";

  function workspace(flows: unknown) {
    return sanitizeWorkspace({
      sites: [
        {
          id: siteId,
          name: "站点",
          baseUrl: "http://localhost:3000",
          loginPath: "/login",
          autoSubmit: false,
        },
      ],
      flows,
    } as never);
  }

  it("keeps a well-formed flow", () => {
    const result = workspace([
      {
        id: "f1",
        siteId,
        name: "创建租户",
        steps: [{ action: "click", text: "创建租户" }],
      },
    ]);
    expect(result.flows).toHaveLength(1);
  });

  it("drops a flow whose site is gone", () => {
    const result = workspace([
      { id: "f1", siteId: "gone", name: "x", steps: [{ action: "click", text: "x" }] },
    ]);
    // A hand-edited file must not produce a flow that can only fail at run time.
    expect(result.flows).toHaveLength(0);
  });

  it("drops steps with an action the executor does not implement", () => {
    const result = workspace([
      {
        id: "f1",
        siteId,
        name: "x",
        steps: [{ action: "eval" }, { action: "click", text: "创建租户" }],
      },
    ]);
    expect(result.flows[0]?.steps).toEqual([{ action: "click", text: "创建租户" }]);
  });

  it("clamps a timeout that is out of range", () => {
    const result = workspace([
      {
        id: "f1",
        siteId,
        name: "x",
        steps: [{ action: "wait", condition: "text", expect: "ok", timeoutMs: 9_000_000 }],
      },
    ]);
    expect(result.flows[0]?.steps[0]?.timeoutMs).toBe(120_000);
  });

  it("ignores a flow with no steps at all", () => {
    expect(workspace([{ id: "f1", siteId, name: "x", steps: [] }]).flows).toHaveLength(0);
  });
});
