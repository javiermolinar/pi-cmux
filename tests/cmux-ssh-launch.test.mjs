import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { openPiSession } from "../extensions/cmux-pi.ts";
import startExtension from "../extensions/cmux-start.ts";
import { resolveHandoffTarget } from "../extensions/cmux-continue.ts";
import zoxideExtension from "../extensions/cmux-zoxide.ts";
import browserExtension from "../extensions/cmux-browser.ts";
import { registerSshTarget, getSshTargetRuntime } from "../lib/ssh/runtime.ts";
import { SSH_LAUNCH_ENV, consumeSshLaunch, encodeSshLaunch, registerSshLaunchBootstrap,
	withSshLaunchEnvironment } from "../lib/ssh/launch.ts";

const windowId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const surfaceId = "33333333-3333-4333-8333-333333333333";
const paneId = "44444444-4444-4444-8444-444444444444";
const newSurface = "55555555-5555-4555-8555-555555555555";
const newPane = "66666666-6666-4666-8666-666666666666";
const target = { destination: "fixture-alias", remoteCwd: "/remote ' $HOME $(do-not-run) café" };
function harness(options = {}) {
	const calls = [], tools = new Map(), commands = new Map(), handlers = new Map(), entries = [], notices = [];
	let session = options.session ?? "parent", branch = options.branch ?? [];
	const ctx = { cwd: "/local/project", hasUI: false,
		sessionManager: { getSessionId: () => session, getBranch: () => branch,
			getSessionFile: () => options.sessionFile, getLeafId: () => "leaf", getSessionName: () => "task" },
		ui: { notify: (...v) => notices.push(v) } };
	const source = { window_id: windowId, workspace_id: workspaceId, surface_id: surfaceId, pane_id: paneId,
		window_ref: "window:1", workspace_ref: "workspace:1", surface_ref: "surface:1", pane_ref: "pane:1" };
	const pi = {
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data }),
		registerTool: t => tools.set(t.name, t), registerCommand: (n, c) => commands.set(n, c),
		on(n, fn) { const list = handlers.get(n) ?? []; list.push(fn); handlers.set(n, list); },
		async exec(file, args) {
			calls.push({ file, args });
			await options.onExec?.(file, args);
			if (file === "git") return { code: 1, killed: false, stdout: "", stderr: "" };
			assert.equal(file, "cmux", "no SSH or zoxide subprocess allowed");
			let payload = {};
			if (args.includes("identify")) payload = { caller: source };
			else if (args.includes("system.capabilities")) payload = { methods: options.noCapabilities ? [] : ["surface.create", "surface.split"] };
			else if (args.includes("workspace.list")) payload = options.workspacePayload ?? { workspaces: [{ id: workspaceId, remote: { enabled: false } }] };
			else if (args.includes("surface.create") || args.includes("surface.split")) {
				const p = JSON.parse(args.at(-1));
				payload = options.created ?? { window_id: windowId, workspace_id: workspaceId, surface_id: newSurface,
					pane_id: p.direction ? newPane : paneId, surface_ref: "surface:2", type: "terminal" };
			} else if (args.includes("list-panes")) payload = { panes: [] };
			else if (args.includes("new-surface") || args.includes("new-split")) payload = { surface_id: newSurface, surface_ref: "surface:2" };
			else assert.ok(args.includes("rename-tab") || args.includes("respawn-pane"), `unexpected ${args.join(" ")}`);
			return { code: 0, killed: false, stdout: JSON.stringify(payload), stderr: "" };
		},
	};
	const runtime = registerSshTarget(pi);
	runtime.startSession({ sessionId: session, localCwd: ctx.cwd }, branch);
	return { pi, ctx, runtime, calls, tools, commands, entries, notices,
		setSession: id => { session = id; }, setBranch: value => { branch = value; },
		ready(association) { runtime.activate(target, association); const v = runtime.beginValidation();
			assert.equal(runtime.completeValidation(v, association ? { ...association, ...target, enabled: true, connected: true, transport: "ssh" } : undefined), true); },
		created: () => calls.filter(c => c.args.includes("surface.create") || c.args.includes("surface.split")),
		emit: async name => { for (const fn of handlers.get(name) ?? []) await fn({}, ctx); },
	};
}

// Decode only the fixed shell quoting emitted by core; never execute a command or shell.
function words(text) {
	const result = []; let word = "", quoted = false, started = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === "'") { quoted = !quoted; started = true; }
		else if (!quoted && c === "\\") { word += text[++i]; started = true; }
		else if (!quoted && /\s/.test(c)) { if (started) result.push(word); word = ""; started = false; }
		else { word += c; started = true; }
	}
	assert.equal(quoted, false); if (started) result.push(word); return result;
}
function launchParts(h) {
	const params = JSON.parse(h.created().at(-1).args.at(-1));
	const shell = words(params.initial_command); assert.deepEqual(shell.slice(0, 2), ["/bin/sh", "-c"]);
	const env = words(shell[2]);
	assert.deepEqual(env.slice(0, 4), ["exec", "/usr/bin/env", "-u", SSH_LAUNCH_ENV]);
	const assignment = env.find(w => w.startsWith(`${SSH_LAUNCH_ENV}=`));
	return { params, raw: assignment?.slice(SSH_LAUNCH_ENV.length + 1), pi: words(env.at(-1)) };
}
function envelope(h, resume) { return encodeSshLaunch(h.runtime.captureDispatch(), resume); }
function mutate(raw, change) {
	const v = JSON.parse(Buffer.from(raw, "base64url").toString()); v.nonce = randomUUID(); change(v);
	return Buffer.from(JSON.stringify(v)).toString("base64url");
}
function consume(h, raw) {
	const env = { [SSH_LAUNCH_ENV]: raw };
	try { return consumeSshLaunch(h.pi, h.ctx, env); }
	finally { assert.equal(Object.hasOwn(env, SSH_LAUNCH_ENV), false, "even invalid input must be removed"); }
}

test("fresh/related/review/resumed SSH Pi stays local and child selection is only configured", async () => {
	for (const placement of ["right", "down", "tab"]) for (const mode of ["fresh", "related", "review", "resume"]) {
		const h = harness(); h.ready();
		const sessionFile = mode === "resume" ? "/local/sessions/child.jsonl" : undefined;
		const result = await openPiSession(h.pi, h.ctx.cwd, { placement, prompt: "user task", title: "title is not authority",
			focus: false, related: mode === "related", role: mode === "review" ? "review" : undefined, sessionFile,
			// review implies related; do not explicitly disable it
			...(mode === "review" ? { related: true } : {}) });
		assert.equal(result.ok, true); assert.equal(h.created().length, 1);
		const { params, raw, pi } = launchParts(h);
		assert.equal(params.remote_context, "local"); assert.equal(params.focus, false);
		assert.equal(params.workspace_id, workspaceId); assert.equal(params.surface_id, surfaceId);
		assert.deepEqual(pi.slice(0, 3), ["cd", "/local/project", "&&"]);
		assert.match(pi[pi.indexOf("exec") + 1], /^(?:pi|\/.*\/pi)$/); assert.equal(pi.includes(target.remoteCwd), false);
		assert.equal(params.initial_command.includes("/usr/bin/ssh"), false);
		assert.equal(h.calls.some(c => c.file === "git" || c.args.includes("respawn-pane")), false);
		const data = JSON.parse(Buffer.from(raw, "base64url").toString());
		assert.deepEqual(data.target, target); assert.equal(data.localCwd, h.ctx.cwd);
		assert.deepEqual(Object.keys(data).sort(), ["issuedAt", "localCwd", "nonce", "parentSessionId", "target", "version", ...(sessionFile ? ["sessionFile"] : [])].sort());
		const child = harness({ session: "child", sessionFile, branch: sessionFile ? [{ type: "message" }] : [] });
		assert.equal(consume(child, raw), true);
		assert.equal(getSshTargetRuntime(child.pi), child.runtime);
		assert.equal(child.runtime.snapshot().state, "configured"); assert.deepEqual(child.runtime.snapshot().target, target);
		assert.throws(() => child.runtime.captureDispatch(), /not ready/);
		assert.equal(child.calls.length, 0); assert.equal(child.entries.at(-1).data.sessionId, "child");
		assert.equal(h.runtime.snapshot().state, "ready"); assert.equal(h.ctx.cwd, "/local/project");
	}
});

test("an unnamed SSH Pi launch uses the selected remote directory, not the local project", async () => {
	const h = harness(); h.ready();
	const result = await openPiSession(h.pi, h.ctx.cwd, { placement: "tab", focus: false });
	assert.equal(result.ok, true);
	assert.equal(result.title, basename(target.remoteCwd));
	assert.equal(h.calls.some(call => call.file === "git"), false);
});

test("bootstrap consumes once, rejects replay/foreign owner/cwd/saved conflicts without connecting", () => {
	const parent = harness(); parent.ready();
	const raw = envelope(parent), child = harness({ session: "child" });
	assert.equal(consume(child, raw), true);
	assert.throws(() => consume(child, envelope(parent)), /refused/, "one receiver cannot consume a second envelope");
	const replay = harness({ session: "other-child" });
	assert.throws(() => consume(replay, raw), /refused/); assert.equal(replay.runtime.snapshot().state, "disconnected");
	for (const [options, edit] of [
		[{ session: "parent" }, () => {}], [{ session: "child" }, v => { v.localCwd = "/remote"; }],
		[{ session: "child" }, v => { v.issuedAt -= 120_000; }], [{ session: "child" }, v => { v.issuedAt += 120_000; }],
		[{ session: "child" }, v => { v.ready = true; }], [{ session: "child" }, v => { v.target.command = "ssh pi"; }],
		[{ session: "child" }, v => { v.target.remoteCwd = "relative"; }],
		[{ session: "child", branch: [{ type: "message" }] }, () => {}],
		[{ session: "child", sessionFile: "/wrong.jsonl" }, v => { v.sessionFile = "/expected.jsonl"; }],
	]) {
		const h = harness(options);
		assert.throws(() => consume(h, mutate(raw, edit)), /refused/);
		assert.equal(h.runtime.snapshot().state, "disconnected"); assert.equal(h.calls.length, 0);
	}
	for (const text of ["", "not base64!", Buffer.from("{}").toString("base64url")]) {
		const h = harness({ session: "child" }); assert.throws(() => consume(h, text), /refused/);
	}
	const conflict = harness({ session: "child", sessionFile: "/resume.jsonl" });
	conflict.runtime.activate({ destination: "different", remoteCwd: "/other" });
	assert.throws(() => consume(conflict, envelope(parent, "/resume.jsonl")), /refused/);
	const cleared = harness({ session: "child", sessionFile: "/resume.jsonl" });
	cleared.runtime.clear(); cleared.setBranch(cleared.entries);
	assert.throws(() => consume(cleared, envelope(parent, "/resume.jsonl")), /refused/);
});

test("matching resumed metadata stays configured and foreign restored sessions fail closed", () => {
	const parent = harness(); parent.ready();
	const record = { type: "custom", customType: "pi-cmux.ssh-target", data: { version: 1, kind: "target",
		sessionId: "child", localCwd: "/local/project", target } };
	const child = harness({ session: "child", sessionFile: "/resume.jsonl", branch: [record] });
	assert.equal(child.runtime.snapshot().state, "configured");
	assert.equal(consume(child, envelope(parent, "/resume.jsonl")), true);
	assert.equal(child.runtime.snapshot().state, "configured"); assert.equal(child.calls.length, 0);
	const foreign = harness({ session: "other", sessionFile: "/resume.jsonl", branch: [record] });
	assert.throws(() => consume(foreign, envelope(parent, "/resume.jsonl")), /refused/);
	assert.equal(foreign.runtime.snapshot().state, "disconnected");
	foreign.runtime.activate(target); // refusal retains the local owner for explicit recovery
	assert.equal(foreign.runtime.snapshot().state, "configured");
});

test("child bootstrap cannot replace unresolved connection intent saved on the current branch", () => {
	const parent = harness(); parent.ready();
	const child = harness({ session: "child", sessionFile: "/resume.jsonl", branch: [{ type: "custom", customType: "pi-cmux.ssh-target", data: {
		version: 1, kind: "pending", sessionId: "child", localCwd: "/local/project", destination: "another-host",
	} }] });
	assert.throws(() => consume(child, envelope(parent, "/resume.jsonl")), /refused/);
	assert.equal(child.runtime.snapshot().state, "disconnected");
	assert.equal(child.calls.length, 0);
});

test("opt-in bootstrap registration shares runtime, strips env synchronously, never replays on session start", async () => {
	const parent = harness(); parent.ready(); const child = harness({ session: "child" });
	const previous = process.env[SSH_LAUNCH_ENV];
	try {
		process.env[SSH_LAUNCH_ENV] = envelope(parent);
		registerSshLaunchBootstrap(child.pi); registerSshLaunchBootstrap(child.pi);
		assert.equal(process.env[SSH_LAUNCH_ENV], undefined);
		await child.emit("session_start"); assert.equal(child.runtime.snapshot().state, "configured");
		const saved = child.entries.length;
		await child.emit("session_start"); assert.equal(child.entries.length, saved);
		assert.equal(child.runtime.snapshot().state, "inactive", "fixture branch is empty; bootstrap cannot activate twice");
		assert.equal(child.calls.length, 0);
	} finally { if (previous === undefined) delete process.env[SSH_LAUNCH_ENV]; else process.env[SSH_LAUNCH_ENV] = previous; }
	assert.equal(withSshLaunchEnvironment("exec pi"), `unset ${SSH_LAUNCH_ENV}; exec pi`);
});

test("shared boundary rejects unready intent, cwd changes, handoffs, workspace and associated placement before Git or cmux", async () => {
	for (const state of ["configured", "disabled", "disconnected"]) {
		const h = harness(); h.runtime.activate(target);
		if (state === "disabled") h.runtime.setEnabled(false);
		if (state === "disconnected") h.runtime.disconnect();
		await assert.rejects(openPiSession(h.pi, h.ctx.cwd, { placement: "tab" }), /not ready/); assert.equal(h.calls.length, 0);
	}
	for (const options of [{}, { placement: "workspace" }, { placement: "tab", role: "continue" }]) {
		const h = harness(); h.ready(); await assert.rejects(openPiSession(h.pi, h.ctx.cwd, options), /unsupported/); assert.equal(h.calls.length, 0);
	}
	const moved = harness(); moved.ready();
	await assert.rejects(openPiSession(moved.pi, "/different", { placement: "tab" }), /same local project/); assert.equal(moved.calls.length, 0);
	const associated = harness(); associated.ready({ workspaceId, backend: "native-ssh" });
	await assert.rejects(openPiSession(associated.pi, associated.ctx.cwd, { placement: "tab" }), /remote-owned/); assert.equal(associated.calls.length, 0);
});

test("unverified remote-owned/missing placement and capabilities never dispatch Pi", async () => {
	for (const workspacePayload of [{}, { workspaces: [{ id: workspaceId, remote: { enabled: true, backend: "native-ssh" } }] },
		{ workspaces: [{ id: workspaceId, remote: { enabled: true, backend: "legacy-relay" } }] },
		{ workspaces: [{ id: workspaceId, remote: { enabled: true, backend: "tmux-mirror" } }] }]) {
		const h = harness({ workspacePayload }); h.ready();
		await assert.rejects(openPiSession(h.pi, h.ctx.cwd, { placement: "tab" }), /locality|placement/); assert.equal(h.created().length, 0);
	}
	const h = harness({ noCapabilities: true }); h.ready();
	await assert.rejects(openPiSession(h.pi, h.ctx.cwd, { placement: "tab" }), /unavailable/); assert.equal(h.created().length, 0);
});

test("tickets/session/cancel rechecked across cmux awaits; post-create changes are uncertain, never replayed", async () => {
	for (const at of ["identify", "system.capabilities", "workspace.list", "surface.create"]) {
		let h; h = harness({ onExec: (_file, args) => { if (args.includes(at)) h.runtime.disconnect(); } }); h.ready();
		await assert.rejects(openPiSession(h.pi, h.ctx.cwd, { placement: "tab" }), /changed|current|uncertain/);
		assert.equal(h.created().length, at === "surface.create" ? 1 : 0);
		assert.equal(h.calls.some(c => c.args.includes("respawn-pane")), false);
	}
	let h; const controller = new AbortController();
	h = harness({ onExec: (_f, args) => { if (args.includes("workspace.list")) controller.abort(); } }); h.ready(); startExtension(h.pi);
	await assert.rejects(h.tools.get("cmux_start_pi").execute("id", { placement: "tab" }, controller.signal, undefined, h.ctx));
	assert.equal(h.created().length, 0);
});

test("start rejects SSH explicit cwd and handoff/worktrees before stat, Git, or session preparation", async () => {
	for (const params of [{ cwd: "/certainly-not-a-local-directory" }, { cwd: "/local/project" },
		{ continueSession: true }, { continueSession: true, branch: "new-branch" }, { role: "continue" }]) {
		const h = harness(); h.ready(); startExtension(h.pi);
		const promise = h.tools.get("cmux_start_pi").execute("id", { placement: "tab", ...params }, undefined, undefined, h.ctx);
		await assert.rejects(promise, /SSH|unsupported/); assert.equal(h.calls.length, 0);
	}
	const h = harness(); h.ready(); startExtension(h.pi);
	const result = await h.tools.get("cmux_start_pi").execute("id", { placement: "tab", related: true, prompt: "task" }, undefined, undefined, h.ctx);
	assert.equal(result.details.cwd, h.ctx.cwd); assert.ok(launchParts(h).raw);
});

test("handoff resolver refuses before even reading session history; zoxide commands and completions do not inspect local data", async () => {
	const h = harness(); h.ready();
	const hostile = { cwd: h.ctx.cwd, sessionManager: new Proxy({}, { get() { throw new Error("session preparation must not run"); } }) };
	for (const request of [{ mode: "handoff" }, { mode: "worktree-create", branch: "branch" }]) {
		const result = await resolveHandoffTarget(h.pi, hostile, request); assert.equal(result.ok, false); assert.match(result.error, /unsupported/);
	}
	zoxideExtension(h.pi);
	for (const name of ["cmz", "z", "cmzh", "zh"]) {
		const command = h.commands.get(name); assert.equal(command.getArgumentCompletions("/local/project"), null);
		await command.handler("/local/project", h.ctx);
	}
	assert.equal(h.calls.length, 0); assert.equal(h.entries.length, 1);
});

test("SSH browser refusal performs no binding/annotation/lifecycle mutation; annotate stop remains available", async () => {
	const h = harness(); const tracked = [];
	browserExtension(h.pi, () => ({ track: b => tracked.push(b), forget: b => tracked.push(b), stop: () => tracked.push("stop") }));
	await h.emit("session_start"); h.ready(); const before = tracked.length;
	await assert.rejects(h.tools.get("cmux_open_browser").execute("id", { url: "http://localhost:3000" }, undefined, undefined, h.ctx), /SSH browser opening/);
	await h.commands.get("cmb").handler("http://localhost:3000", h.ctx);
	assert.match(h.notices.at(-1)[0], /SSH browser opening/); assert.equal(tracked.length, before);
	assert.equal(h.calls.length, 0);
	const result = await h.tools.get("cmux_annotate_browser").execute("id", { enabled: false }, undefined, undefined, h.ctx);
	assert.match(result.content[0].text, /drafts remain/); assert.equal(result.details.enabled, false);
});

test("disabled integration without SSH intent preserves ordinary local workflows", async () => {
	const h = harness(); h.runtime.setEnabled(false);
	const result = await openPiSession(h.pi, h.ctx.cwd, { placement: "tab", prompt: "local task" });
	assert.equal(result.ok, true); assert.ok(h.calls.some(c => c.file === "git"));
});

test("local launch still inspects local title and preserves Pi/orientation quoting with protected creation", async () => {
	const h = harness();
	const result = await openPiSession(h.pi, h.ctx.cwd, { placement: "tab", prompt: "local task", title: "local" });
	assert.equal(result.ok, true); assert.ok(h.calls.some(c => c.file === "git"));
	const outer = words(JSON.parse(h.created()[0].args.at(-1)).initial_command);
	const startup = outer[2];
	assert.equal(h.calls.some(c => c.args.includes("respawn-pane")), false);
	assert.ok(startup.startsWith(`unset ${SSH_LAUNCH_ENV}; cd `));
	assert.equal(startup.includes(`${SSH_LAUNCH_ENV}=`), false);
	const tokens = words(startup);
	assert.match(tokens[tokens.indexOf("exec") + 1], /^(?:pi|\/.*\/pi)$/); assert.equal(h.runtime.snapshot().state, "inactive");
});
