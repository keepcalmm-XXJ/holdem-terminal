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

run("git", ["pull", "--ff-only"]);
run(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--omit=dev"]);
