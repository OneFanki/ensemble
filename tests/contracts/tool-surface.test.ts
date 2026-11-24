import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * MCP 工具面的命名与入参约定。
 *
 * 一次逐工具的审查把这里的每一条都踩到了：同一件事三个名字（开页）、一个名字
 * 两件事（`viewId` 既指容器又指保存的视图）、描述点名的参数在 schema 里并不
 * 存在、对象专属工具有的收 `id` 有的收 `identityId`、`pageId` 在别处都叫
 * `tabId`。单看每一条都像小事，合起来的代价是调用方没法凭直觉猜对任何一处，
 * 只能逐个工具读描述。
 *
 * 行为由 `mcp-browser-tools.test.ts` 与 `mcp-server.test.ts` 守；这里守的是
 * **源码层面一眼能看全的约定**，因为它们只有把全部工具放在一起才看得出来。
 *
 * 解析与 `ai-tools-doc.test.ts` 同一把刀：按 `\n {6}\{\n` 切工具块，对 CRLF
 * 检出不敏感。
 */
const normalise = (text: string): string => text.replace(/\r\n/g, "\n");
const source = normalise(readFileSync(join(process.cwd(), "src/main/mcp/server.ts"), "utf8"));

interface ParsedTool {
  name: string;
  kind: string;
  description: string;
  hidden: boolean;
  properties: string[];
  required: string[];
}

/** 取一个块里 `description:` 与 `kind:` 之间的全部字符串字面量拼成的描述。 */
function descriptionBetween(block: string): string {
  const segment = block.match(/\n {8}description:([\s\S]*?)\n {8}kind:/);
  return segment
    ? [...segment[1]!.matchAll(/"((?:[^"\\])*)"/g)].map((item) => item[1]!).join("")
    : "";
}

const QUOTE = '"';
const BACKSLASH = String.fromCharCode(92);

/**
 * 顶层入参名与必填项：只看 `inputSchema:` 到下一个工具字段之间的那一段。
 *
 * 不按缩进猜——同一个文件里有三种写法：`object({ … })` 单行起头、花括号换行、
 * 以及整段写在一行。按花括号配平取第一层的键，字符串字面量里的括号与逗号
 * 不算（描述里有 `{latitude, longitude, accuracy?}` 这种文本）。
 */
function inputSchemaOf(block: string): { properties: string[]; required: string[] } {
  const start = block.search(/\n {8}inputSchema: /);
  if (start < 0) return { properties: [], required: [] };
  const rest = block.slice(start + 1);
  const end = rest
    .slice(1)
    .search(
      /\n {8}(run|pageTarget|inputTarget|content|recordsPageAction|hidden|argumentAliases|normalizeArguments): /,
    );
  const section = end < 0 ? rest : rest.slice(0, end + 1);
  const open = section.indexOf("{");
  if (open < 0) return { properties: [], required: [] };
  const keys: string[] = [];
  let depth = 0;
  let expectKey = false;
  let closedAt = section.length;
  for (let index = open; index < section.length; index += 1) {
    const char = section.charAt(index);
    // 注释里的英文字母（比如一句说明里的 confirm）不是键。
    if (char === "/" && (section[index + 1] === "/" || section[index + 1] === "*")) {
      const multi = section[index + 1] === "*";
      const stop = multi ? section.indexOf("*/", index + 2) : section.indexOf("\n", index + 2);
      index = stop < 0 ? section.length : stop + (multi ? 1 : 0) - (multi ? 0 : 1);
      continue;
    }
    if (char === QUOTE) {
      // 跳过字符串字面量；只可能出现在值的位置。
      let cursor = index + 1;
      while (cursor < section.length && section[cursor] !== QUOTE) {
        cursor += section[cursor] === BACKSLASH ? 2 : 1;
      }
      index = cursor;
      expectKey = false;
      continue;
    }
    if (char === "{" || char === "[" || char === "(") {
      depth += char === "{" ? 1 : 0;
      expectKey = depth === 1 && char === "{";
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        closedAt = index;
        break;
      }
      expectKey = false;
      continue;
    }
    if (char === "," && depth >= 1) {
      expectKey = depth === 1;
      continue;
    }
    if (expectKey && /[A-Za-z]/.test(char)) {
      const key = /^[A-Za-z][A-Za-z0-9]*(?=\s*:)/.exec(section.slice(index));
      if (key) keys.push(key[0]);
      expectKey = false;
    }
  }
  // 直接写 JSON Schema 的那种（开放键集）没有可枚举的入参。
  if (keys.includes("properties") && keys.includes("additionalProperties")) {
    return { properties: [], required: [] };
  }
  const after = section.slice(closedAt);
  const requiredList = /\[([^\]]*)\]/.exec(after);
  const required = requiredList
    ? [...requiredList[1]!.matchAll(/"([A-Za-z]+)"/g)].map((item) => item[1]!)
    : [];
  return { properties: keys, required };
}

function parseTools(): ParsedTool[] {
  return source
    .split(/\n {6}\{\n/)
    .slice(1)
    .flatMap((block) => {
      const name = block.match(/^ {8}name: "([a-z0-9_]+)"/);
      const kind = block.match(/\n {8}kind: "(read|write|run|danger)"/);
      if (!name || !kind) return [];
      const schema = inputSchemaOf(block);
      return [
        {
          name: name[1]!,
          kind: kind[1]!,
          description: descriptionBetween(block),
          hidden: /\n {8}hidden: true/.test(block),
          properties: schema.properties,
          required: schema.required,
        },
      ];
    });
}

const tools = parseTools();
const visible = tools.filter((tool) => !tool.hidden);
const hidden = tools.filter((tool) => tool.hidden);
const visibleNames = visible.map((tool) => tool.name);

/** `LEGACY_TOOL_NAMES` 里的旧名字 → 规范名。 */
function legacyPairs(): Array<[string, string]> {
  const table = source.match(/const LEGACY_TOOL_NAMES[\s\S]*?\n\];/);
  expect(table, "LEGACY_TOOL_NAMES 定义不存在或已改名").toBeTruthy();
  return [...table![0]!.matchAll(/\{ name: "(\w+)", canonical: "(\w+)" \}/g)].map(
    (item) => [item[1]!, item[2]!] as [string, string],
  );
}

const instructions =
  (source.match(/const SERVER_INSTRUCTIONS = \[([\s\S]*?)\]\.join/) || [])[1] ?? "";

describe("工具名", () => {
  it("finds the tools it is supposed to be checking", () => {
    // 解析失效时下面每条断言都会对着空集合空转通过。
    expect(visible.length).toBeGreaterThan(50);
    expect(visibleNames).toContain("open_browser_tab");
    // 入参解析要能读懂三种写法：单行、花括号换行、带注释与嵌套对象。
    expect(
      visible.find((tool) => tool.name === "set_password")?.properties,
      "入参解析失效",
    ).toContain("password");
    expect(
      visible.find((tool) => tool.name === "handle_browser_dialog")?.properties,
      "注释后的入参被漏掉",
    ).toEqual(["tabId", "accept", "promptText"]);
    expect(
      visible.find((tool) => tool.name === "set_browser_emulation")?.properties,
      "嵌套对象里的键被当成了顶层入参",
    ).toEqual(["tabId", "timezone", "mediaType", "offline", "geolocation"]);
  });

  it("are unique, advertised or hidden alike", () => {
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every compatibility alias points at an advertised tool and takes no name of its own", () => {
    const all = new Set(tools.map((tool) => tool.name));
    const advertised = new Set(visibleNames);
    const pairs = legacyPairs();
    expect(pairs.length).toBeGreaterThan(5);
    for (const [legacy, canonical] of pairs) {
      expect(advertised.has(canonical), `${legacy} 指向的 ${canonical} 不是对外广播的工具`).toBe(
        true,
      );
      expect(all.has(legacy), `${legacy} 既是别名又是一个工具`).toBe(false);
    }
  });

  it("a hidden tool says it is an alias, so nobody mistakes it for a second way", () => {
    expect(hidden.length).toBeGreaterThan(0);
    for (const tool of hidden) {
      expect(tool.description, `${tool.name} 是隐藏工具，描述里要说明它是兼容别名`).toContain(
        "兼容别名",
      );
    }
  });

  it("launch_* is one tool, and it is the external browser", () => {
    expect(visibleNames.filter((name) => name.startsWith("launch_"))).toEqual([
      "launch_external_browser",
    ]);
    // 外部浏览器一族的工具名都带 external：范围写在名字里，调用方不必读描述
    // 才知道它关不了内置标签页。
    for (const name of visibleNames.filter((item) => /external/.test(item))) {
      expect(name).toContain("external");
    }
    for (const name of ["stop_external_browser", "stop_all_external_browsers"]) {
      expect(visibleNames).toContain(name);
    }
  });
});

describe("描述里点到的名字都是真的", () => {
  it("no visible description or the instructions names a tool that does not exist", () => {
    // 描述曾经写着「用 wait_browser」「返回 tabId」「target 三选一」而对应的
    // 工具或字段并不存在。调用方照着描述走，下一步就是一次被拒绝的调用。
    const known = new Set([
      ...tools.map((tool) => tool.name),
      ...legacyPairs().map(([legacy]) => legacy),
    ]);
    const snake = /(?<![A-Za-z0-9_])[a-z]+(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g;
    const dangling: string[] = [];
    for (const text of [...visible.map((tool) => tool.description), instructions]) {
      for (const match of text.matchAll(snake)) {
        if (!known.has(match[0])) dangling.push(match[0]);
      }
    }
    expect(dangling).toEqual([]);
  });

  it("a visible description never sends the caller to a legacy name", () => {
    const legacy = legacyPairs().map(([name]) => name);
    // 整词比较：wait_browser_condition 里含有 wait_browser，但那不是旧名字。
    const strays: string[] = [];
    for (const tool of visible) {
      for (const name of legacy) {
        if (new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(tool.description)) {
          strays.push(`${tool.name} → ${name}`);
        }
      }
    }
    expect(strays).toEqual([]);
  });
});

describe("入参名", () => {
  it("names the object in the parameter: no bare id on a visible tool", () => {
    // 调用方手里同时有几种 id。裸 `id` 传错了对象只能得到一句「不存在」；
    // identityId / viewId / siteId 把对象写在名字里，也写进了模型看到的 schema。
    const bare = visible.filter((tool) => tool.properties.includes("id")).map((tool) => tool.name);
    expect(bare).toEqual([]);
  });

  it("calls a page tabId everywhere, never pageId", () => {
    const pages = visible
      .filter((tool) => tool.properties.includes("pageId"))
      .map((tool) => tool.name);
    expect(pages).toEqual([]);
    for (const name of ["activate_browser_tab", "close_browser_tab", "navigate_browser_tab"]) {
      expect(visible.find((tool) => tool.name === name)?.properties, name).toContain("tabId");
    }
  });

  it("set_password names its owner by siteId or identityId, not by a kind plus an id", () => {
    const tool = visible.find((item) => item.name === "set_password");
    expect(tool, "set_password 未注册").toBeTruthy();
    expect(tool?.properties).toEqual(expect.arrayContaining(["siteId", "identityId", "password"]));
    expect(tool?.properties).not.toEqual(expect.arrayContaining(["ownerKind", "ownerId"]));
  });

  it("tools that work on one page carry browser in their name", () => {
    // `wait_browser`、`check_element_visible`、`set_tab_page` 曾是这一族里仅有的
    // 三个例外。少一个词，靠名字猜工具的调用方就猜不到它们。
    const strays = visible
      .filter((tool) => tool.properties.includes("tabId") && tool.name !== "run_flow")
      .filter((tool) => !tool.name.includes("_browser_"))
      .map((tool) => tool.name);
    expect(strays).toEqual([]);
  });
});

describe("档位与名字的对应", () => {
  it("reserves delete_* for the danger tier, and the danger tier for delete_*", () => {
    for (const tool of visible) {
      if (tool.name.startsWith("delete_")) {
        expect(tool.kind, tool.name).toBe("danger");
        expect(tool.required, `${tool.name} 必须要求显式确认`).toContain("confirm");
      } else {
        expect(tool.kind, `${tool.name} 不是 delete_* 却是 danger 档`).not.toBe("danger");
      }
    }
  });

  it("keeps observation in the read tier, including screenshots", () => {
    for (const name of [
      "read_browser_page",
      "read_browser_element",
      "read_browser_attribute",
      "wait_browser_condition",
      "check_browser_element_visible",
      "screenshot_browser_tab",
      "read_browser_requests",
      "read_browser_console",
      "read_browser_dialog",
      "find_browser_element",
    ]) {
      expect(visible.find((tool) => tool.name === name)?.kind, name).toBe("read");
    }
  });

  it("answers a JavaScript dialog only with an explicit accept", () => {
    const tool = visible.find((item) => item.name === "handle_browser_dialog");
    expect(tool, "handle_browser_dialog 未注册").toBeTruthy();
    expect(tool?.properties).toContain("accept");
    expect(source).toMatch(/\["accept"\]/);
  });
});
