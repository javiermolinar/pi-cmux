import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, dirname, resolve } from "node:path";
import { uuid } from "../lib/orientation/state.ts";
import { prepareLaunchCommand } from "../lib/launch-command.ts";

const CMUX_TIMEOUT_MS = 5000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;
const TAB_TITLE_CONTEXT_TIMEOUT_MS = 1000;
const MAX_TAB_TITLE_LENGTH = 48;
const TAB_TITLE_SEPARATOR = " · ";

export type SplitDirection = "right" | "down";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface PiCommandOptions {
	sessionFile?: string;
	prompt?: string;
	provider?: string;
	model?: string;
	thinking?: PiThinkingLevel;
	/** One-shot session metadata, never part of the prompt. */
	orientationBootstrap?: string;
}

interface CmuxCallerInfo {
	window_id?: string;
	workspace_id?: string;
	pane_id?: string;
	surface_id?: string;
	window_ref?: string;
	workspace_ref?: string;
	pane_ref?: string;
	surface_ref?: string;
}

export interface CmuxCallerContext extends CmuxCallerInfo {
	window_ref?: string;
	workspace_ref: string;
	surface_ref: string;
	pane_ref?: string;
}

interface CmuxIdentifyResponse {
	caller?: CmuxCallerInfo;
}

interface CmuxPaneInfo {
	ref?: string;
	selected_surface_ref?: string;
	surface_refs?: string[];
}

interface CmuxListPanesResponse {
	panes?: CmuxPaneInfo[];
}

interface CmuxSurfaceCreationResponse {
	surface_ref?: unknown;
	surface_id?: unknown;
}

export type CommandOpenResult = { ok: true; workspaceRef: string; surfaceRef: string; source: CmuxCallerContext; created?: Record<string, unknown> } | { ok: false; error: string };

interface CmuxExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface OpenCommandInNewSplitOptions {
	tabTitle?: string;
	focus?: boolean;
	checkLaunch?: () => void;
	/** Read-only asynchronous locality check, followed by a synchronous ticket check. */
	beforeEffect?: (source: CmuxCallerContext) => Promise<void>;
	/** Single RPC create with local startup context; no legacy respawn/discovery fallback. */
	localOnly?: boolean;
}

export interface OpenCommandInNewTabOptions extends OpenCommandInNewSplitOptions {}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function parseJson<T>(text: string): T | undefined {
	try {
		return JSON.parse(text) as T;
	} catch {
		return undefined;
	}
}

function createdIds(stdout: string): Record<string, string> {
	const raw = parseJson<Record<string, unknown>>(stdout);
	return Object.fromEntries(["window_id", "workspace_id", "pane_id", "surface_id"].flatMap((key) => {
		const id = uuid(raw?.[key]);
		return id ? [[key, id]] : [];
	}));
}

function getCreatedSurfaceRef(stdout: string): string | undefined {
	const parsed = parseJson<CmuxSurfaceCreationResponse>(stdout);
	for (const value of [parsed?.surface_ref, parsed?.surface_id]) {
		if (typeof value === "string" && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function resolvePathExecutable(name: string, source = "Minimal Pi PATH"): string {
	// Explicit paths and relative/empty PATH entries resolve before the child cd.
	const candidates = name.includes("/") ? [resolve(name)]
		: (process.env.PATH?.split(delimiter) ?? []).map((entry) => resolve(entry || ".", name));
	for (const path of candidates) {
		try {
			accessSync(path, constants.X_OK);
			if (statSync(path).isFile()) return path;
		} catch { /* continue through missing, broken or non-executable candidates */ }
	}
	throw new Error(`${source} requires executable ${name}${name.includes("/") ? "" : " on the caller PATH"}`);
}

function buildCommandPrefix(cwd: string, minimalPiPath?: string): string[] {
	const commandParts = ["cd", shellEscape(cwd), "&&"];
	if (minimalPiPath !== undefined) {
		// Expand only the child's PATH. Do not add a cwd-searching empty entry.
		commandParts.push(`PATH=${shellEscape(minimalPiPath)}\${PATH:+:"$PATH"}`, "PI_CMUX_PI_PATH_MODE=minimal");
	} else if (process.env.PATH !== undefined) {
		// Helpers and full-mode Pi launches preserve the caller PATH.
		commandParts.push(`PATH=${shellEscape(process.env.PATH)}`);
	}
	commandParts.push("exec");
	return commandParts;
}

export function buildPiCommand(cwd: string, options?: PiCommandOptions): string {
	const mode = process.env.PI_CMUX_PI_PATH_MODE?.trim().toLowerCase() || "minimal";
	if (mode !== "full" && mode !== "minimal") throw new Error("PI_CMUX_PI_PATH_MODE must be full or minimal");
	const binary = process.env.PI_CMUX_BINARY?.trim();
	const executable = binary ? resolvePathExecutable(binary, "PI_CMUX_BINARY")
		: mode === "minimal" ? resolvePathExecutable("pi") : undefined;
	const minimalPath = mode === "minimal" && executable
		? [...new Set([dirname(executable), dirname(resolvePathExecutable("node"))])].join(delimiter) : undefined;
	const prefix = buildCommandPrefix(cwd, minimalPath);
	if (mode === "full") prefix.splice(prefix.length - 1, 0, "PI_CMUX_PI_PATH_MODE=full");
	// cmux need not inherit caller exports. Keep the same wrapper in descendants.
	if (binary && executable) prefix.splice(prefix.length - 1, 0, `PI_CMUX_BINARY=${shellEscape(executable)}`);
	if (options?.orientationBootstrap) prefix.splice(prefix.length - 1, 0, `PI_CMUX_ORIENTATION=${shellEscape(options.orientationBootstrap)}`);
	const commandParts = [...prefix, executable ? shellEscape(executable) : "pi"];
	if (options?.sessionFile) {
		commandParts.push("--session", shellEscape(options.sessionFile));
	}
	if (options?.provider) {
		commandParts.push("--provider", shellEscape(options.provider));
	}
	if (options?.model) {
		commandParts.push("--model", shellEscape(options.model));
	}
	if (options?.thinking) {
		commandParts.push("--thinking", shellEscape(options.thinking));
	}
	const prompt = options?.prompt?.trim();
	if (prompt) {
		commandParts.push("--", shellEscape(prompt));
	}
	return commandParts.join(" ");
}

export function buildShellCommand(cwd: string, command: string): string {
	// This inner shell is non-login. cmux respawn-pane may wrap the whole command
	// in a login shell; the prefix restores PATH, but cannot prevent profile side effects.
	return [...buildCommandPrefix(cwd), "/bin/sh", "-c", shellEscape(command)].join(" ");
}

function normalizeTabTitle(value: string | undefined, fallback: string): string {
	return (value ?? "").replace(/\s+/g, " ").trim() || fallback.replace(/\s+/g, " ").trim();
}

export function formatTabTitle(value: string | undefined, fallback: string): string {
	const title = normalizeTabTitle(value, fallback);
	if (title.length <= MAX_TAB_TITLE_LENGTH) {
		return title;
	}
	return `${title.slice(0, MAX_TAB_TITLE_LENGTH - 3).trimEnd()}...`;
}

/** Repository basename, or directory basename when git is unavailable. */
export async function getProjectName(pi: ExtensionAPI, cwd: string): Promise<string> {
	try {
		const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], {
			cwd,
			timeout: TAB_TITLE_CONTEXT_TIMEOUT_MS,
		});
		const repoRoot = result.code === 0 && !result.killed ? result.stdout.trim() : "";
		if (repoRoot) {
			return basename(repoRoot) || repoRoot;
		}
	} catch {
		// Fall through to directory basename.
	}

	return basename(cwd) || cwd;
}

export async function buildContextualTabTitle(
	pi: ExtensionAPI,
	cwd: string,
	value: string | undefined,
	fallback: string,
): Promise<string> {
	const title = normalizeTabTitle(value, fallback);
	const context = normalizeTabTitle(await getProjectName(pi, cwd), "");
	return formatTabTitle(context ? `${title}${TAB_TITLE_SEPARATOR}${context}` : title, title);
}

function collectSurfaceRefs(panes: CmuxPaneInfo[]): Set<string> {
	const refs = new Set<string>();
	for (const pane of panes) {
		if (pane.selected_surface_ref) {
			refs.add(pane.selected_surface_ref);
		}
		for (const surfaceRef of pane.surface_refs ?? []) {
			refs.add(surfaceRef);
		}
	}
	return refs;
}

export async function execCmux(pi: ExtensionAPI, args: string[], signal?: AbortSignal): Promise<CmuxExecResult> {
	const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS, ...(signal ? { signal } : {}) });
	if (result.killed) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: "cmux command timed out",
		};
	}
	if (result.code !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`,
		};
	}
	return {
		ok: true,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export async function getCallerInfo(pi: ExtensionAPI, signal?: AbortSignal): Promise<{ ok: true; caller: CmuxCallerContext } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "--id-format", "both", "identify"], signal);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to identify cmux caller" };
	}

	const parsed = parseJson<CmuxIdentifyResponse>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (typeof workspaceRef !== "string" || !workspaceRef.trim() || typeof surfaceRef !== "string" || !surfaceRef.trim()) {
		return { ok: false, error: "This command must be run from inside a cmux surface" };
	}

	return {
		ok: true,
		caller: {
			window_id: uuid(parsed?.caller?.window_id),
			workspace_id: uuid(parsed?.caller?.workspace_id),
			pane_id: uuid(parsed?.caller?.pane_id),
			surface_id: uuid(parsed?.caller?.surface_id),
			window_ref: parsed?.caller?.window_ref,
			workspace_ref: workspaceRef,
			surface_ref: surfaceRef,
			pane_ref: parsed?.caller?.pane_ref,
		},
	};
}

async function listPanes(pi: ExtensionAPI, workspaceRef: string): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to list cmux panes" };
	}

	const parsed = parseJson<CmuxListPanesResponse>(result.stdout);
	if (!Array.isArray(parsed?.panes) || parsed.panes.some((pane) =>
		!pane || typeof pane !== "object" ||
		typeof pane.ref !== "string" || !pane.ref.trim() ||
		(pane.selected_surface_ref != null && typeof pane.selected_surface_ref !== "string") ||
		(pane.surface_refs != null && (!Array.isArray(pane.surface_refs) ||
			pane.surface_refs.some((ref) => typeof ref !== "string" || !ref.trim())))
	)) {
		return { ok: false, error: "Invalid cmux pane list response" };
	}
	return { ok: true, panes: parsed.panes };
}

// Stop further dispatch without pretending a created surface can be safely retried.
function checkCreatedLaunch(check?: () => void): void {
	try { check?.(); }
	catch (error) {
		throw new Error(`Created cmux surface, but child command was not dispatched. Do not relaunch automatically. ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function waitForNewSurface(
	pi: ExtensionAPI,
	workspaceRef: string,
	previousPanes: CmuxPaneInfo[],
	paneRef?: string,
	checkLaunch?: () => void,
): Promise<string | undefined> {
	const previousPaneRefs = new Set(previousPanes.map((pane) => pane.ref));
	const previousSurfaceRefs = collectSurfaceRefs(previousPanes);

	for (let attempt = 0; attempt < SPLIT_READY_ATTEMPTS; attempt += 1) {
		checkCreatedLaunch(checkLaunch);
		const panesResult = await listPanes(pi, workspaceRef);
		checkCreatedLaunch(checkLaunch);
		if (!panesResult.ok) {
			return undefined;
		}

		// A tab belongs in its caller's pane; a split must create a new pane.
		const panes = panesResult.panes.filter((pane) => paneRef
			? pane.ref === paneRef
			: !previousPaneRefs.has(pane.ref));
		const newSurfaceRefs = [...collectSurfaceRefs(panes)].filter((ref) => !previousSurfaceRefs.has(ref));
		// Legacy output cannot correlate concurrent creations. Never choose the first match.
		if (panes.length > 1 || newSurfaceRefs.length > 1) return undefined;
		if (newSurfaceRefs.length === 1) return newSurfaceRefs[0];

		await delay(SPLIT_READY_DELAY_MS);
	}

	return undefined;
}

async function renameSurfaceTab(pi: ExtensionAPI, workspaceRef: string, surfaceRef: string, title: string | undefined): Promise<void> {
	const tabTitle = formatTabTitle(title, "");
	if (!tabTitle) {
		return;
	}

	try {
		await execCmux(pi, [
			"rename-tab",
			"--workspace",
			workspaceRef,
			"--surface",
			surfaceRef,
			"--title",
			tabTitle,
		]);
	} catch {
		// Initial tab naming is best-effort; a naming failure must not prevent startup.
	}
}

async function respawnSurface(
	pi: ExtensionAPI,
	workspaceRef: string,
	surfaceRef: string,
	command: string,
	failureMessage: string,
	title: string | undefined,
	checkLaunch?: () => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
	checkCreatedLaunch(checkLaunch);
	await delay(SURFACE_BOOT_DELAY_MS);
	checkCreatedLaunch(checkLaunch);
	// Initialize before child command dispatch; never rename after respawn.
	await renameSurfaceTab(pi, workspaceRef, surfaceRef, title);
	checkCreatedLaunch(checkLaunch);
	let failure: string;
	// respawn-pane sends the command twice, so a long command can cross cmux
	// 0.65.2's 4 KiB request-classification window and lose its reply (#21222).
	const launch = prepareLaunchCommand(command);
	try {
		const result = await execCmux(pi, [
			"respawn-pane", "--workspace", workspaceRef, "--surface", surfaceRef, "--command", launch.command,
		]);
		if (result.ok) return { ok: true };
		failure = result.error || failureMessage;
	} catch (error) { failure = error instanceof Error ? error.message : String(error); }
	// Creation and command dispatch are separate effects. A lost respawn reply
	// is not evidence that the command did not run, nor permission to replay it.
	const bytes = launch.originalBytes;
	const scripted = launch.scriptPath ? ` Script: ${launch.scriptPath}.` : "";
	const hint = /Socket closed before reply/i.test(failure)
		? ` This may match cmux 0.65.2's known large-request routing bug (manaflow-ai/cmux#21222); command size is diagnostic, not proof of the cause.${launch.scriptPath ? " The command was already scripted to keep the request small." : ""}` : "";
	return { ok: false, error: `Created cmux surface ${surfaceRef} in ${workspaceRef}, but child command dispatch was not confirmed. Inspect this surface before retrying; do not relaunch automatically. ${failure} (Launch command: ${bytes} UTF-8 bytes.)${scripted}${hint}` };
}

export async function openCommandInNewWorkspace(
	pi: ExtensionAPI,
	cwd: string,
	command: string,
	options: { title: string; workspaceTitle?: string; focus?: boolean; checkLaunch?: () => void },
): Promise<CommandOpenResult> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) return callerResult;
	const windowRef = callerResult.caller.window_ref;
	if (typeof windowRef !== "string" || !windowRef.trim()) {
		return { ok: false, error: "Could not identify the calling cmux window safely" };
	}

	// Do not pass --command here: some cmux versions type it into an interactive
	// shell. Respawn only the returned workspace's surface, like splits and tabs.
	options.checkLaunch?.();
	const creationFailure = (error: string): CommandOpenResult => ({ ok: false,
		error: `cmux workspace creation was not confirmed in ${windowRef}; a workspace may already exist. The Pi command was not dispatched. Inspect cmux before retrying; do not relaunch automatically. ${error}` });
	let result: CmuxExecResult;
	try {
		result = await execCmux(pi, [
			// The legacy new-workspace verb ignores --json on cmux 0.64.25.
			// Keep refs for command targeting and UUIDs for exact return authorization.
			"--json", "--id-format", "both", "workspace", "create",
			"--window", windowRef, "--cwd", cwd,
			"--name", formatTabTitle(options.workspaceTitle ?? options.title, "Pi"), "--focus", String(options.focus ?? true),
		]);
	} catch (error) { return creationFailure(error instanceof Error ? error.message : String(error)); }
	if (!result.ok) return creationFailure(result.error || "Failed to create cmux workspace");

	checkCreatedLaunch(options.checkLaunch);
	const parsed = parseJson<{ workspace_ref?: unknown; workspace_id?: unknown }>(result.stdout);
	const workspaceRef = [parsed?.workspace_ref, parsed?.workspace_id]
		.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim();
	if (!workspaceRef || workspaceRef === callerResult.caller.workspace_ref || workspaceRef === callerResult.caller.workspace_id
		|| (createdIds(result.stdout).workspace_id !== undefined && createdIds(result.stdout).workspace_id === callerResult.caller.workspace_id)) {
		return { ok: false, error: "Created workspace, but could not identify the new cmux workspace safely" };
	}
	const surfaceRef = getCreatedSurfaceRef(result.stdout) ?? await waitForNewSurface(pi, workspaceRef, [], undefined, options.checkLaunch);
	if (!surfaceRef || surfaceRef === callerResult.caller.surface_ref || surfaceRef === callerResult.caller.surface_id
		|| (createdIds(result.stdout).surface_id !== undefined && createdIds(result.stdout).surface_id === callerResult.caller.surface_id)) {
		return { ok: false, error: "Created workspace, but could not identify its new cmux surface safely" };
	}

	const respawnResult = await respawnSurface(pi, workspaceRef, surfaceRef, command, "Failed to start Pi in the new workspace", options.title, options.checkLaunch);
	if (!respawnResult.ok) return respawnResult;
	return { ok: true, workspaceRef, surfaceRef, source: callerResult.caller, created: createdIds(result.stdout) };
}

async function openLocalCommandSurface(
	pi: ExtensionAPI, source: CmuxCallerContext, placement: SplitDirection | "tab", command: string,
	options: OpenCommandInNewSplitOptions,
): Promise<CommandOpenResult> {
	const windowId = uuid(source.window_id), workspaceId = uuid(source.workspace_id);
	const surfaceId = uuid(source.surface_id), paneId = uuid(source.pane_id);
	if (!windowId || !workspaceId || !surfaceId || !paneId) throw new Error("Local-only launch requires exact cmux caller UUIDs");
	const method = placement === "tab" ? "surface.create" : "surface.split";
	const caps = await execCmux(pi, ["--json", "rpc", "system.capabilities", "{}"]);
	const methods = parseJson<{ methods?: unknown }>(caps.stdout)?.methods;
	if (!caps.ok || caps.stdout.length > 1_048_576 || !Array.isArray(methods) || !methods.includes(method)) throw new Error("cmux local-context creation is unavailable; no launch attempted");
	await options.beforeEffect?.(source);
	options.checkLaunch?.();
	// Long commands go through a private script so the socket request stays
	// small and survives cmux 0.65.2's 4 KiB classification window (#21222).
	const launch = prepareLaunchCommand(command);
	const initialCommand = launch.scriptPath ? launch.command : `/bin/sh -c ${shellEscape(command)}`;
	let created: Record<string, unknown>;
	try {
		// initial_command and remote_context are one server-side operation. Never
		// respawn a surface whose remote ownership might have changed after creation.
		const result = await execCmux(pi, ["--json", "--id-format", "both", "rpc", method, JSON.stringify({
			window_id: windowId, workspace_id: workspaceId, surface_id: surfaceId,
			...(placement === "tab" ? { pane_id: paneId } : { direction: placement }),
			type: "terminal", focus: options.focus ?? true, remote_context: "local",
			initial_command: initialCommand,
		})]);
		if (!result.ok) throw new Error(result.error || "cmux creation failed");
		if (result.stdout.length > 1_048_576) throw new Error("cmux creation response is too large");
		const parsed = parseJson<Record<string, unknown>>(result.stdout);
		if (!parsed || uuid(parsed.window_id) !== windowId || uuid(parsed.workspace_id) !== workspaceId
			|| !uuid(parsed.surface_id) || uuid(parsed.surface_id) === surfaceId || !uuid(parsed.pane_id)
			|| (placement === "tab" ? uuid(parsed.pane_id) !== paneId : uuid(parsed.pane_id) === paneId)
			|| parsed.type !== "terminal") throw new Error("unexpected creation identity");
		created = Object.fromEntries(["window_id", "workspace_id", "pane_id", "surface_id", "surface_ref", "type"]
			.filter(key => typeof parsed[key] === "string").map(key => [key, parsed[key]]));
		options.checkLaunch?.();
	} catch (error) {
		throw new Error(`cmux creation outcome may be uncertain; command may have started. Do not retry automatically. ${error instanceof Error ? error.message : "Creation failed"}`);
	}
	const surfaceRef = typeof created.surface_ref === "string" && /^surface:[1-9][0-9]*$/.test(created.surface_ref)
		? created.surface_ref : uuid(created.surface_id)!;
	await renameSurfaceTab(pi, workspaceId, uuid(created.surface_id)!, options.tabTitle);
	return { ok: true, workspaceRef: source.workspace_ref, surfaceRef, source, created };
}

export async function openCommandInNewSplit(
	pi: ExtensionAPI,
	direction: SplitDirection,
	command: string,
	options: OpenCommandInNewSplitOptions = {},
): Promise<CommandOpenResult> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	if (options.localOnly) return openLocalCommandSurface(pi, callerResult.caller, direction, command, options);
	const { workspace_ref: workspaceRef, surface_ref: surfaceRef } = callerResult.caller;
	// Keep a pre-creation snapshot only for the legacy discovery fallback.
	const beforePanesResult = await listPanes(pi, workspaceRef);

	const splitArgs = [
		"--json", "--id-format", "both",
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
	];
	if (options.focus !== undefined) {
		splitArgs.push("--focus", String(options.focus));
	}

	options.checkLaunch?.();
	const splitResult = await execCmux(pi, splitArgs);
	if (!splitResult.ok) {
		return { ok: false, error: splitResult.error || "Failed to create cmux split" };
	}

	checkCreatedLaunch(options.checkLaunch);
	const newSurfaceRef = getCreatedSurfaceRef(splitResult.stdout) ??
		(beforePanesResult.ok ? await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes, undefined, options.checkLaunch) : undefined);
	if (!newSurfaceRef || newSurfaceRef === surfaceRef || newSurfaceRef === callerResult.caller.surface_id
		|| (createdIds(splitResult.stdout).surface_id !== undefined && createdIds(splitResult.stdout).surface_id === callerResult.caller.surface_id)) {
		return { ok: false, error: "Created split, but could not identify the new cmux surface safely" };
	}

	const respawnResult = await respawnSurface(pi, workspaceRef, newSurfaceRef, command, "Failed to start pi in the new split", options.tabTitle, options.checkLaunch);
	if (!respawnResult.ok) {
		return respawnResult;
	}

	return { ok: true, workspaceRef, surfaceRef: newSurfaceRef, source: callerResult.caller, created: createdIds(splitResult.stdout) };
}

export async function openCommandInNewTab(
	pi: ExtensionAPI,
	command: string,
	options: OpenCommandInNewTabOptions = {},
): Promise<CommandOpenResult> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	if (options.localOnly) return openLocalCommandSurface(pi, callerResult.caller, "tab", command, options);
	const { workspace_ref: workspaceRef, pane_ref: paneRef } = callerResult.caller;
	if (!paneRef) {
		return { ok: false, error: "This command must be run from inside a cmux pane" };
	}

	// Keep a pre-creation snapshot only for the legacy discovery fallback.
	const beforePanesResult = await listPanes(pi, workspaceRef);

	options.checkLaunch?.();
	const newSurfaceResult = await execCmux(pi, [
		"--json", "--id-format", "both",
		"new-surface",
		"--type",
		"terminal",
		"--workspace",
		workspaceRef,
		"--pane",
		paneRef,
		"--focus",
		String(options.focus ?? true),
	]);
	if (!newSurfaceResult.ok) {
		return { ok: false, error: newSurfaceResult.error || "Failed to create cmux tab" };
	}

	checkCreatedLaunch(options.checkLaunch);
	const newSurfaceRef = getCreatedSurfaceRef(newSurfaceResult.stdout) ??
		(beforePanesResult.ok ? await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes, paneRef, options.checkLaunch) : undefined);
	if (!newSurfaceRef || newSurfaceRef === callerResult.caller.surface_ref || newSurfaceRef === callerResult.caller.surface_id
		|| (createdIds(newSurfaceResult.stdout).surface_id !== undefined && createdIds(newSurfaceResult.stdout).surface_id === callerResult.caller.surface_id)) {
		return { ok: false, error: "Created tab, but could not identify the new cmux surface safely" };
	}

	const respawnResult = await respawnSurface(pi, workspaceRef, newSurfaceRef, command, "Failed to start command in the new tab", options.tabTitle, options.checkLaunch);
	if (!respawnResult.ok) {
		return respawnResult;
	}

	return { ok: true, workspaceRef, surfaceRef: newSurfaceRef, source: callerResult.caller, created: createdIds(newSurfaceResult.stdout) };
}
