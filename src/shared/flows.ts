/**
 * Flows: a reusable, site-scoped sequence of UI steps.
 * * The AI figures out how to do something once (create a tenant, invite a user,
 * flip a feature flag), saves the sequence here, and the next session runs it in
 * one call instead of rediscovering the page.
 *
 * **动作层是步骤，编排层才是脚本。** 两者是分开的两件事：
 *
 * 1. 每个动作都走 `Input.dispatch*` 这条真实输入管线，这是「点击真的生效了」
 *    有意义的原因。第一稿曾把整个流程设计成一段在页面里求值的 JS，被否掉：
 *    合成事件触发不了框架处理器，那等于多出一条更弱的执行路径。
 * 2. 编排（循环、条件、从读到的值推导下一步）曾经只能靠把步骤铺平来表达，
 *    后来以 `script` 步骤放开：脚本在 `node:vm` 里跑，能调用的只有动作原语，
 *    **能力边界 = 工具集合**——脚本做不了任何「直接一步步排」做不到的事，
 *    也没有 require/process/网络/凭据。执行器见
 *    `src/main/embedded/flow-script.ts`。
 * 3. 声明式步骤人能读、能改、能重排；script 步骤是编排者的工具，出现在
 *    流程里时也应当一眼看出它编排了哪几个原语。
 */

/**
 * `network-idle` joins the DOM conditions because a step is written as intent:
 * "wait until the save finished" is a request-activity fact, and the model
 * should not have to know which module answers it. `load` and `response` are
 * the same kind of fact — `load` about the document's lifecycle, `response`
 * about one specific request having come back.
 */
export const WAIT_CONDITIONS = [
  "visible",
  "hidden",
  "text",
  "url",
  "value",
  "network-idle",
  "load",
  "response",
] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];

/**
 * `cdp` is the escape hatch, and it is the only action that runs a command
 * nobody wrapped.
 *
 * Everything else here goes through an input pipeline or a purpose-built
 * helper, which is what makes "the page saw a real click" true. A raw command
 * can bypass that, so it is gated by a tier list (`core/cdp/flow-whitelist.ts`)
 * and meant for the cases the wrappers genuinely cannot express — setting a file
 * input, answering a dialog. Using it more than twice in one flow is the signal
 * that an action is missing from the wrappers.
 */
export const FLOW_ACTIONS = [
  "navigate",
  "fill",
  "click",
  "select",
  "press",
  "login",
  "wait",
  "read",
  /**
   * 编排层：一段在 `node:vm` 里跑的 JS，调用动作原语完成循环与条件。
   * 不暴露 `login`（走凭据路径）与 `cdp`（逃生口有自己的白名单与闸门）。
   */
  "script",
  "cdp",
] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];

/**
 * script 步骤的脚本长度上限。
 *
 * 编排脚本只需要循环与条件，写不到一万字符；上限挡的是把整个抓取逻辑塞进
 * 一个步骤。schema 层用同一个常量，两边不会各说各话。
 */
export const FLOW_SCRIPT_MAX_CHARS = 10_000;

/** Keys the page inspector understands when a step needs a target. */
export interface FlowTarget {
  selector?: string;
  label?: string;
  text?: string;
  role?: string;
  exact?: boolean;
}

export interface FlowStep extends FlowTarget {
  action: FlowAction;
  /** Shown in the UI and to the AI instead of re-deriving one from the fields. */
  note?: string;
  /** Text to type; may contain `{{param}}` references. For `script`, the JS body itself. */
  value?: string;
  /** Absolute http(s) address, or a path resolved against the flow's site. */
  url?: string;
  /** Option text for a `select` step. */
  option?: string;
  /** Key name for a `press` step: Enter, Escape, Tab, arrows, Backspace, Delete. */
  key?: string;
  /** Condition for `wait`. */
  condition?: WaitCondition;
  /** Text compared by a `wait` step. */
  expect?: string;
  /** Milliseconds for `wait`; defaults to 5000. For `script`, the whole body's budget. */
  timeoutMs?: number;
  /** A `wait` that is allowed to time out without failing the flow. */
  optional?: boolean;
  /** Variable name a `read` or `script` step stores its result under. */
  as?: string;
  /**
   * CDP method name for a `cdp` step, e.g. `DOM.setFileInputFiles`.
   *
   * Checked against the tier list at run time, not at save time: the setting
   * that unlocks the optional tier can change between the two, and a flow saved
   * while it was on must still fail honestly when it is off.
   */
  method?: string;
  /** Parameters passed through verbatim. Not interpolated into numbers. */
  params?: Record<string, unknown>;
}

export interface FlowParam {
  /** Identifier used in `{{name}}`. */
  name: string;
  /** What the field means, shown when a person runs the flow. */
  label: string;
  required?: boolean;
  /** Masked in the audit log and rendered as a password input. */
  secret?: boolean;
  default?: string;
  description?: string;
}

export interface Flow {
  id: string;
  siteId: string;
  name: string;
  description: string;
  params: FlowParam[];
  steps: FlowStep[];
  createdAt: string;
  updatedAt: string;
}

export interface FlowDraft {
  id?: string;
  siteId: string;
  name: string;
  description?: string;
  params?: FlowParam[];
  steps: FlowStep[];
}

const PRESS_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  " ",
] as const;

export const FLOW_KEYS = PRESS_KEYS;

const VARIABLE = /^\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

/** Replaces `{{name}}` with values. Unknown names are an error, not an empty string. */
export function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`流程里引用了未定义的变量：${name}`);
    return value;
  });
}

/** Runs interpolation over every string field of a step. */
export function interpolateStep(step: FlowStep, vars: Record<string, string>): FlowStep {
  const out: FlowStep = { ...step };
  for (const key of ["value", "url", "option", "expect", "label", "text", "selector"] as const) {
    const current = out[key];
    if (typeof current === "string") out[key] = interpolate(current, vars);
  }
  return out;
}

/**
 * Resolves a flow step's address against the flow's site.
 *
 * 站点往往不装在域名根上（baseUrl 带路径，例如 `…/app`），而步骤写的是
 * 「站点内的位置」，所以 `/` 开头的路径按站点根拼接：`/list` + `…/app`
 * 落在 `…/app/list`，而不是 `new URL` 标准语义给出的 `…/list`。不以 `/`
 * 开头的相对段按 URL 常规解析（相对 base 的目录，`../` 可上溯），绝对
 * 地址原样。
 */
export function resolveFlowUrl(url: string, baseUrl: string): string {
  const target = url.trim();
  if (/^https?:\/\//i.test(target)) return target;
  try {
    if (target.startsWith("/")) {
      const base = new URL(baseUrl);
      const prefix = base.pathname.replace(/\/+$/, "");
      // `new URL` 顺手把拼接结果里的 `.`/`..` 规范化掉，上溯不会逃出语义。
      return new URL(`${base.origin}${prefix}${target}`).toString();
    }
    return new URL(target, baseUrl).toString();
  } catch {
    throw new Error(`无法解析地址：${url}`);
  }
}

/**
 * One line describing what a login step did, so the caller knows what to
 * expect next: a redirect (submitted) or a button still to click.
 */
export function describeLoginOutcome(submitted?: boolean, missingFields?: string[]): string {
  if (missingFields?.length) {
    return `已填入账号密码，缺少字段：${missingFields.join("、")}`;
  }
  return submitted
    ? "已填入并提交，等待跳转"
    : "已填入；站点未开自动提交，需自行点击提交或开 update_site 的 autoSubmit";
}

/**
 * Checks one step in isolation.
 *
 * Every message names the field that is missing rather than saying "invalid
 * step", because these strings end up in front of an AI that has to fix them.
 */
export function validateStep(step: FlowStep, index: number): string[] {
  const problems: string[] = [];
  const at = `第 ${index + 1} 步`;
  const hasTarget = Boolean(step.label || step.selector || step.text || step.role);
  switch (step.action) {
    case "navigate":
      if (!step.url?.trim()) problems.push(`${at}（navigate）需要 url`);
      break;
    case "fill":
      if (!step.label && !step.selector) problems.push(`${at}（fill）需要 label 或 selector`);
      if (step.value === undefined) problems.push(`${at}（fill）需要 value`);
      break;
    case "click":
      if (!hasTarget) problems.push(`${at}（click）需要 label、text、selector 或 role`);
      break;
    case "select":
      if (!step.label && !step.selector) problems.push(`${at}（select）需要 label 或 selector`);
      if (!step.option?.trim()) problems.push(`${at}（select）需要 option`);
      break;
    case "press":
      if (!step.key?.trim()) problems.push(`${at}（press）需要 key`);
      else if (!(PRESS_KEYS as readonly string[]).includes(step.key))
        problems.push(`${at}（press）不支持按键 ${step.key}`);
      break;
    case "login":
      break;
    case "wait":
      if (!step.condition) problems.push(`${at}（wait）需要 condition`);
      if (
        step.condition === "text" ||
        step.condition === "url" ||
        step.condition === "value" ||
        step.condition === "response"
      ) {
        if (!step.expect?.trim()) problems.push(`${at}（wait ${step.condition}）需要 expect`);
      }
      if (
        step.condition === "visible" ||
        step.condition === "hidden" ||
        step.condition === "value"
      ) {
        if (!hasTarget)
          problems.push(`${at}（wait ${step.condition}）需要 label、text 或 selector`);
      }
      break;
    case "read":
      // `text` is allowed here but not on `fill`: reading a paragraph or a
      // heading by the words on it is how a person would describe it, while
      // typing into "the element whose text is X" has no sensible meaning.
      if (!hasTarget) problems.push(`${at}（read）需要 label、text、selector 或 role`);
      if (!step.as?.trim()) problems.push(`${at}（read）需要 as（变量名）`);
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.as))
        problems.push(`${at}（read）的 as 只能是字母、数字与下划线，且不能以数字开头`);
      break;
    case "cdp":
      // The tier is deliberately not checked here: save-time validation would
      // pass for a flow that the current setting cannot run, which is worse than
      // failing at run time with the reason.
      if (!step.method?.trim()) problems.push(`${at}（cdp）需要 method（CDP 命令名）`);
      else if (!/^[A-Z][A-Za-z]+\.[A-Za-z]+$/.test(step.method.trim()))
        problems.push(`${at}（cdp）的 method 要写成 域.方法，例如 DOM.setFileInputFiles`);
      break;
    case "script":
      // 语法在运行时才编译（报错带行号）；这里只挡空脚本与超长脚本。
      if (!step.value?.trim()) problems.push(`${at}（script）需要 value（脚本内容）`);
      else if (step.value.length > FLOW_SCRIPT_MAX_CHARS)
        problems.push(
          `${at}（script）的 value 超过 ${FLOW_SCRIPT_MAX_CHARS} 字符（当前 ${step.value.length}）`,
        );
      if (step.as && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.as))
        problems.push(`${at}（script）的 as 只能是字母、数字与下划线，且不能以数字开头`);
      break;
    default:
      problems.push(`${at} 的动作 ${String(step.action)} 不认识`);
  }
  return problems;
}

/**
 * Validates the whole definition.
 *
 * Variables are collected in order as steps define them, so a `{{value}}` may
 * only refer to a parameter or to something an earlier `read` captured. Catching
 * this at save time is the difference between a clear message now and a run that
 * fails halfway after touching the page.
 */
export function validateFlow(input: { params: FlowParam[]; steps: FlowStep[] }): string[] {
  const problems: string[] = [];
  if (input.steps.length === 0) problems.push("流程至少要有一步");

  const known = new Set<string>();
  for (const param of input.params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(param.name)) {
      problems.push(`参数名 ${param.name} 只能是字母、数字与下划线`);
      continue;
    }
    if (known.has(param.name)) problems.push(`参数名 ${param.name} 重复`);
    known.add(param.name);
  }

  input.steps.forEach((step, index) => {
    problems.push(...validateStep(step, index));
    const referenced = [step.value, step.url, step.option, step.expect]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => [...value.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)])
      .map((match) => match[1] as string);
    for (const name of referenced) {
      if (!known.has(name)) {
        problems.push(`第 ${index + 1} 步引用了未定义的变量 {{${name}}}`);
      }
    }
    if ((step.action === "read" || step.action === "script") && step.as) {
      if (!VARIABLE.test(`{{${step.as}}}`) && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(step.as)) {
        problems.push(`第 ${index + 1} 步的变量名 ${step.as} 不合法`);
      }
      known.add(step.as);
    }
  });
  return problems;
}

/** Values a run starts with: declared defaults, overridden by the caller. */
export function resolveParams(
  params: FlowParam[],
  provided: Record<string, string> = {},
): { values: Record<string, string>; secretNames: string[] } {
  const declared = new Set(params.map((param) => param.name));
  const unknown = Object.keys(provided).filter((name) => !declared.has(name));
  if (unknown.length > 0) {
    // A typo in a parameter name would otherwise silently fall back to its
    // default, which is exactly the kind of quiet wrongness this file avoids.
    throw new Error(`未声明的参数：${unknown.join("、")}`);
  }
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const param of params) {
    const value = provided[param.name] ?? param.default ?? "";
    if (value === "" && param.required) missing.push(param.label || param.name);
    values[param.name] = value;
  }
  if (missing.length > 0) throw new Error(`缺少参数：${missing.join("、")}`);
  return {
    values,
    secretNames: params.filter((param) => param.secret).map((param) => param.name),
  };
}

/** One line describing a step, for the list in the UI and for tool output. */
export interface StepSummary {
  action: FlowAction;
  target: string;
  detail?: string;
}

export function summarizeStep(step: FlowStep): StepSummary {
  const target =
    step.label ?? step.text ?? step.selector ?? step.role ?? step.url ?? step.key ?? "";
  switch (step.action) {
    case "navigate":
      return { action: step.action, target: step.url ?? "" };
    case "fill":
      return { action: step.action, target, detail: step.value };
    case "select":
      return { action: step.action, target, detail: step.option };
    case "click":
      return { action: step.action, target };
    case "press":
      return { action: step.action, target: step.key ?? "" };
    case "login":
      return { action: step.action, target: "" };
    case "wait":
      return {
        action: step.action,
        target,
        detail: step.expect ?? step.condition,
      };
    case "read":
      // The arrow matters: the value leaves the page and lands in a variable,
      // and a bare name beside "read" looks like the variable is the source.
      return { action: step.action, target, detail: step.as ? `→ ${step.as}` : undefined };
    case "cdp":
      return { action: step.action, target: step.method ?? "", detail: "原始 CDP" };
    case "script": {
      // 摘要只回答「这是多大的编排、结果落在哪」；脚本本体在编辑器里看。
      const lines = step.value ? step.value.trim().split("\n").length : 0;
      return {
        action: step.action,
        target: "",
        detail: [lines > 0 ? `${lines} 行脚本` : undefined, step.as ? `→ ${step.as}` : undefined]
          .filter(Boolean)
          .join(" ") || undefined,
      };
    }
    default:
      return { action: step.action, target };
  }
}

/**
 * How long a flow may run before the executor gives up, when the caller says
 * nothing.
 *
 * The default stays at two minutes because that covers the ordinary
 * create-an-account flow. It is no longer a *ceiling*: a flow that uploads a
 * large file or imports a batch legitimately runs longer, and the old hardcoded
 * value made those fail while the work carried on in the background — the caller
 * got a timeout for something that had actually succeeded.
 */
export const FLOW_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * The longest a caller may ask for.
 *
 * Ten minutes: past this a flow is a batch job, and a tool call that blocks for
 * that long is the wrong shape — the caller should chunk it or watch with
 * `wait_browser`. Bounded rather than unbounded so a typo in `timeoutMs` cannot
 * hold a tab for an hour.
 */
export const FLOW_TIMEOUT_MAX_MS = 600_000;

/** Clamps a caller's request into the supported range. */
export function clampFlowTimeout(requested: unknown): number {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return FLOW_TIMEOUT_DEFAULT_MS;
  return Math.min(Math.max(Math.trunc(value), 1_000), FLOW_TIMEOUT_MAX_MS);
}

/** One step's outcome, as reported back to the UI and to an AI caller. */
export interface FlowStepResult {
  index: number;
  action: FlowAction;
  ok: boolean;
  /** Details such as the matched option or the value a `read` captured. */
  detail?: string;
  /** True when a failure was allowed and the run continued. */
  optional?: boolean;
}

export interface FlowRunResult {
  ok: boolean;
  /** Index of the step that stopped the run, when `ok` is false. */
  failedAt?: number;
  reason?: string;
  steps: FlowStepResult[];
  /** Variables captured by `read` steps, so an AI can reuse them (e.g. a new id). */
  vars?: Record<string, string>;
  /**
   * Every raw CDP command the run issued, in order.
   *
   * Present only when a `cdp` step ran. The count is the useful part: more than
   * two almost always means an action is missing from the wrappers, and `note`
   * says so rather than leaving the caller to notice.
   */
  rawCdp?: string[];
  /** A one-line remark about the run as a whole; currently only that count. */
  note?: string;
}
