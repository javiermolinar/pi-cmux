import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { capturePiLaunch, encodeSshLaunch, withSshLaunchEnvironment } from "../lib/ssh/launch.ts";
import { assertLocalWorkspace } from "../lib/ssh/terminal.ts";
import { getSshTargetRuntime } from "../lib/ssh/runtime.ts";
import { conversationChildren, currentConversation, prepareOrientation, rememberChildConversation, validateRelation, type RelationOptions } from "../lib/orientation/runtime.ts";
import { encodeBootstrap, orientedTitle, type Bootstrap } from "../lib/orientation/state.ts";
import { navigationHints } from "../lib/orientation/hints.ts";
import {
	getProjectName,
	buildPiCommand,
	formatTabTitle,
	getCallerInfo,
	openCommandInNewSplit,
	openCommandInNewTab,
	openCommandInNewWorkspace,
	type PiCommandOptions,
	type SplitDirection,
} from "./cmux-core.ts";

export type PiPlacement = "workspace" | "tab" | SplitDirection;

export interface PiLaunchOptions extends PiCommandOptions, RelationOptions {
	placement?: PiPlacement;
	title?: string;
	/** Internal task label before handoff/return instructions are appended. Empty means no task name. */
	taskTitle?: string;
	focus?: boolean;
}

export const PI_LAUNCH_PROPERTIES = {
	placement: {
		type: "string", enum: ["workspace", "right", "down", "tab"],
		description: "Explicit placement overrides task-aware defaults: independent task → workspace; first active same-task agent/reviewer → right split; additional/background same-task agents and handoffs → tab. Tabs/splits stay in the caller's workspace.",
	},
	provider: { type: "string", description: "Optional Pi provider. Requires model; omit both to use Pi's normal model selection." },
	model: { type: "string", description: "Optional Pi model pattern or ID, including provider/model and model:thinking forms." },
	thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], description: "Optional Pi thinking level." },
	title: { type: "string", description: "Short task title for the sidebar workspace or tab." },
	focus: { type: "boolean", default: true, description: "Focus the new workspace or terminal. Set false to open it in the background." },
	related: { type: "boolean", description: "Share the originating conversation's task marker without copying history. Use true for another agent working on the same task; defaults to false for unrelated chats." },
	role: { type: "string", enum: ["chat", "review", "continue"], description: "Conversation role. review and continue imply related=true; role alone never copies conversation history." },
} as const;

export function validatePiLaunchOptions(options: PiLaunchOptions): void {
	validateRelation(options);
	if (!["workspace", "right", "down", "tab"].includes(options.placement ?? "workspace")) {
		throw new Error("Invalid Pi placement");
	}
	if (options.provider?.trim() && !options.model?.trim()) throw new Error("provider requires model");
}

export function resolvePiPlacement(pi: ExtensionAPI, options: PiLaunchOptions): PiPlacement {
	if (options.placement !== undefined) return options.placement;
	const related = options.related ?? (options.role === "review" || options.role === "continue");
	if (!related) return "workspace";
	if (options.role === "continue" || options.focus === false) return "tab";
	const taskId = currentConversation(pi)?.state.taskId;
	const hasRelatedSplit = conversationChildren(pi).some(child => child.taskId === taskId && (child.placement === "right" || child.placement === "down"));
	return hasRelatedSplit ? "tab" : "right";
}

export function describePiPlacement(placement: PiPlacement): string {
	return placement === "workspace" ? "sidebar workspace" : placement === "tab" ? "tab" : `${placement} split`;
}

// The optional check must be side-effect-free: helpers repeat it at dispatch boundaries.
export async function openPiSession(pi: ExtensionAPI, cwd: string, options: PiLaunchOptions, fallbackTitle = "Pi", beforeLaunch?: (seed: Bootstrap | undefined) => void) {
	validatePiLaunchOptions(options);
	const launch = capturePiLaunch(pi, cwd);
	try {
		const placement = resolvePiPlacement(pi, options);
		if (launch.ticket && placement === "workspace") throw new Error("SSH Pi workspace creation is unsupported; request a local tab or split");
		if (launch.ticket && options.role === "continue") throw new Error("SSH handoffs are unsupported");
		launch.check();
		const protectedLaunch = !!getSshTargetRuntime(pi);
		if (protectedLaunch) {
			const caller = await getCallerInfo(pi); launch.check();
			if (!caller.ok) throw new Error(caller.error);
			await assertLocalWorkspace(pi, caller.caller); launch.check();
		}
		// SSH launches must not probe the local repository for remote task context.
		const project = launch.ticket ? basename(launch.ticket.target.remoteCwd) || fallbackTitle : await getProjectName(pi, cwd);
		const topic = formatTabTitle(options.title?.trim() || (options.taskTitle ?? options.prompt), project);
		const workspaceTitle = formatTabTitle(options.title, project);
		launch.check();
		const seed = prepareOrientation(pi, options, topic);
		const checkLaunch = () => {
			launch.check();
			const origin = seed?.origin, own = origin && currentConversation(pi);
			if (origin && (!own || own.state.sessionId !== origin.sessionId || own.state.conversationId !== origin.conversationId
				|| own.state.taskId !== origin.taskId || own.target.surfaceId !== origin.target.surfaceId)) throw new Error("Launch origin binding changed");
			beforeLaunch?.(seed);
		};
		checkLaunch();
		const title = seed ? orientedTitle(seed, topic) : topic;
		const command = withSshLaunchEnvironment(buildPiCommand(cwd, { ...options, orientationBootstrap: seed && encodeBootstrap(seed), provider: options.provider?.trim(), model: options.model?.trim() }),
			launch.ticket ? encodeSshLaunch(launch.ticket, options.sessionFile) : undefined);
		const focus = options.focus ?? true;
		const protectedOptions = protectedLaunch ? { localOnly: true, beforeEffect: async (source: Parameters<typeof assertLocalWorkspace>[1]) => {
			checkLaunch(); await assertLocalWorkspace(pi, source); checkLaunch();
		} } : {};
		const result = placement === "workspace"
			? await openCommandInNewWorkspace(pi, cwd, command, { title, workspaceTitle, focus, checkLaunch })
			: placement === "tab"
				? await openCommandInNewTab(pi, command, { tabTitle: title, focus, checkLaunch, ...protectedOptions })
				: await openCommandInNewSplit(pi, placement, command, { tabTitle: title, focus, checkLaunch, ...protectedOptions });
		// Record exact created children before later checks can report an uncertain outcome.
		if (result.ok) rememberChildConversation(pi, seed, result.created?.surface_id, placement);
		if (result.ok && launch.ticket) {
			try { checkLaunch(); } catch { throw new Error("Pi creation outcome is uncertain after context change; Pi may have started. Do not retry automatically"); }
		}
		if (!result.ok) return result;
		return {
			ok: true as const,
			placement, cwd, title,
			workspaceRef: result.workspaceRef, surfaceRef: result.surfaceRef, source: result.source, created: result.created,
			orientation: seed, navigation: navigationHints(seed),
		};
	} finally { launch.close(); }
}
