import { describe, expect, it } from "vitest";
import {
  flowScriptValueToString,
  runFlowScript,
  type FlowScriptActions,
} from "../src/main/embedded/flow-script";

/**
 * script 步骤的执行器。
 *
 * 这里钉住两件事：沙箱给编排脚本的是**什么**（context 里有什么、没有什么、
 * 哪条路真的封不住），以及原语调用与 vars 的行为。测试在纯 Node 下跑，
 * 执行器不 import BrowserManager——动作是注入的假件。
 */

/** 空动作集：除被测试覆盖的键外，每个原语都抛错，漏网调用会当场炸出来。 */
function noActions(): FlowScriptActions {
  const fail = (name: string) => () => Promise.reject(new Error(`unexpected ${name}`));
  return {
    navigate: fail("navigate"),
    click: fail("click"),
    fill: fail("fill"),
    select: fail("select"),
    press: fail("press"),
    hover: fail("hover"),
    scroll: fail("scroll"),
    check: fail("check"),
    setFiles: fail("setFiles"),
    drag: fail("drag"),
    wait: fail("wait"),
    read: fail("read"),
  };
}

function run(script: string, extra: Partial<Parameters<typeof runFlowScript>[0]> = {}) {
  return runFlowScript({
    script,
    vars: {},
    params: {},
    budgetMs: 2_000,
    actions: noActions(),
    ...extra,
  });
}

describe("sandbox surface", () => {
  it("has no process / require / network bindings", async () => {
    // 这些绑定在 context 里不存在。typeof 探测返回 "undefined" 而不是抛错，
    // 因为 typeof 对未声明标识符是安全的——两种行为都断清楚。
    const outcome = await run(
      `return {
         processType: typeof process,
         requireType: typeof require,
         bufferType: typeof Buffer,
         setTimeoutType: typeof setTimeout,
         fetchType: typeof fetch,
       }`,
    );
    expect(outcome.value).toEqual({
      processType: "undefined",
      requireType: "undefined",
      bufferType: "undefined",
      setTimeoutType: "undefined",
      fetchType: "undefined",
    });
  });

  it("a bare reference to process is a ReferenceError inside the context", async () => {
    // typeof 探测之外，真正去用 process 会炸——这决定一个笔误会以什么形状出现。
    await expect(run("return process.platform")).rejects.toThrow(/process is not defined/);
  });

  it("the constructor escape route reaches the host: vm is not a hard sandbox", async () => {
    /*
     * 这是实测行为，不是防御声明：`globalThis.constructor.constructor` 在
     * 当前 Node 上拿到的就是宿主的 Function，用它构造的函数跑在宿主里，
     * `return process` 返回宿主的 process。注入的原语函数
     * （`fill.constructor`）是同一条路。
     *
     * 所以 script 步骤的安全叙事必须诚实：vm 约束的是**能力面**（正常作者
     * 写循环与条件时碰不到 fs/网络/凭据），不是对抗决心逃逸的作者——那由
     * MCP 权限档位管，而且持有 run_flow 权限的调用方本来就有 evaluate 与
     * cdp 工具，逃逸并没有放大他的权限。
     *
     * 断言「拿得到」把这条边界钉进测试：哪天 Node 把这条路封了，这里会
     * 红着提醒把注释、coverage 文档一起改成新的、更硬的结论。
     */
    const outcome = await run(
      "return globalThis.constructor.constructor('return process')().version",
    );
    expect(typeof outcome.value).toBe("string");
    expect(outcome.value).toMatch(/^v\d+\./);
    const viaPrimitive = await run("return typeof fill.constructor('return process')().platform", {
      actions: { ...noActions(), fill: async () => "ok" },
    });
    expect(viaPrimitive.value).toBe("string");
  });
});

describe("primitives", () => {
  it("calls the injected fill in order, once per loop turn", async () => {
    const fills: Array<{ target: unknown; value: string }> = [];
    const actions: FlowScriptActions = {
      ...noActions(),
      fill: async (target, value) => {
        fills.push({ target, value });
        return "ok";
      },
    };
    const outcome = await run(
      `for (let i = 1; i <= 3; i++) {
         await fill({ label: "租户名称" }, "客户 " + i);
       }
       return "done";`,
      { actions },
    );
    expect(fills.map((item) => item.value)).toEqual(["客户 1", "客户 2", "客户 3"]);
    expect(fills[0]?.target).toEqual({ label: "租户名称" });
    expect(outcome.value).toBe("done");
  });

  it("accepts a string target as a CSS selector", async () => {
    const clicks: unknown[] = [];
    const actions: FlowScriptActions = {
      ...noActions(),
      click: async (target) => {
        clicks.push(target);
        return "ok";
      },
    };
    await run(`await click("#submit"); await click({ text: "创建租户" });`, { actions });
    // 字符串与对象目标是同一个原语的两种写法；原语收到的是脚本给的原样。
    expect(clicks).toEqual(["#submit", { text: "创建租户" }]);
  });

  it("a rejected primitive fails the script with that reason", async () => {
    const actions: FlowScriptActions = {
      ...noActions(),
      click: async () => Promise.reject(new Error("无法点击：not-found")),
    };
    await expect(run(`await click("#x")`, { actions })).rejects.toThrow(/无法点击：not-found/);
  });
});

describe("vars and params", () => {
  it("sees earlier reads in vars and the declared params", async () => {
    const outcome = await run(
      `return { fromVars: vars.order, fromParams: params.tenant }`,
      { vars: { order: "ORD-1" }, params: { tenant: "客户 A" } },
    );
    expect(outcome.value).toEqual({ fromVars: "ORD-1", fromParams: "客户 A" });
  });

  it("read with as writes through to the flow's vars", async () => {
    const vars: Record<string, string> = {};
    const actions: FlowScriptActions = {
      ...noActions(),
      read: async (_target, as) => {
        // browser.ts 的 read 原语实现：值进 outcome.value，as 由 runStepAction
        // 落到 vars。假件按同一个契约把 as 写进 vars，验证脚本侧看得到。
        if (as) vars[as] = "ORD-2026-0002";
        return "ORD-2026-0002";
      },
    };
    const outcome = await run(
      `const no = await read({ text: "订单号" }, "order");
       return { no, viaVars: vars.order };`,
      { vars, actions },
    );
    expect(outcome.value).toEqual({ no: "ORD-2026-0002", viaVars: "ORD-2026-0002" });
    expect(vars.order).toBe("ORD-2026-0002");
  });

  it("console output lands in logs, not in the script's world", async () => {
    const outcome = await run(
      `console.log("第一行", { a: 1 });
       console.warn("警告");
       return typeof console.log;`,
    );
    expect(outcome.logs).toEqual(["log: 第一行 {\"a\":1}", "warn: 警告"]);
    expect(outcome.value).toBe("function");
  });
});

describe("timeouts", () => {
  it("interrupts a script hung on a never-settling primitive", async () => {
    const actions: FlowScriptActions = {
      ...noActions(),
      // 永不 resolve 的原语：脚本协程挂在 await 上，只有竞速能结束它。
      wait: () => new Promise(() => {}),
    };
    const started = Date.now();
    await expect(
      run(`await wait("text", "永远不会出现"); return "done";`, { actions, budgetMs: 300 }),
    ).rejects.toThrow(/脚本超时/);
    // 中断发生在预算量级，而不是等到测试自身的 timeout。
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("interrupts a synchronous infinite loop at the vm level", async () => {
    // vm 的 timeout 在循环回边注入检查：同步死循环不等事件循环空闲就被打断。
    await expect(run(`while (true) {}`, { budgetMs: 300 })).rejects.toThrow(
      /脚本超时|没有跑完/,
    );
  });

  it("a primitive called after the timeout refuses instead of driving the page", async () => {
    /*
     * 竞速返回超时后，脚本协程还挂在第一个原语上；等它恢复，下一次原语
     * 调用必须直接失败——流程已经报了超时，页面不该再被动过。
     */
    let resolveFirst: (() => void) | undefined;
    const calls: string[] = [];
    const actions: FlowScriptActions = {
      ...noActions(),
      wait: () =>
        new Promise((resolve) => {
          resolveFirst = () => resolve({ ok: true, waitedMs: 1 } as never);
        }),
      fill: async (_target, value) => {
        calls.push(value);
        return "ok";
      },
    };
    const attempt = run(
      `await wait("text", "x", 10_000); await fill("#i", "不该发生"); return 1;`,
      { actions, budgetMs: 200 },
    );
    await expect(attempt).rejects.toThrow(/脚本超时/);
    resolveFirst?.();
    await new Promise((r) => setTimeout(r, 20));
    expect(calls).toEqual([]);
  });
});

describe("compile errors", () => {
  it("a syntax error reports the line inside the script body", async () => {
    /*
     * 包装前缀刻意不换行，所以 `flow-script.js:2` 就是脚本本体的第 2 行。
     * 坏行放第二行，断言行号对得上——AI 修脚本靠的就是这个数字。
     */
    await expect(run(`const ok = 1;\nconst broken = )))).`)).rejects.toThrow(
      /脚本语法错误.*第 2 行/,
    );
  });

  it("a runtime error reports the line it threw from", async () => {
    await expect(run(`const a = 1;\nthrow new Error("中途失败");`)).rejects.toThrow(
      /脚本出错.*第 2 行.*中途失败/s,
    );
  });
});

describe("value stringification", () => {
  it("maps a script's return value into a vars-friendly string", () => {
    expect(flowScriptValueToString("文本")).toBe("文本");
    expect(flowScriptValueToString(undefined)).toBe("");
    expect(flowScriptValueToString(null)).toBe("");
    expect(flowScriptValueToString(3)).toBe("3");
    expect(flowScriptValueToString({ a: 1 })).toBe('{"a":1}');
    expect(flowScriptValueToString([1, 2])).toBe("[1,2]");
  });
});
