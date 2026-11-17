import vm from "node:vm";
import type { FlowTarget, WaitCondition } from "@shared/flows";

/**
 * 流程 script 步骤的执行器：脚本在 `node:vm` 的新 context 里编排动作原语。
 *
 * **真实强度必须说清楚。** `node:vm` 不是对抗恶意代码的硬沙箱——Node 官方
 * 文档明确说它不是安全机制。注入 context 的宿主函数（下面的动作原语）携带
 * 宿主原型链，`fn.constructor("return process")()` 这类路径在 vm 里挡不住；
 * 对抗恶意作者的正确闸门是 MCP 权限档位，不是 vm。
 *
 * 这里的威胁模型是「流程作者已持有 run_flow 权限」，所以边界约束的是
 * **能力面**，不是逃逸：context 里没有 require / process / Buffer /
 * setTimeout / fetch，脚本拿到的只有动作原语、本次运行的 vars/params 和
 * 无能力面的内置（JSON、Math 这类）。一个只想写循环与条件的作者，碰不到
 * 文件系统、宿主网络、CDP 与凭据；脚本做不了任何「一步步排普通步骤」
 * 做不到的事。`login` 与 `cdp` 不在原语集合里——前者走凭据路径，后者有
 * 自己的三档白名单，都不经过脚本。
 */

/** 脚本里 console 输出的行数上限；超过就丢弃，编排日志不该淹没流程返回。 */
const FLOW_SCRIPT_LOG_LINES = 200;

/** 单条 console 输出的长度上限。 */
const FLOW_SCRIPT_LOG_CHARS = 500;

/**
 * 脚本里的目标：完整的定位对象，或一个按 CSS selector 处理的字符串。
 * 与工具层「selector 兜底」的用法一致，写循环时短得多。
 */
export type FlowScriptTarget = FlowTarget | string;

/** 脚本能调用的动作原语。签名与对应的流程步骤一一对应，实现由 browser.ts 注入。 */
export interface FlowScriptActions {
  navigate(url: string): Promise<unknown>;
  click(target: FlowScriptTarget): Promise<unknown>;
  fill(target: FlowScriptTarget, value: string): Promise<unknown>;
  select(target: FlowScriptTarget, option: string): Promise<unknown>;
  press(key: string): Promise<unknown>;
  hover(target: FlowScriptTarget): Promise<unknown>;
  scroll(options?: {
    target?: FlowScriptTarget;
    deltaX?: number;
    deltaY?: number;
  }): Promise<unknown>;
  check(target: FlowScriptTarget, desired: boolean): Promise<unknown>;
  setFiles(target: FlowScriptTarget, paths: string[]): Promise<unknown>;
  drag(from: FlowScriptTarget, to: FlowScriptTarget): Promise<unknown>;
  /**
   * 与 wait 步骤一致：text/url 条件给 expect，visible/hidden/value 条件把
   * 目标放在第四个参数。等不到时抛错，除非……没有 optional——编排脚本里
   * 「允许失败」应该写成 try/catch，语言自己就有这个结构。
   */
  wait(
    condition: WaitCondition,
    expect?: string,
    timeoutMs?: number,
    target?: FlowScriptTarget,
  ): Promise<unknown>;
  /** 读元素的文本/值。给了 as 就同时写进 vars（与 read 步骤一致），返回值始终给脚本。 */
  read(target: FlowScriptTarget, as?: string): Promise<string>;
}

export interface FlowScriptInput {
  script: string;
  /** 本次运行积累的变量；read 原语的 as 与脚本自身的赋值都落在这里。 */
  vars: Record<string, string>;
  /** 流程参数：调用方给的输入，运行中不变化。 */
  params: Record<string, string>;
  /** 整个脚本步骤的预算（毫秒），同步与异步两条路都受它约束。 */
  budgetMs: number;
  actions: FlowScriptActions;
}

export interface FlowScriptResult {
  /** 脚本 `return` 的值；`as` 字段把它落进 vars 时用同一个值。 */
  value: unknown;
  /** console 输出，逐行；进流程日志，不进脚本可见的世界。 */
  logs: string[];
}

/**
 * Runs one flow script.
 *
 * 执行形状：脚本包成 `(async () => { ... })()` 在 context 里求值，与预算竞速。
 * 前缀刻意**不换行**——编译错误与运行时错误的行号（`flow-script.js:N`）因此
 * 就是脚本本体的行号，不用减去包装行数。
 */
export async function runFlowScript(input: FlowScriptInput): Promise<FlowScriptResult> {
  const logs: string[] = [];
  /*
   * 超时之后，脚本协程可能还挂在一个原语调用上；等那个原语返回，协程会
   * 带着无人等待的代码「复活」并继续驱动页面。 abort 标志让恢复后的下一次
   * 原语调用立刻失败——流程已经报了超时，页面不该再被动过。
   */
  let aborted = false;
  const guard = (name: string, fn: (...args: never[]) => Promise<unknown>) => {
    return (...args: unknown[]): Promise<unknown> => {
      if (aborted) return Promise.reject(new Error(`脚本已超时，${name} 不再执行`));
      return fn(...(args as never[]));
    };
  };
  const actions = input.actions;

  const context = vm.createContext({
    // 无能力面的内置：脚本要用它们做计算与判断，但它们碰不到宿主资源。
    // Error 一族在清单之外多给了——`throw new Error(...)` 是编排的基本写法，
    // 而 Error 同样没有能力面。
    JSON,
    Math,
    Date,
    String,
    Number,
    Boolean,
    Array,
    Object,
    Promise,
    Error,
    TypeError,
    RangeError,
    RegExp,
    console: {
      log: logTo(logs, "log"),
      info: logTo(logs, "info"),
      warn: logTo(logs, "warn"),
      error: logTo(logs, "error"),
      debug: logTo(logs, "debug"),
    },
    vars: input.vars,
    params: input.params,
    navigate: guard("navigate", actions.navigate),
    click: guard("click", actions.click),
    fill: guard("fill", actions.fill),
    select: guard("select", actions.select),
    press: guard("press", actions.press),
    hover: guard("hover", actions.hover),
    scroll: guard("scroll", actions.scroll),
    check: guard("check", actions.check),
    setFiles: guard("setFiles", actions.setFiles),
    drag: guard("drag", actions.drag),
    wait: guard("wait", actions.wait),
    read: guard("read", actions.read),
  });

  let compiled: vm.Script;
  try {
    compiled = new vm.Script(`(async () => { ${input.script} })()`, {
      filename: "flow-script.js",
    });
  } catch (error) {
    throw wrapScriptError(error, "语法错误");
  }

  // 同步段的死循环由 vm 自己的 timeout 打断（它在循环回边注入检查），
  // 异步段的等待由下面的竞速打断——两条路都要盖住，缺口是哪一个都不行。
  let running: Promise<unknown>;
  try {
    running = compiled.runInContext(context, { timeout: input.budgetMs });
  } catch (error) {
    throw wrapScriptError(error, "脚本超时或执行被中断");
  }

  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      Promise.resolve(running).then(
        (value) => ({ kind: "done" as const, value }),
        (error) => ({ kind: "error" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), input.budgetMs);
      }),
    ]);
    if (outcome.kind === "timeout") {
      aborted = true;
      throw new Error(
        `脚本超时：${Math.round(input.budgetMs)} ms 预算用完，脚本还没跑完（可给本步骤加 timeoutMs 或调大流程 timeoutMs）`,
      );
    }
    if (outcome.kind === "error") {
      throw wrapScriptError(outcome.error, "出错");
    }
    return { value: outcome.value, logs };
  } finally {
    if (timer) clearTimeout(timer);
    // 竞速已经决定结果之后，挂着的协程再 reject 不该炸成 unhandled rejection。
    running.catch(() => {});
  }
}

/** 脚本返回值落进 vars（Record<string, string>）时的字符串化。 */
export function flowScriptValueToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "";
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 把 vm 里的错误翻成人读的一句话；行号取 `flow-script.js:N` 的 N。 */
function wrapScriptError(error: unknown, label: string): Error {
  if (error instanceof Error && /Script execution timed out/.test(error.message)) {
    return new Error("脚本超时：同步代码在预算内没有跑完（检查有没有无终止条件的循环）");
  }
  const source = error instanceof Error ? `${error.stack ?? ""}\n${error.message}` : String(error);
  const line = /flow-script\.js:(\d+)/.exec(source)?.[1];
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`脚本${label}${line ? `（第 ${line} 行）` : ""}：${message}`);
}

function logTo(sink: string[], level: string): (...args: unknown[]) => void {
  return (...args: unknown[]) => {
    if (sink.length >= FLOW_SCRIPT_LOG_LINES) return;
    const text = args.map(formatLogValue).join(" ").slice(0, FLOW_SCRIPT_LOG_CHARS);
    sink.push(`${level}: ${text}`);
  };
}

function formatLogValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
