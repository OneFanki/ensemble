#!/usr/bin/env node
/**
 * Runs a slice of the e2e suites, by index range.
 *
 * `run-all-e2e.mjs` runs the whole list in one go, which on this machine means
 * twenty-plus minutes with no output until the end — long enough that a slow
 * suite and a hung one look the same. This runs one third at a time so a stall
 * is visible as "this batch is still on suite N".
 *
 * Usage: node scripts/run-e2e-batch.mjs <from> <to>
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const from = Number(process.argv[2] ?? 0);
const to = Number(process.argv[3] ?? 0);
const VISIBLE_WINDOW_SUITES = new Set(["e2e-external-launch.mjs"]);

const files = readdirSync("scripts")
  .filter((name) => /^e2e-[a-z0-9-]+\.mjs$/.test(name))
  .filter((name) => !VISIBLE_WINDOW_SUITES.has(name))
  .sort()
  .slice(from, to);

const rows = [];
for (const file of files) {
  const started = Date.now();
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [`scripts/${file}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    // A suite that never exits is a failure, not a slow pass. Ten minutes is
    // well past the slowest real one (bookmarks, ~40s).
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      done({ code: 124, out: `${out}\nFAIL (killed after 10 minutes)` });
    }, 600_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code, out });
    });
  });
  const summary =
    /SUMMARY (\d+\/\d+)/.exec(result.out)?.[1] ??
    /(\d+\/\d+) assertions passed/.exec(result.out)?.[1] ??
    "no summary";
  const failures = [...result.out.matchAll(/^FAIL (.+)$/gm)].map((match) => match[1]);
  rows.push({ file, code: result.code, summary, failures });
  console.log(
    `${result.code === 0 && failures.length === 0 ? "ok  " : "FAIL"} ${file.padEnd(32)} ${summary.padEnd(16)} ${Math.round((Date.now() - started) / 1000)}s`,
  );
  for (const failure of failures) console.log(`       x ${failure}`);
}

const broken = rows.filter((row) => row.code !== 0 || row.failures.length > 0);
console.log(`\n${rows.length - broken.length}/${rows.length} suites clean in this batch`);
if (broken.length) {
  console.log("failing:", broken.map((row) => row.file).join(", "));
  process.exitCode = 1;
}
