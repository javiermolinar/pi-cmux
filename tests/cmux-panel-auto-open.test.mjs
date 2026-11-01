import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import cmuxPanelExtension from "../extensions/cmux-panel.ts";

const ids = {
	window: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
	workspace: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
	surface: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
};
const settings = (autoOpen) => ({ "pi-cmux": { panel: { autoOpen } } });
const success = (value = "") => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "", killed: false });
const caller = () => ({ window_id: ids.window, workspace_id: ids.workspace, surface_id: ids.surface,
	workspace_ref: "workspace:1", surface_ref: "surface:1" });

function harness(t, { global = {}, project = {}, panel = true, mode = "tui", env = {}, respond } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-cmux-panel-auto-open-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const home = join(root, "home"), agentDir = join(root, "agent"), cwd = join(root, "project");
	mkdirSync(agentDir); mkdirSync(join(cwd, ".pi"), { recursive: true });
	const panelPath = join(home, ".config", "cmux", "sidebars", "agent-state-panel.js");
	mkdirSync(join(home, ".config", "cmux", "sidebars"), { recursive: true });
	if (panel) writeFileSync(panelPath, "// installed test fixture; never executed\n");
	const writeSettings = (path, value) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	const globalPath = join(agentDir, "settings.json"), projectPath = join(cwd, ".pi", "settings.json");
	writeSettings(globalPath, global); writeSettings(projectPath, project);
	for (const [key, value] of Object.entries({ HOME: home, PI_CODING_AGENT_DIR: agentDir,
		CMUX_WORKSPACE_ID: ids.workspace, CMUX_SURFACE_ID: ids.surface, ...env })) {
		const previous = process.env[key];
		t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	t.mock.method(console, "warn", () => {});
	const handlers = new Map(), calls = [];
	const defaultReply = (args) => {
		if (args.at(-1) === "identify") return success({ caller: caller() });
		if (args.includes("workspace.list")) return success({ workspaces: [
			{ id: ids.workspace, remote: { enabled: false, connected: false, transport: null, backend: null } },
		] });
		assert.deepEqual(args, ["right-sidebar", "set", "custom", "agent-state-panel", "--workspace", ids.workspace, "--no-focus"]);
		return success();
	};
	cmuxPanelExtension({
		on: (name, handler) => handlers.set(name, handler),
		exec: async (command, args, options) => {
			assert.equal(command, "cmux");
			calls.push({ command, args, options });
			return respond ? respond(args, defaultReply, options) : defaultReply(args);
		},
	});
	const ctx = { cwd, mode };
	const emit = (name, event = {}) => handlers.get(name)?.({ type: name, ...event }, ctx);
	return { root, ctx, calls, handlers, panelPath, globalPath, projectPath,
		start: (reason = "startup") => emit("session_start", { reason }),
		shutdown: () => emit("session_shutdown", { reason: "quit" }) };
}
const opens = h => h.calls.filter(call => call.args[0] === "right-sidebar");

test("auto-open defaults to false and registration performs no CLI work", async t => {
	const h = harness(t);
	assert.equal(h.calls.length, 0);
	await h.start();
	assert.equal(h.calls.length, 0);
	assert.deepEqual([...h.handlers.keys()], ["session_shutdown", "session_start"]);
});

for (const [label, global, project, expected] of [
	["project opt-in", {}, settings(true), 1],
	["global opt-in", settings(true), {}, 1],
	["project opt-out", settings(true), settings(false), 0],
	["project overrides global false", settings(false), settings(true), 1],
]) {
	test(`auto-open ${label}`, async t => {
		const h = harness(t, { global, project });
		await h.start();
		assert.equal(opens(h).length, expected);
		if (expected) {
			assert.equal(h.calls.length, 3);
			assert.ok(h.calls.every(call => call.options.timeout === 5000));
			assert.deepEqual(opens(h)[0].args, ["right-sidebar", "set", "custom", "agent-state-panel", "--workspace", ids.workspace, "--no-focus"]);
		}
	});
}

for (const value of ["true", 1, null, [], {}]) {
	test(`auto-open rejects non-boolean ${JSON.stringify(value)} instead of inheriting global true`, async t => {
		const h = harness(t, { global: settings(true), project: settings(value) });
		await h.start(); assert.equal(h.calls.length, 0);
	});
}

for (const project of ["{", "null", "[]", { "pi-cmux": null }, { "pi-cmux": { panel: [] } }]) {
	test(`auto-open fails closed for malformed settings ${JSON.stringify(project)}`, async t => {
		const h = harness(t, { global: settings(true), project });
		await h.start(); assert.equal(h.calls.length, 0);
	});
}

test("missing project settings inherit global opt-in", async t => {
	const h = harness(t, { global: settings(true) });
	rmSync(h.projectPath);
	await h.start(); assert.equal(opens(h).length, 1);
});

for (const mode of ["print", "json", "rpc", "sdk"]) {
	test(`auto-open never changes cmux in ${mode} even with inherited environment and opt-in`, async t => {
		const h = harness(t, { mode, project: settings(true) });
		await h.start(); assert.equal(h.calls.length, 0);
	});
}

for (const env of [{ CMUX_WORKSPACE_ID: undefined }, { CMUX_SURFACE_ID: undefined },
	{ CMUX_WORKSPACE_ID: "workspace:1" }, { CMUX_SURFACE_ID: "not-a-uuid" }]) {
	test(`auto-open refuses cmux environment ${Object.entries(env).map(([key, value]) => `${key}=${String(value)}`).join(", ")}`, async t => {
		const h = harness(t, { env, project: settings(true) });
		await h.start(); assert.equal(h.calls.length, 0);
	});
}

for (const kind of ["missing", "directory", "symlink"]) {
	test(`auto-open requires an installed regular panel file (${kind})`, async t => {
		const h = harness(t, { panel: false, project: settings(true) });
		if (kind === "directory") mkdirSync(h.panelPath);
		if (kind === "symlink") { writeFileSync(join(h.root, "other.js"), ""); symlinkSync(join(h.root, "other.js"), h.panelPath); }
		await h.start(); assert.equal(h.calls.length, 0);
	});
}

for (const field of ["window_id", "workspace_id", "surface_id", "workspace_ref"]) {
	test(`auto-open refuses mismatched/missing caller ${field}`, async t => {
		const h = harness(t, { project: settings(true), respond: (args, fallback) => {
			if (args.at(-1) !== "identify") return fallback(args);
			const identity = caller();
			if (field === "workspace_id" || field === "surface_id") identity[field] = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
			else delete identity[field];
			return success({ caller: identity });
		} });
		await h.start(); assert.equal(opens(h).length, 0);
	});
}

for (const evidence of ["remote", "missing", "duplicate", "stale"]) {
	test(`auto-open refuses ${evidence} workspace locality`, async t => {
		const h = harness(t, { project: settings(true), respond: (args, fallback) => {
			if (!args.includes("workspace.list")) return fallback(args);
			const row = { id: ids.workspace, remote: { enabled: false } };
			if (evidence === "remote") row.remote.enabled = true;
			if (evidence === "missing") delete row.remote;
			return success({ workspaces: evidence === "stale" ? [] : evidence === "duplicate" ? [row, row] : [row] });
		} });
		await h.start(); assert.equal(opens(h).length, 0);
	});
}

test("auto-open runs once per load, never on new/resume/fork or later starts after manual close", async t => {
	const h = harness(t, { project: settings(true) });
	for (const reason of ["new", "resume", "fork"]) await h.start(reason);
	assert.equal(h.calls.length, 0);
	await h.start("reload");
	await h.start("startup");
	await h.start("reload");
	assert.equal(opens(h).length, 1);
});

test("a disabled startup is consumed; changing settings later does not unexpectedly reopen the panel", async t => {
	const h = harness(t);
	await h.start();
	writeFileSync(h.projectPath, JSON.stringify(settings(true)));
	await h.start(); assert.equal(h.calls.length, 0);
});

for (const failure of ["error", "timeout", "throw"]) {
	test(`auto-open ${failure} is swallowed without retry or command-content logging`, async t => {
		const h = harness(t, { project: settings(true), respond: (args, fallback) => {
			if (args[0] !== "right-sidebar") return fallback(args);
			if (failure === "throw") throw new Error("private transport content");
			return { code: 1, stdout: "", stderr: "private transport content", killed: failure === "timeout" };
		} });
		await h.start(); await h.start();
		assert.equal(opens(h).length, 1);
		assert.ok(console.warn.mock.calls.every(call => !call.arguments.join(" ").includes("private transport content")));
	});
}

for (const stage of ["identify", "workspace.list"]) {
	test(`shutdown fences an in-flight ${stage} before the open effect`, async t => {
		let entered, release;
		const waiting = new Promise(resolve => { entered = resolve; });
		const blocked = new Promise(resolve => { release = resolve; });
		const h = harness(t, { project: settings(true), respond: async (args, fallback) => {
			if (args.includes(stage)) { entered(); await blocked; }
			return fallback(args);
		} });
		const pending = h.start();
		await waiting; await h.shutdown(); release(); await pending;
		assert.equal(opens(h).length, 0);
		assert.equal(h.calls[0].options.signal.aborted, true);
	});
}

test("panel removal during locality lookup prevents the open", async t => {
	const h = harness(t, { project: settings(true), respond: (args, fallback) => {
		if (args.includes("workspace.list")) rmSync(h.panelPath);
		return fallback(args);
	} });
	await h.start(); assert.equal(opens(h).length, 0);
});

test("caller environment changes during locality lookup prevent the open", async t => {
	const h = harness(t, { project: settings(true), respond: (args, fallback) => {
		if (args.includes("workspace.list")) process.env.CMUX_SURFACE_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
		return fallback(args);
	} });
	await h.start(); assert.equal(opens(h).length, 0);
});

test("overlapping startup events cannot duplicate the open attempt", async t => {
	let entered, release;
	const waiting = new Promise(resolve => { entered = resolve; });
	const blocked = new Promise(resolve => { release = resolve; });
	const h = harness(t, { project: settings(true), respond: async (args, fallback) => {
		if (args.at(-1) === "identify") { entered(); await blocked; }
		return fallback(args);
	} });
	const first = h.start();
	await waiting;
	await h.start(); release(); await first;
	assert.equal(opens(h).length, 1);
	assert.equal(h.calls.length, 3);
});

test("identify failure never probes locality or replays startup", async t => {
	const h = harness(t, { project: settings(true), respond: () => ({ code: 1, killed: false, stdout: "", stderr: "unavailable" }) });
	await h.start(); await h.start();
	assert.equal(h.calls.length, 1);
	assert.equal(opens(h).length, 0);
});
