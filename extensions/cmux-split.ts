import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

async function openPiInSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	args: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return openCommandInNewSplit(
		pi,
		direction,
		buildPiCommand(ctx.cwd, { prompt: args.trim().length > 0 ? args : undefined }),
	);
}

function registerSplitCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const result = await openPiInSplit(pi, ctx, direction, args);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`cmux split failed: ${result.error}`, "error");
			}
		},
	});
}

export default function cmuxSplitExtension(pi: ExtensionAPI) {
	registerSplitCommand(
		pi,
		"cmv",
		"right",
		"Open a new vertical cmux split and start a fresh pi session",
		"Opened a new vertical cmux split",
	);
	registerSplitCommand(
		pi,
		"cmux-v",
		"right",
		"Alias for /cmv",
		"Opened a new vertical cmux split",
	);

	registerSplitCommand(
		pi,
		"cmh",
		"down",
		"Open a new horizontal cmux split and start a fresh pi session",
		"Opened a new horizontal cmux split",
	);
	registerSplitCommand(
		pi,
		"cmux-h",
		"down",
		"Alias for /cmh",
		"Opened a new horizontal cmux split",
	);
}
