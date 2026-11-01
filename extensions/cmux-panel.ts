import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execCmux, getCallerInfo } from "./cmux-core.ts";
import { uuid } from "../lib/orientation/state.ts";
import { assertLocalWorkspace } from "../lib/ssh/terminal.ts";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Strict opt-in; project false overrides global true. Invalid settings fail closed. */
function panelAutoOpen(cwd: string): boolean {
	let enabled = false;
	for (const path of [join(getAgentDir(), "settings.json"), join(cwd, ".pi", "settings.json")]) {
		try {
			const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!object(settings)) throw new Error("Invalid settings");
			const section = settings["pi-cmux"];
			if (section === undefined) continue;
			if (!object(section)) throw new Error("Invalid package settings");
			const panel = section.panel;
			if (panel === undefined) continue;
			if (!object(panel)) throw new Error("Invalid panel settings");
			if (panel.autoOpen === undefined) continue;
			if (typeof panel.autoOpen !== "boolean") throw new Error("Invalid autoOpen setting");
			enabled = panel.autoOpen;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			console.warn(`[pi-cmux] Panel auto-open disabled: invalid or unreadable settings in ${path}`);
			return false;
		}
	}
	return enabled;
}

function installedPanelExists(): boolean {
	try {
		return lstatSync(join(homedir(), ".config", "cmux", "sidebars", "agent-state-panel.js")).isFile();
	} catch {
		return false;
	}
}

export default function cmuxPanelExtension(pi: ExtensionAPI) {
	let attempted = false;
	let controller: AbortController | undefined;

	pi.on("session_shutdown", () => controller?.abort());
	pi.on("session_start", async (event, ctx) => {
		// /new, /resume and /fork must not undo a person's manual close.
		if (attempted || (event.reason !== "startup" && event.reason !== "reload")) return;
		attempted = true; // Consume before awaiting, including failures and disabled starts.
		if (ctx.mode !== "tui") return;
		const workspaceId = uuid(process.env.CMUX_WORKSPACE_ID);
		const surfaceId = uuid(process.env.CMUX_SURFACE_ID);
		if (!workspaceId || !surfaceId || !panelAutoOpen(ctx.cwd) || !installedPanelExists()) return;

		controller = new AbortController();
		const { signal } = controller;
		try {
			const identified = await getCallerInfo(pi, signal);
			if (signal.aborted || !identified.ok) return;
			const source = identified.caller;
			if (!source.window_id || source.workspace_id !== workspaceId || source.surface_id !== surfaceId) return;
			await assertLocalWorkspace(pi, source);
			if (signal.aborted || uuid(process.env.CMUX_WORKSPACE_ID) !== workspaceId
				|| uuid(process.env.CMUX_SURFACE_ID) !== surfaceId || !installedPanelExists()) return;

			const result = await execCmux(pi, [
				"right-sidebar", "set", "custom", "agent-state-panel", "--workspace", workspaceId, "--no-focus",
			], signal);
			if (!result.ok && !signal.aborted) console.warn("[pi-cmux] Agent panel auto-open unconfirmed; no retry attempted");
		} catch {
			if (!signal.aborted) console.warn("[pi-cmux] Agent panel auto-open unavailable; no retry attempted");
		}
	});
}
