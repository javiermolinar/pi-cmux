// Trusted bootstrap for a newly created local cmux workspace. No listener,
// shell-input injection, parent conversation, prompt, or automatic retry.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildPiCommand, getCallerInfo } from "../../extensions/cmux-core.ts";
import { assertLocalWorkspace } from "../../lib/ssh/terminal.ts";
import { BindingStore, encodeBootstrap, uuid } from "../../lib/orientation/state.ts";
import { waitForPiBinding } from "../../lib/orientation/startup.ts";

const execute = promisify(execFile);

export function panelEnvironment(config, inherited = process.env) {
  const env = { ...inherited };
  for (const key of ["PI_CMUX_ORIENTATION", "PI_CMUX_SSH_LAUNCH", "PI_SESSION_ID", "PI_SESSION_FILE",
    "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
  env.PATH = [...new Set([dirname(config.pi), dirname(config.node), dirname(config.cmux),
    "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");
  env.PI_CMUX_PI_PATH_MODE = "minimal";
  env.PI_CODING_AGENT_DIR = config.agentDir;
  return env;
}

export function panelAdapter(config, env) {
  return { exec: async (command, args, options) => {
    if (command !== "cmux") throw new Error("Panel bootstrap only executes the pinned cmux CLI");
    try {
      const result = await execute(config.cmux, args, { ...options, env, encoding: "utf8", maxBuffer: 1_048_576 });
      return { ...result, code: 0, killed: false };
    } catch (error) {
      return { stdout: error.stdout ?? "", stderr: error.stderr || error.message,
        code: typeof error.code === "number" ? error.code : 1, killed: Boolean(error.killed) };
    }
  } };
}

export async function preparePanelSession(config, request, pi, environment = process.env) {
  if (config?.version !== 1 || request?.version !== 1 || !uuid(request.sourceWorkspaceId)) {
    throw new Error("Invalid panel launch request");
  }
  for (const key of ["node", "pi", "cmux", "agentDir"]) {
    if (typeof config[key] !== "string" || !isAbsolute(config[key]) || config[key].includes("\0")) {
      throw new Error("Panel installation has invalid executable/config paths; reinstall it");
    }
  }
  if (typeof request.cwd !== "string" || request.cwd.length > 1024 || /[\u0000-\u001f\u007f]/.test(request.cwd)) {
    throw new Error("Specify a valid local directory (up to 1024 characters)");
  }
  const raw = request.cwd.trim();
  const cwd = raw === "~" ? homedir() : raw.startsWith("~/") ? resolve(homedir(), raw.slice(2)) : raw;
  if (!isAbsolute(cwd) || !(await stat(cwd)).isDirectory()) throw new Error("Choose an existing absolute local directory");
  for (const path of [config.node, config.pi, config.cmux]) {
    await access(path, constants.X_OK);
    if (!(await stat(path)).isFile()) throw new Error("Pinned executable is not a file");
  }
  const result = await getCallerInfo(pi);
  if (!result.ok) throw new Error(result.error);
  const caller = result.caller;
  if (![caller.window_id, caller.workspace_id, caller.pane_id, caller.surface_id].every(uuid)
      || uuid(caller.workspace_id) === uuid(request.sourceWorkspaceId)
      || uuid(environment.CMUX_WORKSPACE_ID) !== uuid(caller.workspace_id)
      || uuid(environment.CMUX_SURFACE_ID) !== uuid(caller.surface_id)) {
    throw new Error("Panel bootstrap must run in a distinct new workspace with exact UUID identity");
  }
  // workspace.list is scoped to this new workspace's window. Both the source
  // and new workspace must still be present and explicitly ordinary-local.
  await assertLocalWorkspace(pi, { ...caller, workspace_id: request.sourceWorkspaceId });
  await assertLocalWorkspace(pi, caller);
  return { cwd, caller, seed: { version: 1, taskId: randomUUID(), conversationId: randomUUID(),
    role: "main", topic: "Pi" } };
}

export async function launchPanelSession(config, request) {
  // Validate config before deriving its environment (preparation repeats the
  // full contract before any child starts).
  if (!config || !["node", "pi", "cmux", "agentDir"].every((key) => typeof config[key] === "string" && isAbsolute(config[key]))) {
    throw new Error("Invalid panel launch installation");
  }
  const env = panelEnvironment(config);
  const pi = panelAdapter(config, env);
  const { cwd, caller, seed } = await preparePanelSession(config, request, pi, env);
  // This process is the dedicated bootstrap, so setting its PATH is isolated.
  process.env.PATH = env.PATH;
  process.env.PI_CMUX_PI_PATH_MODE = "minimal";
  const command = buildPiCommand(cwd, { orientationBootstrap: encodeBootstrap(seed) });
  const target = ["--workspace", caller.workspace_id];
  const status = (text) => pi.exec("cmux", ["set-status", "pi-panel-startup", text, "--workspace", caller.workspace_id], { timeout: 5000 });
  await status("Starting Pi…");
  const child = spawn("/bin/sh", ["-c", command], { cwd, env, stdio: "inherit" });
  // Install completion handlers before awaiting startup; no orphaned/replayed
  // launch if the executable fails immediately.
  let ended = false;
  const completion = new Promise((done) => {
    child.once("error", (error) => { ended = true; done({ code: 1, error: error.message }); });
    child.once("exit", (code, signal) => { ended = true; done({ code: code ?? 1, signal }); });
  });
  const forwardInt = () => child.kill("SIGINT"), forwardTerm = () => child.kill("SIGTERM");
  process.on("SIGINT", forwardInt);
  process.on("SIGTERM", forwardTerm);
  try {
    const store = new BindingStore(join(config.agentDir, "pi-cmux", "orientation"));
    const startup = await waitForPiBinding(seed, caller.surface_id, (id) => store.read(id), () => {
      if (ended) throw new Error("The launched process exited");
    });
    if (startup.state === "bound") {
      await pi.exec("cmux", ["clear-status", "pi-panel-startup", "--workspace", caller.workspace_id], { timeout: 5000 });
    } else {
      await status("Pi startup unconfirmed · inspect before retrying");
      await pi.exec("cmux", ["log", "--level", "warning", ...target, startup.reason], { timeout: 5000 });
    }
    const result = await completion;
    if (result.error) throw new Error(result.error);
    return result.code;
  } finally {
    process.off("SIGINT", forwardInt);
    process.off("SIGTERM", forwardTerm);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error("Use the installed panel's New Pi action");
    process.exitCode = await launchPanelSession(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));
  } catch (error) {
    console.error(`New Pi did not complete: ${error.message}\nInspect this workspace before retrying; no automatic relaunch was attempted.`);
    process.exitCode = 1;
  }
}
