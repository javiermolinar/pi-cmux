import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildShellCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

async function openToolInSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	args: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return openCommandInNewSplit(pi, direction, buildShellCommand(ctx.cwd, args.trim()));
}

function registerOpenCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(`Usage: /${name} <command...>`, "warning");
				return;
			}

			const result = await openToolInSplit(pi, ctx, direction, command);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`tool split failed: ${result.error}`, "error");
			}
		},
	});
}

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	registerOpenCommand(
		pi,
		"cmo",
		"right",
		"Open a new right split and run any shell command there",
		"Opened a tool split to the right",
	);
	registerOpenCommand(
		pi,
		"cmov",
		"right",
		"Alias for /cmo",
		"Opened a tool split to the right",
	);

	registerOpenCommand(
		pi,
		"cmoh",
		"down",
		"Open a new lower split and run any shell command there",
		"Opened a tool split below",
	);
}
