import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { getCallerInfo, type CmuxCallerContext } from "../../extensions/cmux-core.ts";
import { assertLocalWorkspace } from "../ssh/terminal.ts";
import { uuid } from "../orientation/state.ts";
import { inspectInstalledPanel, installSidebar, renderInstalledPanel } from "../panel-install.mjs";

export interface DoctorActionOptions {
	sidebarDir?: string;
	env?: NodeJS.ProcessEnv;
	/** Must throw when the invocation/session is no longer current. */
	check: () => void;
	confirm: (title: string, message: string) => Promise<boolean>;
	identify?: typeof getCallerInfo;
	assertLocal?: typeof assertLocalWorkspace;
}
export const panelTarget = (options: { sidebarDir?: string } = {}) =>
	join(options.sidebarDir ?? join(homedir(), ".config", "cmux", "sidebars"), "agent-state-panel.js");

/** Inspect every existing ancestor without following symlinks. Missing directories
 * are recorded, not created. Comparing this ticket rejects stale paths after a prompt. */
function pathTicket(target: string): string {
	if (!isAbsolute(target) || resolve(target) !== target) throw new Error("Panel target must be an absolute normalized path");
	const rows: unknown[] = [];
	let path = target;
	for (;;) {
		try {
			const stat = lstatSync(path);
			if (stat.isSymbolicLink() || (path === target ? !stat.isFile() : !stat.isDirectory())) {
				throw new Error(`Refusing symlink or non-${path === target ? "file" : "directory"}: ${path}`);
			}
			rows.push([path, stat.dev, stat.ino, stat.mode]);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			rows.push([path, "missing"]);
		}
		const parent = dirname(path);
		if (parent === path) break;
		path = parent;
	}
	return JSON.stringify(rows);
}

/** Only this explicit action creates directories/files. No retries, settings edits,
 * or implicit authorization from a managed header. Existing content is backed up. */
export async function installDoctorPanel(options: DoctorActionOptions): Promise<string> {
	options.check();
	const target = panelTarget(options), ticket = pathTicket(target);
	const before = inspectInstalledPanel(target);
	if (before.status === "non-file") throw new Error("Panel target is not a regular file");
	const content = renderInstalledPanel();
	const confirmed = await options.confirm("Install/update panel?", [
		`Target: ${target}`,
		`State: ${before.status}; modified=${before.status === "modified"}; sha256=${before.hash ?? "(missing)"}; mode=${before.mode?.toString(8) ?? "0600 (new file)"}`,
		before.hash ? "Existing raw bytes and permission mode will be preserved in an exclusive .backup-<timestamp> file before replacement (unless already current). The replacement retains that mode." : "Create the missing target and parent directories only after confirmation.",
		"No settings will be edited and the panel will not be opened.",
	].join("\n"));
	options.check();
	if (!confirmed) return "Cancelled; no changes.";
	if (pathTicket(target) !== ticket) throw new Error("Panel path changed during confirmation; no installation attempted");
	const after = inspectInstalledPanel(target);
	if (after.status !== before.status || after.hash !== before.hash || after.mode !== before.mode) {
		throw new Error("Panel content/hash changed during confirmation; no installation attempted");
	}
	options.check();
	const result = installSidebar(target, content, before.hash);
	options.check();
	return result.changed ? `Panel installed.${result.backup ? ` Backup: ${result.backup}` : ""} Not opened.` : "Panel is already current; no changes.";
}

const identityKeys = ["window_id", "workspace_id", "pane_id", "surface_id"] as const;
function requireCaller(caller: CmuxCallerContext | undefined, env: NodeJS.ProcessEnv): asserts caller is CmuxCallerContext {
	if (!caller || identityKeys.some(key => !uuid(caller[key]))) throw new Error("Panel action requires an initially verified caller with exact UUIDs");
	if (uuid(env.CMUX_WORKSPACE_ID) !== caller.workspace_id || uuid(env.CMUX_SURFACE_ID) !== caller.surface_id
		|| (env.CMUX_WINDOW_ID !== undefined && uuid(env.CMUX_WINDOW_ID) !== caller.window_id)
		|| (env.CMUX_PANE_ID !== undefined && uuid(env.CMUX_PANE_ID) !== caller.pane_id)) {
		throw new Error("Caller no longer matches CMUX environment");
	}
}

/** A single non-focusing effect for the original caller; never guess a window or
 * repeat an uncertain request. Reidentification and locality are read-only. */
async function setDoctorPanelVisibility(pi: ExtensionAPI, initial: CmuxCallerContext | undefined, options: DoctorActionOptions, visible: boolean): Promise<string> {
	options.check();
	const env = () => options.env ?? process.env;
	requireCaller(initial, env());
	// Copy before any await: injected/cached report objects must not retarget an action.
	const caller = { ...initial };
	const identified = await (options.identify ?? getCallerInfo)(pi);
	options.check();
	requireCaller(caller, env());
	if (!identified.ok || identityKeys.some(key => identified.caller[key] !== caller[key])) {
		throw new Error("Caller is stale/unverified; refusing panel action");
	}
	await (options.assertLocal ?? assertLocalWorkspace)(pi, identified.caller);
	options.check();
	requireCaller(caller, env());
	const latest = await (options.identify ?? getCallerInfo)(pi);
	options.check();
	requireCaller(caller, env());
	if (!latest.ok || identityKeys.some(key => latest.caller[key] !== caller[key])) {
		throw new Error("Caller changed during locality verification; refusing panel action");
	}
	if (visible) {
		const target = panelTarget(options);
		pathTicket(target);
		const panel = inspectInstalledPanel(target);
		if (!panel.hash || panel.status === "missing" || panel.status === "non-file") throw new Error("Install a regular panel file before opening");
	}
	options.check();
	try {
		const args = visible ? ["set", "custom", "agent-state-panel"] : ["hide"];
		args.push("--workspace", caller.workspace_id!, "--window", caller.window_id!);
		if (visible) args.push("--no-focus");
		const result = await pi.exec("cmux", ["right-sidebar", ...args], { timeout: 5000 });
		options.check();
		if (result.killed || result.code !== 0 || result.stderr.trim()) throw new Error(`exit=${result.code}; killed=${result.killed}; ${result.stderr || result.stdout}`);
		return visible ? "Pi Agents show requested for the verified caller window without focus."
			: "Right sidebar hide requested for the verified caller window.";
	} catch (error) {
		throw new Error(`Panel ${visible ? "open" : "hide"} outcome may be uncertain; not retried. ${error instanceof Error ? error.message : String(error)}`);
	}
}

export async function openDoctorPanel(pi: ExtensionAPI, initial: CmuxCallerContext | undefined, options: DoctorActionOptions): Promise<string> {
	return setDoctorPanelVisibility(pi, initial, options, true);
}

/** Hides the whole right sidebar, including Files/Find if selected; no installed panel is required. */
export async function hideDoctorPanel(pi: ExtensionAPI, initial: CmuxCallerContext | undefined, options: DoctorActionOptions): Promise<string> {
	return setDoctorPanelVisibility(pi, initial, options, false);
}
