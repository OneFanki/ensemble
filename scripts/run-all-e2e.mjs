#!/usr/bin/env node
/**
 * Runs every e2e suite in turn and prints one line per suite.
 *
 * Sequential on purpose: each suite spawns its own Electron with its own
 * user-data-dir, and this machine has capacity for about one at a time.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";

/**
 * Suites that open real windows on the desktop and are therefore opt-in.
 *
 * Everything here is discovered by the glob below, but running it unasked pops
 * visible windows on whatever the user is doing. Naming them (rather than
 * renaming the files) keeps the "every e2e-* runs" rule intact while making the
 * exception one readable line.
 *
 * Membership is about what the suite launches, not what it asserts: a suite
 * that spawns Electron without `ENSEMBLE_HEADLESS` shows a real app window
 * (minimize and pop-out need one — their subject is the OS window itself),
 * and `e2e-external-launch` opens the system browser. Compositor culling of an
 * off-window guest, by contrast, reproduces headless: `e2e-ai-frames` measures
 * about 1fps with the node outside the window and about 60fps once it is back,
 * so it belongs in the default run.
 */
const VISIBLE_WINDOW_SUITES = new Set([
  "e2e-external-launch.mjs",
  "e2e-minimize.mjs",
  "e2e-popout.mjs",
]);

const files = readdirSync("scripts")
  .filter((name) => /^e2e-[a-z0-9-]+\.mjs$/.test(name))
  .filter((name) => !VISIBLE_WINDOW_SUITES.has(name))
  .sort();
const skipped = readdirSync("scripts")
  .filter((name) => VISIBLE_WINDOW_SUITES.has(name))
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
  // Three summary formats exist because the suites grew independently. Missing
  // one is not cosmetic: a suite whose format is unrecognised prints "no
  // summary" and still counts as clean, so its failures would be invisible in
  // the one place that claims "all e2e passed". `checks passed` is the newest
  // spelling (bookmark-flyout / popout / http-auth) and was the gap.
  const summary = /SUMMARY (\d+\/\d+)/.exec(result.out)?.[1]
    ?? /(\d+\/\d+) assertions passed/.exec(result.out)?.[1]
    ?? /(\d+\/\d+) checks passed/.exec(result.out)?.[1]
    ?? "no summary";
  const failures = [...result.out.matchAll(/^FAIL (.+)$/gm)].map((match) => match[1]);
  // A summary of `5/6` is a failed run even when every line it printed was a
  // pass and the exit code is 0: some suites report a shortfall only in the
  // tally. "no summary" is also not clean — an unrecognised format must not be
  // a way to pass, which is exactly how one format stayed unchecked.
  const tally = summary === "no summary" ? null : summary.split("/").map(Number);
  const shortfall = tally === null || tally[0] !== tally[1];
  rows.push({ file, code: result.code, summary, failures, shortfall });
  console.log(
    `${result.code === 0 && failures.length === 0 && !shortfall ? "ok  " : "FAIL"} ${file.padEnd(30)} ${summary.padEnd(18)} ${Math.round((Date.now() - started) / 1000)}s`,
  );
  for (const failure of failures) console.log(`       x ${failure}`);
  if (shortfall && summary === "no summary") console.log("       x no recognisable summary line");
}

const broken = rows.filter((row) => row.code !== 0 || row.failures.length > 0 || row.shortfall);
console.log(`\n${rows.length - broken.length}/${rows.length} suites clean`);
if (skipped.length) {
  // Said out loud rather than silently omitted: "all e2e passed" would otherwise
  // be a claim about a smaller set than the user thinks.
  console.log(`skipped (opens real browser windows, run by hand): ${skipped.join(", ")}`);
}
if (broken.length) {
  console.log("failing:", broken.map((row) => row.file).join(", "));
  process.exitCode = 1;
}
