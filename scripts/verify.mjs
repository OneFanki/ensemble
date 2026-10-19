import { spawn } from "node:child_process";

const gates = [
  { name: "typecheck", command: "pnpm", args: ["typecheck"] },
  { name: "test", command: "pnpm", args: ["test"] },
  { name: "build", command: "pnpm", args: ["build"] },
];

const isWindows = process.platform === "win32";

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(isWindows ? `${command}.cmd` : command, args, {
      stdio: "inherit",
      shell: isWindows,
    });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

// Non fail-fast on purpose: one run should surface every broken gate, not just the first.
const results = [];
for (const gate of gates) {
  console.log(`\n=== ${gate.name} ===`);
  const startedAt = Date.now();
  const code = await run(gate.command, gate.args);
  results.push({ ...gate, code, ms: Date.now() - startedAt });
}

console.log("\n=== verify summary ===");
for (const result of results) {
  const mark = result.code === 0 ? "PASS" : "FAIL";
  console.log(`${mark}  ${result.name.padEnd(10)} ${(result.ms / 1000).toFixed(1)}s`);
}

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  console.error(`\n${failed.length} gate(s) failed: ${failed.map((item) => item.name).join(", ")}`);
  process.exit(1);
}
