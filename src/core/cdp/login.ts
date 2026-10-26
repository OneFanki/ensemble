export interface LoginFieldInput {
  label: string;
  value: string;
}

export interface LoginFillInput {
  username: string;
  password: string;
  submit: boolean;
  /** Fields beyond username/password, matched by their on-page label text. */
  extraFields?: LoginFieldInput[];
}

export interface FillOutcome {
  ok: boolean;
  reason?: string;
  filledUsername: boolean;
  submitted: boolean;
  /** Labels from extraFields that were written to the page. */
  filledExtra: string[];
  /** Configured labels whose input could not be located. */
  missingExtra: string[];
  /** Visible text inputs the user has not described yet, described by their hint. */
  unmatchedInputs: string[];
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
  const extraFields = JSON.stringify(input.extraFields ?? []);

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
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    };

    const normalize = (value) => String(value || "").toLowerCase().replace(/\\s+/g, "");
    const isTextish = (el) => {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      return ["text", "email", "tel", "search", "number", ""].includes(type);
    };
    const labelText = (el) => {
      const parts = [];
      if (el.labels) for (const label of el.labels) parts.push(label.textContent || "");
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        for (const id of labelledBy.split(/\\s+/)) {
          const node = doc.getElementById(id);
          if (node) parts.push(node.textContent || "");
        }
      }
      const wrapper = el.closest("label");
      if (wrapper) parts.push(wrapper.textContent || "");
      // Component libraries (Naive UI, Ant Design, Element Plus) put the field
      // label in its own div next to — but not wrapping — the control, so none of
      // the three lookups above finds it. Climb the wrapper chain and take the
      // first ancestor that holds a single label-looking element.
      if (parts.join(" ").trim() === "") {
        let scope = el.parentElement;
        for (let depth = 0; scope && depth < 5; depth += 1, scope = scope.parentElement) {
          const labels = Array.from(
            scope.querySelectorAll(
              'label,legend,[role=columnheader],[class*="label"],[class*="Label"],[class*="title"],[class*="Title"]',
            ),
          ).filter((node) => (node.textContent || "").trim());
          if (labels.length === 1) {
            parts.push(labels[0].textContent || "");
            break;
          }
          // More than one label in the scope means it is the form, not a field.
          if (labels.length > 1) break;
        }
      }
      return parts.join(" ");
    };
    const hintOf = (el) =>
      [
        el.name,
        el.id,
        el.getAttribute("autocomplete"),
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        labelText(el),
      ]
        .filter(Boolean)
        .join(" ");
    const describe = (el) => {
      const hint = [el.getAttribute("placeholder"), el.name, el.id, el.getAttribute("aria-label")]
        .filter(Boolean)
        .join(" · ");
      return (hint || el.type || "input").slice(0, 60);
    };

    const form = passwordField.form;
    const scope = form || doc;
    const inputs = Array.from(scope.querySelectorAll("input")).filter(visible);
    const used = new Set([passwordField]);
    const filledExtra = [];
    const missingExtra = [];

    for (const field of ${extraFields}) {
      const needle = normalize(field.label);
      if (!needle) continue;
      const target = inputs.find(
        (el) => !used.has(el) && isTextish(el) && normalize(hintOf(el)).includes(needle),
      );
      if (!target) {
        missingExtra.push(field.label);
        continue;
      }
      setValue(target, field.value);
      used.add(target);
      filledExtra.push(field.label);
    }

    const passwordIndex = inputs.indexOf(passwordField);
    const beforePassword = (passwordIndex >= 0 ? inputs.slice(0, passwordIndex) : inputs).filter(
      (el) => !used.has(el) && isTextish(el) && !el.disabled && !el.readOnly,
    );
    const usernameField =
      beforePassword.find((el) =>
        /user|email|login|account|phone|mobile|账号|用户|邮箱|手机/i.test(hintOf(el)),
      ) || beforePassword[0];

    const unmatchedInputs = beforePassword
      .filter((el) => el !== usernameField && !el.value)
      .map(describe);

    if (usernameField) setValue(usernameField, ${username});
    setValue(passwordField, ${password});
    passwordField.focus();

    let submitted = false;
    if (${submit}) {
      // Click the login button the way a person does, before falling back to
      // submitting the form. Most login pages today are single-page apps: the
      // button is type="button" (or a div) with a JS handler, and there is often
      // no submit handler on the form at all. requestSubmit() on such a page
      // fires a submit event nobody listens to, so the fill reported success
      // while the page just sat there — which read exactly like "autofill filled
      // it but I still have to press the button myself".
      const clickTarget = (() => {
        const formNow = passwordField.form;
        const scopes = formNow ? [formNow, doc] : [doc];
        for (const scopeRoot of scopes) {
          const candidates = Array.from(
            scopeRoot.querySelectorAll('button, input[type="submit"], [role="button"]'),
          ).filter(visible);
          const loginLooking = candidates.find((el) => {
            if (el.disabled) return false;
            const text = [
              el.textContent || "",
              el.getAttribute("value") || "",
              el.getAttribute("aria-label") || "",
              el.getAttribute("title") || "",
            ]
              .join(" ")
              .toLowerCase();
            // Reject the affordances that sit in every login form but do not
            // sign in: forgot-password, show-password, register, cancel.
            if (/forgot|reset|忘记|找回|show|显示|register|注册|sign\\s*up|cancel|取消/.test(text)) {
              return false;
            }
            if (/login|log\\s*in|sign\\s*in|submit|登录|登入|登陆|确定|确认|进入/.test(text)) {
              return true;
            }
            // A submit button inside the login form needs no word to explain
            // itself; it is the form's default action.
            return el.getAttribute("type") === "submit" && Boolean(formNow) && formNow.contains(el);
          });
          if (loginLooking) return loginLooking;
        }
        return undefined;
      })();

      if (clickTarget) {
        clickTarget.click();
        submitted = true;
      } else if (form && typeof form.requestSubmit === "function") {
        form.requestSubmit();
        submitted = true;
      } else if (form) {
        form.submit();
        submitted = true;
      }
    }

    return {
      ok: true,
      filledUsername: Boolean(usernameField),
      submitted,
      filledExtra,
      missingExtra,
      unmatchedInputs,
    };
  })()`;
}

export function buildAuthCheckExpression(checkPath: string): string {
  // Cache-bust on every evaluation: the answer flips with the session (401
  // before sign-in, 2xx after), and a cached pre-login 401 made the auto-login
  // routine wait out its whole deadline believing the sign-in had failed.
  const separator = checkPath.includes("?") ? "&" : "?";
  const target = JSON.stringify(`${checkPath}${separator}_=${Date.now()}`);
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
