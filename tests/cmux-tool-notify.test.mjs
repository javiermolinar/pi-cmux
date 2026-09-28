import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import cmuxNotifyExtension from "../extensions/cmux-notify.ts";

function settings(tools) {
	return { "pi-cmux": { notify: { tools } } };
}

async function createHarness(t, { global = {}, project = {}, env = {}, mode = "tui" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-cmux-tool-notify-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const writeSettings = (path, value) => writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
	writeSettings(join(agentDir, "settings.json"), global);
	writeSettings(join(cwd, ".pi", "settings.json"), project);
	for (const [name, value] of Object.entries({
		PI_CODING_AGENT_DIR: agentDir,
		PI_CMUX_NOTIFY_LEVEL: "all",
		PI_CMUX_NOTIFY_FORCE: undefined,
		PI_CMUX_NOTIFY_DEBOUNCE_MS: "0",
		PI_CMUX_NOTIFY_TITLE: "Pi",
		CMUX_SURFACE_ID: "surface:test",
		CMUX_PANEL_ID: undefined,
		...env,
	})) {
		const previous = process.env[name];
		t.after(() => previous === undefined ? delete process.env[name] : process.env[name] = previous);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	t.mock.method(console, "warn", () => {});
	const handlers = new Map();
	const calls = [];
	cmuxNotifyExtension({
		on: (name, handler) => handlers.set(name, handler),
		exec: async (command, args) => {
			calls.push({ command, args });
			return { code: 0, stdout: "", stderr: "", killed: false };
		},
	});
	const ctx = { cwd, mode, isIdle: () => true };
	const emit = (name, event = {}, context = ctx) => handlers.get(name)?.({ type: name, ...event }, context);
	await emit("session_start", { reason: "startup" });
	return { calls, ctx, emit, start: (toolName, args = {}) => emit("tool_execution_start", { toolName, args }) };
}

test("tool notifications require an exact configured name and expose only a path basename", async (t) => {
	const h = await createHarness(t, { project: settings({ ask_user_question: true, read: true }) });
	await h.start("bash", { command: "private shell command" });
	await h.start("ask_user_question_extra");
	await h.start("ask_user_question", { question: "private question" });
	await h.start("read", { path: "/private/project/config.ts" });
	assert.deepEqual(h.calls.map(({ args }) => args), [
		["notify", "--title", "Pi", "--subtitle", "Tool: ask_user_question", "--body", "Using ask_user_question"],
		["notify", "--title", "Pi", "--subtitle", "Tool: read", "--body", "Using read on config.ts"],
	]);
});

test("project tool settings add entries and disable global entries", async (t) => {
	const h = await createHarness(t, {
		global: settings({ read: true, ask_user_question: true }),
		project: settings({ read: { disabled: true }, write: true }),
	});
	for (const tool of ["read", "ask_user_question", "write"]) await h.start(tool);
	assert.deepEqual(h.calls.map(({ args }) => args.at(-1)), ["Using ask_user_question", "Using write"]);
});

for (const invalid of [null, [], false, "bad", 42]) {
	for (const field of ["notify", "tools"]) {
		test(`invalid ${field}=${JSON.stringify(invalid)} does not break registration or global settings`, async (t) => {
			const project = field === "notify" ? { "pi-cmux": { notify: invalid } } : settings(invalid);
			const h = await createHarness(t, { global: settings({ read: true }), project });
			await h.start("read");
			assert.equal(h.calls.length, 1);
		});
	}
}

for (const project of ["{", "null", "[]", { "pi-cmux": null }, { "pi-cmux": [] }]) {
	test(`malformed settings ${JSON.stringify(project)} are ignored`, async (t) => {
		const h = await createHarness(t, { project });
		await h.start("read");
		assert.equal(h.calls.length, 0);
	});
}

test("invalid tool entries do not enable tools or remove a global entry", async (t) => {
	const h = await createHarness(t, {
		global: settings({ read: true }),
		project: settings({ read: { disabled: "true" }, "bad name": true, bash: false, write: null, edit: {} }),
	});
	for (const tool of ["read", "bad name", "bash", "write", "edit"]) await h.start(tool);
	assert.deepEqual(h.calls.map(({ args }) => args.at(-1)), ["Using read"]);
});

for (const level of [undefined, "", "invalid", "disabled", "all", "medium", "low"]) {
	test(`tool notification level ${String(level)}`, async (t) => {
		const h = await createHarness(t, { project: settings({ read: true }), env: { PI_CMUX_NOTIFY_LEVEL: level } });
		await h.start("read");
		assert.equal(h.calls.length, ["all", "medium", "low"].includes(level) ? 1 : 0);
	});
}

for (const mode of ["print", "json", "rpc", "sdk"]) {
	test(`inherited cmux environment does not enable notifications in ${mode}`, async (t) => {
		const h = await createHarness(t, { mode, project: settings({ read: true }) });
		await h.start("read");
		assert.equal(h.calls.length, 0);
	});
}

for (const panel of [undefined, "panel:test"]) {
	test(`tool notifications require a surface or legacy panel (${String(panel)})`, async (t) => {
		const h = await createHarness(t, { project: settings({ read: true }), env: { CMUX_SURFACE_ID: undefined, CMUX_PANEL_ID: panel } });
		await h.start("read");
		assert.equal(h.calls.length, panel ? 1 : 0);
	});
}

for (const [level, expected] of [[undefined, 0], ["disabled", 0], ["all", 1], ["low", 1]]) {
	test(`forced tool notifications in headless mode still honor level ${String(level)}`, async (t) => {
		const h = await createHarness(t, {
			mode: "print", project: settings({ read: true }),
			env: { PI_CMUX_NOTIFY_LEVEL: level, PI_CMUX_NOTIFY_FORCE: "1", CMUX_SURFACE_ID: undefined },
		});
		await h.start("write");
		await h.start("read");
		assert.equal(h.calls.length, expected);
	});
}

test("session replacement reloads settings from the new context cwd", async (t) => {
	const h = await createHarness(t, { project: settings({ read: true }) });
	await h.start("read");
	const nextCwd = join(h.ctx.cwd, "next");
	mkdirSync(join(nextCwd, ".pi"), { recursive: true });
	writeFileSync(join(nextCwd, ".pi", "settings.json"), JSON.stringify(settings({ write: true })));
	await h.emit("session_start", { reason: "resume" }, { ...h.ctx, cwd: nextCwd });
	await h.start("read");
	await h.start("write");
	assert.deepEqual(h.calls.map(({ args }) => args.at(-1)), ["Using read", "Using write"]);
});
