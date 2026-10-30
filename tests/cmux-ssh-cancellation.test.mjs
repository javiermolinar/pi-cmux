import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { SshExecutionAdapter, createSshOperations } from "../lib/ssh/adapter.ts";
import { SshTargetRuntime } from "../lib/ssh/runtime.ts";
import { SshTransportError } from "../lib/ssh/transport.ts";
import { coreNames, installed, piVersions, sshSdk } from "./helpers/ssh-sdk.mjs";

const success = () => ({ exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) });
const cancelled = (controller, mode) => controller.abort(mode === "timeout"
	? new DOMException("Fixture deadline", "TimeoutError") : undefined);
const owner = { sessionId: "uncertainty-test", localCwd: "/local" };
const target = { destination: "fixture", remoteCwd: "/remote" };
function runtime() {
	const state = new SshTargetRuntime(() => {});
	state.startSession(owner, []); state.activate(target);
	return state;
}
const uncertain = (error, kind) => error instanceof SshTransportError && error.kind === kind
	&& error.uncertain === true && /effects may have occurred; do not automatically retry/.test(error.message)
	&& !/not dispatched/.test(error.message);

for (const [version, root] of piVersions) for (const sshFirst of [true, false]) {
	const options = { skip: installed(root) ? false : `${version} unavailable; no dependency installation attempted` };
	for (const mode of ["cancelled", "timeout"]) for (const operation of ["write", "edit", "bash", "mkdir"]) {
		test(`${version}, SSH ${sshFirst ? "first" : "last"}: ${mode} after acknowledged ${operation} never reports not dispatched`, options, async t => {
			const h = await sshSdk(t, root, sshFirst);
			writeFileSync(join(h.cwd, "sentinel"), "LOCAL");
			if (operation === "edit") writeFileSync(join(h.remote, "effect-before-cancel"), "BEFORE");
			await h.connect(); await h.turn();
			const abort = new AbortController(), base = h.adapter().transport;
			let completed = 0;
			const command = "printf EFFECT_COMPLETED > effect-before-cancel";
			h.adapter().transport = { async run(request) {
				const result = await base.run(request);
				if ((operation === "bash" && request.script === command)
					|| (operation === "mkdir" && request.script.startsWith("mkdir -p "))
					|| (["write", "edit"].includes(operation) && request.script.startsWith("cat > "))) {
					completed++; cancelled(abort, mode); // After actual effects and framed acknowledgment.
				}
				return result;
			} };
			const args = operation === "bash" ? { command }
				: operation === "edit" ? { path: "effect-before-cancel", edits: [{ oldText: "BEFORE", newText: "EFFECT_COMPLETED" }] }
				: { path: operation === "mkdir" ? "created-directory/file" : "effect-before-cancel", content: "EFFECT_COMPLETED" };
			const result = await h.direct(`ssh_${operation === "mkdir" ? "write" : operation}`, args, h.cached(), abort.signal);
			assert.equal(completed, 1, "no automatic retry");
			if (operation === "mkdir") {
				assert.equal(existsSync(join(h.remote, "created-directory")), true);
				assert.equal(existsSync(join(h.remote, "created-directory/file")), false);
			} else assert.equal(readFileSync(join(h.remote, "effect-before-cancel"), "utf8"), "EFFECT_COMPLETED");
			assert.equal(result.isError, true, JSON.stringify(result));
			const error = result.result.content[0].text;
			assert.match(error, new RegExp(`SSH ${mode} failure`));
			assert.match(error, /remote effects may have occurred; do not automatically retry/);
			assert.doesNotMatch(error, /not dispatched/);
			assert.equal(readFileSync(join(h.cwd, "sentinel"), "utf8"), "LOCAL");
			assert.equal(existsSync(join(h.cwd, "effect-before-cancel")), false);
		});
	}
	for (const mode of ["cancelled", "timeout"]) test(`${version}, SSH ${sshFirst ? "first" : "last"}: ${mode} during Pi's post-write continuation retains uncertainty`, options, async t => {
		const h = await sshSdk(t, root, sshFirst); await h.connect(); await h.turn();
		const base = h.adapter().transport, abort = new AbortController();
		h.adapter().transport = { async run(request) {
			const result = await base.run(request);
			if (request.script.startsWith("cat > ")) {
				// Let the adapter's immediate post-transport guard pass, then abort
				// before Pi's awaited write/mutation-queue continuation completes.
				queueMicrotask(() => queueMicrotask(() => cancelled(abort, mode)));
			}
			return result;
		} };
		const result = await h.direct("ssh_write", { path: "late-cancel", content: "COMPLETED" }, h.cached(), abort.signal);
		assert.equal(result.isError, true);
		assert.equal(readFileSync(join(h.remote, "late-cancel"), "utf8"), "COMPLETED");
		assert.match(result.result.content[0].text, /remote effects may have occurred; do not automatically retry/);
		assert.doesNotMatch(result.result.content[0].text, /not dispatched/);
	});
	test(`${version}, SSH ${sshFirst ? "first" : "last"}: revoked post-effect work is uncertain and cannot disconnect its replacement`, options, async t => {
		const h = await sshSdk(t, root, sshFirst); await h.connect(); await h.turn();
		const base = h.adapter().transport, state = h.adapter().runtime;
		let writes = 0;
		h.adapter().transport = { async run(request) {
			const result = await base.run(request);
			if (request.script.startsWith("cat > ")) {
				writes++;
				state.activate({ destination: "replacement", remoteCwd: h.remote });
				state.completeValidation(state.beginValidation());
			}
			return result;
		} };
		const result = await h.direct("ssh_write", { path: "effect-before-replacement", content: "COMPLETED" });
		assert.equal(result.isError, true);
		assert.match(result.result.content[0].text, /remote effects may have occurred; do not automatically retry/);
		assert.equal(readFileSync(join(h.remote, "effect-before-replacement"), "utf8"), "COMPLETED");
		assert.equal(writes, 1);
		assert.equal(state.snapshot().target.destination, "replacement");
		assert.equal(state.snapshot().state, "ready");
		assert.equal((await h.direct("ssh_bash", { command: ":" })).isError, true, "replacement still needs a fresh turn");
	});
	test(`${version}, SSH ${sshFirst ? "first" : "last"}: cancellation before dispatch has no remote or local effects`, options, async t => {
		const h = await sshSdk(t, root, sshFirst); await h.connect(); await h.turn();
		const before = h.spawns.length;
		for (const name of coreNames) {
			const args = name === "bash" ? { command: "touch not-created" }
				: name === "edit" ? { path: "not-created", edits: [{ oldText: "OLD", newText: "NEW" }] }
				: name === "write" ? { path: "not-created", content: "NO" } : { path: "not-created" };
			const result = await h.direct(`ssh_${name}`, args, h.cached(), AbortSignal.abort());
			assert.equal(result.isError, true);
		}
		assert.equal(h.spawns.length, before);
		assert.equal(existsSync(join(h.cwd, "not-created")), false);
		assert.equal(existsSync(join(h.remote, "not-created")), false);
	});
}

test("first-request transport no-dispatch evidence remains precise; later-stage evidence is workflow-scoped", async () => {
	for (const earlier of [false, true]) {
		const state = runtime(); state.completeValidation(state.beginValidation());
		const failure = new SshTransportError("spawn", false); let calls = 0;
		const ops = createSshOperations(state, { async run() {
			calls++; if (earlier && calls === 1) return success(); throw failure;
		} }, state.captureDispatch());
		if (earlier) await ops.bash.exec(":", owner.localCwd, { onData() {} });
		await assert.rejects(ops.write.writeFile("not-created", "NO"), error => earlier
			? uncertain(error, "spawn") : error === failure);
		assert.equal(calls, earlier ? 2 : 1);
	}
});

for (const mode of ["cancelled", "timeout"]) {
	for (const action of ["resolveHome", "probeValidation"]) test(`${action}: ${mode} after transport handoff is uncertain`, async () => {
		const state = runtime(), abort = new AbortController();
		let calls = 0;
		const adapter = new SshExecutionAdapter(state, { transport: { async run(request) {
			request.assertCurrent(); calls++; cancelled(abort, mode); return success();
		} } });
		const work = action === "resolveHome" ? adapter.resolveHome("fixture", abort.signal) : adapter.probeValidation(abort.signal);
		await assert.rejects(work, error => uncertain(error, mode));
		assert.equal(calls, 1); assert.notEqual(state.snapshot().state, "ready");
	});
	test(`${mode} before first dispatch retains definite no-dispatch evidence`, async () => {
		const state = runtime(); state.completeValidation(state.beginValidation());
		const abort = new AbortController(); cancelled(abort, mode);
		let calls = 0;
		const ops = createSshOperations(state, { async run() { calls++; return success(); } }, state.captureDispatch(), abort.signal);
		await assert.rejects(ops.write.writeFile("not-created", "NO"), { kind: mode, uncertain: false });
		assert.equal(calls, 0);
	});
	test(`${mode} after earlier workflow dispatch cannot become not dispatched on a later stage`, async () => {
		const state = runtime(); state.completeValidation(state.beginValidation());
		const abort = new AbortController(); let calls = 0;
		const ops = createSshOperations(state, { async run(request) {
			request.assertCurrent(); calls++; return success();
		} }, state.captureDispatch(), abort.signal);
		await ops.bash.exec(":", owner.localCwd, { onData() {} });
		cancelled(abort, mode);
		await assert.rejects(ops.write.writeFile("later-stage", "NO"), error => uncertain(error, mode));
		assert.equal(calls, 1);
	});
}
