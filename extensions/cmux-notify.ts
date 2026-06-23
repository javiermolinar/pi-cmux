import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const DEFAULT_THRESHOLD_MS = 15000;
const DEFAULT_DEBOUNCE_MS = 3000;
const NOTIFY_TIMEOUT_MS = 5000;
const DEFAULT_NOTIFY_LEVEL = "all";
const DEFAULT_INCLUDE_ASSISTANT_RESPONSE = false;
const ASSISTANT_RESPONSE_MAX_LENGTH = 500;
const GLOBAL_SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");
const SETTINGS_SECTION_NAME = "pi-cmux";
const TOOL_NOTIFICATION_SUBTITLE_PREFIX = "Tool";

type NotifyLevel = "all" | "medium" | "low" | "disabled";

interface RunState {
	startedAt: number;
	isPiSubagent: boolean;
	readFiles: Set<string>;
	changedFiles: Set<string>;
	searchCount: number;
	bashCount: number;
	firstToolError: string | undefined;
}

interface AssistantMessageLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	content?: Array<{ type?: string; text?: string }>;
}

interface ToolNotificationInput {
	disabled?: boolean;
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

function readPiCmuxNotifyTools(settingsPath: string): Record<string, unknown> {
	const settings = readJsonFile(settingsPath);
	const section = settings?.[SETTINGS_SECTION_NAME];
	if (!section) {
		return {};
	}
	if (typeof section !== "object" || Array.isArray(section)) {
		console.warn(`[pi-cmux] Ignoring invalid "${SETTINGS_SECTION_NAME}" settings in ${settingsPath}`);
		return {};
	}

	const notify = (section as { notify?: unknown }).notify;
	if (notify === undefined) {
		return {};
	}
	if (typeof notify !== "object" || Array.isArray(notify)) {
		console.warn(`[pi-cmux] Ignoring invalid "${SETTINGS_SECTION_NAME}.notify" settings in ${settingsPath}`);
		return {};
	}

	const tools = (notify as { tools?: unknown }).tools;
	if (tools === undefined) {
		return {};
	}
	if (typeof tools !== "object" || Array.isArray(tools)) {
		console.warn(`[pi-cmux] Ignoring invalid "${SETTINGS_SECTION_NAME}.notify.tools" settings in ${settingsPath}`);
		return {};
	}

	return tools as Record<string, unknown>;
}

function isValidToolName(value: string): boolean {
	return /^[A-Za-z0-9_.:-]+$/.test(value);
}

function normalizeToolNotification(
	toolName: string,
	value: unknown,
	settingsPath: string,
): true | null | undefined {
	if (!toolName || !isValidToolName(toolName)) {
		console.warn(`[pi-cmux] Skipping invalid notify tool name "${toolName}" from ${settingsPath}`);
		return undefined;
	}

	if (value === true) {
		return true;
	}

	if (!value || typeof value !== "object" || Array.isArray(value)) {
		console.warn(
			`[pi-cmux] Skipping invalid notify tool "${toolName}" from ${settingsPath}; expected true or { "disabled": true }`,
		);
		return undefined;
	}

	const config = value as ToolNotificationInput;
	if (config.disabled) {
		return null;
	}

	console.warn(
		`[pi-cmux] Skipping invalid notify tool "${toolName}" from ${settingsPath}; expected true or { "disabled": true }`,
	);
	return undefined;
}

function loadConfiguredNotifyTools(cwd: string): Set<string> {
	const configuredTools = new Set<string>();
	const settingsPaths = [GLOBAL_SETTINGS_PATH, join(cwd, ".pi", "settings.json")];

	for (const settingsPath of settingsPaths) {
		const tools = readPiCmuxNotifyTools(settingsPath);
		for (const [toolName, value] of Object.entries(tools)) {
			const normalized = normalizeToolNotification(toolName, value, settingsPath);
			if (normalized === null) {
				configuredTools.delete(toolName);
				continue;
			}
			if (!normalized) {
				continue;
			}
			configuredTools.add(toolName);
		}
	}

	return configuredTools;
}

function getNumberFromEnv(name: string, fallback: number): number {
	const value = process.env[name];
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getBooleanFromEnv(name: string, fallback: boolean): boolean {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return fallback;
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return fallback;
}

function getNotifyLevelFromEnv(): NotifyLevel {
	const value = process.env.PI_CMUX_NOTIFY_LEVEL?.trim().toLowerCase();
	if (value === "all" || value === "medium" || value === "low" || value === "disabled") {
		return value;
	}
	return DEFAULT_NOTIFY_LEVEL;
}

function pluralize(count: number, singular: string, plural: string = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(1, Math.round(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes === 0) return `${seconds}s`;
	if (seconds === 0) return `${minutes}m`;
	return `${minutes}m ${seconds}s`;
}

function getPathFromInput(event: ToolResultEvent): string | undefined {
	const path = event.input.path;
	return typeof path === "string" && path.length > 0 ? path : undefined;
}

function getPathFromArgs(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null) return undefined;
	const value = (args as { path?: unknown }).path;
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getFirstText(event: ToolResultEvent): string | undefined {
	const textPart = event.content.find((part) => part.type === "text");
	if (!textPart || textPart.type !== "text") return undefined;
	const text = textPart.text.trim();
	return text.length > 0 ? text : undefined;
}

function summarizeError(event: ToolResultEvent): string {
	const path = getPathFromInput(event);
	if (path) {
		return `${event.toolName} failed for ${basename(path)}`;
	}
	if (isBashToolResult(event)) {
		return "bash command failed";
	}
	const text = getFirstText(event);
	if (!text) {
		return `${event.toolName} failed`;
	}
	return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function summarizeToolStart(toolName: string, args: unknown): string {
	const path = getPathFromArgs(args);
	return path ? `Using ${toolName} on ${basename(path)}` : `Using ${toolName}`;
}

function summarizeSuccess(state: RunState, durationMs: number, thresholdMs: number): string {
	const changedCount = state.changedFiles.size;
	if (changedCount === 1) {
		const [file] = [...state.changedFiles];
		const summary = `Updated ${basename(file)}`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (changedCount > 1) {
		const summary = `Updated ${changedCount} ${pluralize(changedCount, "file")}`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}

	const readCount = state.readFiles.size;
	if (readCount === 1) {
		const [file] = [...state.readFiles];
		const summary = `Reviewed ${basename(file)}`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (readCount > 1) {
		const summary = `Reviewed ${readCount} ${pluralize(readCount, "file")}`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}

	if (state.searchCount > 0 && state.bashCount > 0) {
		const summary = `Ran ${state.searchCount} ${pluralize(state.searchCount, "search")} and ${state.bashCount} ${pluralize(state.bashCount, "shell command")}`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (state.searchCount > 0) {
		const summary = state.searchCount === 1 ? "Searched the codebase" : `Ran ${state.searchCount} searches`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	if (state.bashCount > 0) {
		const summary = `Ran ${state.bashCount} ${pluralize(state.bashCount, "shell command")}`;
		return durationMs >= thresholdMs ? `${summary} in ${formatDuration(durationMs)}` : summary;
	}
	return durationMs >= thresholdMs
		? `Finished in ${formatDuration(durationMs)}`
		: "Finished and waiting for input";
}

function isAssistantMessage(message: unknown): message is AssistantMessageLike {
	return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

function getLastAssistantMessage(messages: readonly unknown[]): AssistantMessageLike | undefined {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (isAssistantMessage(message)) return message;
	}
	return undefined;
}

function extractAssistantText(message: AssistantMessageLike): string | undefined {
	if (!Array.isArray(message.content)) return undefined;

	const text = message.content
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				part.type === "text" &&
				typeof part.text === "string" &&
				part.text.trim().length > 0,
		)
		.map((part) => part.text.trim())
		.join("\n")
		.trim();

	return text.length > 0 ? text : undefined;
}

function truncateText(text: string, maxLength: number): string {
	return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function summarizeAssistantText(message: AssistantMessageLike): string | undefined {
	const text = extractAssistantText(message);
	return text ? truncateText(text, 120) : undefined;
}

function getAssistantResponseText(messages: readonly unknown[]): string | undefined {
	const lastAssistant = getLastAssistantMessage(messages);
	if (!lastAssistant || (lastAssistant.stopReason !== "stop" && lastAssistant.stopReason !== "length")) {
		return undefined;
	}

	const text = extractAssistantText(lastAssistant);
	return text ? truncateText(text, ASSISTANT_RESPONSE_MAX_LENGTH) : undefined;
}

function summarizeRunError(messages: readonly unknown[], fallbackError?: string): string | undefined {
	const assistantMessage = getLastAssistantMessage(messages);
	if (!assistantMessage) return fallbackError;
	if (assistantMessage.stopReason !== "error" && assistantMessage.stopReason !== "aborted") {
		return undefined;
	}

	const summary = assistantMessage.errorMessage?.trim() || summarizeAssistantText(assistantMessage) || fallbackError || "Agent run failed";
	return summary.length > 120 ? `${summary.slice(0, 117)}...` : summary;
}

function buildSubtitle(hasRunError: boolean, state: RunState, durationMs: number, thresholdMs: number): string {
	if (hasRunError) return "Error";
	if (state.changedFiles.size > 0 || durationMs >= thresholdMs) return "Task Complete";
	return "Waiting";
}

function shouldNotify(level: NotifyLevel, subtitle: string): boolean {
	if (level === "disabled") return false;
	if (level === "all") return true;
	if (level === "medium") return subtitle === "Task Complete" || subtitle === "Error";
	if (level === "low") return subtitle === "Error";
	return true;
}

function shouldNotifyToolStart(level: NotifyLevel): boolean {
	return level !== "disabled";
}

function isPiSubagentSystemPrompt(systemPrompt: string): boolean {
	const hasActiveAgentTag = /<active_agent\b[^>]*\bname=(["'])[^"']+\1[^>]*\/?>/i.test(systemPrompt);
	const hasSubagentContext = systemPrompt.includes("<sub_agent_context>");
	const hasSubagentWording = /pi coding agent sub-agent/i.test(systemPrompt) ||
		/operating as a sub-agent/i.test(systemPrompt);
	return (hasActiveAgentTag && hasSubagentContext) || hasSubagentWording;
}

function createEmptyRunState(isPiSubagent = false): RunState {
	return {
		startedAt: Date.now(),
		isPiSubagent,
		readFiles: new Set<string>(),
		changedFiles: new Set<string>(),
		searchCount: 0,
		bashCount: 0,
		firstToolError: undefined,
	};
}

export default function cmuxNotifyExtension(pi: ExtensionAPI) {
	const thresholdMs = getNumberFromEnv("PI_CMUX_NOTIFY_THRESHOLD_MS", DEFAULT_THRESHOLD_MS);
	const debounceMs = getNumberFromEnv("PI_CMUX_NOTIFY_DEBOUNCE_MS", DEFAULT_DEBOUNCE_MS);
	const notifyLevel = getNotifyLevelFromEnv();
	const includeAssistantResponse = getBooleanFromEnv("PI_CMUX_NOTIFY_INCLUDE_RESPONSE", DEFAULT_INCLUDE_ASSISTANT_RESPONSE);
	const title = process.env.PI_CMUX_NOTIFY_TITLE || "Pi";
	const notifyTools = loadConfiguredNotifyTools(process.cwd());

	let runState = createEmptyRunState();
	let pendingIsPiSubagent = false;
	let lastNotificationAt = 0;
	let lastNotificationKey = "";
	let cmuxUnavailable = false;

	const sendNotification = async (subtitle: string, body: string): Promise<{ ok: boolean; error?: string }> => {
		if (cmuxUnavailable) {
			return { ok: false, error: "cmux notify is unavailable" };
		}

		const notificationKey = `${subtitle}\n${body}`;
		const now = Date.now();
		if (notificationKey === lastNotificationKey && now - lastNotificationAt < debounceMs) {
			return { ok: true };
		}

		const args = ["notify", "--title", title, "--subtitle", subtitle, "--body", body];
		const result = await pi.exec("cmux", args, { timeout: NOTIFY_TIMEOUT_MS });
		if (result.killed) {
			return { ok: false, error: "cmux notify timed out" };
		}
		if (result.code !== 0) {
			const error = result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`;
			if (error.includes("not found") || error.includes("ENOENT")) {
				cmuxUnavailable = true;
			}
			return { ok: false, error };
		}

		lastNotificationAt = now;
		lastNotificationKey = notificationKey;
		return { ok: true };
	};

	pi.on("before_agent_start", async (event) => {
		pendingIsPiSubagent = isPiSubagentSystemPrompt(event.systemPrompt);
	});

	pi.on("agent_start", async () => {
		runState = createEmptyRunState(pendingIsPiSubagent);
		pendingIsPiSubagent = false;
	});

	pi.on("tool_execution_start", async (event) => {
		if (!shouldNotifyToolStart(notifyLevel) || !notifyTools.has(event.toolName)) {
			return;
		}

		await sendNotification(
			`${TOOL_NOTIFICATION_SUBTITLE_PREFIX}: ${event.toolName}`,
			summarizeToolStart(event.toolName, event.args),
		);
	});

	pi.on("tool_result", async (event) => {
		if (event.isError && !runState.firstToolError) {
			runState.firstToolError = summarizeError(event);
		}

		if (isReadToolResult(event)) {
			const path = getPathFromInput(event);
			if (path) runState.readFiles.add(path);
			return;
		}

		if (isEditToolResult(event) || isWriteToolResult(event)) {
			const path = getPathFromInput(event);
			if (path && !event.isError) runState.changedFiles.add(path);
			return;
		}

		if (isGrepToolResult(event) || isFindToolResult(event)) {
			if (!event.isError) runState.searchCount += 1;
			return;
		}

		if (isBashToolResult(event) && !event.isError) {
			runState.bashCount += 1;
		}
	});

	pi.on("agent_end", async (event) => {
		if (runState.isPiSubagent) {
			return;
		}

		const durationMs = Date.now() - runState.startedAt;
		const runError = summarizeRunError(event.messages, runState.firstToolError);
		const subtitle = buildSubtitle(Boolean(runError), runState, durationMs, thresholdMs);
		if (!shouldNotify(notifyLevel, subtitle)) {
			return;
		}
		let body = runError || summarizeSuccess(runState, durationMs, thresholdMs);

		if (!runError && includeAssistantResponse) {
			const responseText = getAssistantResponseText(event.messages);
			if (responseText) {
				body = `${body}\n${responseText}`;
			}
		}

		await sendNotification(subtitle, body);
	});

}
