import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildPiCommand, openCommandInNewSplit, type SplitDirection } from "./cmux-core.ts";

type ReviewMode = "general" | "bugs" | "refactor" | "tests" | "diff";

interface ReviewRequest {
	mode: ReviewMode;
	targetOrFocus?: string;
}

function getReviewUsage(commandName: string): string {
	return `Usage: /${commandName}  (defaults to --diff)  |  /${commandName} [--bugs|--refactor|--tests] <target>  |  /${commandName} --diff [focus]`;
}

function parseReviewArgs(args: string): { ok: true; request: ReviewRequest } | { ok: false; error: string } {
	const trimmed = args.trim();
	if (!trimmed) {
		return { ok: true, request: { mode: "diff" } };
	}

	const tokens = trimmed.split(/\s+/).filter((token) => token.length > 0);
	let mode: ReviewMode = "general";
	let modeWasExplicit = false;
	let index = 0;

	while (index < tokens.length && tokens[index].startsWith("--")) {
		const token = tokens[index];
		let nextMode: ReviewMode | undefined;
		if (token === "--bugs") nextMode = "bugs";
		if (token === "--refactor") nextMode = "refactor";
		if (token === "--tests") nextMode = "tests";
		if (token === "--diff") nextMode = "diff";
		if (!nextMode) {
			return { ok: false, error: `Unknown review flag: ${token}` };
		}
		if (modeWasExplicit) {
			return { ok: false, error: "Use only one review mode flag at a time" };
		}
		mode = nextMode;
		modeWasExplicit = true;
		index += 1;
	}

	const targetOrFocus = tokens.slice(index).join(" ").trim() || undefined;
	if (mode !== "diff" && !targetOrFocus) {
		return { ok: false, error: "Specify a file or directory to review" };
	}

	return { ok: true, request: { mode, targetOrFocus } };
}

function getGitHubPullRequestUrl(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	return /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/.test(trimmed) ? trimmed : undefined;
}

function buildReviewPrompt(request: ReviewRequest): string {
	const commonInstructions = [
		"Use the bundled code-review skill if it is available.",
		"Start with a concise summary ordered by severity.",
		"Then list concrete findings with suggested fixes and any missing tests.",
		"Do not edit files unless asked.",
	].join(" ");
	const pullRequestUrl = getGitHubPullRequestUrl(request.targetOrFocus);
	const modeInstruction =
		request.mode === "bugs"
			? "Focus on correctness issues, runtime failures, bad assumptions, and edge cases."
			: request.mode === "refactor"
				? "Focus on simplifications, structure, naming, duplication, and maintainability while preserving behavior."
				: request.mode === "tests"
					? "Focus on missing coverage, brittle assertions, and untested edge cases."
					: "Focus on correctness, readability, maintainability, and missing tests.";

	if (pullRequestUrl) {
		return `Review GitHub pull request ${pullRequestUrl}. Use the gh CLI to inspect it, including gh pr view ${pullRequestUrl} and gh pr diff ${pullRequestUrl}. ${modeInstruction} Prioritize the changed code, likely regressions, and missing tests before adding lower-priority notes. ${commonInstructions}`;
	}

	if (request.mode === "diff") {
		const focus = request.targetOrFocus ? ` Extra focus: ${request.targetOrFocus}.` : "";
		return `Review the current git diff in this repository.${focus} Prioritize regressions, correctness issues, risky edge cases, and missing tests. ${commonInstructions}`;
	}

	return `Review ${request.targetOrFocus} from the current project. ${modeInstruction} If the target is a directory, review the most relevant files within that scope. ${commonInstructions}`;
}

async function openReviewSplit(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	direction: SplitDirection,
	request: ReviewRequest,
): Promise<{ ok: true } | { ok: false; error: string }> {
	return openCommandInNewSplit(pi, direction, buildPiCommand(ctx.cwd, { prompt: buildReviewPrompt(request) }));
}

function registerReviewCommand(
	pi: ExtensionAPI,
	name: string,
	direction: SplitDirection,
	description: string,
	successMessage: string,
): void {
	pi.registerCommand(name, {
		description,
		handler: async (args, ctx) => {
			const parsed = parseReviewArgs(args);
			if (!parsed.ok) {
				ctx.ui.notify(`${parsed.error}. ${getReviewUsage(name)}`, "warning");
				return;
			}

			const result = await openReviewSplit(pi, ctx, direction, parsed.request);
			if (result.ok) {
				ctx.ui.notify(successMessage, "info");
			} else {
				ctx.ui.notify(`review split failed: ${result.error}`, "error");
			}
		},
	});
}

export default function cmuxReviewExtension(pi: ExtensionAPI) {
	registerReviewCommand(
		pi,
		"cmrv",
		"right",
		"Open a new right split and start a fresh pi code review session",
		"Opened a review split to the right",
	);
	registerReviewCommand(
		pi,
		"review-v",
		"right",
		"Alias for /cmrv",
		"Opened a review split to the right",
	);

	registerReviewCommand(
		pi,
		"cmrh",
		"down",
		"Open a new lower split and start a fresh pi code review session",
		"Opened a review split below",
	);
	registerReviewCommand(
		pi,
		"review-h",
		"down",
		"Alias for /cmrh",
		"Opened a review split below",
	);
}
