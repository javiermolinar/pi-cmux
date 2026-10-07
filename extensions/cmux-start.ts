import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { resolveHandoffTarget } from "./cmux-continue.ts";
import {
	describePiPlacement,
	openPiSession,
	PI_LAUNCH_PROPERTIES,
	validatePiLaunchOptions,
	type PiLaunchOptions,
} from "./cmux-pi.ts";

interface StartPiParams extends Omit<PiLaunchOptions, "sessionFile"> {
	cwd?: string;
	continueSession?: boolean;
	branch?: string;
	fromRef?: string;
}

const PARAMETERS = {
	type: "object",
	additionalProperties: false,
	properties: {
		...PI_LAUNCH_PROPERTIES,
		cwd: {
			type: "string", minLength: 1,
			description: "Working directory for a fresh session. Accepts an absolute path, a path relative to the current session, or ~/…; must be an existing directory. Defaults to the current session's directory. Cannot be combined with continueSession=true.",
		},
		prompt: {
			type: "string",
			description: "Initial task for a fresh session, or handoff notes (goal, progress, next steps, constraints) when continuing.",
		},
		continueSession: {
			type: "boolean", default: false,
			description: "Hand off the current task with context. Set true only when the user explicitly asks to hand off, continue, or inherit this conversation. Defaults to a fresh session.",
		},
		branch: {
			type: "string",
			description: "Create a new branch worktree for the handoff. Requires continueSession=true; receives summary context, not full history or uncommitted changes.",
		},
		fromRef: { type: "string", description: "Optional base git ref for branch. Requires branch." },
	},
} as const;

async function resolveStartDirectory(value: string | undefined, baseDir: string): Promise<string> {
	if (value === undefined) return baseDir;
	const path = value.trim();
	if (!path) throw new Error("Specify a non-empty cwd path");
	if (path.includes("\0")) throw new Error("cwd must not contain NUL characters");
	const expanded = path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
	const cwd = resolve(baseDir, expanded);
	let info;
	try {
		info = await stat(cwd);
	} catch (error) {
		throw new Error(`Cannot access cwd ${cwd}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (!info.isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
	return cwd;
}

function getHandoffLeaf(ctx: ExtensionContext, toolCallId: string): string | null {
	// A tool runs before its own result is persisted. Exclude its entire assistant
	// tool-call batch, including sibling results, so the child has no pending calls.
	const callEntry = ctx.sessionManager.getBranch().find((entry) =>
		entry.type === "message" && entry.message.role === "assistant" &&
		entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId));
	return callEntry ? callEntry.parentId : ctx.sessionManager.getLeafId();
}

export default function cmuxStartExtension(pi: ExtensionAPI) {
	pi.registerCommand("cmn", {
		description: "Start a fresh Pi chat in a new left-sidebar workspace: /cmn <prompt>",
		handler: async (args, ctx) => {
			const prompt = args.trim();
			if (!prompt) {
				ctx.ui.notify("Usage: /cmn <prompt>", "warning");
				return;
			}
			try {
				const result = await openPiSession(pi, ctx.cwd, { prompt });
				if (!result.ok) throw new Error(result.error);
				ctx.ui.notify(`Opened a new sidebar chat: ${result.title}`, "info");
			} catch (error) {
				ctx.ui.notify(`new chat failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerTool({
		name: "cmux_start_pi",
		label: "Start Pi in cmux",
		description: "Start an independent Pi chat in a new cmux left-sidebar workspace (default), split, or tab. Start fresh in the current or a specified directory, or explicitly hand off the current task with conversation context, optionally in a new branch worktree. Not a managed subagent: results are not returned to this chat. The source session stays open.",
		promptSnippet: "Start a user-requested Pi agent or hand off a task to a new agent in the cmux sidebar, with optional split/tab placement.",
		promptGuidelines: [
			"Use cmux_start_pi only when the user explicitly asks to start another Pi agent/session or hand off the current task. Do not create agents proactively.",
			"Default to placement='workspace' for a new agent or sidebar conversation. Use 'right' or 'down' for an explicit split, and 'tab' for a tab within the current workspace.",
			"Sessions are fresh by default. Set continueSession=true only for an explicit handoff, continuation, or request to inherit this conversation.",
			"When the user requests a fresh session in another repo or directory, pass its path through cwd. Relative paths resolve from the current session; ~/ is supported. Omit cwd for handoffs, which retain the source directory or use the new worktree.",
			"Supply a short task-specific title for the sidebar. For reviews, pass the user's requested review tool or workflow in prompt; do not prescribe one.",
			"For handoffs, include a concise prompt with the goal, progress, next steps, and constraints. Worktree handoffs receive this summary, not the full history; uncommitted files are not copied.",
			"Pass task text through prompt and model settings through provider, model, and thinking; do not construct a Pi shell command with cmux_open_terminal or bash.",
			"A handoff leaves this session open. After confirming success, leave the handed-off work to the new agent unless the user asks for parallel work.",
		],
		parameters: PARAMETERS as any,
		executionMode: "sequential",
		async execute(toolCallId, rawParams, signal, _onUpdate, ctx) {
			const params = rawParams as StartPiParams;
			validatePiLaunchOptions(params);
			const branch = params.branch?.trim();
			const fromRef = params.fromRef?.trim();
			if (params.branch !== undefined && !branch) throw new Error("Specify a non-empty branch name");
			if (params.fromRef !== undefined && !fromRef) throw new Error("Specify a non-empty base ref");
			if (branch && !params.continueSession) throw new Error("branch requires continueSession=true");
			if (fromRef && !branch) throw new Error("fromRef requires branch");
			if (params.cwd !== undefined && params.continueSession) throw new Error("cwd cannot be combined with continueSession=true");
			signal?.throwIfAborted();
			let cwd = await resolveStartDirectory(params.cwd, ctx.cwd);
			let sessionFile: string | undefined;
			let prompt = params.prompt?.trim();
			if (params.continueSession) {
				// Capture the boundary before asynchronous repository inspection.
				const leafId = getHandoffLeaf(ctx, toolCallId);
				const result = await resolveHandoffTarget(pi, ctx, branch
					? { mode: "worktree-create", branch, fromRef, note: prompt }
					: { mode: "handoff", note: prompt }, leafId);
				if (!result.ok) throw new Error(result.error);
				({ cwd, sessionFile, prompt } = result.target);
			}

			const title = params.title?.trim() || (params.continueSession ? ctx.sessionManager.getSessionName() : undefined)
				|| params.prompt?.trim() || (params.continueSession ? "Continue" : "Pi");
			signal?.throwIfAborted();
			const result = await openPiSession(pi, cwd, { ...params, sessionFile, prompt, title });
			if (!result.ok) throw new Error(result.error);
			const location = describePiPlacement(result.placement);
			return {
				content: [{ type: "text", text: `Started ${params.continueSession ? "a handoff" : "a fresh Pi session"} in a new cmux ${location}: ${result.title}. Working directory: ${cwd}. The source session remains open.` }],
				details: {
					placement: result.placement, cwd, title: result.title,
					continueSession: params.continueSession ?? false, sessionFile,
					workspaceRef: result.workspaceRef,
				},
			};
		},
	});
}
