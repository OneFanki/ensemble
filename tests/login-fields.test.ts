import { normalizeFieldLabel, resolveLoginFields } from "@core/login-fields";
import { describe, expect, it } from "vitest";

describe("login field resolution", () => {
  it("normalizes whitespace and case for matching", () => {
    expect(normalizeFieldLabel("  租户 名 ")).toBe("租户名");
    expect(normalizeFieldLabel("Tenant Code")).toBe("tenantcode");
  });

  it("keeps the account's own fields", () => {
    const fields = resolveLoginFields({ extraFields: [{ label: "租户名", value: "acme" }] });
    expect(fields).toEqual([{ label: "租户名", value: "acme" }]);
  });

  it("trims the label and value it hands to the page", () => {
    const fields = resolveLoginFields({ extraFields: [{ label: " 租户 名 ", value: " beta " }] });
    expect(fields).toEqual([{ label: "租户 名", value: "beta" }]);
  });

  it("drops a row whose value is empty", () => {
    // The form leaves a blank row behind while typing, and clearing a value means
    // "no such field" — sending an empty string would erase whatever the page or
    // a previous fill put there.
    const fields = resolveLoginFields({
      extraFields: [
        { label: "租户名", value: "  " },
        { label: "公司码", value: "shenzhen" },
      ],
    });
    expect(fields).toEqual([{ label: "公司码", value: "shenzhen" }]);
  });

  it("ignores rows without a label", () => {
    const fields = resolveLoginFields({
      extraFields: [{ label: "  ", value: "orphan" }],
    });
    expect(fields).toEqual([]);
  });

  it("keeps only the first row for a repeated label", () => {
    // Two rows with the same normalized label would produce two writes to the
    // same input; the first one is the one the user sees first.
    const fields = resolveLoginFields({
      extraFields: [
        { label: "租户名", value: "acme" },
        { label: " 租户 名 ", value: "beta" },
      ],
    });
    expect(fields).toEqual([{ label: "租户名", value: "acme" }]);
  });

  it("returns nothing for an account with no fields", () => {
    expect(resolveLoginFields({})).toEqual([]);
  });
});
