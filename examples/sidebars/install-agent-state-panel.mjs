// Explicit opt-in installer for this repository-only prototype. Does not
// activate the sidebar or change cmux.json. Never runs when Pi loads a package.
import { createHash } from "node:crypto";
import { copyFileSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolvePathExecutable } from "../../extensions/cmux-core.ts";

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function renderSidebar(source, config) {
  return "// pi-cmux managed prototype; edit the worktree source, then explicitly reinstall.\n"
    + `const PI_PANEL_LAUNCH = ${JSON.stringify(config)};\n` + source;
}

export function installSidebar(target, content, expectedHash) {
  mkdirSync(dirname(target), { recursive: true });
  let existing;
  try {
    if (!lstatSync(target).isFile()) throw new Error("Refusing to replace a symlink or non-file sidebar");
    existing = readFileSync(target, "utf8");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing === content) return { changed: false };
  if (existing === undefined) {
    writeFileSync(target, content, { flag: "wx", mode: 0o600 });
    return { changed: true };
  }
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || sha256(existing) !== expectedHash) {
    throw new Error("Sidebar exists; inspect it and pass --replace <its-sha256> to explicitly update it");
  }
  const backup = target + ".backup-" + Date.now();
  copyFileSync(target, backup, constants.COPYFILE_EXCL);
  const temporary = target + ".tmp-" + process.pid;
  try {
    writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
    if (!lstatSync(target).isFile() || sha256(readFileSync(target, "utf8")) !== expectedHash) {
      throw new Error("Sidebar changed during installation; not replacing it");
    }
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
  return { changed: true, backup };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--replace")) {
      throw new Error("Usage: node examples/sidebars/install-agent-state-panel.mjs [--replace <installed-sha256>]");
    }
    const source = readFileSync(new URL("./agent-state-panel.js", import.meta.url), "utf8");
    const config = { version: 1, node: process.execPath, pi: resolvePathExecutable("pi"),
      cmux: resolvePathExecutable("cmux"), agentDir: getAgentDir(),
      bridge: fileURLToPath(new URL("./launch-pi.mjs", import.meta.url)) };
    const target = join(homedir(), ".config", "cmux", "sidebars", "agent-state-panel.js");
    const result = installSidebar(target, renderSidebar(source, config), args[1]);
    console.log(`${result.changed ? "Installed" : "Already current"}: ${target}`);
    if (result.backup) console.log(`Previous copy: ${result.backup}`);
    console.log("Next: cmux sidebar validate agent-state-panel");
    console.log("Then: cmux right-sidebar set custom agent-state-panel --no-focus");
    console.log("Keep this worktree at its current path: the panel's launch bridge lives here.");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
