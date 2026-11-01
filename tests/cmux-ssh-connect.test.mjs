import assert from "node:assert/strict";
import { test } from "node:test";
import { SshTargetRuntime } from "../lib/ssh/runtime.ts";
import { SshExecutionAdapter } from "../lib/ssh/adapter.ts";
import { SshTransportError } from "../lib/ssh/transport.ts";
import { createSshConnector, decideSshConversation, registerSshConnect, validateConnect, SSH_AUTH_GUIDANCE } from "../lib/ssh/connect.ts";

const target = { destination: "javi", remoteCwd: "/srv/project" };
function fixture(run, requested = target) {
	const entries = [], calls = [], tools = new Map();
	const runtime = new SshTargetRuntime((type, record) => entries.push({ type, record }));
	runtime.startSession({ sessionId: "current", localCwd: "/local" }, []);
	const ctx = { cwd: "/local", signal: undefined, isIdle: () => true, hasUI: true,
		sessionManager: { getSessionId: () => "current" },
		ui: { confirm() { assert.fail("Connection must not ask for confirmation"); }, select() { assert.fail("No picker"); }, input() { assert.fail("No questionnaire"); } } };
	let authorized = true;
	const authority = { currentRequest: (_ctx, action, params) => authorized && action === "connect" && params.destination === requested.destination && params.remoteCwd === requested.remoteCwd };
	const adapter = new SshExecutionAdapter(runtime, { transport: { async run(request) {
		request.assertCurrent(); calls.push(request);
		return run ? run(request) : { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	} } });
	const connect = createSshConnector(adapter, authority);
	return { entries, calls, ctx, adapter, runtime, connect, authority, tools, revoke() { authorized = false; } };
}

test("complete 'Connect to javi in /srv/project' supplied fields connect without questions or a yes/no gate", async () => {
	// This asserts supplied-field flow, not a claim about natural-language model compliance.
	const decision = decideSshConversation(target);
	assert.deepEqual(decision, { kind: "connect", target });
	const h = fixture();
	assert.match(await h.connect(decision.target, h.ctx), /ready/);
	assert.equal(h.calls.length, 1); assert.equal(h.entries.length, 1);
	assert.deepEqual(h.runtime.snapshot().target, target);
	assert.equal(h.runtime.snapshot().association, undefined);
	assert.equal(h.runtime.snapshot().state, "ready");
	assert.equal(h.calls[0].script, "test -d . && test -x . && :");
});

test("missing fields ask exactly one question; discovery never selects even a sole candidate", () => {
	const h = fixture();
	assert.equal(decideSshConversation({}).field, "destination");
	assert.equal(decideSshConversation({ remoteCwd: target.remoteCwd }).field, "destination");
	assert.deepEqual(decideSshConversation({ destination: "javi" }), {
		kind: "connect", target: { destination: "javi", remoteCwd: "~" },
	});
	for (const remoteCwd of ["", "relative", "~/project", "~other"]) {
		assert.equal(decideSshConversation({ destination: "javi", remoteCwd }).field, "remoteCwd", "invalid explicit paths never default home");
	}
	for (const candidates of [["javi"], ["javi", "javi-work"]]) {
		const decision = decideSshConversation({ remoteCwd: target.remoteCwd, ambiguousHostCandidates: candidates });
		assert.equal(decision.kind, "question"); assert.equal(decision.field, "destination");
		assert.deepEqual(decision.suggestions, candidates); assert.match(decision.question, /manual/);
	}
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
});

const homeRequest = { destination: "javi", remoteCwd: "~" };
function homeReply(request, home = "/home/remote ' café $HOME $(not-executed)") {
	const nonce = /PI_CMUX_SSH_FILE_V1:([a-f0-9]{48}):/.exec(request.script)?.[1];
	assert.ok(nonce);
	const payload = Buffer.isBuffer(home) ? home : Buffer.from(home);
	return { exitCode: 0, stdout: Buffer.concat([Buffer.from(`PI_CMUX_SSH_FILE_V1:${nonce}:${payload.length}\n`), payload,
		Buffer.from(`\nPI_CMUX_SSH_FILE_END_V1:${nonce}\n`)]), stderr: Buffer.alloc(0) };
}

for (const supplied of [{ destination: "javi" }, homeRequest]) {
	test(`remote home request ${JSON.stringify(supplied)} resolves before saving an absolute target`, async () => {
		const home = "/home/remote ' café $HOME $(not-executed)";
		const h = fixture(request => {
			if (request.script === "test -d . && test -x . && :") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
			assert.equal(h.runtime.snapshot().state, "disconnected");
			assert.equal(h.runtime.snapshot().reason, "connection-pending");
			assert.equal(h.entries.length, 1);
			assert.equal(h.entries[0].record.kind, "pending");
			assert.equal(h.entries[0].record.destination, "javi");
			assert.equal(h.entries[0].record.target, undefined);
			assert.equal(h.runtime.snapshot().target, undefined);
			assert.throws(() => h.runtime.captureDispatch(), /not ready/);
			assert.deepEqual(request.target, { destination: "javi", remoteCwd: "/" });
			assert.equal(request.maxOutputBytes, 20 * 1024);
			return homeReply(request, home);
		}, homeRequest);
		assert.match(await h.connect(supplied, h.ctx), /ready/);
		assert.equal(h.calls.length, 2, "one home lookup, then one cwd validation; neither is a retry");
		assert.equal(h.entries.length, 2);
		assert.deepEqual(h.entries[1].record.target, { destination: "javi", remoteCwd: home });
		assert.deepEqual(h.calls[1].target, h.entries[1].record.target);
		assert.equal(h.runtime.snapshot().state, "ready");
	});
}

for (const mode of ["relative", "control", "oversized", "invalid-utf8", "noise", "trailing", "failure", "auth"]) {
	test(`invalid remote-home resolution (${mode}) never saves a guessed target or retries`, async () => {
		const h = fixture(request => {
			if (mode === "auth") throw new SshTransportError("connection", true);
			const payload = mode === "relative" ? "relative" : mode === "control" ? "/PRIVATE\npath" : mode === "oversized" ? "/" + "x".repeat(4096)
				: mode === "invalid-utf8" ? Buffer.from([47, 255]) : "/home/PRIVATE";
			const reply = homeReply(request, payload);
			if (mode === "noise") return { ...reply, stdout: Buffer.concat([Buffer.from("PRIVATE notice\n"), reply.stdout]) };
			if (mode === "trailing") return { ...reply, stdout: Buffer.concat([reply.stdout, Buffer.from("PRIVATE notice")]) };
			if (mode === "failure") return { ...reply, exitCode: 1 };
			return reply;
		}, homeRequest);
		await assert.rejects(h.connect({ destination: "javi" }, h.ctx), error => !error.message.includes("PRIVATE"));
		assert.equal(h.calls.length, 1);
		assert.equal(h.entries.length, 1); assert.equal(h.entries[0].record.kind, "pending");
		assert.equal(h.runtime.snapshot().state, "disconnected");
		assert.equal(h.runtime.snapshot().target, undefined);
		assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	});
}

test("home lookup revokes old dispatch and cancellation cannot restore it or fall back locally", async () => {
	let finish;
	const h = fixture(request => request.script === "test -d . && test -x . && :"
		? { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
		: new Promise(resolve => { finish = () => resolve(homeReply(request)); }), homeRequest);
	h.runtime.activate(target); await h.adapter.validate();
	const oldTicket = h.runtime.captureDispatch();
	const cancel = new AbortController();
	const pending = h.connect(homeRequest, h.ctx, cancel.signal);
	assert.throws(() => h.runtime.assertDispatch(oldTicket), /no longer current/);
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	cancel.abort(); await assert.rejects(pending);
	finish(); await Promise.resolve();
	assert.equal(h.entries.length, 2, "only the old target and unresolved new intent were saved");
	assert.equal(h.runtime.snapshot().state, "disconnected");
});

test("stale home lookup cannot overwrite a replacement target, even after A to B to A", async () => {
	let finish;
	const h = fixture(request => request.script === "test -d . && test -x . && :"
		? { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }
		: new Promise(resolve => { finish = () => resolve(homeReply(request)); }), homeRequest);
	const pending = h.connect(homeRequest, h.ctx);
	const rejected = assert.rejects(pending);
	h.runtime.activate(target);
	h.runtime.activate({ destination: "other", remoteCwd: "/other" });
	h.runtime.activate(target); await h.adapter.validate();
	finish(); await rejected;
	assert.deepEqual(h.runtime.snapshot().target, target);
	assert.equal(h.runtime.snapshot().state, "ready");
	assert.equal(h.entries.length, 4, "pending intent and replacements only; no late home selection is saved");
});

test("failed home resolution remains non-local after reload and requires a fresh connection request", async () => {
	const h = fixture(() => { throw new SshTransportError("connection", true); }, homeRequest);
	await assert.rejects(h.connect(homeRequest, h.ctx));
	h.runtime.startSession({ sessionId: "current", localCwd: "/local" }, h.entries.map(({ type, record }) => ({ type: "custom", customType: type, data: record })));
	assert.equal(h.runtime.snapshot().state, "disconnected");
	assert.equal(h.runtime.snapshot().reason, "connection-pending");
	assert.equal(h.runtime.snapshot().target, undefined);
	assert.throws(() => h.runtime.beginValidation(), /cannot be validated/);
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	assert.equal(h.calls.length, 1, "reload never replays home discovery");
});

test("home evidence retains its fence across the caller's await boundary", async () => {
	const h = fixture(request => homeReply(request), homeRequest);
	const resolved = await h.adapter.resolveHome("javi");
	h.runtime.activate(target);
	assert.throws(() => resolved.assertCurrent());
	assert.deepEqual(h.runtime.snapshot().target, target);
});

test("manual user@host is accepted, never a discovered workspace/backend/mode", async () => {
	const h = fixture();
	const manual = { destination: "dev@manual.example", remoteCwd: "/opt/work" };
	const connect = createSshConnector(h.adapter, { currentRequest: (_ctx, action, p) => action === "connect" && p.destination === manual.destination });
	await connect(decideSshConversation(manual).target, h.ctx);
	assert.deepEqual(h.runtime.snapshot().target, manual); assert.equal(h.runtime.snapshot().association, undefined);
});

test("incomplete/unsafe/unknown secret or execution fields fail before activation, persistence and transport", async () => {
	const h = fixture();
	const invalid = [{}, { destination: "javi", remoteCwd: "" }, { remoteCwd: "/srv" },
		{ ...target, destination: "-oProxyCommand=bad" }, { ...target, destination: "a;echo" },
		{ ...target, remoteCwd: "~/project" }, { ...target, remoteCwd: "/x\nsecret" },
		... ["password", "privateKey", "passphrase", "command", "mode", "backend", "workspaceId", "confirmed"].map(key => ({ ...target, [key]: "sensitive-sentinel" })),
		Object.assign(Object.create({ destination: "javi" }), { remoteCwd: "/srv" }),
		Object.defineProperty({ remoteCwd: "/srv" }, "destination", { get() { assert.fail("Getter must not run"); } }),
	];
	for (const params of invalid) {
		assert.throws(() => validateConnect(params));
		await assert.rejects(h.connect(params, h.ctx), error => !error.message.includes("sensitive-sentinel"));
	}
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0); assert.equal(h.runtime.snapshot().state, "inactive");
});

test("disabled, foreign ctx, absent current intent and pre-cancelled calls have no side effects", async () => {
	for (const setup of [
		h => h.runtime.setEnabled(false), h => { h.ctx.cwd = "/other"; },
		h => { h.ctx.sessionManager.getSessionId = () => "other"; },
		h => h.revoke(),
		h => { h.ctx.signal = AbortSignal.abort(); },
	]) {
		const h = fixture(); setup(h);
		await assert.rejects(h.connect(target, h.ctx));
		assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
	}
	const h = fixture(); await assert.rejects(h.connect(target, h.ctx, AbortSignal.abort()));
	assert.equal(h.entries.length, 0); assert.equal(h.calls.length, 0);
	assert.deepEqual(decideSshConversation({ ...target, cancelled: true }), { kind: "cancelled" });
});

test("authentication failure gives fixed outside-chat guidance, no retry/key setup or secret output", async () => {
	const h = fixture(() => { throw new SshTransportError("connection", true); });
	await assert.rejects(h.connect(target, h.ctx), { message: SSH_AUTH_GUIDANCE });
	assert.equal(h.calls.length, 1); assert.equal(h.runtime.snapshot().state, "disconnected");
	assert.deepEqual(h.entries[0].record.target, target);
	const other = fixture(() => { throw new Error("password-sensitive-sentinel"); });
	await assert.rejects(other.connect(target, other.ctx), e => !e.message.includes("sensitive-sentinel"));
});

test("in-flight revocation cannot publish readiness or automatically reconnect", async () => {
	let finish;
	const h = fixture(() => new Promise(resolve => { finish = resolve; }));
	const pending = h.connect(target, h.ctx);
	h.runtime.setEnabled(false);
	finish({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
	await assert.rejects(pending); assert.equal(h.runtime.snapshot().state, "disabled");
	assert.equal(h.calls.length, 1);
});

test("opt-in registration is inert, idempotent and rejects forged consent parameters", async () => {
	const h = fixture(); const pi = { registerTool(tool) { h.tools.set(tool.name, tool); } };
	registerSshConnect(pi, h.adapter, h.authority); registerSshConnect(pi, h.adapter, h.authority);
	assert.equal(h.tools.size, 1); assert.equal(h.calls.length, 0); assert.equal(h.entries.length, 0);
	const tool = h.tools.get("ssh_connect");
	assert.equal(tool.exposure, "model-only");
	assert.equal(tool.executionMode, "sequential");
	assert.equal(tool.parameters.additionalProperties, false);
	assert.deepEqual(tool.parameters.required, ["destination"]);
	assert.equal(tool.parameters.properties.remoteCwd.default, "~");
	await assert.rejects(tool.execute("test", { ...target, confirmed: true }, undefined, undefined, h.ctx));
	h.ctx.isIdle = () => false; // Real model tool context is busy, not an idle slash command.
	const result = await tool.execute("test", target, undefined, undefined, h.ctx);
	assert.deepEqual(result.details, {}); assert.equal(h.calls.length, 1);
});
