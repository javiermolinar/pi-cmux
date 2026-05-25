import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { basename, dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

const GIT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_STATUS_LINES = 20;

export interface GitExecResult {
	ok: boolean;
	stdout: string;
	stderr: string;
	error?: string;
}

export interface GitRepoInfo {
	repoRoot: string;
	branch?: string;
	statusLines: string[];
}

interface GitWorktreeInfo {
	path: string;
	branch?: string;
}

export async function execGit(pi: ExtensionAPI, cwd: string, args: string[]): Promise<GitExecResult> {
	const result = await pi.exec("git", args, { timeout: GIT_TIMEOUT_MS, cwd });
	if (result.killed) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: "git command timed out",
		};
	}
	if (result.code !== 0) {
		return {
			ok: false,
			stdout: result.stdout,
			stderr: result.stderr,
			error: result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`,
		};
	}
	return {
		ok: true,
		stdout: result.stdout,
		stderr: result.stderr,
	};
}

export async function getGitRepoInfo(pi: ExtensionAPI, cwd: string, maxStatusLines: number = DEFAULT_MAX_STATUS_LINES): Promise<GitRepoInfo | undefined> {
	const rootResult = await execGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (!rootResult.ok) return undefined;
	const repoRoot = rootResult.stdout.trim();
	if (!repoRoot) return undefined;

	const branchResult = await execGit(pi, cwd, ["branch", "--show-current"]);
	const statusResult = await execGit(pi, cwd, ["status", "--short", "--untracked-files=all"]);

	return {
		repoRoot,
		branch: branchResult.ok ? branchResult.stdout.trim() || undefined : undefined,
		statusLines: statusResult.ok
			? statusResult.stdout
				.split("\n")
				.map((line) => line.trimEnd())
				.filter((line) => line.trim().length > 0)
				.slice(0, maxStatusLines)
			: [],
	};
}

function parseWorktreeList(text: string): GitWorktreeInfo[] {
	const worktrees: GitWorktreeInfo[] = [];
	let current: GitWorktreeInfo | undefined;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trimEnd();
		if (line.startsWith("worktree ")) {
			if (current) worktrees.push(current);
			current = { path: line.slice("worktree ".length).trim() };
			continue;
		}
		if (!current) continue;
		if (line.startsWith("branch ")) {
			current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "") || undefined;
			continue;
		}
		if (line.length === 0) {
			worktrees.push(current);
			current = undefined;
		}
	}

	if (current) worktrees.push(current);
	return worktrees;
}

function slugifyBranchName(branch: string): string {
	return branch
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "worktree";
}

export async function branchExists(pi: ExtensionAPI, repoRoot: string, branch: string): Promise<boolean> {
	const result = await pi.exec("git", ["show-ref", "--verify", "--", `refs/heads/${branch}`], { timeout: GIT_TIMEOUT_MS, cwd: repoRoot });
	return !result.killed && result.code === 0;
}

async function resolveWorktreePath(
	pi: ExtensionAPI,
	repoRoot: string,
	branch: string,
): Promise<{ ok: true; path: string; reused: boolean } | { ok: false; error: string }> {
	const listResult = await execGit(pi, repoRoot, ["worktree", "list", "--porcelain"]);
	if (!listResult.ok) {
		return { ok: false, error: listResult.error || "Failed to list git worktrees" };
	}

	const existing = parseWorktreeList(listResult.stdout).find((worktree) => worktree.branch === branch);
	if (existing) {
		return { ok: true, path: existing.path, reused: true };
	}

	const worktreeRoot = join(dirname(repoRoot), `${basename(repoRoot)}-worktrees`);
	const targetPath = join(worktreeRoot, slugifyBranchName(branch));
	if (existsSync(targetPath)) {
		return { ok: false, error: `Worktree path already exists and cannot be reused: ${targetPath}` };
	}

	mkdirSync(worktreeRoot, { recursive: true });
	return { ok: true, path: targetPath, reused: false };
}

export async function ensureExistingBranchWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	branch: string,
): Promise<{ ok: true; path: string; reused: boolean } | { ok: false; error: string }> {
	if (!(await branchExists(pi, repoRoot, branch))) {
		return { ok: false, error: `Local branch does not exist: ${branch}` };
	}

	const pathResult = await resolveWorktreePath(pi, repoRoot, branch);
	if (!pathResult.ok) return pathResult;
	if (pathResult.reused) return pathResult;

	const addResult = await execGit(pi, repoRoot, ["worktree", "add", pathResult.path, branch]);
	if (!addResult.ok) {
		return { ok: false, error: addResult.error || `Failed to create worktree for branch ${branch}` };
	}

	return pathResult;
}

export async function ensureCreatedBranchWorktree(
	pi: ExtensionAPI,
	repoRoot: string,
	branch: string,
	fromRef?: string,
): Promise<{ ok: true; path: string } | { ok: false; error: string }> {
	if (await branchExists(pi, repoRoot, branch)) {
		return { ok: false, error: `Branch already exists: ${branch}` };
	}

	const pathResult = await resolveWorktreePath(pi, repoRoot, branch);
	if (!pathResult.ok) return pathResult;
	if (pathResult.reused) {
		return { ok: true, path: pathResult.path };
	}

	const args = ["worktree", "add", "-b", branch, pathResult.path];
	if (fromRef?.trim()) {
		args.push(fromRef.trim());
	}
	const addResult = await execGit(pi, repoRoot, args);
	if (!addResult.ok) {
		return { ok: false, error: addResult.error || `Failed to create branch worktree ${branch}` };
	}

	return { ok: true, path: pathResult.path };
}
