import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status || 1);
}

function output(command, args) {
  const result = spawnSync(command, args, {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    encoding: "utf8",
  });
  if (result.status !== 0) process.exit(result.status || 1);
  return result.stdout.trim();
}

const before = output("git", ["rev-parse", "HEAD"]);
run("git", ["pull", "--ff-only"]);
if (output("git", ["rev-parse", "HEAD"]) !== before)
  run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev"]);
