import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CMUX_TIMEOUT_MS = 5000;
const SPLIT_READY_ATTEMPTS = 20;
const SPLIT_READY_DELAY_MS = 150;
const SURFACE_BOOT_DELAY_MS = 250;

export type SplitDirection = "right" | "down";

interface CmuxCallerInfo {
	workspace_ref?: string;
	surface_ref?: string;
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

interface CmuxExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

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

export function shellEscape(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPiCommand(cwd: string, options?: { sessionFile?: string; prompt?: string }): string {
	const commandParts = ["cd", shellEscape(cwd), "&&", "exec", "pi"];
	if (options?.sessionFile) {
		commandParts.push("--session", shellEscape(options.sessionFile));
	}
	const prompt = options?.prompt?.trim();
	if (prompt) {
		commandParts.push(shellEscape(prompt));
	}
	return commandParts.join(" ");
}

export function buildShellCommand(cwd: string, command: string): string {
	return ["cd", shellEscape(cwd), "&&", "exec", "sh", "-lc", shellEscape(command)].join(" ");
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

async function execCmux(pi: ExtensionAPI, args: string[]): Promise<CmuxExecResult> {
	const result = await pi.exec("cmux", args, { timeout: CMUX_TIMEOUT_MS });
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

async function getCallerInfo(pi: ExtensionAPI): Promise<{ ok: true; caller: Required<CmuxCallerInfo> } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "identify"]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to identify cmux caller" };
	}

	const parsed = parseJson<CmuxIdentifyResponse>(result.stdout);
	const workspaceRef = parsed?.caller?.workspace_ref;
	const surfaceRef = parsed?.caller?.surface_ref;
	if (!workspaceRef || !surfaceRef) {
		return { ok: false, error: "This command must be run from inside a cmux surface" };
	}

	return { ok: true, caller: { workspace_ref: workspaceRef, surface_ref: surfaceRef } };
}

async function listPanes(pi: ExtensionAPI, workspaceRef: string): Promise<{ ok: true; panes: CmuxPaneInfo[] } | { ok: false; error: string }> {
	const result = await execCmux(pi, ["--json", "list-panes", "--workspace", workspaceRef]);
	if (!result.ok) {
		return { ok: false, error: result.error || "Failed to list cmux panes" };
	}

	const parsed = parseJson<CmuxListPanesResponse>(result.stdout);
	return { ok: true, panes: parsed?.panes ?? [] };
}

async function waitForNewSurface(pi: ExtensionAPI, workspaceRef: string, previousPanes: CmuxPaneInfo[]): Promise<string | undefined> {
	const previousPaneRefs = new Set(previousPanes.map((pane) => pane.ref).filter((ref): ref is string => Boolean(ref)));
	const previousSurfaceRefs = collectSurfaceRefs(previousPanes);

	for (let attempt = 0; attempt < SPLIT_READY_ATTEMPTS; attempt += 1) {
		const panesResult = await listPanes(pi, workspaceRef);
		if (!panesResult.ok) {
			return undefined;
		}

		for (const pane of panesResult.panes) {
			if (pane.ref && !previousPaneRefs.has(pane.ref)) {
				if (pane.selected_surface_ref) {
					return pane.selected_surface_ref;
				}
				const firstSurfaceRef = pane.surface_refs?.find((ref) => !previousSurfaceRefs.has(ref));
				if (firstSurfaceRef) {
					return firstSurfaceRef;
				}
			}
		}

		for (const pane of panesResult.panes) {
			for (const surfaceRef of pane.surface_refs ?? []) {
				if (!previousSurfaceRefs.has(surfaceRef)) {
					return surfaceRef;
				}
			}
		}

		await delay(SPLIT_READY_DELAY_MS);
	}

	return undefined;
}

export async function openCommandInNewSplit(
	pi: ExtensionAPI,
	direction: SplitDirection,
	command: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) {
		return callerResult;
	}

	const { workspace_ref: workspaceRef, surface_ref: surfaceRef } = callerResult.caller;
	const beforePanesResult = await listPanes(pi, workspaceRef);
	if (!beforePanesResult.ok) {
		return beforePanesResult;
	}

	const splitResult = await execCmux(pi, [
		"new-split",
		direction,
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
	]);
	if (!splitResult.ok) {
		return { ok: false, error: splitResult.error || "Failed to create cmux split" };
	}

	const newSurfaceRef = await waitForNewSurface(pi, workspaceRef, beforePanesResult.panes);
	if (!newSurfaceRef) {
		return { ok: false, error: "Created split, but could not find the new cmux surface" };
	}

	await delay(SURFACE_BOOT_DELAY_MS);

	const respawnResult = await execCmux(pi, [
		"respawn-pane",
		"--workspace",
		workspaceRef,
		"--surface",
		newSurfaceRef,
		"--command",
		command,
	]);
	if (!respawnResult.ok) {
		return { ok: false, error: respawnResult.error || "Failed to start pi in the new split" };
	}

	return { ok: true };
}
