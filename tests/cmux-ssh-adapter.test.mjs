import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import { createSshOperations, registerSshAdapter, resolveRemotePath, SshExecutionAdapter } from "../lib/ssh/adapter.ts";
import { OpenSshTransport, SshTransportError } from "../lib/ssh/transport.ts";
import { SshTargetRuntime } from "../lib/ssh/runtime.ts";

function harness(t, enabled = true) {
	const root = mkdtempSync(join(tmpdir(), "cmux-ssh-adapter-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const local = join(root, "local"), remote = join(root, "remote ' $d $(touch BAD) café");
	mkdirSync(local); mkdirSync(remote);
	const handlers = new Map(), tools = new Map(), commands = new Map(), calls = [];
	let active = ["read", "write", "edit", "bash"];
	const ctx = { cwd: local, sessionManager: SessionManager.inMemory(local), ui: { notify() {} }, isIdle: () => true };
	const pi = {
		on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
		registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
		appendEntry(type, data) { ctx.sessionManager.appendCustomEntry(type, data); },
		getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; },
	};
	const transport = new OpenSshTransport((file, args, options) => {
		calls.push({ file, args, options });
		return spawn("/bin/sh", ["-c", args.at(-1)], { stdio: "pipe", env: { PATH: "/usr/bin:/bin", REMOTE_SENTINEL: "remote" } });
	});
	const adapter = registerSshAdapter(pi, { transport, enabled });
	const emit = async (name, event = {}) => { let result; for (const fn of handlers.get(name) ?? []) result = await fn(event, ctx); return result; };
	const execute = (name, args, signal) => tools.get(name).execute("fixture", args, signal, undefined, ctx);
	return { root, local, remote, ctx, pi, adapter, runtime: adapter.runtime, emit, execute, calls, commands, tools };
}

const coreNames = ["read", "write", "edit", "bash"];
const guardedNames = [...coreNames, "powershell", "grep", "find", "ls"];
const remoteCalls = [
	["ssh_read", { path: "NO_LOCAL" }],
	["ssh_write", { path: "NO_LOCAL", content: "bad" }],
	["ssh_edit", { path: "NO_LOCAL", edits: [{ oldText: "old", newText: "new" }] }],
	["ssh_bash", { command: "touch NO_LOCAL" }],
];

for (const enabled of [true, false]) {
	test(`${enabled ? "enabled" : "disabled"} registration preserves local owners and rejects inactive SSH calls without connecting`, async (t) => {
		const h = harness(t, enabled); await h.emit("session_start");
		assert.equal(registerSshAdapter(h.pi), h.adapter); assert.equal(h.calls.length, 0);
		const factories = [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition];
		for (const [index, name] of coreNames.entries()) {
			assert.equal(h.tools.has(name), false);
			const tool = h.tools.get(`ssh_${name}`);
			assert.equal(tool.exposure, "direct"); assert.equal(tool.defaultActive, false);
			assert.deepEqual(tool.parameters, factories[index](h.local).parameters);
			assert.match(tool.description, /SSH target/); assert.match(tool.promptSnippet, /remote/i);
			assert.ok(tool.promptGuidelines.length > 0);
		}
		for (const [name, args] of remoteCalls) await assert.rejects(h.execute(name, args), /not ready/);
		for (const toolName of guardedNames) assert.equal(await h.emit("tool_call", { toolName }), undefined);
		// Pi owns local behavior; pi-cmux supplies no inactive local wrappers.
		await createWriteToolDefinition(h.local).execute("local", { path: "local.txt", content: "local only" }, undefined, undefined, h.ctx);
		assert.equal(readFileSync(join(h.local, "local.txt"), "utf8"), "local only");
		assert.equal(existsSync(join(h.local, "NO_LOCAL")), false);
		assert.equal(await h.emit("user_bash"), undefined);
		assert.equal(h.calls.length, 0); assert.equal(await h.emit("before_agent_start"), undefined);
	});
}

test("local tool_call guard follows remote intent in every enablement state", async (t) => {
	for (const enabled of [true, false]) {
		const h = harness(t); await h.emit("session_start");
		h.runtime.activate({ destination: "fixture", remoteCwd: h.remote });
		h.runtime.setEnabled(enabled);
		for (const phase of ["selected", "ready", "disabled", "disconnected", "restored", "pending"]) {
			if (phase === "ready" && enabled) await h.adapter.validate();
			if (phase === "disabled") h.runtime.setEnabled(false);
			if (phase === "disconnected") { h.runtime.setEnabled(enabled); h.runtime.disconnect(); }
			if (phase === "restored") await h.emit("session_start");
			if (phase === "pending") {
				h.runtime.setEnabled(true); h.runtime.beginResolution("fixture"); h.runtime.setEnabled(enabled);
				await h.emit("session_start"); // Pending intent survives restoration without a target.
			}
			for (const toolName of guardedNames) {
				assert.equal((await h.emit("tool_call", { toolName }))?.block, true, `${enabled}: ${phase}: ${toolName}`);
			}
			for (const toolName of ["ssh_read", "ssh_write", "ssh_edit", "ssh_bash", "unrelated"]) {
				assert.equal(await h.emit("tool_call", { toolName }), undefined);
			}
			if (h.runtime.snapshot().state !== "ready") {
				const count = h.calls.length;
				for (const [name, args] of remoteCalls) await assert.rejects(h.execute(name, args), /not ready/);
				await assert.rejects(h.emit("user_bash"), /not ready/);
				assert.equal(h.calls.length, count);
			}
		}
		h.runtime.clear();
		for (const toolName of guardedNames) assert.equal(await h.emit("tool_call", { toolName }), undefined);
		assert.equal(await h.emit("user_bash"), undefined);
	}
});

test("literal remote read/write/edit paths and large content never touch local project", async (t) => {
	const h = harness(t); await h.emit("session_start");
	h.adapter.selection.prepare(h.ctx);
	h.runtime.activate({ destination: "fixture", remoteCwd: h.remote });
	await h.adapter.validate(); assert.equal(h.runtime.snapshot().state, "ready"); await h.emit("turn_start");
	const name = "nested/ ~ @ '$HOME' $(touch BAD) café name.txt";
	const content = "original ' $() café\n".repeat(100_000);
	await h.execute("ssh_write", { path: name, content });
	assert.equal(readFileSync(join(h.remote, name), "utf8"), content);
	assert.equal(existsSync(join(h.local, "nested")), false); assert.equal(existsSync(join(h.remote, "BAD")), false);
	const read = await h.execute("ssh_read", { path: name, offset: 1, limit: 1 });
	assert.match(read.content[0].text, /original/);
	const exact = "literal.txt";
	await h.execute("ssh_write", { path: exact, content: "first\nsecond\nthird\n" });
	const edit = await h.execute("ssh_edit", { path: exact, edits: [{ oldText: "first", newText: "FIRST" }, { oldText: "third", newText: "THIRD" }] });
	assert.match(edit.content[0].text, /literal.txt/);
	assert.equal(readFileSync(join(h.remote, exact), "utf8"), "FIRST\nsecond\nTHIRD\n");
	assert.equal(existsSync(join(h.local, exact)), false);
	assert.equal(resolveRemotePath(h.remote, "~/$HOME/$(touch BAD)"), `${h.remote}/~/$HOME/$(touch BAD)`);
	const prompt = await h.emit("before_agent_start");
	assert.match(prompt.message.content, /remain LOCAL/); assert.match(prompt.message.content, /not automatically loaded/);
	assert.match(prompt.message.content, /ssh_read\/ssh_write\/ssh_edit\/ssh_bash/);
});

test("remote bash and user shell preserve cwd, remote PATH and exit status", async (t) => {
	const h = harness(t); await h.emit("session_start");
	h.adapter.selection.prepare(h.ctx);
	h.runtime.activate({ destination: "fixture", remoteCwd: h.remote }); await h.adapter.validate(); await h.emit("turn_start");
	const command = 'printf "%s\\n%s\\n%s" "$PWD" "$PATH" "$REMOTE_SENTINEL"; exit 23';
	const result = await h.execute("ssh_bash", { command });
	assert.match(result.content[0].text, /remote/); assert.equal(result.structuredContent.exit_code, 23);
	const user = await h.emit("user_bash", { command });
	const chunks = [];
	const status = await user.operations.exec(command, h.local, { onData: b => chunks.push(b), env: { PATH: "MAC_SENTINEL" } });
	assert.equal(status.exitCode, 23); assert.equal(Buffer.concat(chunks).toString(), `${h.remote}\n/usr/bin:/bin\nremote`);
	await assert.rejects(user.operations.exec(":", "/wrong-local-cwd", { onData() {} }), /context changed/);
});

test("configured/resumed, disabled and disconnected intent fail closed without local mutation", async (t) => {
	const h = harness(t); await h.emit("session_start");
	h.runtime.activate({ destination: "fixture", remoteCwd: h.remote });
	for (const state of ["configured", "ready", "disabled", "disconnected"]) {
		if (state === "ready") { await h.adapter.validate(); await h.emit("session_start"); }
		if (state === "disabled") h.runtime.setEnabled(false);
		if (state === "disconnected") { h.runtime.setEnabled(true); h.runtime.disconnect(); }
		const count = h.calls.length;
		for (const [name, args] of remoteCalls) await assert.rejects(h.execute(name, args), /not ready/);
		await assert.rejects(h.emit("user_bash"), /not ready/);
		assert.equal(h.calls.length, count); assert.equal(existsSync(join(h.local, "NO_LOCAL")), false);
	}
});

test("validation failure, cancelled action and stale callbacks do not replay or replace newer target", async () => {
	const runtime = new SshTargetRuntime(() => {}); runtime.startSession({ sessionId: "test", localCwd: "/local" }, []);
	const A = { destination: "fixture-A", remoteCwd: "/remote" }, B = { ...A, destination: "fixture-B" };
	let calls = 0;
	const adapter = new SshExecutionAdapter(runtime, { transport: { async run() { calls++; throw new SshTransportError("connection", true); } } });
	runtime.activate(A); await assert.rejects(adapter.validate(), /connection\/authentication/);
	assert.equal(runtime.snapshot().state, "disconnected"); assert.equal(calls, 1);
	const controller = new AbortController(); controller.abort();
	await assert.rejects(adapter.validate(controller.signal), /cancelled/); assert.equal(calls, 1);
	let finish;
	const deferred = new SshExecutionAdapter(runtime, { transport: { run: () => new Promise(r => { finish = r; }) } });
	runtime.activate(A); const pending = deferred.validate();
	runtime.activate(B); const validation = runtime.beginValidation(); runtime.completeValidation(validation);
	finish({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
	await assert.rejects(pending, /cancelled/); assert.equal(runtime.snapshot().state, "ready"); assert.equal(runtime.snapshot().target.destination, "fixture-B");
});

test("association is rechecked before effects, and late observations cannot dispatch a replacement", async () => {
	const runtime = new SshTargetRuntime(() => {}); runtime.startSession({ sessionId: "test", localCwd: "/local" }, []);
	const association = { workspaceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", backend: "native-ssh" };
	const target = { destination: "fixture", remoteCwd: "/remote" };
	runtime.activate(target, association);
	const v = runtime.beginValidation(); runtime.completeValidation(v, { ...association, destination: "fixture", enabled: true, transport: "ssh", connected: true });
	let effects = 0;
	const ops = createSshOperations(runtime, { async run() { effects++; } }, runtime.captureDispatch(), undefined, async () => undefined);
	await assert.rejects(ops.write.writeFile("a", "b"), /association/); assert.equal(effects, 0);
	assert.equal(runtime.snapshot().state, "disconnected");
});
