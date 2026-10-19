export interface LoginFillInput {
  username: string;
  password: string;
  submit: boolean;
}

/**
 * Builds a page-side script that fills the login form.
 * Values are JSON encoded so quotes/newlines cannot break out of the script.
 * The password never leaves the main process except inside this expression.
 */
export function buildFillExpression(input: LoginFillInput): string {
  const username = JSON.stringify(input.username);
  const password = JSON.stringify(input.password);
  const submit = input.submit ? "true" : "false";

  return `(() => {
    const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const roots = [document];
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        if (frame.contentDocument) roots.push(frame.contentDocument);
      } catch {}
    }
    const queryAll = (selector) => roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));
    const passwordField = queryAll('input[type="password"]').find(visible);
    if (!passwordField) return { ok: false, reason: "password-field-not-found" };

    const doc = passwordField.ownerDocument;
    const view = doc.defaultView;
    const setValue = (el, value) => {
      const proto = view ? view.HTMLInputElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor && descriptor.set) descriptor.set.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const form = passwordField.form;
    const scope = form || doc;
    const inputs = Array.from(scope.querySelectorAll("input")).filter(visible);
    const passwordIndex = inputs.indexOf(passwordField);
    const beforePassword = passwordIndex >= 0 ? inputs.slice(0, passwordIndex) : inputs;
    const usernameField =
      beforePassword.find((el) => {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        if (!["text", "email", "tel", ""].includes(type)) return false;
        const hint = [el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute("aria-label")]
          .filter(Boolean)
          .join(" ");
        return /user|email|login|account|phone|mobile|账号|用户|邮箱|手机/i.test(hint);
      }) || beforePassword.find((el) => {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        return ["text", "email", "tel", ""].includes(type) && !el.disabled && !el.readOnly;
      });

    if (usernameField) setValue(usernameField, ${username});
    setValue(passwordField, ${password});
    passwordField.focus();

    let submitted = false;
    if (${submit}) {
      if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
        submitted = true;
      } else if (form) {
        form.submit();
        submitted = true;
      } else {
        const button = Array.from(scope.querySelectorAll('button, input[type="submit"]')).find(visible);
        if (button) {
          button.click();
          submitted = true;
        }
      }
    }

    return { ok: true, filledUsername: Boolean(usernameField), submitted };
  })()`;
}

export function buildAuthCheckExpression(checkPath: string): string {
  const target = JSON.stringify(checkPath);
  return `(async () => {
    try {
      const response = await fetch(${target}, {
        credentials: "include",
        redirect: "follow",
        headers: { accept: "application/json" }
      });
      return { status: response.status, ok: response.ok, url: response.url };
    } catch (error) {
      return { status: 0, ok: false, error: String(error) };
    }
  })()`;
}
