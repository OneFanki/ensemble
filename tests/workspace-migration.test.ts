import { describe, expect, it } from "vitest";
import { BUILTIN_LAYOUTS, findLayout, resolveSlotAssignments } from "@shared/layouts";
import { emptyWorkspace, sanitizeWorkspace } from "@core/processes/registry";
import type { Scene } from "@shared/types";

const environment = {
  id: "env-1",
  name: "订单服务-测试环境",
  baseUrl: "http://localhost:3000",
  loginPath: "/login",
  autoSubmit: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const identity = {
  id: "id-1",
  environmentId: "env-1",
  name: "管理员 · 主账号",
  username: "admin",
  role: "admin",
  color: "amber",
  passwordMode: "inherit",
  status: "unknown",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const scene = (overrides: Partial<Scene> = {}): Scene => ({
  id: "scene-1",
  environmentId: "env-1",
  name: "权限矩阵",
  identityIds: ["id-1"],
  layoutId: "2x2",
  slotAssignments: {},
  paths: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("sanitizeWorkspace", () => {
  it("returns an empty workspace when the file is missing fields", () => {
    expect(sanitizeWorkspace({})).toEqual(emptyWorkspace());
  });

  it("migrates a scene stored with the old fixed layout key", () => {
    const legacy = {
      ...scene(),
      layoutId: undefined,
      layout: "3x1",
    } as unknown as Scene & { layout: string };
    const result = sanitizeWorkspace({ scenes: [legacy] });
    expect(result.scenes[0]?.layoutId).toBe("3x1");
    expect(result.scenes[0]?.slotAssignments).toEqual({});
  });

  it("drops the retired environment kind field so it cannot come back", () => {
    const result = sanitizeWorkspace({
      environments: [{ ...environment, kind: "local" } as typeof environment],
    });
    expect(result.environments[0]).not.toHaveProperty("kind");
    expect(result.environments[0]?.name).toBe("订单服务-测试环境");
  });

  it("drops non-integer and negative slot assignments", () => {
    const result = sanitizeWorkspace({
      scenes: [
        scene({
          slotAssignments: { "id-1": 1, "id-2": -1, "id-3": 1.5 } as Record<string, number>,
        }),
      ],
    });
    expect(result.scenes[0]?.slotAssignments).toEqual({ "id-1": 1 });
  });

  it("keeps only well-formed custom presets and clamps their slots", () => {
    const result = sanitizeWorkspace({
      layoutPresets: [
        {
          id: "custom-1",
          name: "左大右小",
          builtin: false,
          slots: [{ x: 0.7, y: 0, width: 0.6, height: 1 }],
        },
        { id: "empty", name: "no slots", builtin: false, slots: [] },
        { id: "bad", name: "nope", builtin: false, slots: [{ x: "a" }] },
      ] as never,
    });
    expect(result.layoutPresets).toHaveLength(1);
    expect(result.layoutPresets[0]?.name).toBe("左大右小");
    expect(result.layoutPresets[0]?.slots[0]?.x).toBeLessThanOrEqual(0.4);
  });
});

describe("built-in presets", () => {
  it("exposes a no-layout mode with no slots", () => {
    const free = BUILTIN_LAYOUTS.find((preset) => preset.id === "free");
    expect(free?.slots).toEqual([]);
  });

  it("keeps the classic grids available", () => {
    for (const id of ["1x1", "2x1", "1x2", "2x2", "3x1"]) {
      expect(findLayout(id).slots.length).toBeGreaterThan(0);
    }
  });
});

describe("resolveSlotAssignments", () => {
  const preset = findLayout("2x2");

  it("keeps explicit assignments and fills the rest in member order", () => {
    const result = resolveSlotAssignments(preset, ["a", "b", "c"], { b: 0 });
    expect(result).toEqual({ b: 0, a: 1, c: 2 });
  });

  it("ignores slots that point outside the preset", () => {
    const result = resolveSlotAssignments(preset, ["a", "b"], { a: 9 });
    expect(result).toEqual({ a: 0, b: 1 });
  });

  it("ignores members that are no longer in the scene", () => {
    const result = resolveSlotAssignments(preset, ["a"], { gone: 2 });
    expect(result).toEqual({ a: 0 });
  });

  it("returns no assignments for the no-layout preset", () => {
    expect(resolveSlotAssignments(findLayout("free"), ["a", "b"], { a: 0 })).toEqual({});
  });
});
