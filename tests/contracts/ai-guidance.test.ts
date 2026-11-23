import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 「AI 该走哪条路」的契约。
 *
 * 这份 MCP 端点暴露两条名字不同的开页路径：`open_browser_*` 与 `launch_*`。两条
 * **默认都开在内置浏览器**；外部系统浏览器只在调用方显式传 `external: true` 时
 * 才开，用途是给人看或做保真校验。一次真实事故里，客户端 AI 把本该在内置表面
 * 里完成的校验开进了系统浏览器——当时三处信号都指向外部：并列的 instructions、
 * 不带限定的工具描述、靠前的注册顺序。
 *
 * 工具描述与注册顺序各有改动；这里守住的是**选路语义**本身：
 *
 * 1. `SERVER_INSTRUCTIONS` 必须给出明确的取舍规则：内置是默认，外部是显式例外；
 * 2. 每个 `launch_*` 工具的描述必须同时写明「默认内置」与 `external`，少一半都
 *    会让模型把它当成另一种东西；
 * 3. 登录段必须写明开页会自动归属账号，匹配不到才落干净会话——「不带
 *    identityId 就是干净会话」是与实现矛盾的旧说法，会让模型回去手填登录表单；
 * 4. `resolve_browser_target`（URL → 该用哪个身份）必须存在且只读；
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

  it("有一段同时点名两条路径：内置先出场，每个 launch_ 句都写明默认内置与 external 例外", () => {
    // 取舍段：两条路径的名字必须出现在同一段里——选路规则只有同时摆出
    // 两个选项才成立，分散在两段就成了各自的产品介绍。
    const paragraph = paragraphs(text).find(
      (part) => part.includes("open_browser") && /launch_/.test(part),
    );
    expect(
      paragraph,
      "SERVER_INSTRUCTIONS 缺少同时点名 open_browser_* 与 launch_* 的取舍段，AI 失去选路依据",
    ).toBeTruthy();
    // 默认路径先说，例外后说：阅读顺序本身就是结论。
    expect(
      paragraph!.indexOf("open_browser"),
      "取舍段里 open_browser_* 必须先于 launch_* 出场",
    ).toBeLessThan(paragraph!.indexOf("launch_"));
    /*
      每个提到 launch_ 的句子都要把两半说全：默认落在内置浏览器，外部窗口
      只在显式传 external 时才开。只说「内置」会让模型不知道还有保真校验这条路；
      只说「外部」则回到事故形态——模型把 launch_* 当成与内置并列的另一套驱动。
    */
    const launchSentences = paragraph!
      .split(/(?<=[.!?])\s+/)
      .filter((sentence) => /launch_/.test(sentence));
    expect(launchSentences.length, "取舍段必须有一句说明 launch_* 的定位").toBeGreaterThan(0);
    for (const sentence of launchSentences) {
      expect(sentence, `这句提到 launch_ 却没说它默认开在内置浏览器：「${sentence}」`).toMatch(
        /embedded/i,
      );
      expect(sentence, `这句提到 launch_ 却没说 external 才开外部窗口：「${sentence}」`).toMatch(
        /external/i,
      );
    }
  });

  it("不把 launch_ 列在与 open_browser 并列的典型顺序里", () => {
    // 「…open_browser_view or launch_view」这种裸并列句正是事故里的误导源：
    // 句尾重音落在 launch_view 上，模型读到的是一条并列推荐。典型顺序只需要
    // open_browser_*；launch_* 的定位由取舍段单独交代。
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

describe("launch_* 工具自报默认与例外", () => {
  it("每个 launch_* 工具的描述都同时写明默认内置与 external", () => {
    const launches = toolBlocks(read("src/main/mcp/server.ts")).filter((block) =>
      /^ {8}name: "launch_/.test(block),
    );
    expect(
      launches.length,
      "launch_* 工具一个都没解析到，块切分规则可能已失效",
    ).toBeGreaterThanOrEqual(3);
    for (const block of launches) {
      const name = block.match(/^ {8}name: "(launch_\w+)"/)![1]!;
      const description = descriptionOf(block);
      expect(
        description,
        `${name} 的描述没写它默认开在内置浏览器，AI 会以为它另有去处`,
      ).toMatch(/内置/);
      expect(
        description,
        `${name} 的描述没写 external: true 才开外部窗口，保真校验这条路会被埋没`,
      ).toMatch(/external/);
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
