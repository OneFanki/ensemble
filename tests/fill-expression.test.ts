import { buildFillExpression } from "@core/cdp/login";
import { describe, expect, it } from "vitest";

describe("buildFillExpression", () => {
  it("embeds extra fields as JSON data, not as code", () => {
    const expression = buildFillExpression({
      username: "admin",
      password: "s3cret",
      submit: false,
      extraFields: [{ label: '租户名 "quoted"', value: "line\nbreak" }],
    });

    expect(expression).toContain(JSON.stringify('租户名 "quoted"'));
    expect(expression).toContain(JSON.stringify("line\nbreak"));
    expect(expression).toContain("filledExtra");
    expect(expression).toContain("missingExtra");
    expect(expression).toContain("unmatchedInputs");
  });

  it("marks extra inputs as used before picking the username field", () => {
    const expression = buildFillExpression({
      username: "admin",
      password: "pw",
      submit: true,
      extraFields: [{ label: "租户名", value: "acme" }],
    });

    // The extra-field loop must run first and register the element it filled,
    // otherwise a tenant input can be mistaken for the username input.
    expect(expression.indexOf("for (const field of")).toBeLessThan(
      expression.indexOf("const usernameField"),
    );
    expect(expression).toContain("used.add(target)");
  });

  it("omits the extra-field loop when nothing is configured", () => {
    const expression = buildFillExpression({
      username: "admin",
      password: "pw",
      submit: false,
    });
    expect(expression).toContain("for (const field of [])");
  });
});
