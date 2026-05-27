import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	buildContextualTabTitle,
	buildShellCommand,
	openCommandInNewSplit,
	openCommandInNewTab,
	type SplitDirection,
} from "./cmux-core.ts";
import { onI18nLocaleChanged, t, type I18nKey } from "./i18n.ts";

const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_SECTION_NAME = "pi-cmux";
const RESERVED_COMMAND_NAMES = new Set([
	"login",
	"logout",
	"model",
	"scoped-models",
	"settings",
	"resume",
	"new",
	"name",
	"session",
	"tree",
	"fork",
	"compact",
	"copy",
	"export",
	"share",
	"reload",
	"hotkeys",
	"changelog",
	"quit",
	"exit",
	"help",
	"cmv",
	"cmux-v",
	"cmh",
	"cmux-h",
	"cmo",
	"cmov",
	"cmoh",
	"cmt",
	"cmz",
	"cmzh",
	"z",
	"zh",
	"cmrv",
	"cmrh",
	"review-v",
	"review-h",
	"cmcv",
	"cmch",
]);

interface ConfiguredSplitCommandInput {
	run?: string;
	acceptArgs?: boolean;
	direction?: string;
	title?: string;
	description?: string;
	disabled?: boolean;
}

interface ConfiguredSplitCommand {
	run: string;
	acceptArgs: boolean;
	direction: SplitDirection;
	title?: string;
	description: string;
}

type TerminalPlacement = SplitDirection | "tab";

type OpenToolContext = Pick<ExtensionContext, "cwd">;

interface CmuxOpenTerminalParams {
	command: string;
	placement?: TerminalPlacement;
	title?: string;
	focus?: boolean;
}

const CMUX_OPEN_TERMINAL_PARAMETERS = {
	type: "object",
	additionalProperties: false,
	required: ["command"],
	properties: {
		command: {
			type: "string",
			description: "Interactive terminal command to run, for example k9s, htop, lazygit, or npm run dev",
		},
		placement: {
			type: "string",
			enum: ["right", "down", "tab"],
			default: "tab",
			description: "Where to open the command. Use tab for a new cmux tab/surface.",
		},
		title: {
			type: "string",
			description: "Optional cmux tab title. Defaults to the command.",
		},
		focus: {
			type: "boolean",
			default: true,
			description: "Whether cmux should focus the new terminal. Defaults to true.",
		},
	},
} as const;

async function openToolInSplit(
	pi: ExtensionAPI,
	ctx: OpenToolContext,
	direction: SplitDirection,
	args: string,
	title?: string,
	focus?: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const command = args.trim();
	return openCommandInNewSplit(pi, direction, buildShellCommand(ctx.cwd, command), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, title ?? command, "Tool"),
		focus,
	});
}

async function openToolInTab(
	pi: ExtensionAPI,
	ctx: OpenToolContext,
	args: string,
	title?: string,
	focus?: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const command = args.trim();
	return openCommandInNewTab(pi, buildShellCommand(ctx.cwd, command), {
		tabTitle: await buildContextualTabTitle(pi, ctx.cwd, title ?? command, "Tool"),
		focus,
	});
}

function registerOpenCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	descriptionKey: I18nKey,
	successKey: I18nKey,
): void {
	pi.registerCommand(name, {
		description: t(descriptionKey),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(t("open.usage", { name }), "warning");
				return;
			}

			const result = await openToolInSplit(pi, ctx, direction, command);
			if (result.ok) {
				ctx.ui.notify(t(successKey), "info");
			} else {
				ctx.ui.notify(t("open.failed", { error: result.error }), "error");
			}
		},
	});
}

function registerTabOpenCommand(pi: ExtensionAPI, name: string): void {
	pi.registerCommand(name, {
		description: t("open.tab.description"),
		handler: async (args, ctx) => {
			const command = args.trim();
			if (!command) {
				ctx.ui.notify(t("open.usage", { name }), "warning");
				return;
			}

			const result = await openToolInTab(pi, ctx, command, command, true);
			if (result.ok) {
				ctx.ui.notify(t("open.success.tab"), "info");
			} else {
				ctx.ui.notify(t("open.failed.tab", { error: result.error }), "error");
			}
		},
	});
}

function readJsonFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) {
		return undefined;
	}

	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			console.warn(`[pi-cmux] Ignoring non-object settings file: ${path}`);
			return undefined;
		}
		return parsed as Record<string, unknown>;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.warn(`[pi-cmux] Failed to read settings from ${path}: ${message}`);
		return undefined;
	}
}

function readPiCmuxCommands(settingsPath: string): Record<string, unknown> {
	const settings = readJsonFile(settingsPath);
	const section = settings?.[SETTINGS_SECTION_NAME];
	if (!section) {
		return {};
	}
	if (typeof section !== "object" || Array.isArray(section)) {
		console.warn(`[pi-cmux] Ignoring invalid \"${SETTINGS_SECTION_NAME}\" settings in ${settingsPath}`);
		return {};
	}

	const commands = (section as { commands?: unknown }).commands;
	if (commands === undefined) {
		return {};
	}
	if (typeof commands !== "object" || Array.isArray(commands)) {
		console.warn(`[pi-cmux] Ignoring invalid \"${SETTINGS_SECTION_NAME}.commands\" settings in ${settingsPath}`);
		return {};
	}

	return commands as Record<string, unknown>;
}

function isValidCommandName(value: string): boolean {
	return /^[a-z0-9][a-z0-9-]*$/i.test(value);
}

function getDefaultConfiguredCommandDescription(commandName: string, run: string): string {
	return `Open ${run} in a cmux split via /${commandName}`;
}

function normalizeSplitDirection(
	value: unknown,
	commandName: string,
	settingsPath: string,
): SplitDirection | undefined {
	if (value === undefined) {
		return "right";
	}
	if (value === "right" || value === "down") {
		return value;
	}

	console.warn(
		`[pi-cmux] Skipping configured command /${commandName} with invalid direction from ${settingsPath}; expected \"right\" or \"down\"`,
	);
	return undefined;
}

function normalizeConfiguredSplitCommand(
	commandName: string,
	value: unknown,
	settingsPath: string,
): ConfiguredSplitCommand | null | undefined {
	if (!isValidCommandName(commandName)) {
		console.warn(`[pi-cmux] Skipping invalid configured command name \"${commandName}\" from ${settingsPath}`);
		return undefined;
	}

	if (typeof value === "string") {
		const run = value.trim();
		if (!run) {
			console.warn(`[pi-cmux] Skipping empty configured command /${commandName} from ${settingsPath}`);
			return undefined;
		}
		return {
			run,
			acceptArgs: false,
			direction: "right",
			description: getDefaultConfiguredCommandDescription(commandName, run),
		};
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(`[pi-cmux] Skipping invalid configured command /${commandName} from ${settingsPath}`);
		return undefined;
	}

	const config = value as ConfiguredSplitCommandInput;
	if (config.disabled) {
		return null;
	}

	const run = typeof config.run === "string" ? config.run.trim() : "";
	if (!run) {
		console.warn(`[pi-cmux] Skipping configured command /${commandName} without a valid \"run\" value from ${settingsPath}`);
		return undefined;
	}

	const direction = normalizeSplitDirection(config.direction, commandName, settingsPath);
	if (!direction) {
		return undefined;
	}

	const title = typeof config.title === "string" && config.title.trim().length > 0 ? config.title.trim() : undefined;

	return {
		run,
		acceptArgs: config.acceptArgs === true,
		direction,
		title,
		description:
			typeof config.description === "string" && config.description.trim().length > 0
				? config.description.trim()
				: getDefaultConfiguredCommandDescription(commandName, run),
	};
}

function loadConfiguredSplitCommands(cwd: string): Map<string, ConfiguredSplitCommand> {
	const configuredCommands = new Map<string, ConfiguredSplitCommand>();
	const settingsPaths = [GLOBAL_SETTINGS_PATH, join(cwd, ".pi", "settings.json")];

	for (const settingsPath of settingsPaths) {
		const commands = readPiCmuxCommands(settingsPath);
		for (const [commandName, value] of Object.entries(commands)) {
			const normalized = normalizeConfiguredSplitCommand(commandName, value, settingsPath);
			if (normalized === null) {
				configuredCommands.delete(commandName);
				continue;
			}
			if (!normalized) {
				continue;
			}
			configuredCommands.set(commandName, normalized);
		}
	}

	return configuredCommands;
}

function registerConfiguredSplitCommand(
	pi: ExtensionAPI,
	commandName: string,
	config: ConfiguredSplitCommand,
): void {
	pi.registerCommand(commandName, {
		description: config.description,
		handler: async (args, ctx) => {
			const trimmedArgs = args.trim();
			if (trimmedArgs.length > 0 && !config.acceptArgs) {
				ctx.ui.notify(`Usage: /${commandName}`, "warning");
				return;
			}

			const command = trimmedArgs.length > 0 ? `${config.run} ${trimmedArgs}` : config.run;
			const result = await openToolInSplit(pi, ctx, config.direction, command, config.title ?? config.run);
			if (result.ok) {
				const location = config.direction === "right" ? "to the right" : "below";
				ctx.ui.notify(`Opened /${commandName} split ${location}`, "info");
			} else {
				ctx.ui.notify(`configured command failed: ${result.error}`, "error");
			}
		},
	});
}

function normalizeTerminalPlacement(value: unknown): TerminalPlacement {
	return value === "right" || value === "down" || value === "tab" ? value : "tab";
}

function getPlacementLabel(placement: TerminalPlacement): string {
	if (placement === "right") {
		return "right split";
	}
	if (placement === "down") {
		return "lower split";
	}
	return "tab";
}

async function openTerminalCommand(
	pi: ExtensionAPI,
	ctx: OpenToolContext,
	params: CmuxOpenTerminalParams,
): Promise<{ ok: true; placement: TerminalPlacement; command: string } | { ok: false; error: string }> {
	const command = typeof params.command === "string" ? params.command.trim() : "";
	if (!command) {
		return { ok: false, error: "Specify a command to open" };
	}

	const placement = normalizeTerminalPlacement(params.placement);
	const title = params.title?.trim() || command;
	const focus = params.focus ?? true;
	const result = placement === "tab"
		? await openToolInTab(pi, ctx, command, title, focus)
		: await openToolInSplit(pi, ctx, placement, command, title, focus);

	if (!result.ok) {
		return result;
	}

	return { ok: true, placement, command };
}

function registerAgentTerminalTool(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "cmux_open_terminal",
		label: "Open cmux terminal",
		description:
			"Open an interactive terminal command in cmux as a right split, lower split, or new tab/surface. Use for user-requested TUIs, logs, dev servers, watches, or long-running terminal views.",
		promptSnippet:
			"Open an interactive terminal command in cmux when the user asks for a tool or view in another pane, split, tab, or background terminal.",
		promptGuidelines: [
			"Use cmux_open_terminal only when the user explicitly asks to open a command in cmux, another pane, split, tab, or background terminal.",
			"Use cmux_open_terminal with placement='tab' when the user says tab, placement='right' for a side pane, and placement='down' for a below/lower pane.",
			"Use cmux_open_terminal for interactive TUIs like k9s, lazygit, htop, hunk, log tails, dev servers, or watches; do not use bash for these unless the user wants captured output.",
			"Do not open terminals proactively with cmux_open_terminal without a user request.",
		],
		parameters: CMUX_OPEN_TERMINAL_PARAMETERS as any,
		executionMode: "sequential",
		async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
			const params = rawParams as CmuxOpenTerminalParams;
			const result = await openTerminalCommand(pi, ctx, params);
			if (!result.ok) {
				throw new Error(result.error);
			}

			const location = getPlacementLabel(result.placement);
			return {
				content: [{ type: "text", text: `Opened ${result.command} in a cmux ${location}.` }],
				details: {
					command: result.command,
					placement: result.placement,
					cwd: ctx.cwd,
				},
			};
		},
	});
}

function registerOpenCommands(pi: ExtensionAPI): void {
	registerOpenCommand(
		pi,
		"cmo",
		"right",
		"open.right.description",
		"open.success.right",
	);
	registerOpenCommand(
		pi,
		"cmov",
		"right",
		"open.alias.cmo",
		"open.success.right",
	);

	registerOpenCommand(
		pi,
		"cmoh",
		"down",
		"open.down.description",
		"open.success.down",
	);

	registerTabOpenCommand(pi, "cmt");
}

function registerConfiguredSplitCommands(pi: ExtensionAPI): void {
	const registeredConfiguredNames = new Set<string>();
	for (const [commandName, config] of loadConfiguredSplitCommands(process.cwd())) {
		const normalizedName = commandName.toLowerCase();
		if (RESERVED_COMMAND_NAMES.has(normalizedName) || registeredConfiguredNames.has(normalizedName)) {
			console.warn(`[pi-cmux] Skipping configured command /${commandName}: command already exists`);
			continue;
		}
		registerConfiguredSplitCommand(pi, commandName, config);
		registeredConfiguredNames.add(normalizedName);
	}
}

export default function cmuxOpenExtension(pi: ExtensionAPI) {
	registerOpenCommands(pi);
	registerConfiguredSplitCommands(pi);
	registerAgentTerminalTool(pi);
	onI18nLocaleChanged(pi, () => {
		registerOpenCommands(pi);
	});
}
