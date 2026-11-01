// Explicit opt-in installer. Does not activate the sidebar or change cmux.json.
// Never runs when Pi loads a package.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installSidebar, renderInstalledPanel } from "../../lib/panel-install.mjs";
export { installSidebar, sha256 } from "../../lib/panel-install.mjs";

// Legacy fixture renderer only. Production installs never inject launch config.
export function renderSidebar(source, config) {
  return "// pi-cmux managed prototype; edit the worktree source, then explicitly reinstall.\n"
    + `const PI_PANEL_LAUNCH = ${JSON.stringify(config)};\n` + source;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== "--replace")) {
      throw new Error("Usage: node examples/sidebars/install-agent-state-panel.mjs [--replace <installed-sha256>]");
    }
    const target = join(homedir(), ".config", "cmux", "sidebars", "agent-state-panel.js");
    const result = installSidebar(target, renderInstalledPanel(), args[1]);
    console.log(`${result.changed ? "Installed" : "Already current"}: ${target}`);
    if (result.backup) console.log(`Previous copy: ${result.backup}`);
    console.log("Next: cmux sidebar validate agent-state-panel");
    console.log("Then: cmux right-sidebar set custom agent-state-panel --no-focus");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
