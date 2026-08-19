import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { execCmux, formatTabTitle, getCallerInfo } from "./cmux-core.ts";

// Opt-in conversation-driven tab titles.
//
// After the first agent turn of a conversation, summarize the session into a
// short topic title with a headless `pi --print --no-tools` run and rename the
// current cmux tab. Workspace names are never touched, so this complements
// cmux's built-in workspace auto-naming (which is skipped for workspaces with
// a user-set name and always renames the workspace itself).
//
// Disabled by default; enable with PI_CMUX_AUTOTITLE=1.
//
// Three guards keep the headless summarizer safe (all verified the hard way):
// - Headless children (`pi --print`) load this package too; the ctx.mode gate
//   keeps them from re-entering the naming pass (infinite recursion).
// - The child env drops CMUX_SURFACE_ID/CMUX_TAB_ID/CMUX_PANEL_ID and sets
//   CMUX_PI_HOOKS_DISABLED=1, so it neither re-enters cmux hooks (notification
//   storms) nor resolves to this surface.
// - Headless pi waits for stdin EOF, so the child stdin must be ignored or it
//   hangs until the timeout with empty output.

const SUMMARIZE_TIMEOUT_MS = 90_000;
const MAX_MESSAGE_CHARS = 1500;
const MAX_CACHED_MESSAGES = 6;
const MIN_MESSAGES_FOR_TITLE = 2;

interface CachedMessage {
	role: "user" | "assistant";
	text: string;
}

let conversationTitle: string | undefined;
let hasCustomName = false;
let recentMessages: CachedMessage[] = [];
let namingInFlight = false;

function getBooleanFromEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off" || value === "disabled") return false;
	return fallback;
}

function isAutotitleEnabled(): boolean {
	return getBooleanFromEnv("PI_CMUX_AUTOTITLE", false);
}

function isInteractive(ctx: ExtensionContext): boolean {
	// Headless children load this extension too; never run there.
	return ctx.mode === "tui";
}

function truncate(value: string, max: number): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

function sanitizeTitle(raw: string): string | undefined {
	const title = raw
		.replace(/^["'「『《\s]+|["'」』》\s]+$/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!title) return undefined;
	return formatTabTitle(title, "");
}

function lastAssistantText(event: unknown): string | undefined {
	const messages = (event as { messages?: unknown } | undefined)?.messages;
	if (!Array.isArray(messages)) return undefined;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: unknown; content?: unknown } | undefined;
		if (!message || message.role !== "assistant") continue;
		const content = message.content;
		const parts: string[] = [];
		if (typeof content === "string") {
			parts.push(content);
		} else if (Array.isArray(content)) {
			for (const block of content) {
				if ((block as { type?: unknown } | undefined)?.type === "text") {
					const text = (block as { text?: unknown }).text;
					if (typeof text === "string") parts.push(text);
				}
			}
		}
		const text = parts.join("\n").trim();
		if (text) return text;
	}
	return undefined;
}

function buildSummarizePrompt(): string | undefined {
	if (recentMessages.length < MIN_MESSAGES_FOR_TITLE) return undefined;
	const lines = recentMessages
		.slice(-MAX_CACHED_MESSAGES)
		.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${truncate(message.text, MAX_MESSAGE_CHARS)}`);
	return [
		"Summarize the conversation below into a short tab title of 2-5 words, written in the conversation's primary language.",
		"Reply with the title only: no quotes, no trailing punctuation, no explanation.",
		"If the conversation contains pasted logs or code, describe the underlying goal instead of quoting the content.",
		"",
		lines.join("\n"),
	].join("\n");
}

function summarizeProcess(prompt: string, cwd: string): Promise<string> {
	return new Promise((resolve) => {
		// Sanitized environment: the headless child must not re-enter cmux hooks
		// (notifications) or resolve to this surface.
		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (value === undefined) continue;
			if (key === "CMUX_SURFACE_ID" || key === "CMUX_TAB_ID" || key === "CMUX_PANEL_ID") continue;
			env[key] = value;
		}
		env.CMUX_PI_HOOKS_DISABLED = "1";

		let stdout = "";
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolve(stdout);
		};

		try {
			const model = process.env.PI_CMUX_AUTOTITLE_MODEL?.trim();
			const args = ["--print", "--no-tools"];
			if (model) args.push("--model", model);
			args.push(prompt);
			const child = spawn("pi", args, {
				cwd,
				env,
				timeout: SUMMARIZE_TIMEOUT_MS,
				// Headless pi waits for stdin EOF unless it is closed explicitly.
				stdio: ["ignore", "pipe", "pipe"],
			});
			child.stdout?.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
			child.on("error", () => finish());
			child.on("close", () => finish());
		} catch {
			finish();
		}
	});
}

async function renameTab(pi: ExtensionAPI, title: string): Promise<void> {
	const callerResult = await getCallerInfo(pi);
	if (!callerResult.ok) return;
	const { workspace_ref: workspaceRef, surface_ref: surfaceRef } = callerResult.caller;
	await execCmux(pi, [
		"rename-tab",
		"--workspace",
		workspaceRef,
		"--surface",
		surfaceRef,
		"--title",
		title,
	]);
}

async function runNamingPass(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	const prompt = buildSummarizePrompt();
	if (!prompt) return;

	const raw = await summarizeProcess(prompt, ctx.cwd);
	const title = raw.trim() ? sanitizeTitle(raw) : undefined;
	if (!title) return;

	conversationTitle = title;
	// Best-effort: losing the race with a closed tab is fine.
	try {
		await renameTab(pi, title);
	} catch {
		// Ignore rename failures.
	}
}

export default function cmuxAutotitleExtension(pi: ExtensionAPI): void {
	if (!isAutotitleEnabled()) return;

	pi.on("session_start", async (event, ctx) => {
		if (!isInteractive(ctx)) return;
		const reason = (event as { reason?: string } | undefined)?.reason;
		if (reason === "new" || reason === "fork") {
			// New conversation: forget the old topic so the next turn re-titles.
			conversationTitle = undefined;
			hasCustomName = false;
		}
		recentMessages = [];
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!isInteractive(ctx)) return;
		const prompt = (event as { prompt?: string } | undefined)?.prompt?.trim();
		if (prompt) recentMessages.push({ role: "user", text: prompt });
	});

	pi.on("agent_end", async (event, ctx) => {
		if (!isInteractive(ctx)) return;
		const reply = lastAssistantText(event);
		if (reply) recentMessages.push({ role: "assistant", text: reply });

		// Title once per conversation; skip while a user-set name owns the tab.
		if (conversationTitle || hasCustomName || namingInFlight) return;
		namingInFlight = true;
		try {
			await runNamingPass(pi, ctx);
		} finally {
			namingInFlight = false;
		}
	});

	// A user-set session display name (/name) always wins.
	pi.on("session_info_changed", async (event, ctx) => {
		if (!isInteractive(ctx)) return;
		const name = (event as { name?: string } | undefined)?.name?.trim();
		if (!name) return;
		hasCustomName = true;
		conversationTitle = name;
		const title = sanitizeTitle(name);
		if (!title) return;
		try {
			await renameTab(pi, title);
		} catch {
			// Ignore rename failures.
		}
	});
}
