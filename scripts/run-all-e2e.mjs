#!/usr/bin/env node
/**
 * Runs every e2e suite in turn and prints one line per suite.
 *
 * Sequential on purpose: each suite spawns its own Electron with its own
 * user-data-dir, and this machine has capacity for about one at a time.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("scripts")
  .filter((name) => /^e2e-[a-z-]+\.mjs$/.test(name))
  .sort();

const rows = [];
for (const file of files) {
  const started = Date.now();
  const result = await new Promise((done) => {
    const child = spawn(process.execPath, [`scripts/${file}`], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
  const summary = /SUMMARY (\d+\/\d+)/.exec(result.out)?.[1]
    ?? /(\d+\/\d+) assertions passed/.exec(result.out)?.[1]
    ?? "no summary";
  const failures = [...result.out.matchAll(/^FAIL (.+)$/gm)].map((match) => match[1]);
  rows.push({ file, code: result.code, summary, failures });
  console.log(
    `${result.code === 0 && failures.length === 0 ? "ok  " : "FAIL"} ${file.padEnd(30)} ${summary.padEnd(18)} ${Math.round((Date.now() - started) / 1000)}s`,
  );
  for (const failure of failures) console.log(`       x ${failure}`);
}

const broken = rows.filter((row) => row.code !== 0 || row.failures.length > 0);
console.log(`\n${rows.length - broken.length}/${rows.length} suites clean`);
if (broken.length) {
  console.log("failing:", broken.map((row) => row.file).join(", "));
  process.exitCode = 1;
}
