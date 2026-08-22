import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { execCmux, formatTabTitle, getCallerInfo } from "./cmux-core.ts";

// Opt-in conversation-driven tab titles.
//
// After the first agent turn of a conversation, summarize the session into a
// short topic title with a single in-process LLM call and rename the current
// cmux tab. Workspace names are never touched, so this complements cmux's
// built-in workspace auto-naming (which is skipped for workspaces with a
// user-set name and always renames the workspace itself).
//
// Disabled by default; enable with PI_CMUX_AUTOTITLE=1.
//
// The summarizer deliberately does NOT spawn a headless `pi --print` child:
// - A child writes a real session file, polluting `pi -r`.
// - A child loads this package (and cmux hooks) again, re-triggering cmux
//   notifications for the naming pass itself.
// - A child pays the full pi system prompt (AGENTS.md, skills, ...) in tokens.
// Instead we reuse pi's own streaming entry point (`completeSimple` from
// pi-ai, the same completeSummarization uses internally) with a compact
// transcript and a short system prompt: one standalone request, no session
// file, no tool definitions, no child process.

const SUMMARIZE_TIMEOUT_MS = 60_000;
const SUMMARIZE_MAX_TOKENS = 1024;
const MAX_MESSAGE_CHARS = 300;
const MAX_CACHED_MESSAGES = 6;
const MIN_MESSAGES_FOR_TITLE = 2;

const TITLE_SYSTEM_PROMPT = [
	"You write tab titles for a coding session.",
	"Summarize the conversation into a short title of 2-5 words in the conversation's primary language.",
	"Describe the user's concrete goal, not the act of chatting; if the conversation contains pasted logs or code, describe the underlying goal instead of quoting the content.",
	"Reply with the title only: no quotes, no trailing punctuation, no explanation.",
].join(" ");

interface CachedMessage {
	role: "user" | "assistant";
	text: string;
}

let conversationTitle: string | undefined;
let hasCustomName = false;
let recentMessages: CachedMessage[] = [];
let namingInFlight = false;
let namingAbort: AbortController | undefined;

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
	// Only the interactive TUI owns a cmux tab worth renaming.
	return ctx.mode === "tui";
}

function truncate(value: string, max: number): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	if (trimmed.length <= max) return trimmed;
	// Keep the head and the tail: important content tends to sit at the start
	// (the request, the error) and the end (the outcome, the question) of a
	// message, while the middle is usually detail.
	const head = Math.ceil(max * 0.6);
	const tail = Math.floor(max * 0.4) - 1; // minus the ellipsis
	return `${trimmed.slice(0, head)}…${trimmed.slice(-tail)}`;
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

function buildTranscript(): string | undefined {
	if (recentMessages.length < MIN_MESSAGES_FOR_TITLE) return undefined;
	return recentMessages
		.slice(-MAX_CACHED_MESSAGES)
		.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${truncate(message.text, MAX_MESSAGE_CHARS)}`)
		.join("\n");
}

type SessionModel = NonNullable<ExtensionContext["model"]>;

// Resolve PI_CMUX_AUTOTITLE_MODEL ("provider/model" or a bare model id)
// against the session's model registry; fall back to the current model.
function resolveSummarizerModel(ctx: ExtensionContext): SessionModel | undefined {
	const requested = process.env.PI_CMUX_AUTOTITLE_MODEL?.trim();
	if (!requested) return ctx.model ?? undefined;
	const separator = requested.indexOf("/");
	if (separator > 0) {
		const provider = requested.slice(0, separator);
		const modelId = requested.slice(separator + 1);
		return ctx.modelRegistry.find(provider, modelId) ?? ctx.model ?? undefined;
	}
	for (const candidate of ctx.modelRegistry.getAvailable()) {
		if (candidate.id === requested) return candidate;
	}
	return ctx.model ?? undefined;
}

// One standalone LLM call inside the pi process: no child session file, no
// re-loaded extensions, no tool schemas, no full pi system prompt.
async function summarizeInProcess(transcript: string, ctx: ExtensionContext): Promise<string | undefined> {
	const model = resolveSummarizerModel(ctx);
	if (!model) return undefined;

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return undefined;

	const controller = new AbortController();
	namingAbort = controller;
	const timeout = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);
	try {
		const message = await completeSimple(
			model,
			{
				systemPrompt: TITLE_SYSTEM_PROMPT,
				messages: [{ role: "user", content: transcript, timestamp: Date.now() }],
			},
			{
				maxTokens: SUMMARIZE_MAX_TOKENS,
				signal: controller.signal,
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				cacheRetention: "none",
			},
		);
		const parts: string[] = [];
		if (Array.isArray(message?.content)) {
			for (const block of message.content) {
				if ((block as { type?: unknown }).type === "text") {
					const text = (block as { text?: unknown }).text;
					if (typeof text === "string" && text.trim()) parts.push(text.trim());
				}
			}
		}
		// Models occasionally wrap the title in a fence, quotes, or a "Title:" label.
		return parts.join("\n").trim() || undefined;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timeout);
		if (namingAbort === controller) namingAbort = undefined;
	}
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
	const transcript = buildTranscript();
	if (!transcript) return;

	const raw = await summarizeInProcess(transcript, ctx);
	const title = raw ? sanitizeTitle(raw) : undefined;
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
		// The user moved on: don't let a stale naming pass rename the tab late.
		namingAbort?.abort();
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
