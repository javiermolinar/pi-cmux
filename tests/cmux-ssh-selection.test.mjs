import assert from "node:assert/strict";
import { test } from "node:test";
import { registerSshAdapter } from "../lib/ssh/adapter.ts";
import { registerSshConnect } from "../lib/ssh/connect.ts";
import { SshTargetRuntime } from "../lib/ssh/runtime.ts";
import { SSH_TARGET_ENTRY } from "../lib/ssh/target.ts";
import { consumeSshLaunch, encodeSshLaunch, SSH_LAUNCH_ENV } from "../lib/ssh/launch.ts";
import { GUARDED_LOCAL_TOOLS, SSH_DATA_TOOLS, SSH_SELECTION_ENTRY, parseSshSelectionRecord, restoreSshSelection } from "../lib/ssh/selection.ts";

const owner = { sessionId: "selection-test", localCwd: "/local/project" };
const target = { destination: "fixture", remoteCwd: "/remote/project" };
const capture = (localTools, extra = {}) => ({ version: 1, ...owner, kind: "capture", localTools, exact: true, ...extra });
const entry = (customType, data) => ({ type: "custom", customType, data });
const intent = (kind = "target", extra = {}) => entry(SSH_TARGET_ENTRY, { version: 1, ...owner, kind, ...(kind === "target" ? { target } : {}), ...extra });

// Membership-only host seam: mirrors Pi rejecting hidden, filtered and unknown names.
// These are focused controller tests, not a replacement for real SDK/codemode coverage.
function host(options = {}) {
	const handlers = new Map(), tools = new Map(), commands = new Map(), notices = [], effects = [], selections = [];
	for (const name of [...GUARDED_LOCAL_TOOLS, "other", "later"]) tools.set(name, { name, exposure: "deferred", owner: "another extension" });
	let active = [...(options.active ?? ["read", "write", "edit", "bash", "other"])];
	let branch = [...(options.branch ?? [])], sessionId = options.sessionId ?? owner.sessionId;
	const excluded = new Set(options.excluded ?? []);
	let failSave = false, failSelection = false, idle = true;
	const ctx = { cwd: owner.localCwd, sessionManager: {
		getSessionId: () => sessionId, getBranch: () => branch, getSessionFile: () => undefined,
	}, isIdle: () => idle, ui: { notify: (...args) => notices.push(args) } };
	const pi = {
		on(name, fn) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
		registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
		getActiveTools: () => [...active],
		setActiveTools(names) {
			if (failSelection) throw new Error("host selection failed");
			active = [...new Set(names)].filter(name => tools.has(name) && tools.get(name).exposure !== "hidden" && !excluded.has(name));
			selections.push([...active]);
		},
		appendEntry(type, data) { if (failSave) throw new Error("host save failed"); branch.push(entry(type, data)); },
	};
	const localDefinitions = new Map(tools);
	const adapter = registerSshAdapter(pi, { enabled: options.enabled ?? true, transport: { async run(request) {
		request.assertCurrent(); effects.push(request);
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	} } });
	registerSshConnect(pi, adapter, { currentRequest: () => true });
	const emit = async (name, event = {}, context = ctx) => {
		let result;
		for (const fn of handlers.get(name) ?? []) { const next = await fn(event, context); if (next !== undefined) result = next; }
		return result;
	};
	return { pi, ctx, adapter, runtime: adapter.runtime, selection: adapter.selection, tools, commands, branch: () => branch,
		effects, notices, selections, excluded, localDefinitions, emit,
		call: (name, params = {}) => tools.get(name).execute("selection-call", params, undefined, undefined, ctx),
		active: () => [...active], setActive: names => { active = [...names]; },
		failSave: value => { failSave = value; }, failSelection: value => { failSelection = value; }, idle: value => { idle = value; },
		replace(id, entries, names) { sessionId = id; branch = [...entries]; active = [...names]; },
	};
}
async function ready(h, next = target) {
	h.selection.prepare(h.ctx); h.runtime.activate(next); await h.adapter.validate();
}

for (const enabled of [true, false]) test(`ordinary ${enabled ? "enabled" : "disabled"} startup preserves other owners and selection`, async () => {
	const h = host({ enabled, active: ["read", "grep", "other"] });
	await h.emit("session_start"); await h.emit("before_agent_start");
	assert.deepEqual(h.active(), ["read", "grep", "other"]); assert.equal(h.selections.length, 0);
	assert.equal(h.branch().length, 0); assert.equal(h.effects.length, 0);
	for (const name of GUARDED_LOCAL_TOOLS) {
		assert.equal(h.tools.get(name), h.localDefinitions.get(name));
		assert.equal(await h.emit("tool_call", { toolName: name, parentToolCallId: "script" }), undefined);
	}
	assert.equal(await h.emit("user_bash", { command: ":", excludeFromContext: true }), undefined);
	await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.deepEqual(new Set(h.active()), new Set(["read", "grep", "other"]));
});

test("forced local-mode SSH activation is removed, never delegated locally", async () => {
	const h = host({ active: ["read", "other", "ssh_write"] }); await h.emit("session_start");
	assert.deepEqual(h.active(), ["read", "other"]);
	await assert.rejects(h.call("ssh_write", { path: "sentinel", content: "no" }), /not ready\/selected/);
	assert.equal(h.effects.length, 0);
});

test("capture precedes effects, is bounded and once per episode; ready needs the next turn", async () => {
	const h = host({ active: ["read", "bash", "grep", "other"] }); await h.emit("session_start");
	assert.equal(h.tools.get("ssh_connect").exposure, "model-only");
	assert.equal(h.tools.get("ssh_connect").executionMode, "sequential");
	await h.call("ssh_connect", target);
	const records = h.branch();
	assert.equal(records[0].customType, SSH_SELECTION_ENTRY);
	assert.deepEqual(records[0].data, capture(["read", "bash", "grep"]));
	assert.equal(records[1].customType, SSH_TARGET_ENTRY);
	assert.deepEqual(h.active(), ["other", "ssh_read", "ssh_bash"], "ready membership precedes Pi’s request snapshot; execution is still gated");
	for (const name of GUARDED_LOCAL_TOOLS) {
		h.setActive(["other", name]); // deferred/cached/reactivated owner still goes through the guard
		assert.equal((await h.emit("tool_call", { toolName: name, parentToolCallId: "cached-script" })).block, true);
	}
	await assert.rejects(h.call("ssh_bash", { command: ":" }), /fresh model turn/);
	const shell = await h.emit("user_bash", { command: ":", excludeFromContext: true });
	assert.ok(shell.operations, "user !/!! routing does not wait for the model gate");
	await h.emit("turn_start");
	assert.deepEqual(new Set(h.active()), new Set(["other", "ssh_read", "ssh_bash"]));
	await h.call("ssh_bash", { command: ":" });
	await assert.rejects(h.call("ssh_write", { path: "sentinel", content: "no" }), /not ready\/selected/);
	const old = h.runtime.captureDispatch();
	for (const next of [{ ...target, destination: "replacement" }, target]) {
		await h.call("ssh_connect", next);
		assert.throws(() => h.runtime.assertDispatch(old), /no longer current/);
		await assert.rejects(h.call("ssh_bash", { command: ":" }), /fresh model turn/);
		await h.emit("turn_start");
	}
	assert.equal(h.branch().filter(row => row.customType === SSH_SELECTION_ENTRY).length, 1);
});

test("read-only mapping never enables writes or shell, and clear preserves unrelated CURRENT membership", async () => {
	const h = host({ active: ["read", "find", "other"] }); await h.emit("session_start"); await ready(h); await h.emit("turn_start");
	assert.deepEqual(h.active(), ["other", "ssh_read"]);
	h.setActive(["ssh_read", "later", "write"]);
	await h.emit("before_agent_start");
	assert.deepEqual(h.active(), ["later", "ssh_read"]);
	await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.deepEqual(new Set(h.active()), new Set(["later", "read", "find"]));
	assert.equal(h.branch().at(-2).data.kind, "clear"); assert.equal(h.branch().at(-2).customType, SSH_TARGET_ENTRY);
	assert.equal(h.branch().at(-1).customType, SSH_SELECTION_ENTRY); assert.equal(h.branch().at(-1).data.kind, "clear");
	assert.equal(h.runtime.snapshot().state, "inactive");
	assert.throws(() => h.runtime.captureDispatch(), /not ready/);
	await h.emit("session_tree"); assert.deepEqual(new Set(h.active()), new Set(["later", "read", "find"]));
	for (const name of GUARDED_LOCAL_TOOLS) assert.equal(h.tools.get(name), h.localDefinitions.get(name));
});

test("filters/hidden/missing names fail closed without bypass; clear respects host availability", async () => {
	const h = host({ excluded: ["ssh_write"] }); await h.emit("session_start"); await ready(h);
	await h.emit("turn_start");
	assert.deepEqual(h.active(), ["other"]);
	for (const name of SSH_DATA_TOOLS) await assert.rejects(h.call(name, {}), /not ready\/selected/);
	assert.ok(h.notices.some(([text]) => /filtered, hidden or unavailable/.test(text)));
	h.excluded.add("write"); h.tools.get("edit").exposure = "hidden"; h.tools.delete("bash");
	await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.deepEqual(h.active(), ["other", "read"]);
});

test("capture persistence failure blocks before target effects; clear failure remains latched", async () => {
	const h = host(); await h.emit("session_start"); h.failSave(true);
	await assert.rejects(h.call("ssh_connect", target), /did not complete/);
	assert.equal(h.effects.length, 0); assert.equal(h.branch().length, 0);
	assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
	await assert.rejects(h.commands.get("ssh-clear").handler("", h.ctx), /admission remains blocked/);
	assert.equal((await h.emit("tool_call", { toolName: "bash" })).block, true);
	h.failSave(false); await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.deepEqual(new Set(h.active()), new Set(["other", "read", "write", "edit", "bash"]));
});

test("observer tool-selection failure is recorded, not swallowed as successful admission", async () => {
	const h = host(); await h.emit("session_start"); h.selection.prepare(h.ctx);
	h.setActive(["read", "other"]); h.failSelection(true);
	h.runtime.activate(target); // observer is invoked with the runtime mutation guard held
	assert.equal((await h.emit("tool_call", { toolName: "read" })).block, true);
	h.failSelection(false); await h.adapter.validate(); await h.emit("turn_start");
	await assert.rejects(h.emit("user_bash", { command: ":" }), /shell admission is blocked/);
	await assert.rejects(h.call("ssh_read", { path: "no" }), /not ready\/selected/);
	await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.equal(await h.emit("tool_call", { toolName: "read" }), undefined);
});

test("runtime observers synchronize without capturing tickets while runtime is busy", async () => {
	const h = host(); await h.emit("session_start");
	let captures = 0;
	h.runtime.captureDispatch = () => { captures++; throw new Error("observer must not request tickets"); };
	await ready(h); await h.emit("turn_start");
	assert.equal(captures, 0);
	assert.deepEqual(new Set(h.active()), new Set(["other", ...SSH_DATA_TOOLS]));
	assert.equal(h.notices.some(([text]) => /could not be synchronized/.test(text)), false);
});

test("selection parser rejects unknown fields/names, foreign data, getters, duplicate membership and corrupt newest records", () => {
	assert.deepEqual(parseSshSelectionRecord(capture(["read"])).localTools, ["read"]);
	for (const value of [capture(["read", "read"]), capture(["unknown"]), capture(["read"], { version: 99 }),
		capture(["read"], { readiness: true }), Object.defineProperty(capture(["read"]), "exact", { get() { assert.fail("getter invoked"); } })]) {
		assert.throws(() => parseSshSelectionRecord(value));
	}
	for (const value of [capture(["write"], { sessionId: "foreign" }), capture(["bash"], { localCwd: "/foreign" }), {}]) {
		assert.equal(restoreSshSelection(owner, [entry(SSH_SELECTION_ENTRY, capture(["read"])), entry(SSH_SELECTION_ENTRY, value)]).kind, "invalid");
	}
	assert.equal(restoreSshSelection(owner, [entry(SSH_SELECTION_ENTRY, capture(["write"])), intent("clear"), intent()]).kind, "clear");
	assert.equal(restoreSshSelection(owner, [entry(SSH_SELECTION_ENTRY, capture(["write"])), entry(SSH_SELECTION_ENTRY, { version: 1, ...owner, kind: "clear" }), intent()]).kind, "clear");
});

test("branch reconstruction uses saved custom membership, never filtered transcript or another branch readiness", async () => {
	const saved = entry(SSH_SELECTION_ENTRY, capture(["read", "ls"]));
	const h = host({ active: ["other"], branch: [saved, intent()] }); await h.emit("session_start");
	assert.equal(h.runtime.snapshot().state, "configured");
	await h.commands.get("ssh-validate").handler("", h.ctx);
	await assert.rejects(h.call("ssh_read", { path: "no" }), /fresh model turn/);
	await h.emit("turn_start"); assert.deepEqual(h.active(), ["other", "ssh_read"]);
	const lease = h.selection.lease(h.ctx), ticket = h.runtime.captureDispatch();
	h.replace("different-session", [], ["bash", "later"]);
	assert.equal((await h.emit("tool_call", { toolName: "bash" })).block, true, "live context required even before startup");
	await h.emit("session_tree");
	assert.throws(lease, /context|lifecycle/); assert.throws(() => h.runtime.assertDispatch(ticket), /no longer current/);
	assert.deepEqual(h.active(), ["bash", "later"]);
	await h.commands.get("ssh-clear").handler("", h.ctx); assert.deepEqual(new Set(h.active()), new Set(["bash", "later"]));
});

test("same-session tree navigation uses that branch's capture and revokes the prior ready turn", async () => {
	const h = host({ active: ["read", "other"] }); await h.emit("session_start"); await ready(h); await h.emit("turn_start");
	const lease = h.selection.lease(h.ctx), ticket = h.runtime.captureDispatch();
	h.replace(owner.sessionId, [entry(SSH_SELECTION_ENTRY, capture(["bash"])), intent()], ["ssh_read", "later"]);
	await h.emit("session_tree");
	assert.throws(lease, /lifecycle/); assert.throws(() => h.runtime.assertDispatch(ticket), /no longer current/);
	assert.deepEqual(h.active(), ["later"]); assert.equal(h.runtime.snapshot().state, "configured");
	await h.commands.get("ssh-validate").handler("", h.ctx); await h.emit("turn_start");
	assert.deepEqual(h.active(), ["later", "ssh_bash"]);
	await h.commands.get("ssh-clear").handler("", h.ctx); assert.deepEqual(h.active(), ["later", "bash"]);
});

for (const kind of ["legacy", "invalid", "foreign", "target-clear", "selection-clear"]) test(`${kind} capture reconstruction is conservative and warns on clear`, async () => {
	const prior = entry(SSH_SELECTION_ENTRY, capture(["write", "bash"]));
	const branch = kind === "legacy" ? [intent()]
		: kind === "target-clear" ? [prior, intent("clear"), intent()]
		: kind === "selection-clear" ? [prior, entry(SSH_SELECTION_ENTRY, { version: 1, ...owner, kind: "clear" }), intent()]
		: [prior, entry(SSH_SELECTION_ENTRY, kind === "invalid" ? {} : capture(["write"], { sessionId: "foreign" })), intent()];
	const h = host({ branch, active: ["read", "other"] }); await h.emit("session_start");
	assert.deepEqual(h.active(), ["other"]);
	await ready(h); await h.emit("turn_start");
	assert.deepEqual(h.active(), kind === "legacy" ? ["other", "ssh_read"] : ["other"]);
	await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.deepEqual(new Set(h.active()), new Set(kind === "legacy" ? ["other", "read"] : ["other"]));
	assert.ok(h.notices.some(([text]) => /Exact local tool selection could not be restored/.test(text)));
});

test("durable clear metadata restores only known, available membership until a newer tool declaration", async () => {
	const cleared = entry(SSH_SELECTION_ENTRY, { ...capture(["read", "bash"]), kind: "clear" });
	const oldRemoteDeclaration = { type: "message", message: { role: "system", toolsAdded: [{ name: "ssh_read" }] } };
	for (const mode of ["no-request", "sections-only", "newer-tools", "filtered", "empty", "foreign", "legacy", "orphan-clear"]) {
		const record = mode === "empty" ? { ...cleared.data, localTools: [] }
			: mode === "foreign" ? { ...cleared.data, sessionId: "another-session" }
			: mode === "legacy" ? { version: 1, ...owner, kind: "clear" } : cleared.data;
		const branch = [oldRemoteDeclaration, ...(mode === "orphan-clear" ? [] : [intent("clear")]), entry(SSH_SELECTION_ENTRY, record),
			...(mode === "sections-only" ? [{ type: "message", message: { role: "system", sections: { guidelines: "changed" } } }] : []),
			...(mode === "newer-tools" ? [{ type: "message", message: { role: "system", toolsAdded: [{ name: "read" }], toolsRemoved: [{ name: "ssh_read" }] } }] : [])];
		const h = host({ branch, active: mode === "newer-tools" ? ["read", "other"] : ["ssh_read", "other"],
			excluded: mode === "filtered" ? ["bash"] : [] });
		await h.emit("session_start");
		const expected = ["empty", "foreign", "legacy", "orphan-clear"].includes(mode) ? ["other"]
			: ["filtered", "newer-tools"].includes(mode) ? ["other", "read"] : ["other", "read", "bash"];
		assert.deepEqual(new Set(h.active()), new Set(expected), mode);
		assert.equal(h.runtime.snapshot().state, "inactive"); assert.equal(h.effects.length, 0);
	}
	assert.deepEqual(parseSshSelectionRecord(cleared.data).localTools, ["read", "bash"]);
	for (const bad of [{ ...cleared.data, localTools: ["read", "read"] }, { ...cleared.data, localTools: ["unknown"] },
		{ version: 1, ...owner, kind: "clear", localTools: ["read"] }, { version: 1, ...owner, kind: "clear", exact: true }]) {
		assert.throws(() => parseSshSelectionRecord(bad));
	}
});

test("orphan capture without target intent is inert; a new connection captures this local selection", async () => {
	const h = host({ active: ["read", "other"], branch: [entry(SSH_SELECTION_ENTRY, capture(["write", "bash"]))] });
	await h.emit("session_start"); assert.deepEqual(h.active(), ["read", "other"]);
	await ready(h); await h.emit("turn_start"); assert.deepEqual(h.active(), ["other", "ssh_read"]);
});

test("shutdown latches LOCAL mode closed too, and ready reload restores selection but never readiness", async () => {
	const h = host(); await h.emit("session_start"); const oldLease = h.selection.lease(h.ctx);
	await h.emit("session_shutdown");
	assert.equal((await h.emit("tool_call", { toolName: "bash", parentToolCallId: "stale" })).block, true);
	await assert.rejects(h.emit("user_bash", { command: ":" }), /stale|shutting down/);
	assert.throws(oldLease, /stale|shutting down/);
	await h.emit("session_start"); await ready(h); await h.emit("turn_start");
	await h.emit("session_shutdown"); await h.emit("session_start");
	assert.equal(h.runtime.snapshot().state, "configured"); assert.deepEqual(h.active(), ["other"]);
	await assert.rejects(h.call("ssh_bash", { command: ":" }), /not ready\/selected/);
});

test("bind, validate and clear remain idle-only", async () => {
	const h = host(); await h.emit("session_start"); h.idle(false);
	for (const [name, args] of [["ssh-bind", JSON.stringify(target)], ["ssh-validate", ""], ["ssh-clear", ""]]) {
		await assert.rejects(h.commands.get(name).handler(args, h.ctx), /idle/);
	}
	assert.equal(h.branch().length, 0); assert.equal(h.effects.length, 0);
});

test("fresh child eligibility is checked before its own capture and stays configured-only", async () => {
	const parent = new SshTargetRuntime(() => {});
	parent.startSession({ ...owner, sessionId: "parent" }, []); parent.activate(target); parent.completeValidation(parent.beginValidation());
	for (const history of [false, true]) {
		const initial = [{ type: "model_change" }, { type: "thinking_level_change" }, ...(history ? [entry("unrelated", {})] : [])];
		const h = host({ active: ["read", "other"], branch: initial }); await h.emit("session_start");
		let called = false;
		const env = { [SSH_LAUNCH_ENV]: encodeSshLaunch(parent.captureDispatch()) };
		const accept = () => { called = true; h.selection.prepare(h.ctx); };
		if (history) { assert.throws(() => consumeSshLaunch(h.pi, h.ctx, env, accept), /refused/); assert.equal(called, false); }
		else {
			assert.equal(consumeSshLaunch(h.pi, h.ctx, env, accept), true); assert.equal(called, true);
			assert.deepEqual(h.branch()[2].data, capture(["read"]));
			assert.equal(h.branch()[3].customType, SSH_TARGET_ENTRY);
			assert.equal(h.runtime.snapshot().state, "configured"); assert.equal(h.effects.length, 0);
			assert.deepEqual(h.active(), ["other"]); assert.throws(() => h.runtime.captureDispatch(), /not ready/);
		}
	}
});
