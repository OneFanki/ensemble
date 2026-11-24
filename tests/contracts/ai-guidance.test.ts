import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「AI 该走哪条路」的契约。
 *
 * 这份 MCP 端点有两种浏览器表面。内置浏览器的页面 AI 读得到、点得动，所有页面
 * 工作都在这里；外部系统浏览器的窗口 AI 驱动不了，只用来给人看或确认页面在
 * 真实浏览器里表现一致。一次真实事故里，客户端 AI 把本该在内置表面里完成的
 * 校验开进了系统浏览器——当时 `launch_*` 一个工具靠 `external` 开关在两种表面
 * 之间切换，三处信号都指向外部：并列的 instructions、不带限定的工具描述、靠前
 * 的注册顺序。
 *
 * 现在两种表面是两族名字：`open_browser_*` 与 `*_browser_*` 只管内置，
 * `launch_external_browser` 只管外部；旧的 `launch_view` / `launch_identity` /
 * `launch_clean_session` 降为隐藏的兼容别名。这里守住的是**选路语义**本身：
 *
 * 1. `SERVER_INSTRUCTIONS` 必须在一段里同时摆出两条路，并说清活儿在哪边干；
 * 2. 对外广播的 `launch_*` 只有 `launch_external_browser` 一个，它的描述必须
 *    写明这些窗口驱动不了、把调用方指回内置工具；
 * 3. 登录段必须写明开页会自动归属账号，匹配不到才落干净会话——「不带
 *    identityId 就是干净会话」是与实现矛盾的旧说法，会让模型回去手填登录表单；
 * 4. `resolve_browser_target`（URL → 该用哪个账号）必须存在且只读；
 * 5. 它的实现不得携带凭据回显字段。
 *
 * 解析与 `ai-tools-doc.test.ts` 同一把刀：按 `\n {6}\{\n` 切工具块、取 8 空格
 * 缩进的 `name` / `kind`，对 CRLF 检出不敏感。
 */
const normalise = (text: string): string => text.replace(/\r\n/g, "\n");
const read = (path: string): string => normalise(readFileSync(join(process.cwd(), path), "utf8"));

/** 从源码里取出 SERVER_INSTRUCTIONS 数组字面量拼成的实际指令文本。 */
function instructionsText(source: string): string {
  const match = source.match(/const SERVER_INSTRUCTIONS = \[([\s\S]*?)\]\.join/);
  expect(match, "SERVER_INSTRUCTIONS 定义不存在或已改名").toBeTruthy();
  const literals = [...match![1]!.matchAll(/"((?:[^"\\])*)"/g)].map((item) => item[1]!);
  return literals.join("\n");
}

/** 工具定义块，与 ai-tools-doc.test.ts 同一切分规则。 */
function toolBlocks(source: string): string[] {
  return normalise(source).split(/\n {6}\{\n/).slice(1);
}

/** 工具块的 description 字面量拼接；description 位于 name 与 kind 之间。 */
function descriptionOf(block: string): string {
  const segment = block.match(/\n {8}description:[\s\S]*?\n {8}kind:/);
  expect(segment, "工具块缺少 description 或 kind，切分假设已失效").toBeTruthy();
  return [...segment![0].matchAll(/"((?:[^"\\])*)"/g)].map((item) => item[1]!).join("");
}

/** 指令文本按空行分段。 */
const paragraphs = (text: string): string[] => text.split(/\n\s*\n/);

describe("SERVER_INSTRUCTIONS 的浏览器选路规则", () => {
  const text = instructionsText(read("src/main/mcp/server.ts"));

  it("有一段同时摆出两条路：页面工作在内置，外部窗口只是给人看", () => {
    // 取舍段：两个工具的名字必须出现在同一段里——选路规则只有同时摆出
    // 两个选项才成立，分散在两段就成了各自的产品介绍。
    const paragraph = paragraphs(text).find(
      (part) => part.includes("open_browser") && part.includes("launch_external_browser"),
    );
    expect(
      paragraph,
      "SERVER_INSTRUCTIONS 缺少同时点名 open_browser_* 与 launch_external_browser 的取舍段，AI 失去选路依据",
    ).toBeTruthy();
    // 干活的那条路先说：阅读顺序本身就是结论。
    expect(paragraph!.indexOf("open_browser")).toBeLessThan(
      paragraph!.indexOf("launch_external_browser"),
    );
    // 外部窗口驱动不了这件事必须在同一句里说掉，否则模型会把它当成另一套驱动。
    const launchSentence = paragraph!
      .split(/(?<=[.!?])\s+/)
      .find((sentence) => sentence.includes("launch_external_browser"));
    expect(launchSentence, "取舍段里找不到提到 launch_external_browser 的句子").toBeTruthy();
    expect(paragraph!.toLowerCase()).toMatch(/cannot be driven|can't be driven/);
    expect(paragraph!.toLowerCase()).toContain("embedded browser");
  });

  it("不再把 launch_ 说成打开内置页面的办法", () => {
    // 「launch_* 默认开在内置浏览器」是事故之后、合并之前的那版说法；留着它
    // 等于告诉模型有两个名字可以做同一件事。
    expect(text).not.toMatch(/launch_\*|launch_view|launch_identity|launch_clean_session/);
    expect(text).not.toMatch(/open_browser\w* or\s+launch_/);
  });

  it("登录段写明开页会自动归属账号，匹配不到才落干净会话", () => {
    const signing = paragraphs(text).find((part) => /Signing in/.test(part));
    expect(signing, "SERVER_INSTRUCTIONS 缺少登录段").toBeTruthy();
    // 自动归属是开页的默认行为，指令必须说出来，否则模型会先去手填登录表单
    expect(signing).toMatch(/open_browser_tab resolves the account by itself/);
    // 干净会话是兜底而不是默认：顺序说反会让模型以为不带 identityId 就没有登录态
    expect(signing).toMatch(/clean session when nothing matches/);
    expect(signing).not.toMatch(/without identityId you get/);
  });
});

describe("launch_* 只剩一个，且只管外部浏览器", () => {
  const serverSource = read("src/main/mcp/server.ts");
  const launchBlocks = () =>
    toolBlocks(serverSource).filter((block) => /^ {8}name: "launch_\w+"/.test(block));
  const advertised = () => launchBlocks().filter((block) => !/\n {8}hidden: true/.test(block));
  const hidden = () => launchBlocks().filter((block) => /\n {8}hidden: true/.test(block));
  /** 工具块的名字；取不到说明切分假设失效，当场报出来而不是断言通过。 */
  const nameOf = (block: string): string => {
    const name = block.match(/^ {8}name: "(\w+)"/)?.[1];
    expect(name, "工具块缺少 name，切分假设已失效").toBeTruthy();
    return name ?? "";
  };
  const only = (blocks: string[]): string => {
    expect(blocks, "期望恰好一个工具块").toHaveLength(1);
    return blocks[0] ?? "";
  };

  it("对外广播的 launch_* 只有 launch_external_browser", () => {
    expect(advertised().map(nameOf)).toEqual(["launch_external_browser"]);
  });

  it("它的描述写明这些窗口驱动不了，并把调用方指回内置工具", () => {
    const description = descriptionOf(only(advertised()));
    expect(description, "没说 AI 读不到也操作不了外部窗口").toMatch(/读不到也操作不了/);
    expect(description, "没把要操作页面的调用方指回 open_browser_tab").toContain(
      "open_browser_tab",
    );
    expect(description, "没给出关闭窗口的办法").toContain("stop_external_browser");
  });

  it("旧的 launch_view / launch_identity / launch_clean_session 只作为隐藏别名存在", () => {
    expect(hidden().map(nameOf).sort()).toEqual(["launch_clean_session", "launch_identity", "launch_view"]);
    for (const block of hidden()) {
      expect(descriptionOf(block), `${nameOf(block)} 的描述没说明它是兼容别名`).toContain("兼容别名");
    }
  });
});

describe("resolve_browser_target 的存在与安全边界", () => {
  const serverSource = read("src/main/mcp/server.ts");
  const block = () =>
    toolBlocks(serverSource).find((item) => /^ {8}name: "resolve_browser_target"/.test(item));

  it("注册在工具集合里且是只读档", () => {
    // 开页虽然会自动归属，模型仍需要一个只读入口在打开之前看清「这个地址对应
    // 哪些账号」——多账号站点选谁、账号不属于该站点时的提醒都在这里。
    expect(
      block(),
      "resolve_browser_target 未注册",
    ).toBeTruthy();
    expect(block()).toMatch(/\n {8}kind: "read"/);
  });

  it("实现块不含凭据回显字段", () => {
    // 只读指路工具没有任何理由触碰凭据；返回对象里出现 password / secret
    // 字样即视为把读密码的口子开进了 read 档。
    expect(block()).not.toMatch(/password|secret/i);
  });
});
