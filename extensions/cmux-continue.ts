import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SplitDirection } from "./cmux-core.ts";
import { openPiSession } from "./cmux-pi.ts";
import { capturePiLaunch, hasSshIntent } from "../lib/ssh/launch.ts";
import {
	ensureCreatedBranchWorktree,
	getGitRepoInfo,
	type GitRepoInfo,
} from "./git-core.ts";

const MAX_TEXT_LENGTH = 280;
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");

const promptTemplateCache = new Map<string, string>();

type HandoffSource = Pick<ExtensionContext, "cwd" | "sessionManager">;

export type ContinueRequest =
	| { mode: "handoff"; note?: string }
	| { mode: "worktree-create"; branch: string; fromRef?: string; note?: string };

interface HandoffContext {
	sourceCwd: string;
	sourceSessionName?: string;
	sourceSessionFile?: string;
	currentTask?: string;
	repo?: GitRepoInfo;
	modifiedFiles: string[];
	newFiles: string[];
	otherStatusLines: string[];
	note?: string;
	fromRef?: string;
	targetBranch?: string;
	targetWorktreePath?: string;
}

interface HandoffTarget {
	cwd: string;
	sessionFile: string;
	prompt: string;
}

interface MessageLike {
	role?: string;
	content?: unknown;
}

interface SessionMessageEntryLike {
	type?: string;
	message?: MessageLike;
}

function truncateText(text: string, maxLength: number = MAX_TEXT_LENGTH): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxLength) return trimmed;
	return `${trimmed.slice(0, maxLength - 3)}...`;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function getContinueUsage(commandName: string): string {
	return `Usage: /${commandName} [note]  |  /${commandName} -c <branch> [--from <ref>] [note]`;
}

function parseContinueArgs(args: string): { ok: true; request: ContinueRequest } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { ok: true, request: { mode: "handoff" } };
	}

	const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
	const [first, ...rest] = tokens;
	if (first === "-t" || first === "--tree" || first === "--worktree") {
		return { ok: false, error: "Existing-branch worktree mode is disabled for now; use -c <branch> to create a new worktree branch" };
	}
	if (first === "-c" || first === "--create") {
		if (rest.length < 1) {
			return { ok: false, error: "Create-worktree mode requires a branch name" };
		}
		const [branch, ...remaining] = rest;
		let fromRef: string | undefined;
		const noteParts: string[] = [];
		for (let index = 0; index < remaining.length; index += 1) {
			const token = remaining[index];
			if (token === "--from" || token === "-f") {
				const next = remaining[index + 1];
				if (!next) {
					return { ok: false, error: "--from requires a git ref" };
				}
				fromRef = next;
				index += 1;
				continue;
			}
			noteParts.push(token);
		}
		const note = noteParts.join(" ").trim() || undefined;
		return { ok: true, request: { mode: "worktree-create", branch, fromRef, note } };
	}
	if (trimmed.startsWith("-")) {
		return { ok: false, error: `Unknown flag: ${first}` };
	}

	return { ok: true, request: { mode: "handoff", note: trimmed } };
}

function isSessionMessageEntry(entry: unknown): entry is SessionMessageEntryLike {
	return typeof entry === "object" && entry !== null && (entry as { type?: unknown }).type === "message";
}

function getMessageText(message: MessageLike | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") {
		const text = normalizeWhitespace(message.content);
		return text.length > 0 ? truncateText(text) : undefined;
	}
	if (!Array.isArray(message.content)) return undefined;
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => {
			return typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string";
		})
		.map((part) => normalizeWhitespace(part.text))
		.filter((part) => part.length > 0)
		.join(" ")
		.trim();
	return text.length > 0 ? truncateText(text) : undefined;
}

function isControlMessageText(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return true;
	if (trimmed.startsWith("/") || trimmed.startsWith(":")) return true;
	if (/^run (?:\/|:)reload/i.test(trimmed)) return true;
	return false;
}

function isSyntheticHandoffText(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("Handoff context from another Pi pane:") || trimmed.startsWith("Continue the current task from this new pane.") || trimmed.startsWith("Continue the current task in this git worktree for branch ");
}

function isLowSignalTaskText(text: string): boolean {
	const normalized = text.trim().toLowerCase();
	if (!normalized) return true;
	if ([
		"yes",
		"ok",
		"okay",
		"yep",
		"yeah",
		"sure",
		"nice",
		"cool",
		"great",
		"go ahead",
		"do it",
		"makes sense",
		"ok makes sense",
		"okay makes sense",
	].includes(normalized)) {
		return true;
	}
	return normalized.split(/\s+/).length === 1 && normalized.length <= 4;
}

function findRecentTaskText(entries: readonly unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!isSessionMessageEntry(entry) || entry.message?.role !== "user") continue;
		const text = getMessageText(entry.message);
		if (!text || isControlMessageText(text) || isSyntheticHandoffText(text) || isLowSignalTaskText(text)) continue;
		return text;
	}
	return undefined;
}

function shouldIgnoreStatusPath(file: string): boolean {
	return file === ".agents" || file.startsWith(".agents/") || file === ".pi" || file.startsWith(".pi/") || file === "node_modules" || file.startsWith("node_modules/");
}

function summarizeGitStatusLines(statusLines: readonly string[]): { modifiedFiles: string[]; newFiles: string[]; otherStatusLines: string[] } {
	const modifiedFiles: string[] = [];
	const newFiles: string[] = [];
	const otherStatusLines: string[] = [];

	for (const line of statusLines) {
		const code = line.slice(0, 2);
		const file = line.slice(3).trim();
		if (!file || shouldIgnoreStatusPath(file)) {
			continue;
		}
		if (code === "??") {
			newFiles.push(file);
			continue;
		}
		if (code.includes("M") || code.includes("A") || code.includes("D") || code.includes("R") || code.includes("C")) {
			modifiedFiles.push(file);
			continue;
		}
		otherStatusLines.push(line);
	}

	return { modifiedFiles, newFiles, otherStatusLines };
}

function buildHandoffSummary(context: HandoffContext, includeLineageHint: boolean): string {
	const lines = ["Handoff context from another Pi pane:"];
	lines.push(`- Source cwd: ${context.sourceCwd}`);
	if (context.sourceSessionName) lines.push(`- Session name: ${context.sourceSessionName}`);
	if (context.repo?.branch) lines.push(`- Source branch: ${context.repo.branch}`);
	if (context.targetBranch) lines.push(`- Target branch: ${context.targetBranch}`);
	if (context.fromRef) lines.push(`- Base ref: ${context.fromRef}`);
	if (context.targetWorktreePath) lines.push(`- Target worktree: ${context.targetWorktreePath}`);
	if (context.currentTask) lines.push(`- Current task: ${context.currentTask}`);
	if (context.note) lines.push(`- Focus note: ${context.note}`);
	if (context.modifiedFiles.length > 0) {
		lines.push("- Modified files:");
		for (const file of context.modifiedFiles) {
			lines.push(`  ${file}`);
		}
	}
	if (context.newFiles.length > 0) {
		lines.push("- New files:");
		for (const file of context.newFiles) {
			lines.push(`  ${file}`);
		}
	}
	if (context.otherStatusLines.length > 0) {
		lines.push("- Other git status:");
		for (const line of context.otherStatusLines) {
			lines.push(`  ${line}`);
		}
	}
	if (includeLineageHint) {
		lines.push("- This session was forked from the current conversation path so prior context is already available here.");
	}
	return lines.join("\n");
}

function readPromptTemplate(name: string): string {
	const cached = promptTemplateCache.get(name);
	if (cached) return cached;
	const template = readFileSync(join(TEMPLATE_DIR, name), "utf8");
	promptTemplateCache.set(name, template);
	return template;
}

function renderPromptTemplate(name: string, replacements: Record<string, string>): string {
	let template = readPromptTemplate(name);
	for (const [key, value] of Object.entries(replacements)) {
		template = template.replaceAll(`{{${key}}}`, value);
	}
	return template.trim();
}

function buildFocusNoteSentence(note?: string): string {
	return note ? ` Focus on: ${note}.` : "";
}

function buildSameCheckoutPrompt(note: string | undefined, inheritedHistory: boolean): string {
	if (inheritedHistory) {
		return renderPromptTemplate("handoff-same-checkout.md", {
			FOCUS_NOTE_SENTENCE: buildFocusNoteSentence(note),
		});
	}
	if (note) {
		return `Continue the current task from this new pane. Focus on: ${note}. Use the handoff summary already present in this session. Start with the highest-priority next step.`;
	}
	return "Continue the current task from this new pane. Use the handoff summary already present in this session. Start with the highest-priority next step.";
}

function buildWorktreePrompt(branch: string, note?: string): string {
	return renderPromptTemplate("handoff-worktree.md", {
		TARGET_BRANCH: branch,
		FOCUS_NOTE_SENTENCE: buildFocusNoteSentence(note),
	});
}

function buildWorktreeBootstrapPrompt(branch: string, note?: string): string {
	return buildWorktreePrompt(branch, note);
}

function appendUserMessage(sessionManager: SessionManager, text: string): void {
	sessionManager.appendMessage({
		role: "user",
		content: text,
		timestamp: Date.now(),
	});
}

function persistPreparedSession(sessionManager: SessionManager): string | undefined {
	const sessionFile = sessionManager.getSessionFile();
	// Pi defers writing user-only sessions until the first assistant response.
	// The child process needs the seed on disk before it starts.
	if (sessionFile && !existsSync(sessionFile)) {
		const entries = [sessionManager.getHeader(), ...sessionManager.getEntries()];
		writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx", mode: 0o600 });
	}
	return sessionFile;
}

function createForkedSameCheckoutSession(ctx: HandoffSource, summary: string, leafId: string | null): string | undefined {
	const currentSessionFile = ctx.sessionManager.getSessionFile();
	if (!currentSessionFile || !existsSync(currentSessionFile) || !leafId) return undefined;

	// Work on a separate manager: branching must never change the source session.
	const fork = SessionManager.open(currentSessionFile, ctx.sessionManager.getSessionDir());
	if (!fork.getEntry(leafId) || !fork.createBranchedSession(leafId)) return undefined;
	appendUserMessage(fork, summary);
	return persistPreparedSession(fork);
}

function createSummaryOnlySession(cwd: string, summary: string): string | undefined {
	const sessionManager = SessionManager.create(cwd);
	appendUserMessage(sessionManager, summary);
	return persistPreparedSession(sessionManager);
}

async function buildHandoffContext(pi: ExtensionAPI, ctx: HandoffSource, note?: string): Promise<HandoffContext> {
	const branchEntries = ctx.sessionManager.getBranch();
	const repo = await getGitRepoInfo(pi, ctx.cwd);
	const statusSummary = summarizeGitStatusLines(repo?.statusLines ?? []);
	return {
		sourceCwd: ctx.cwd,
		sourceSessionName: ctx.sessionManager.getSessionName(),
		sourceSessionFile: ctx.sessionManager.getSessionFile(),
		currentTask: ctx.sessionManager.getSessionName() || findRecentTaskText(branchEntries),
		repo,
		modifiedFiles: statusSummary.modifiedFiles,
		newFiles: statusSummary.newFiles,
		otherStatusLines: statusSummary.otherStatusLines,
		note,
	};
}

export async function resolveHandoffTarget(
	pi: ExtensionAPI,
	ctx: HandoffSource,
	request: ContinueRequest,
	leafId?: string | null,
): Promise<{ ok: true; target: HandoffTarget } | { ok: false; error: string }> {
	if (hasSshIntent(pi)) return { ok: false, error: "SSH handoffs/worktrees are unsupported; no local Git or session preparation was performed" };
	const launch = capturePiLaunch(pi, ctx.cwd);
	try {
		leafId = leafId === undefined ? ctx.sessionManager.getLeafId() : leafId;
		if (request.mode === "handoff") {
			const context = await buildHandoffContext(pi, ctx, request.note);
			launch.check();
			const forkedSessionFile = createForkedSameCheckoutSession(ctx, buildHandoffSummary(context, true), leafId);
			const sessionFile = forkedSessionFile || createSummaryOnlySession(ctx.cwd, buildHandoffSummary(context, false));
			if (!sessionFile) {
				return { ok: false, error: "Failed to create a handoff session" };
			}
			return {
				ok: true,
				target: {
					cwd: ctx.cwd,
					sessionFile,
					prompt: buildSameCheckoutPrompt(request.note, Boolean(forkedSessionFile)),
				},
			};
		}

		const repo = await getGitRepoInfo(pi, ctx.cwd);
		launch.check();
		if (!repo) {
			return { ok: false, error: "Not inside a git repository" };
		}

		const worktreeResult = await ensureCreatedBranchWorktree(pi, repo.repoRoot, request.branch, request.fromRef);
		launch.check();
		if (!worktreeResult.ok) {
			return worktreeResult;
		}

		const context = await buildHandoffContext(pi, ctx, request.note);
		launch.check();
		context.targetBranch = request.branch;
		context.fromRef = request.fromRef;
		context.targetWorktreePath = worktreeResult.path;
		const summary = buildHandoffSummary(context, false);
		const sessionFile = createSummaryOnlySession(worktreeResult.path, summary);
		if (!sessionFile) {
			return { ok: false, error: "Failed to create a worktree handoff session" };
		}

		return {
			ok: true,
			target: {
				cwd: worktreeResult.path,
				sessionFile,
				prompt: buildWorktreeBootstrapPrompt(request.branch, request.note),
			},
		};
	} finally { launch.close(); }
}

async function openContinueSplit(
	pi: ExtensionAPI,
	ctx: HandoffSource,
	direction: SplitDirection,
	request: ContinueRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const handoffTarget = await resolveHandoffTarget(pi, ctx, request);
	if (!handoffTarget.ok) {
		return handoffTarget;
	}

	const { cwd, sessionFile, prompt } = handoffTarget.target;
	const taskTitle = ctx.sessionManager.getSessionName() || request.note?.trim() || "";
	return openPiSession(pi, cwd, { sessionFile, prompt, taskTitle, placement: direction, related: true, role: "continue" });
}

function registerContinueCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const parsed = parseContinueArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(`${parsed.error}. ${getContinueUsage(name)}`, "warning");
				return;
			}

			await ctx.waitForIdle();
			const result = await openContinueSplit(pi, ctx, direction, parsed.request);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`continuation failed: ${result.error}`, "error");
			}
		},
	});
}

export default function cmuxContinueExtension(pi: ExtensionAPI) {
	registerContinueCommand(
		pi,
		"cmcv",
		"right",
		"Open a new right split and continue the current task, optionally in a git worktree",
		"Opened a continuation split to the right",
	);

	registerContinueCommand(
		pi,
		"cmch",
		"down",
		"Open a new lower split and continue the current task, optionally in a git worktree",
		"Opened a continuation split below",
	);
}
