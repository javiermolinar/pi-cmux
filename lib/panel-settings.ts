import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface PanelSettingsResolution {
	autoOpen: boolean;
	source: "default" | "global" | "project" | "invalid";
	path?: string;
	errors: { path: string; detail: string }[];
}
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
/** Strict opt-in, global then project. Any invalid/unreadable settings fail closed. */
export function resolvePanelSettings(cwd: string, options: { agentDir?: string } = {}): PanelSettingsResolution {
	let result: PanelSettingsResolution = { autoOpen: false, source: "default", errors: [] };
	for (const [source, path] of [
		["global", join(options.agentDir ?? getAgentDir(), "settings.json")],
		["project", join(cwd, ".pi", "settings.json")],
	] as const) {
		try {
			const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (!object(settings)) throw new Error("Invalid settings object");
			const section = settings["pi-cmux"];
			if (section === undefined) continue;
			if (!object(section)) throw new Error("Invalid pi-cmux settings object");
			const panel = section.panel;
			if (panel === undefined) continue;
			if (!object(panel)) throw new Error("Invalid panel settings object");
			if (panel.autoOpen === undefined) continue;
			if (typeof panel.autoOpen !== "boolean") throw new Error("panel.autoOpen must be boolean");
			result = { autoOpen: panel.autoOpen, source, path, errors: [] };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			return { autoOpen: false, source: "invalid", path, errors: [{ path, detail: error instanceof Error ? error.message : String(error) }] };
		}
	}
	return result;
}
