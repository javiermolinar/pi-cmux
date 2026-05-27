import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import {
	isBashToolResult,
	isEditToolResult,
	isFindToolResult,
	isGrepToolResult,
	isReadToolResult,
	isWriteToolResult,
} from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";

const DEFAULT_COMPLETE_THRESHOLD_MS = 15000;
const DEFAULT_FINAL_CLEAR_DELAY_MS = 2500;
const CMUX_SIDEBAR_TIMEOUT_MS = 1500;
const MAX_LOG_LENGTH = 240;
const MAX_PROMPT_LENGTH = 120;
const DEFAULT_STATUS_PRIORITY = 80;
const TOKEN_PROGRESS_UPDATE_MIN_MS = 500;

type StatusKind = "running" | "tool" | "waiting" | "complete" | "cancelled" | "error";
type LogLevel = "info" | "progress" | "success" | "warning" | "error";
type FlashLevel = "all" | "error" | "disabled";

interface RunState {
	startedAt: number;
	prompt?: string;
	readFiles: Set<string>;
	changedFiles: Set<string>;
	searchCount: number;
	listCount: number;
	bashCount: number;
	toolCount: number;
	turnCount: number;
	firstToolError: string | undefined;
}

interface TokenUsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: number | { total?: number };
}

interface TokenTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

interface AssistantMessageLike {
	role: "assistant";
	stopReason?: string;
	errorMessage?: string;
	content?: string | Array<{ type?: string; text?: string }>;
	usage?: TokenUsageLike;
}

const STATUS_STYLE: Record<StatusKind, { icon: string; color: string }> = {
	running: { icon: "sparkle", color: "#0A84FF" },
	tool: { icon: "hammer", color: "#FF9F0A" },
	waiting: { icon: "clock", color: "#8E8E93" },
	complete: { icon: "check", color: "#30D158" },
	cancelled: { icon: "x", color: "#8E8E93" },
	error: { icon: "x", color: "#FF453A" },
};

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
	if (value === "0" || value === "false" || value === "no" || value === "off" || value === "disabled") return false;
	return fallback;
}

function getFlashLevelFromEnv(): FlashLevel {
	const value = process.env.PI_CMUX_SIDEBAR_FLASH?.trim().toLowerCase();
	if (value === "all") return "all";
	if (value === "error" || value === "errors") return "error";
	if (value === "0" || value === "false" || value === "off" || value === "disabled") return "disabled";
	return "all";
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

function truncateText(text: string, maxLength: number): string {
	const trimmed = text.replace(/\s+/g, " ").trim();
	return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength - 3)}...` : trimmed;
}

function sanitizeStatusKeyPart(value: string): string {
	return value.replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

function getStatusKey(): string {
	const configured = process.env.PI_CMUX_SIDEBAR_STATUS_KEY?.trim();
	if (configured) return configured;

	const surfaceOrTab = process.env.CMUX_SURFACE_ID || process.env.CMUX_TAB_ID || String(process.pid);
	const suffix = sanitizeStatusKeyPart(surfaceOrTab).slice(0, 64) || String(process.pid);
	return `pi-cmux-${suffix}`;
}

function hasCmuxWorkspaceContext(): boolean {
	return Boolean(process.env.CMUX_WORKSPACE_ID?.trim());
}

function createEmptyRunState(prompt?: string): RunState {
	return {
		startedAt: Date.now(),
		prompt,
		readFiles: new Set<string>(),
		changedFiles: new Set<string>(),
		searchCount: 0,
		listCount: 0,
		bashCount: 0,
		toolCount: 0,
		turnCount: 0,
		firstToolError: undefined,
	};
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

function summarizeToolError(event: ToolResultEvent): string {
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
	return truncateText(text, 120);
}

function isLsToolResultEvent(event: ToolResultEvent): boolean {
	return event.toolName === "ls";
}

function summarizeToolResult(event: ToolResultEvent): string {
	const path = getPathFromInput(event);
	if (isReadToolResult(event) && path) return `Read ${basename(path)}`;
	if ((isEditToolResult(event) || isWriteToolResult(event)) && path) return `Updated ${basename(path)}`;
	if ((isGrepToolResult(event) || isFindToolResult(event)) && path) return `Searched ${basename(path)}`;
	if (isLsToolResultEvent(event) && path) return `Listed ${basename(path)}`;
	if (isBashToolResult(event)) return "bash command completed";
	return `${event.toolName} completed`;
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
	if (state.listCount > 0) {
		const summary = state.listCount === 1 ? "Listed files" : `Listed files ${state.listCount} times`;
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
	if (typeof message.content === "string") {
		const text = message.content.trim();
		return text.length > 0 ? text : undefined;
	}
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

function summarizeAssistantText(message: AssistantMessageLike): string | undefined {
	const text = extractAssistantText(message);
	return text ? truncateText(text, 120) : undefined;
}

function summarizeRunFailure(
	messages: readonly unknown[],
	fallbackError?: string,
): { kind: "error" | "cancelled"; summary: string } | undefined {
	const assistantMessage = getLastAssistantMessage(messages);
	if (!assistantMessage) return fallbackError ? { kind: "error", summary: fallbackError } : undefined;
	if (assistantMessage.stopReason !== "error" && assistantMessage.stopReason !== "aborted") {
		return undefined;
	}

	const summary = assistantMessage.errorMessage?.trim() || summarizeAssistantText(assistantMessage) || fallbackError;
	if (assistantMessage.stopReason === "aborted") {
		return { kind: "cancelled", summary: summary || "Operation aborted" };
	}
	return { kind: "error", summary: summary || "Agent run failed" };
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function createEmptyTokenTotals(): TokenTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function getUsageCostTotal(cost: unknown): number {
	const direct = finiteNumber(cost);
	if (direct !== undefined) return direct;
	if (typeof cost !== "object" || cost === null) return 0;
	return finiteNumber((cost as { total?: unknown }).total) ?? 0;
}

function getUsageTokenTotal(usage: TokenUsageLike): number {
	const totalTokens = finiteNumber(usage.totalTokens) ?? 0;
	if (totalTokens > 0) return totalTokens;
	return (
		(finiteNumber(usage.input) ?? 0) +
		(finiteNumber(usage.output) ?? 0) +
		(finiteNumber(usage.cacheRead) ?? 0) +
		(finiteNumber(usage.cacheWrite) ?? 0)
	);
}

function hasReportableUsage(usage?: TokenUsageLike): usage is TokenUsageLike {
	if (!usage) return false;
	return getUsageTokenTotal(usage) > 0 || getUsageCostTotal(usage.cost) > 0;
}

function addTokenUsage(totals: TokenTotals, usage?: TokenUsageLike): void {
	if (!hasReportableUsage(usage)) return;
	totals.input += finiteNumber(usage.input) ?? 0;
	totals.output += finiteNumber(usage.output) ?? 0;
	totals.cacheRead += finiteNumber(usage.cacheRead) ?? 0;
	totals.cacheWrite += finiteNumber(usage.cacheWrite) ?? 0;
	totals.cost += getUsageCostTotal(usage.cost);
}

function addTokenTotals(left: TokenTotals, right: TokenTotals): TokenTotals {
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cost: left.cost + right.cost,
	};
}

function getSessionTokenTotals(messages: readonly unknown[]): TokenTotals {
	const totals = createEmptyTokenTotals();
	for (const message of messages) {
		if (!isAssistantMessage(message)) continue;
		addTokenUsage(totals, message.usage);
	}
	return totals;
}

function getBranchTokenTotals(entries: readonly unknown[]): TokenTotals {
	const totals = createEmptyTokenTotals();
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const candidate = entry as { type?: unknown; message?: unknown };
		if (candidate.type !== "message" || !isAssistantMessage(candidate.message)) continue;
		addTokenUsage(totals, candidate.message.usage);
	}
	return totals;
}

function trimFixed(value: number, digits: number): string {
	return value.toFixed(digits).replace(/\.0$/, "");
}

function formatTokenCount(count: number): string {
	if (count >= 1_000_000) return `${trimFixed(count / 1_000_000, count >= 10_000_000 ? 0 : 1)}m`;
	if (count >= 1_000) return `${trimFixed(count / 1_000, count >= 100_000 ? 0 : 1)}k`;
	return String(Math.round(count));
}

function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

function formatTokenSummary(totals: TokenTotals, includeCost: boolean): string | undefined {
	const cache = totals.cacheRead + totals.cacheWrite;
	const hasTokens = totals.input > 0 || cache > 0 || totals.output > 0;
	const hasCost = includeCost && totals.cost > 0;
	if (!hasTokens && !hasCost) return undefined;

	const parts: string[] = [];
	if (hasTokens) {
		const tokenParts = [`↑${formatTokenCount(totals.input)}`];
		if (cache > 0) tokenParts.push(`+${formatTokenCount(cache)} cache`);
		tokenParts.push(`↓${formatTokenCount(totals.output)}`);
		parts.push(`tok ${tokenParts.join(" ")}`);
	}
	if (hasCost) parts.push(formatCost(totals.cost));
	return parts.join(" · ");
}

function buildFinalState(
	failure: { kind: "error" | "cancelled"; summary: string } | undefined,
	state: RunState,
	durationMs: number,
	thresholdMs: number,
): "waiting" | "complete" | "cancelled" | "error" {
	if (failure) return failure.kind;
	if (state.changedFiles.size > 0 || durationMs >= thresholdMs) return "complete";
	return "waiting";
}

function estimateProgress(state: RunState): number {
	const progress = 0.08 + state.turnCount * 0.14 + state.toolCount * 0.04;
	return Math.min(0.9, Math.max(0.08, progress));
}

function progressValue(value: number): string {
	return Math.min(1, Math.max(0, value)).toFixed(2);
}

function shouldFlash(level: FlashLevel, isError: boolean): boolean {
	if (level === "disabled") return false;
	if (level === "error") return isError;
	return true;
}

function isCmuxUnavailableError(text: string): boolean {
	const normalized = text.toLowerCase();
	const commandNotFound = normalized.includes("cmux") &&
		(normalized.includes("command not found") || normalized.includes("cmux: not found"));
	return normalized.includes("enoent") ||
		commandNotFound ||
		normalized.includes("no such file or directory") ||
		normalized.includes("failed to connect") ||
		normalized.includes("could not connect") ||
		normalized.includes("connection refused") ||
		normalized.includes("connection reset") ||
		normalized.includes("econnrefused") ||
		normalized.includes("econnreset") ||
		normalized.includes("socket");
}

export default function cmuxSidebarExtension(pi: ExtensionAPI) {
	if (!getBooleanFromEnv("PI_CMUX_SIDEBAR", true) || !hasCmuxWorkspaceContext()) {
		return;
	}

	const statusKey = getStatusKey();
	const source = process.env.PI_CMUX_SIDEBAR_SOURCE?.trim() || "pi";
	const priority = getNumberFromEnv("PI_CMUX_SIDEBAR_STATUS_PRIORITY", DEFAULT_STATUS_PRIORITY);
	const thresholdMs = getNumberFromEnv(
		"PI_CMUX_SIDEBAR_COMPLETE_THRESHOLD_MS",
		getNumberFromEnv("PI_CMUX_NOTIFY_THRESHOLD_MS", DEFAULT_COMPLETE_THRESHOLD_MS),
	);
	const progressEnabled = getBooleanFromEnv("PI_CMUX_SIDEBAR_PROGRESS", true);
	const tokenTrackingEnabled = getBooleanFromEnv("PI_CMUX_SIDEBAR_TOKENS", true);
	const includeTokenCost = getBooleanFromEnv("PI_CMUX_SIDEBAR_COST", false);
	const toolLogsEnabled = getBooleanFromEnv("PI_CMUX_SIDEBAR_LOG_TOOLS", false);
	const includePromptInLog = getBooleanFromEnv("PI_CMUX_SIDEBAR_LOG_PROMPT", false);
	const flashLevel = getFlashLevelFromEnv();
	const finalClearDelayMs = getNumberFromEnv(
		"PI_CMUX_SIDEBAR_FINAL_CLEAR_MS",
		getNumberFromEnv("PI_CMUX_SIDEBAR_PROGRESS_CLEAR_MS", DEFAULT_FINAL_CLEAR_DELAY_MS),
	);

	let runState = createEmptyRunState();
	let pendingPrompt: string | undefined;
	let runSequence = 0;
	let agentActive = false;
	let cmuxUnavailable = false;
	let flashUnavailable = false;
	let commandQueue = Promise.resolve();
	let finalClearTimeout: ReturnType<typeof setTimeout> | undefined;
	let tokenBaseTotals = createEmptyTokenTotals();
	let tokenRunTotals = createEmptyTokenTotals();
	let liveAssistantUsage: TokenUsageLike | undefined;
	let latestTokenSummary: string | undefined;
	let activeToolCount = 0;
	let currentProgressValue: number | undefined;
	let currentProgressLabel: string | undefined;
	let lastTokenProgressUpdateAt = 0;

	const markCmuxUnavailableIfFatal = (text: string): void => {
		if (isCmuxUnavailableError(text)) {
			cmuxUnavailable = true;
		}
	};

	const runCmux = async (args: string[], onFailure?: () => void): Promise<void> => {
		if (cmuxUnavailable) return;
		try {
			const result = await pi.exec("cmux", args, { timeout: CMUX_SIDEBAR_TIMEOUT_MS });
			if (result.killed) {
				onFailure?.();
				return;
			}
			if (result.code !== 0) {
				markCmuxUnavailableIfFatal(result.stderr.trim() || result.stdout.trim() || `cmux exited with code ${result.code}`);
				onFailure?.();
			}
		} catch (error) {
			markCmuxUnavailableIfFatal(error instanceof Error ? error.message : String(error));
			onFailure?.();
		}
	};

	const enqueueCmux = (args: string[], onFailure?: () => void): void => {
		if (cmuxUnavailable) return;
		commandQueue = commandQueue.then(() => runCmux(args, onFailure), () => runCmux(args, onFailure));
	};

	const flushCmux = async (): Promise<void> => {
		await commandQueue.catch(() => undefined);
	};

	const setStatus = (kind: StatusKind, value: string): void => {
		const style = STATUS_STYLE[kind];
		enqueueCmux([
			"set-status",
			statusKey,
			value,
			"--icon",
			style.icon,
			"--color",
			style.color,
			"--priority",
			String(priority),
		]);
	};

	const clearStatus = (): void => {
		enqueueCmux(["clear-status", statusKey]);
	};

	const appendLog = (level: LogLevel, message: string): void => {
		enqueueCmux(["log", "--level", level, "--source", source, "--", truncateText(message, MAX_LOG_LENGTH)]);
	};

	const getCurrentTokenTotals = (): TokenTotals => {
		const totals = addTokenTotals(tokenBaseTotals, tokenRunTotals);
		addTokenUsage(totals, liveAssistantUsage);
		return totals;
	};

	const updateLatestTokenSummary = (totals: TokenTotals): void => {
		latestTokenSummary = tokenTrackingEnabled ? formatTokenSummary(totals, includeTokenCost) : undefined;
	};

	const buildProgressLabel = (label: string): string => {
		return latestTokenSummary ? `${label} · ${latestTokenSummary}` : label;
	};

	const refreshProgressLabel = (force = false): void => {
		if (!progressEnabled || currentProgressValue === undefined || currentProgressLabel === undefined) return;
		const now = Date.now();
		if (!force && now - lastTokenProgressUpdateAt < TOKEN_PROGRESS_UPDATE_MIN_MS) return;
		lastTokenProgressUpdateAt = now;
		enqueueCmux(["set-progress", progressValue(currentProgressValue), "--label", buildProgressLabel(currentProgressLabel)]);
	};

	const refreshTokenSummary = (force = false): void => {
		updateLatestTokenSummary(getCurrentTokenTotals());
		refreshProgressLabel(force);
	};

	const setProgress = (value: number, label: string): void => {
		currentProgressValue = value;
		currentProgressLabel = label;
		if (!progressEnabled) return;
		lastTokenProgressUpdateAt = Date.now();
		enqueueCmux(["set-progress", progressValue(value), "--label", buildProgressLabel(label)]);
	};

	const clearProgress = (): void => {
		currentProgressValue = undefined;
		currentProgressLabel = undefined;
		if (!progressEnabled) return;
		enqueueCmux(["clear-progress"]);
	};

	const triggerFlash = (isError: boolean): void => {
		if (flashUnavailable || !shouldFlash(flashLevel, isError)) return;
		enqueueCmux(["trigger-flash"], () => {
			flashUnavailable = true;
		});
	};

	const cancelFinalClear = (): void => {
		if (!finalClearTimeout) return;
		clearTimeout(finalClearTimeout);
		finalClearTimeout = undefined;
	};

	const scheduleFinalClear = (sequence: number): void => {
		cancelFinalClear();
		finalClearTimeout = setTimeout(() => {
			finalClearTimeout = undefined;
			if (sequence === runSequence) {
				clearProgress();
				clearStatus();
			}
		}, finalClearDelayMs);
		(finalClearTimeout as { unref?: () => void }).unref?.();
	};

	pi.on("session_start", async () => {
		cancelFinalClear();
		runState = createEmptyRunState();
		tokenBaseTotals = createEmptyTokenTotals();
		tokenRunTotals = createEmptyTokenTotals();
		liveAssistantUsage = undefined;
		latestTokenSummary = undefined;
		agentActive = false;
		activeToolCount = 0;
		clearProgress();
		clearStatus();
	});

	pi.on("before_agent_start", async (event) => {
		pendingPrompt = event.prompt ? truncateText(event.prompt, MAX_PROMPT_LENGTH) : undefined;
	});

	pi.on("agent_start", async (_event, ctx) => {
		runSequence += 1;
		agentActive = true;
		cancelFinalClear();
		runState = createEmptyRunState(pendingPrompt);
		pendingPrompt = undefined;
		tokenBaseTotals = tokenTrackingEnabled ? getBranchTokenTotals(ctx.sessionManager.getBranch()) : createEmptyTokenTotals();
		tokenRunTotals = createEmptyTokenTotals();
		liveAssistantUsage = undefined;
		activeToolCount = 0;
		updateLatestTokenSummary(tokenBaseTotals);
		setStatus("running", "Pi running");
		setProgress(0.08, "Starting");
		appendLog("progress", includePromptInLog && runState.prompt ? `Started: ${runState.prompt}` : "Run started");
	});

	pi.on("turn_start", async (event) => {
		runState.turnCount = Math.max(runState.turnCount, event.turnIndex + 1);
		setStatus("running", event.turnIndex > 0 ? `Pi turn ${event.turnIndex + 1}` : "Pi thinking");
		setProgress(estimateProgress(runState), "Thinking");
		if (toolLogsEnabled && event.turnIndex > 0) {
			appendLog("progress", `Turn ${event.turnIndex + 1} started`);
		}
	});

	pi.on("message_update", async (event) => {
		if (!tokenTrackingEnabled || !isAssistantMessage(event.message) || !hasReportableUsage(event.message.usage)) return;
		liveAssistantUsage = event.message.usage;
		refreshTokenSummary();
	});

	pi.on("message_end", async (event) => {
		if (!tokenTrackingEnabled || !isAssistantMessage(event.message)) return;
		addTokenUsage(tokenRunTotals, event.message.usage);
		liveAssistantUsage = undefined;
		refreshTokenSummary(true);
	});

	pi.on("tool_execution_start", async (event) => {
		activeToolCount += 1;
		setStatus("tool", `Pi ${event.toolName}`);
		setProgress(estimateProgress(runState), event.toolName);
		if (toolLogsEnabled) {
			appendLog("progress", summarizeToolStart(event.toolName, event.args));
		}
	});

	pi.on("tool_result", async (event) => {
		runState.toolCount += 1;

		if (event.isError) {
			const errorSummary = summarizeToolError(event);
			if (!runState.firstToolError) {
				runState.firstToolError = errorSummary;
			}
			appendLog("warning", errorSummary);
			setProgress(estimateProgress(runState), "Tool warning");
			return;
		}

		if (isReadToolResult(event)) {
			const path = getPathFromInput(event);
			if (path) runState.readFiles.add(path);
		} else if (isEditToolResult(event) || isWriteToolResult(event)) {
			const path = getPathFromInput(event);
			if (path) {
				runState.changedFiles.add(path);
				appendLog("success", `Updated ${basename(path)}`);
			}
		} else if (isGrepToolResult(event) || isFindToolResult(event)) {
			runState.searchCount += 1;
		} else if (isLsToolResultEvent(event)) {
			runState.listCount += 1;
		} else if (isBashToolResult(event)) {
			runState.bashCount += 1;
		}

		if (toolLogsEnabled && !(isEditToolResult(event) || isWriteToolResult(event))) {
			appendLog("info", summarizeToolResult(event));
		}
		setProgress(estimateProgress(runState), "Working");
	});

	pi.on("tool_execution_end", async () => {
		activeToolCount = Math.max(0, activeToolCount - 1);
		if (agentActive && activeToolCount === 0) {
			setStatus("running", "Pi thinking");
			setProgress(estimateProgress(runState), "Thinking");
		}
	});

	pi.on("agent_end", async (event) => {
		agentActive = false;
		activeToolCount = 0;
		const durationMs = Date.now() - runState.startedAt;
		const failure = summarizeRunFailure(event.messages, runState.firstToolError);
		const finalState = buildFinalState(failure, runState, durationMs, thresholdMs);
		const summary = failure?.summary || summarizeSuccess(runState, durationMs, thresholdMs);
		if (tokenTrackingEnabled) {
			tokenRunTotals = getSessionTokenTotals(event.messages);
			liveAssistantUsage = undefined;
			updateLatestTokenSummary(addTokenTotals(tokenBaseTotals, tokenRunTotals));
		} else {
			latestTokenSummary = undefined;
		}
		const tokenSummary = latestTokenSummary;
		const summaryWithUsage = tokenSummary ? `${summary} · ${tokenSummary}` : summary;

		if (finalState === "error") {
			setStatus("error", "Pi error");
			setProgress(1, "Error");
			appendLog("error", summaryWithUsage);
			triggerFlash(true);
		} else if (finalState === "cancelled") {
			setStatus("cancelled", "Pi cancelled");
			setProgress(1, "Cancelled");
			appendLog("warning", summaryWithUsage);
			triggerFlash(false);
		} else if (finalState === "complete") {
			setStatus("complete", "Pi done");
			setProgress(1, "Done");
			appendLog("success", summaryWithUsage);
			triggerFlash(false);
		} else {
			setStatus("waiting", "Pi waiting");
			setProgress(1, "Waiting");
			appendLog("info", summaryWithUsage);
			triggerFlash(false);
		}

		scheduleFinalClear(runSequence);
	});

	pi.on("session_shutdown", async () => {
		runSequence += 1;
		agentActive = false;
		activeToolCount = 0;
		cancelFinalClear();
		clearProgress();
		clearStatus();
		await flushCmux();
	});
}
