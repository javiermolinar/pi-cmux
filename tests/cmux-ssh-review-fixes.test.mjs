import assert from "node:assert/strict";
import { test } from "node:test";
import registerSsh from "../extensions/cmux-ssh.ts";
import { createSshOperations, registerSshAdapter } from "../lib/ssh/adapter.ts";

const target = { destination: "fixture", remoteCwd: "/remote" };
const success = (stdout = Buffer.alloc(0)) => ({ exitCode: 0, stdout, stderr: Buffer.alloc(0) });
function host(id) {
	const tools = new Map(), handlers = new Map(), records = [];
	let active = ["read", "write", "edit", "bash"];
	const pi = { on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
		registerTool: tool => tools.set(tool.name, tool), registerCommand() {}, appendEntry: (type, data) => records.push({ type: "custom", customType: type, data }),
		getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; } };
	const ctx = { cwd: "/local/review-fix", hasUI: false, isIdle: () => false,
		sessionManager: { getSessionId: () => id, getBranch: () => records, getSessionFile: () => undefined }, ui: { notify() {}, setStatus() {} } };
	return { pi, ctx, tools, async emit(name, event = {}) { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); },
		call(name, args, signal) { return tools.get(name).execute("review-fix", args, signal, undefined, ctx); } };
}
async function authorize(h, destination = target.destination, remoteCwd = target.remoteCwd) {
	const prompt = `Connect to ${destination} in ${remoteCwd}`;
	await h.emit("input", { source: "interactive", text: prompt });
	await h.emit("before_agent_start", { messageType: "user", prompt });
}
function deferredValidation(id) {
	const h = host(id); let resolve;
	const calls = [];
	const adapter = registerSsh(h.pi, { env: {}, transport: { async run(request) {
		request.assertCurrent(); calls.push(request);
		if (calls.length === 1) return new Promise(r => { resolve = r; });
		return success();
	} } });
	return { ...h, adapter, runtime: adapter.runtime, calls, finish: () => resolve(success()) };
}

test("R1 grant-only invalidation during validation never leaves a ready target", async () => {
	for (const invalidate of [
		h => h.emit("input", { source: "interactive", text: "cancel", streamingBehavior: "steer" }),
		h => h.emit("input", { source: "interactive", text: "unrelated new request" }),
		h => h.emit("before_agent_start", { messageType: "custom", message: {} }),
	]) {
		const h = deferredValidation("grant-revoked"); await h.emit("session_start"); await authorize(h);
		const pending = h.call("ssh_connect", target);
		const rejected = assert.rejects(pending, /did not complete|cancelled/);
		await invalidate(h); h.finish(); await rejected;
		assert.notEqual(h.runtime.snapshot().state, "ready");
		assert.throws(() => h.runtime.captureDispatch(), /not ready/);
		assert.equal(h.calls.length, 1);
	}
});

test("R1 grant revocation aborts pending transport without waiting for its success", async () => {
	const h = deferredValidation("abort-pending-grant"); await h.emit("session_start"); await authorize(h);
	let settled = false;
	const pending = h.call("ssh_connect", target).then(() => "success", () => { settled = true; return "rejected"; });
	await h.emit("input", { source: "interactive", text: "cancel", streamingBehavior: "steer" });
	await new Promise(resolve => setImmediate(resolve));
	try {
		assert.equal(h.calls[0].signal.aborted, true);
		assert.equal(settled, true, "revocation must not await an uncooperative transport");
		assert.equal(await pending, "rejected");
		assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	} finally { h.finish(); await pending; }
});

test("R1 late completion cannot disconnect a newer target or same-target generation", async () => {
	for (const next of [{ destination: "replacement", remoteCwd: "/next" }, target]) {
		const h = deferredValidation("newer-selection"); await h.emit("session_start"); await authorize(h);
		const old = h.call("ssh_connect", target).catch(error => error);
		await h.emit("input", { source: "interactive", text: "cancel", streamingBehavior: "steer" });
		await new Promise(resolve => setImmediate(resolve));
		h.runtime.activate(next); await h.adapter.validate();
		const ticket = h.runtime.captureDispatch();
		h.finish(); await old;
		assert.equal(h.runtime.snapshot().state, "ready");
		assert.deepEqual(h.runtime.snapshot().target, next);
		h.runtime.assertDispatch(ticket);
	}
});

// A virtual remote filesystem and wire reply; no actual filesystem, SSH or cleanup.
function fileHost(id, options = {}) {
	const h = host(id); let contents = options.content ?? Buffer.from("OLD\n");
	let writes = 0, attempts = 0;
	const adapter = registerSshAdapter(h.pi, { transport: { async run(request) {
		request.assertCurrent(); attempts++;
		if (request.script === "test -d . && test -x . && :") return success(Buffer.from(options.validationNoise ?? ""));
		const reading = request.script.includes("wc -c") || request.script.startsWith("cat --");
		const writing = request.script.startsWith("cat >");
		if (writing) { writes++; contents = Buffer.from(request.input); }
		const payload = reading ? contents : Buffer.alloc(0);
		const nonce = /PI_CMUX_SSH_FILE_V1:([a-f0-9]{48}):/.exec(request.script)?.[1];
		let stdout = nonce ? Buffer.concat([Buffer.from(`PI_CMUX_SSH_FILE_V1:${nonce}:${payload.length}\n`), payload, Buffer.from(`\nPI_CMUX_SSH_FILE_END_V1:${nonce}\n`)]) : payload;
		if (reading && options.readNoise) stdout = Buffer.concat([Buffer.from(options.readNoise), stdout]);
		if (writing && options.writeNoise) stdout = Buffer.concat([stdout, Buffer.from(options.writeNoise)]);
		if (reading && options.corruptRead) stdout = options.corruptRead(stdout);
		return success(stdout);
	} } });
	return { ...h, adapter, runtime: adapter.runtime, contents: () => contents, writes: () => writes, attempts: () => attempts };
}
async function ready(h) { await h.emit("session_start"); h.adapter.selection.prepare(h.ctx); h.runtime.activate(target); await h.adapter.validate(); await h.emit("turn_start"); }

test("R1 probes stay non-ready until a synchronous authorized commit and are single-use", async () => {
	const h = fileHost("commit-boundary"); await h.emit("session_start"); h.runtime.activate(target);
	const probe = await h.adapter.probeValidation();
	assert.equal(h.runtime.snapshot().state, "configured");
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	assert.throws(() => probe.commit(() => { throw new Error("grant revoked"); }), /grant revoked/);
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	assert.throws(() => probe.commit(), /consumed/);
	h.runtime.activate({ destination: "newer", remoteCwd: "/newer" }); await h.adapter.validate();
	const newer = h.runtime.captureDispatch(); probe.discard(); h.runtime.assertDispatch(newer);
});

test("R2 binary read and MIME cache consume exact framed payload, not protocol text", async () => {
	const payload = Buffer.from([0, 255, 128, 10, 13, 0, 195, 169]);
	const h = fileHost("binary-payload", { content: payload }); await ready(h);
	const ops = createSshOperations(h.runtime, h.adapter.transport, h.runtime.captureDispatch()).read;
	assert.equal(await ops.detectImageMimeType("fixture.bin"), null);
	assert.deepEqual(await ops.readFile("fixture.bin"), payload);
	assert.equal(h.writes(), 0);
});

test("R2 noisy validation is refused without granting readiness or attempting file mutation", async () => {
	const h = fileHost("noisy-validation", { validationNoise: "SHELL STARTUP NOTICE\n" });
	await h.emit("session_start"); h.runtime.activate(target);
	await assert.rejects(h.adapter.validate(), /unexpected stdout|quiet/);
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	assert.equal(h.writes(), 0);
});

test("R2 notice during read is not persisted by a successful edit", async () => {
	const h = fileHost("noisy-read", { readNoise: "SHELL STARTUP NOTICE\n" }); await ready(h);
	await assert.rejects(h.call("ssh_edit", { path: "fixture.txt", edits: [{ oldText: "OLD", newText: "NEW" }] }), /Invalid SSH file response/);
	assert.equal(h.contents().toString(), "OLD\n"); assert.equal(h.writes(), 0);
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
});

test("R2 malformed or trailing read frames fail before edit writes", async () => {
	for (const corruptRead of [
		bytes => bytes.subarray(0, -1),
		bytes => Buffer.concat([bytes, Buffer.from("notice")]),
		bytes => Buffer.from("invalid length or missing frame"),
	]) {
		const h = fileHost("corrupt-read", { corruptRead }); await ready(h);
		await assert.rejects(h.call("ssh_edit", { path: "fixture.txt", edits: [{ oldText: "OLD", newText: "NEW" }] }), /Invalid SSH file response/);
		assert.equal(h.writes(), 0); assert.equal(h.contents().toString(), "OLD\n");
	}
});

test("R2 legitimate notice-like file text and Unicode remain exact payload data", async () => {
	const original = "SHELL STARTUP NOTICE\nOLD café 🌍\n";
	const h = fileHost("real-file-notice", { content: Buffer.from(original) }); await ready(h);
	await h.call("ssh_edit", { path: "fixture.txt", edits: [{ oldText: "OLD", newText: "NEW" }] });
	assert.equal(h.contents().toString(), original.replace("OLD", "NEW")); assert.equal(h.writes(), 1);
});

test("R2 write acknowledgement noise is uncertain, never retried or rolled back", async () => {
	const h = fileHost("uncertain-ack", { writeNoise: "late account notice\n" }); await ready(h);
	await assert.rejects(h.call("ssh_edit", { path: "fixture.txt", edits: [{ oldText: "OLD", newText: "NEW" }] }), error => error.uncertain === true && /do not.*retry/i.test(error.message));
	assert.equal(h.contents().toString(), "NEW\n"); assert.equal(h.writes(), 1);
	assert.equal(h.attempts(), 4); // Validation, access, read, write: no reconnect or replay.
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
});
