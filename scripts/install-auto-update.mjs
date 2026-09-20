import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin")
  throw new Error("自动更新安装脚本目前仅支持 macOS");

const root = fileURLToPath(new URL("../", import.meta.url));
const launchAgents = join(homedir(), "Library", "LaunchAgents");
const logs = join(homedir(), ".holdem-terminal");
const target = join(launchAgents, "com.holdem-terminal.update.plist");
const escape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

mkdirSync(launchAgents, { recursive: true });
mkdirSync(logs, { recursive: true });
writeFileSync(
  target,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.holdem-terminal.update</string>
  <key>ProgramArguments</key><array>
    <string>${escape(process.execPath)}</string>
    <string>${escape(join(root, "scripts", "update.mjs"))}</string>
  </array>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>${escape(join(logs, "update.log"))}</string>
  <key>StandardErrorPath</key><string>${escape(join(logs, "update.log"))}</string>
</dict></plist>
`,
);
try {
  execFileSync("launchctl", ["bootout", `gui/${process.getuid()}`, target], {
    stdio: "ignore",
  });
} catch {}
execFileSync("launchctl", ["bootstrap", `gui/${process.getuid()}`, target]);
console.log(`已启用每小时自动更新：${target}`);
