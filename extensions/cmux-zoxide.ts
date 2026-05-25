import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

const ZOXIDE_TIMEOUT_MS = 5000;
const MAX_COMPLETIONS = 10;

function expandHome(value: string): string {
	if (value === "~") {
		return os.homedir();
	}
	if (value.startsWith("~/")) {
		return path.join(os.homedir(), value.slice(2));
	}
	return value;
}

function resolveDirectoryCandidate(value: string, baseDir: string): string | undefined {
	const trimmed = value.trim();
	if (!trimmed) {
		return undefined;
	}
	const expanded = expandHome(trimmed);
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
	if (!existsSync(resolved)) {
		return undefined;
	}
	return statSync(resolved).isDirectory() ? resolved : undefined;
}

function getZoxideMatches(prefix: string): string[] {
	const query = prefix.trim();
	if (!query) {
		return [];
	}
	try {
		const output = execFileSync("zoxide", ["query", "-l", ...query.split(/\s+/)], {
			encoding: "utf8",
			timeout: ZOXIDE_TIMEOUT_MS,
		});
		return output
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(0, MAX_COMPLETIONS);
	} catch {
		return [];
	}
}

async function resolveZoxideTarget(
	pi: ExtensionAPI,
	query: string,
	baseDir: string,
	commandName: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	const directDirectory = resolveDirectoryCandidate(query, baseDir);
	if (directDirectory) {
		return { ok: true, path: directDirectory };
	}

	const keywords = query.trim().split(/\s+/).filter((part) => part.length > 0);
	if (keywords.length === 0) {
		return { ok: false, error: `Usage: /${commandName} <query>` };
	}

	const result = await pi.exec("zoxide", ["query", ...keywords], { timeout: ZOXIDE_TIMEOUT_MS });
	if (result.killed) {
		return { ok: false, error: "zoxide query timed out" };
	}
	if (result.code !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || "No zoxide match found";
		return { ok: false, error: message };
	}

	const targetPath = result.stdout.trim();
	if (!targetPath) {
		return { ok: false, error: "No zoxide match found" };
	}

	return { ok: true, path: targetPath };
}

async function openPiInZoxideSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	query: string,
	direction: SplitDirection,
	commandName: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const targetResult = await resolveZoxideTarget(pi, query, ctx.cwd, commandName);
	if (!targetResult.ok) {
		return targetResult;
	}

	return openCommandInNewSplit(pi, direction, buildPiCommand(targetResult.path));
}

function registerZoxideCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		getArgumentCompletions: (prefix) => {
			const matches = getZoxideMatches(prefix);
			return matches.length > 0 ? matches.map((match) => ({ value: match, label: match })) : null;
		},
		handler: async (args, ctx) => {
			const query = args.trim();
			if (!query) {
				ctx.ui.notify(`Usage: /${name} <query>`, "warning");
				return;
			}

			const result = await openPiInZoxideSplit(pi, ctx, query, direction, name);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`zoxide failed: ${result.error}`, "error");
			}
		},
	});
}

export default function cmuxZoxideExtension(pi: ExtensionAPI) {
	registerZoxideCommand(
		pi,
		"cmz",
		"right",
		"Open a new right split for a zoxide directory match and start pi there",
		"Opened a new zoxide split to the right",
	);
	registerZoxideCommand(
		pi,
		"z",
		"right",
		"Alias for /cmz",
		"Opened a new zoxide split to the right",
	);

	registerZoxideCommand(
		pi,
		"cmzh",
		"down",
		"Open a new lower split for a zoxide directory match and start pi there",
		"Opened a new zoxide split below",
	);
	registerZoxideCommand(
		pi,
		"zh",
		"down",
		"Alias for /cmzh",
		"Opened a new zoxide split below",
	);
}
