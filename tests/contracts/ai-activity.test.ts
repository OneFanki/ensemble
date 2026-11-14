import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * AI activity is a log, and the message centre is for news.
 *
 * The two used to be the same list: every tool call wrote a `kind: "ai"` row
 * beside login captures and expired accounts, through one 500-row cap, with a
 * dedupe key that could not see which tool had run. Sixteen rows from one
 * automation run pushed real notifications out of the list they were meant to be
 * read in.
 *
 * These assertions name the consequences rather than the shapes, because the
 * shapes are free to move: no AI row may reach the message centre, a refusal may
 * not be the end of the story, and a decision costs a question.
 */
const read = (path: string): string => readFileSync(join(process.cwd(), path), "utf8");

describe("AI activity lives outside the message centre", () => {
  const types = read("src/shared/types.ts");
  const main = read("src/main/index.ts");
  const server = read("src/main/mcp/server.ts");
  const messages = read("src/core/messages.ts");

  it("has no AI kind left in the message vocabulary", () => {
    // `MessageKind` drives the filter chips, the icons and the storage; leaving
    // "ai" in it would let a new writer put one back without noticing.
    const kind = types.slice(types.indexOf("export type MessageKind"), types.indexOf("export type MessageAction"));
    expect(kind).not.toContain('"ai"');
  });

  it("drops AI rows written before the split", () => {
    // Old `messages.json` files still carry them. Filtered on read rather than
    // migrated: the record already exists in the new file from that day on, and
    // a copied row would appear as news a second time.
    expect(main).toContain('(message.kind as string) !== "ai"');
  });

  it("does not write AI activity into the message store", () => {
    const handler = main.slice(
      main.indexOf("onPageAction:"),
      main.indexOf("embedded: {", main.indexOf("onPageAction:")),
    );
    expect(handler.length).toBeGreaterThan(0);
    expect(handler).toContain("aiActivityStore().add(");
    expect(handler).not.toContain("messageStore().add(");
  });

  it("records before checking whether a window exists", () => {
    // The AI keeps working while the app is in the tray; a history that only
    // recorded what happened on screen would be missing exactly the calls nobody
    // was watching.
    const handler = main.slice(
      main.indexOf("onPageAction:"),
      main.indexOf("embedded: {", main.indexOf("onPageAction:")),
    );
    const record = handler.indexOf("aiActivityStore().add(");
    const windowCheck = handler.indexOf("mainWindow.isDestroyed()");
    expect(record).toBeGreaterThan(0);
    expect(windowCheck).toBeGreaterThan(record);
  });

  it("gives the log its own cap and its own dedupe key", () => {
    // One shared cap is what let AI calls evict login captures. The merge key has
    // to include the tool: the message centre's key was (kind, title, action), so
    // a click and a following type in one tab collapsed into the click's row.
    expect(messages).toContain("MESSAGE_LIMIT");
    const store = read("src/core/ai-activity.ts");
    expect(store).toContain("AI_ACTIVITY_LIMIT");
    expect(store).toMatch(/item\.tool === input\.tool/);
    expect(store).toMatch(/item\.ok === input\.ok/);
  });

  it("asks about an unlisted origin instead of refusing outright", () => {
    const gate = server.slice(server.indexOf("private async resolveOriginGate("));
    expect(gate).toMatch(/await this\.options\.approve\(/);
    // The refusal text has to tell the AI to stop and say so, or a client will
    // read "denied" as "try another tool".
    expect(gate).toContain("不要重试");
  });

  it("keeps a session grant out of the stored settings", () => {
    // "允许本次运行" is an answer about this run. Writing it to disk would
    // silently upgrade it to the permanent answer the user did not choose.
    expect(server).toContain("private sessionGrants = new Set<string>();");
    expect(server).toMatch(/this\.sessionGrants\.clear\(\)/);
    expect(server).toMatch(/aiSessionOrigins: \[\.\.\.this\.sessionGrants\]/);
  });
});
