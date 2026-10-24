/**
 * Flows: a reusable, site-scoped sequence of UI steps.
 * * The AI figures out how to do something once (create a tenant, invite a user,
 * flip a feature flag), saves the sequence here, and the next session runs it in
 * one call instead of rediscovering the page.
 *
 * **Steps, not scripts.** A flow could have been an arbitrary JavaScript body
 * evaluated in the page, and that is what the first draft proposed. It was
 * rejected for three concrete reasons:
 *
 * 1. A script can only dispatch synthetic events. Every other action in this app
 *    goes through `Input.dispatch*`, which is what makes framework handlers fire
 *    and what makes "did the click actually work" mean anything. A flow that
 *    clicks differently from a person would be a second, weaker execution path.
 * 2. A shared workspace full of arbitrary JavaScript needs a code-review gate
 *    before the first run, per client, forever. A declarative step list can only
 *    do what the tools can already do, on its own site, so the security story
 *    stays the one that already exists.
 * 3. A person can read, fix and reorder steps. Nobody edits a stranger's script.
 *
 * What a script would buy is computed logic (read a table cell, derive a value,
 * loop until done). `read` covers the first of those: it captures page text into
 * a variable that later steps interpolate. Anything beyond that belongs in
 * `evaluate_browser_page`, which still exists for one-off work.
 */

export const WAIT_CONDITIONS = ["visible", "hidden", "text", "url", "value"] as const;
export type WaitCondition = (typeof WAIT_CONDITIONS)[number];

export const FLOW_ACTIONS = [
  "navigate",
  "fill",
  "click",
  "select",
  "press",
  "login",
  "wait",
  "read",
] as const;
export type FlowAction = (typeof FLOW_ACTIONS)[number];

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
  /** Text to type; may contain `{{param}}` references. */
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
  /** Milliseconds for `wait`; defaults to 5000. */
  timeoutMs?: number;
  /** A `wait` that is allowed to time out without failing the flow. */
  optional?: boolean;
  /** Variable name a `read` step stores its result under. */
  as?: string;
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
      if (step.condition === "text" || step.condition === "url" || step.condition === "value") {
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
    if (step.action === "read" && step.as) {
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
    default:
      return { action: step.action, target };
  }
}

/** Seconds a flow may run for before the executor gives up. */
export const FLOW_TIMEOUT_MS = 120_000;

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
}
