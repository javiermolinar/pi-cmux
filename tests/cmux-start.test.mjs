import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cmuxStartExtension from "../extensions/cmux-start.ts";
import cmuxContinueExtension from "../extensions/cmux-continue.ts";
import piCmuxExtension from "../extensions/index.ts";

const { parseArgs } = await import(new URL("./cli/args.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const gitEnv = () => ({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function assistant(content = [{ type: "text", text: "Previous implementation details" }]) {
	return { role: "assistant", content, api: "openai-responses", provider: "openai", model: "test", stopReason: "stop", usage: EMPTY_USAGE, timestamp: Date.now() };
}

function harness(t, options = {}) {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-cmux-start-")));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const cwd = join(root, "project's files");
	const bin = join(root, "bin");
	mkdirSync(cwd);
	mkdirSync(bin);
	symlinkSync(process.execPath, join(bin, "node"));
	writeFileSync(join(bin, "pi"), '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({cwd:process.cwd(), args:process.argv.slice(2)}));\n', { mode: 0o755 });
	const oldPath = process.env.PATH;
	process.env.PATH = `${bin}:/usr/bin:/bin`;
	t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; });
	t.mock.method(globalThis, "setTimeout", (callback) => { queueMicrotask(callback); return 0; });
	// Exercise the real SessionManager without writing to the user's session store.
	const create = SessionManager.create;
	t.mock.method(SessionManager, "create", (directory, sessionDir, opts) => create.call(SessionManager, directory, sessionDir ?? join(root, "seeded-sessions"), opts));
	const sessionManager = SessionManager.create(cwd, join(root, "source-sessions"));
	const commands = new Map();
	const tools = new Map();
	const calls = [];
	const notifications = [];
	const ctx = { cwd, sessionManager, waitForIdle: async () => {}, ui: { notify: (...args) => notifications.push(args) } };
	const pi = {
		on() {},
		registerCommand(name, command) { commands.set(name, command); },
		registerTool(tool) { tools.set(tool.name, tool); },
		async exec(command, args, execOptions) {
			calls.push({ command, args, options: execOptions });
			if (command === "git") {
				if (options.git) {
					const result = spawnSync(command, args, { cwd: execOptions.cwd, encoding: "utf8", timeout: execOptions.timeout, env: gitEnv() });
					return { code: result.status, killed: Boolean(result.error), stdout: result.stdout, stderr: result.stderr };
				}
				return { code: 1, killed: false, stdout: "", stderr: "not a git repository" };
			}
			assert.equal(command, "cmux");
			const subcommand = args[0] === "--json" ? args[1] : args[0];
			if (options.fail === subcommand) return { code: 1, killed: false, stdout: "", stderr: `${subcommand} failed` };
			let response = {};
			if (subcommand === "identify") response = { caller: { window_ref: "window:1", workspace_ref: "workspace:1", pane_ref: "pane:1", surface_ref: "surface:1" } };
			else if (subcommand === "list-panes") response = { panes: [{ ref: "pane:1", surface_refs: ["surface:1"] }] };
			else if (subcommand === "workspace") {
				assert.equal(args[2], "create");
				response = { workspace_ref: "workspace:2", surface_ref: "surface:2" };
			} else if (subcommand === "new-split" || subcommand === "new-surface") response = { surface_ref: "surface:2" };
			else assert.ok(["respawn-pane", "rename-tab"].includes(subcommand), `Unexpected cmux call: ${subcommand}`);
			return { code: 0, killed: false, stdout: JSON.stringify(response), stderr: "" };
		},
	};
	if (options.settings) {
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify(options.settings));
		t.mock.method(process, "cwd", () => cwd);
	}
	(options.extension ?? cmuxStartExtension)(pi);
	return {
		root, cwd, ctx, commands, tools, calls, notifications,
		invoke: (params = {}, signal) => tools.get("cmux_start_pi").execute("start-call", params, signal, undefined, ctx),
		callsFor: (name) => calls.filter((call) => call.command === "cmux" && (call.args[0] === "--json" ? call.args[1] : call.args[0]) === name),
		launch() {
			const call = calls.find((call) => call.command === "cmux" && call.args[0] === "respawn-pane");
			assert.ok(call, "Pi must be launched");
			const command = call.args[call.args.indexOf("--command") + 1];
			const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", timeout: 10000, env: { ...process.env, PATH: "/usr/bin:/bin" } });
			assert.ifError(result.error);
			assert.equal(result.status, 0, result.stderr);
			const captured = JSON.parse(result.stdout);
			const parsed = parseArgs(captured.args);
			assert.deepEqual(parsed.diagnostics, []);
			assert.equal(parsed.unknownFlags.size, 0);
			return { ...captured, parsed };
		},
	};
}

test("bundle advertises browser, terminal, and Pi tools and registers /cmn, not /cmc", (t) => {
	const h = harness(t, { extension: piCmuxExtension });
	assert.deepEqual([...h.tools.keys()].sort(), ["cmux_annotate_browser", "cmux_open_browser", "cmux_open_terminal", "cmux_start_pi"]);
	assert.ok(h.commands.has("cmb"));
	assert.ok(h.commands.has("cmba"));
	assert.ok(h.commands.has("cmn"));
	assert.equal(h.commands.has("cmc"), false);
	assert.ok(h.commands.has("cmcv"));
	assert.ok(h.commands.has("cmch"));
	for (const name of ["cmrv", "cmrh", "review-v", "review-h"]) {
		assert.equal(h.commands.has(name), false, `${name} is no longer bundled`);
	}
	const tool = h.tools.get("cmux_start_pi");
	assert.equal(tool.parameters.properties.placement.default, "workspace");
	assert.equal(tool.parameters.properties.continueSession.default, false);
	assert.equal(tool.parameters.properties.cwd.type, "string");
	assert.equal(tool.parameters.properties.cwd.minLength, 1);
	assert.ok(tool.promptGuidelines.some((text) => text.includes("pass its path through cwd")));
	assert.ok(tool.promptGuidelines.some((text) => text.includes("explicitly")));
});

test("users can register former review command names as configured shortcuts", (t) => {
	const commands = Object.fromEntries(["cmrv", "cmrh", "review-v", "review-h"].map((name) => [name, "echo own-review"]));
	const h = harness(t, { extension: piCmuxExtension, settings: { "pi-cmux": { commands } } });
	for (const name of Object.keys(commands)) {
		assert.match(h.commands.get(name).description, /echo own-review/);
	}
});

for (const [name, description] of [["cmn", /fresh Pi chat/], ["cmb", /Open a browser/], ["cmba", /Retry browser annotations/]]) {
	test(`configured shortcuts cannot replace /${name}`, (t) => {
		const warnings = [];
		t.mock.method(console, "warn", (message) => warnings.push(message));
		const h = harness(t, { extension: piCmuxExtension, settings: { "pi-cmux": { commands: { [name]: "echo wrong" } } } });
		assert.match(h.commands.get(name).description, description);
		assert.ok(warnings.some((warning) => warning.includes(`/${name}: command already exists`)));
	});
}

for (const prompt of ["Review the auth flow", "--help", "--handoff", "  First line\nSecond line  ", 'Bob\'s "quoted" task: $HOME $(printf wrong) `printf wrong`; *.txt | cat']) {
	test(`/cmn launches a fresh workspace and preserves prompt ${JSON.stringify(prompt)}`, async (t) => {
		const h = harness(t);
		await h.commands.get("cmn").handler(prompt, h.ctx);
		const launch = h.launch();
		assert.deepEqual(launch.args, ["--", prompt.trim()]);
		assert.equal(launch.cwd, h.cwd);
		assert.equal(launch.parsed.session, undefined);
		assert.equal(h.callsFor("workspace").length, 1);
		assert.equal(h.notifications.at(-1)[1], "info");
	});
}

test("/cmn rejects an empty prompt without creating a workspace", async (t) => {
	const h = harness(t);
	await h.commands.get("cmn").handler(" \n ", h.ctx);
	assert.deepEqual(h.notifications, [["Usage: /cmn <prompt>", "warning"]]);
	assert.equal(h.calls.length, 0);
});

test("/cmn reports creation failures", async (t) => {
	const h = harness(t, { fail: "workspace" });
	await h.commands.get("cmn").handler("A new task", h.ctx);
	assert.equal(h.notifications.at(-1)[1], "error");
	assert.match(h.notifications.at(-1)[0], /workspace failed/);
	assert.equal(h.callsFor("respawn-pane").length, 0);
});

test("/cmn normalizes and bounds the task-derived sidebar title", async (t) => {
	const h = harness(t);
	await h.commands.get("cmn").handler(`  Task\n   ${"long ".repeat(40)}  `, h.ctx);
	const args = h.callsFor("workspace")[0].args;
	const title = args[args.indexOf("--name") + 1];
	assert.match(title, /^Task long /);
	assert.ok(title.length <= 48);
	assert.ok(title.endsWith("..."));
});

for (const placement of [undefined, "workspace", "right", "down", "tab"]) {
	test(`tool starts fresh without reading source history: placement=${placement}`, async (t) => {
		const h = harness(t);
		h.ctx.sessionManager = new Proxy({}, { get() { assert.fail("fresh sessions must not inspect history"); } });
		const result = await h.invoke({ placement, prompt: "--help", title: "Auth review", focus: false, provider: "openai", model: "example", thinking: "high" });
		const launch = h.launch();
		assert.deepEqual(launch.args, ["--provider", "openai", "--model", "example", "--thinking", "high", "--", "--help"]);
		assert.equal(result.details.continueSession, false);
		assert.equal(result.details.cwd, h.cwd);
		assert.equal(launch.cwd, h.cwd);
		assert.equal(result.details.placement, placement ?? "workspace");
		const subcommand = !placement || placement === "workspace" ? "workspace" : placement === "tab" ? "new-surface" : "new-split";
		const args = h.callsFor(subcommand)[0].args;
		assert.equal(args[args.indexOf("--focus") + 1], "false");
		if (placement === "right" || placement === "down") assert.equal(args[2], placement);
	});
}

for (const placement of ["workspace", "right", "down", "tab"]) {
	for (const pathKind of ["absolute", "relative", "home-relative"]) {
		test(`tool starts in the requested directory: ${placement}, ${pathKind}`, async (t) => {
			const h = harness(t);
			const target = join(h.root, 'other repo\'s $HOME $(printf wrong) `printf wrong`; files');
			mkdirSync(target);
			const cwd = pathKind === "absolute" ? target : pathKind === "relative"
				? relative(h.cwd, target) : `~/${relative(homedir(), target)}`;
			h.ctx.sessionManager = new Proxy({}, { get() { assert.fail("fresh sessions must not inspect history"); } });
			const result = await h.invoke({ cwd, placement, prompt: "Review this repo" });
			assert.equal(h.launch().cwd, target);
			assert.equal(result.details.cwd, target);
			assert.match(result.content[0].text, /Working directory:/);
			assert.match(result.details.title, /^Review this repo · other repo/);
			assert.ok(h.calls.some((call) => call.command === "git" && call.options.cwd === target));
			assert.equal(h.ctx.cwd, h.cwd, "source directory must not change");
			if (placement === "workspace") {
				const args = h.callsFor("workspace")[0].args;
				assert.equal(args[args.indexOf("--cwd") + 1], target);
			}
		});
	}
}

test("tool expands a bare home directory", async (t) => {
	const h = harness(t);
	const result = await h.invoke({ cwd: "~" });
	assert.equal(h.launch().cwd, realpathSync(homedir()));
	assert.equal(result.details.cwd, homedir());
});

for (const pathKind of ["missing", "file", "file-parent"]) {
	test(`tool rejects a ${pathKind} cwd before opening cmux`, async (t) => {
		const h = harness(t);
		const file = join(h.root, "not-a-directory");
		writeFileSync(file, "test");
		const cwd = pathKind === "missing" ? join(h.root, "missing") : pathKind === "file" ? file : join(file, "child");
		await assert.rejects(() => h.invoke({ cwd }), /cwd/);
		assert.equal(h.calls.length, 0);
	});
}

test("tool can open an empty fresh chat", async (t) => {
	const h = harness(t);
	await h.invoke();
	assert.deepEqual(h.launch().args, []);
});

for (const [params, pattern] of [
	[{ placement: "invalid" }, /placement/],
	[{ cwd: "" }, /non-empty cwd/],
	[{ cwd: " \n " }, /non-empty cwd/],
	[{ cwd: "bad\0path" }, /NUL/],
	[{ cwd: ".", continueSession: true }, /cwd cannot be combined/],
	[{ cwd: ".", continueSession: true, branch: "fix/auth" }, /cwd cannot be combined/],
	[{ branch: "fix/auth" }, /continueSession/],
	[{ branch: " " }, /branch name/],
	[{ fromRef: "main" }, /requires branch/],
	[{ fromRef: " " }, /base ref/],
	[{ provider: "openai" }, /requires model/],
]) {
	test(`tool rejects invalid options before side effects: ${JSON.stringify(params)}`, async (t) => {
		const h = harness(t);
		await assert.rejects(() => h.invoke(params), pattern);
		assert.equal(h.calls.length, 0);
	});
}

test("tool does not launch after cancellation", async (t) => {
	const h = harness(t);
	await assert.rejects(() => h.invoke({}, AbortSignal.abort()), /abort/i);
	assert.equal(h.calls.length, 0);
});

test("tool reports cmux errors rather than a successful result", async (t) => {
	const h = harness(t, { fail: "respawn-pane" });
	await assert.rejects(() => h.invoke({ prompt: "Test auth" }), /respawn-pane failed/);
	assert.equal(h.callsFor("workspace").length, 1);
});

for (const previousAssistant of [false, true]) {
	test(`handoff forks the active branch before its own tool batch, previousAssistant=${previousAssistant}`, async (t) => {
		const h = harness(t);
		const source = h.ctx.sessionManager;
		source.appendMessage({ role: "user", content: "Implement authentication", timestamp: Date.now() });
		if (previousAssistant) {
			const forkPoint = source.appendMessage(assistant());
			source.appendMessage({ role: "user", content: "Abandoned branch", timestamp: Date.now() });
			source.branch(forkPoint);
		}
		source.appendMessage({ role: "user", content: "Hand this task off", timestamp: Date.now() });
		source.appendMessage(assistant([
			{ type: "toolCall", id: "sibling-call", name: "read", arguments: { path: "auth.ts" } },
			{ type: "toolCall", id: "start-call", name: "cmux_start_pi", arguments: { continueSession: true } },
		]));
		source.appendMessage({ role: "toolResult", toolName: "read", toolCallId: "sibling-call", content: [{ type: "text", text: "Sibling result" }], isError: false, timestamp: Date.now() });
		const sourceFile = source.getSessionFile();
		const before = readFileSync(sourceFile, "utf8");
		const leaf = source.getLeafId();
		const result = await h.invoke({ continueSession: true, prompt: "Next: add login tests", title: "Login tests" });
		const file = result.details.sessionFile;
		assert.notEqual(file, sourceFile);
		assert.equal(h.launch().parsed.session, file);
		assert.equal(readFileSync(sourceFile, "utf8"), before);
		assert.equal(source.getLeafId(), leaf);
		const fork = SessionManager.open(file);
		assert.equal(fork.getHeader().parentSession, sourceFile);
		const text = JSON.stringify(fork.getEntries());
		assert.match(text, /Implement authentication/);
		assert.match(text, /Next: add login tests/);
		assert.match(text, /forked from the current conversation/);
		assert.doesNotMatch(text, /start-call|sibling-call|Abandoned branch/);
		fork.appendMessage(assistant());
		assert.equal(readFileSync(file, "utf8").split("\n").filter((line) => line && JSON.parse(line).type === "session").length, 1);
	});
}

for (const mode of ["in-memory", "unflushed", "empty"]) {
	test(`handoff persists summary-only context for ${mode} sources`, async (t) => {
		const h = harness(t);
		if (mode === "in-memory") h.ctx.sessionManager = SessionManager.inMemory(h.cwd);
		if (mode !== "empty") h.ctx.sessionManager.appendMessage({ role: "user", content: "Implement authentication", timestamp: Date.now() });
		const result = await h.invoke({ continueSession: true, prompt: "Add login tests next" });
		const file = result.details.sessionFile;
		assert.ok(existsSync(file));
		const seeded = SessionManager.open(file);
		const text = JSON.stringify(seeded.getEntries());
		assert.match(text, /Add login tests next/);
		assert.doesNotMatch(text, /forked from the current conversation/);
		if (mode !== "empty") assert.match(text, /Current task: Implement authentication/);
		seeded.appendMessage(assistant());
		assert.match(readFileSync(file, "utf8"), /Add login tests next/);
	});
}

test("worktree handoff creates a branch and persists summary without copying dirty files or history", async (t) => {
	const h = harness(t, { git: true });
	for (const args of [["init", "-b", "main"], ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial"]]) {
		const result = spawnSync("git", args, { cwd: h.cwd, encoding: "utf8", env: gitEnv() });
		assert.equal(result.status, 0, result.stderr);
	}
	writeFileSync(join(h.cwd, "dirty.txt"), "source only");
	h.ctx.sessionManager.appendMessage({ role: "user", content: "Implement login", timestamp: Date.now() });
	h.ctx.sessionManager.appendMessage(assistant([{ type: "text", text: "History should not be copied" }]));
	const result = await h.invoke({ continueSession: true, branch: "fix/login", fromRef: "main", prompt: "Implement login tests" });
	assert.notEqual(result.details.cwd, h.cwd);
	assert.equal(h.launch().cwd, result.details.cwd);
	assert.equal(existsSync(join(result.details.cwd, "dirty.txt")), false);
	const seeded = SessionManager.open(result.details.sessionFile);
	assert.equal(seeded.getHeader().cwd, result.details.cwd);
	const text = JSON.stringify(seeded.getEntries());
	assert.match(text, /Target branch: fix\/login/);
	assert.match(text, /Base ref: main/);
	assert.match(text, /Implement login tests/);
	assert.match(text, /dirty.txt/);
	assert.doesNotMatch(text, /History should not be copied/);
	await assert.rejects(() => h.invoke({ continueSession: true, branch: "fix/login" }), /Branch already exists/);
	assert.equal(h.callsFor("workspace").length, 1);
});

test("legacy continuation commands keep their split placements", async (t) => {
	const h = harness(t, { extension: cmuxContinueExtension });
	for (const [name, direction] of [["cmcv", "right"], ["cmch", "down"]]) {
		await h.commands.get(name).handler("Focus on tests", h.ctx);
		assert.equal(h.callsFor("new-split").at(-1).args[2], direction);
	}
	assert.equal(h.callsFor("workspace").length, 0);
});
