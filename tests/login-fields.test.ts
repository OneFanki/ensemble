import { normalizeFieldLabel, resolveLoginFields } from "@core/login-fields";
import { describe, expect, it } from "vitest";

describe("login field resolution", () => {
  it("normalizes whitespace and case for matching", () => {
    expect(normalizeFieldLabel("  租户 名 ")).toBe("租户名");
    expect(normalizeFieldLabel("Tenant Code")).toBe("tenantcode");
  });

  it("uses environment fields when the identity adds none", () => {
    const fields = resolveLoginFields({ extraFields: [{ label: "租户名", value: "acme" }] }, {});
    expect(fields).toEqual([{ label: "租户名", value: "acme" }]);
  });

  it("lets an identity override the same label regardless of spacing or case", () => {
    const fields = resolveLoginFields(
      {
        extraFields: [
          { label: "租户名", value: "acme" },
          { label: "公司码", value: "shenzhen" },
        ],
      },
      { extraFields: [{ label: " 租户 名 ", value: "beta" }] },
    );
    expect(fields).toEqual([
      { label: "租户名", value: "beta" },
      { label: "公司码", value: "shenzhen" },
    ]);
  });

  it("removes an inherited field when the identity value is empty", () => {
    const fields = resolveLoginFields(
      { extraFields: [{ label: "租户名", value: "acme" }] },
      { extraFields: [{ label: "租户名", value: "  " }] },
    );
    expect(fields).toEqual([]);
  });

  it("ignores rows without a label", () => {
    const fields = resolveLoginFields(
      { extraFields: [{ label: "  ", value: "orphan" }] },
      { extraFields: [{ label: "", value: "orphan" }] },
    );
    expect(fields).toEqual([]);
  });

  it("keeps identity-only fields", () => {
    const fields = resolveLoginFields({}, { extraFields: [{ label: "PIN", value: "1234" }] });
    expect(fields).toEqual([{ label: "PIN", value: "1234" }]);
  });
});
