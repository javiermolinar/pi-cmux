import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";
import registerCmuxSsh from "../extensions/cmux-ssh.ts";
import cmuxOpen from "../extensions/cmux-open.ts";
import startPi from "../extensions/cmux-start.ts";
import browserExtension from "../extensions/cmux-browser.ts";
import { initI18n } from "../extensions/i18n.ts";
import { OpenSshTransport, shellQuote } from "../lib/ssh/transport.ts";
import { SSH_LAUNCH_ENV } from "../lib/ssh/launch.ts";

const ids = { window_id: "11111111-1111-4111-8111-111111111111", workspace_id: "22222222-2222-4222-8222-222222222222", pane_id: "33333333-3333-4333-8333-333333333333", surface_id: "44444444-4444-4444-8444-444444444444" };
function fixture(t, opts = {}) {
	const root = mkdtempSync(join(realpathSync(tmpdir()), "cmux-ssh-e2e-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const local = join(root, "local"), remote = join(root, "remote ' $HOME café"), bin = join(root, "remote-bin"), home = join(root, "home");
	for (const path of [local, remote, bin, home, join(home, ".ssh")]) mkdirSync(path, { mode: 0o700 });
	writeFileSync(join(bin, "hostname"), "#!/bin/sh\nprintf '%s\\n' REMOTE_HOST_SENTINEL\n", { mode: 0o700 });
	const fakeSsh = join(root, "fake-ssh");
	writeFileSync(fakeSsh, `#!/bin/sh\nfor last do :; done\nPATH=${shellQuote(`${bin}:/usr/bin:/bin`)}; export PATH\nexec /bin/sh -c "$last"\n`, { mode: 0o700 });
	const tools = new Map(), registeredTools = [], commands = new Map(), handlers = new Map(), calls = [], sshCalls = [], confirmations = [];
	for (const create of [createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition]) {
		const tool = create(local); tools.set(tool.name, tool);
	}
	let active = ["read", "write", "edit", "bash"];
	const manager = SessionManager.inMemory(local);
	const ctx = { cwd: local, sessionManager: manager, isIdle: () => false, hasUI: true, signal: undefined,
		ui: { setStatus() {}, notify() {}, async confirm(title, preview) { confirmations.push({ title, preview }); return opts.confirm ?? false; } } };
	const pi = {
		registerTool(tool) { registeredTools.push(tool.name); tools.set(tool.name, tool); }, registerCommand(name, c) { commands.set(name, c); },
		appendEntry(type, data) { manager.appendCustomEntry(type, data); },
		getActiveTools: () => [...active], setActiveTools: names => { active = [...names]; },
		on(name, fn) { const rows = handlers.get(name) ?? []; rows.push(fn); handlers.set(name, rows); },
		async exec(file, args) {
			calls.push({ file, args });
			if (file === "git") return { code: 1, killed: false, stdout: "", stderr: "" };
			assert.equal(file, "cmux");
			let payload = {};
			if (args.includes("identify")) payload = { caller: { ...ids, window_ref: "window:1", workspace_ref: "workspace:1", pane_ref: "pane:1", surface_ref: "surface:1" } };
			else if (args.includes("system.capabilities")) payload = { methods: ["surface.create", "surface.split"] };
			else if (args.includes("workspace.list")) payload = { workspaces: [{ id: ids.workspace_id, remote: opts.remoteWorkspace ?? { enabled: false } }] };
			else if (args.includes("surface.create") || args.includes("surface.split")) {
				const p = JSON.parse(args.at(-1));
				payload = { ...ids, surface_id: "55555555-5555-4555-8555-555555555555", pane_id: p.direction ? "66666666-6666-4666-8666-666666666666" : ids.pane_id, surface_ref: "surface:2", type: "terminal" };
			} else assert.ok(args.includes("rename-tab"));
			return { code: 0, killed: false, stdout: JSON.stringify(payload), stderr: "" };
		},
	};
	const transport = new OpenSshTransport((file, args) => {
		sshCalls.push({ file, args });
		return spawn("/bin/sh", ["-c", opts.authFail ? "exit 255" : args.at(-1)], { stdio: "pipe", env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } });
	});
	const adapter = registerCmuxSsh(pi, { env: opts.env ?? {}, transport, aliasHome: home,
		discovery: { homeDirectory: home, listWorkspaces: async () => ({ workspaces: [] }) } });
	cmuxOpen(pi); startPi(pi);
	const emit = async (name, event = {}) => { const results = []; for (const fn of handlers.get(name) ?? []) results.push(await fn(event, ctx)); return results; };
	const request = async (text, extra = {}) => {
		await emit("input", { text, source: "interactive", ...extra });
		return emit("before_agent_start", { messageType: "user", prompt: text });
	};
	const execute = async (name, params = {}, signal) => {
		const results = await emit("tool_call", { toolName: name, toolCallId: "fixture", input: params });
		const blocked = results.find(result => result?.block);
		if (blocked) throw new Error(blocked.reason);
		return tools.get(name).execute("fixture", params, signal, undefined, ctx);
	};
	const target = { destination: "fixture", remoteCwd: remote };
	const connectText = `Connect to fixture in ${JSON.stringify(remote)}`;
	return { root, local, remote, home, fakeSsh, pi, ctx, manager, adapter, runtime: adapter.runtime, tools, registeredTools, commands, calls, sshCalls, confirmations, emit, request, execute, target, connectText };
}

test("central registration is inert; complete direct request connects once and sentinel checks prove core/helper locality", async t => {
	const h = fixture(t); await h.emit("session_start");
	assert.equal(h.sshCalls.length, 0); assert.equal(h.calls.length, 0);
	await h.execute("write", { path: "sentinel.txt", content: "LOCAL_FILE_SENTINEL" });
	const messages = await h.request(h.connectText);
	assert.match(messages.at(-1).message.content, /Use ssh_connect without another question/);
	await h.execute("ssh_connect", h.target);
	assert.equal(h.confirmations.length, 0); assert.equal(h.sshCalls.length, 1);
	await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/);
	assert.equal(h.sshCalls.length, 1, "no automatic replay in the same input grant");
	await assert.rejects(h.execute("ssh_write", { path: "sentinel.txt", content: "no stale batch" }), /fresh model turn/);
	await h.emit("turn_start");
	await h.execute("ssh_write", { path: "sentinel.txt", content: "REMOTE_FILE_SENTINEL" });
	await h.execute("ssh_edit", { path: "sentinel.txt", edits: [{ oldText: "REMOTE", newText: "EDITED_REMOTE" }] });
	assert.match((await h.execute("ssh_read", { path: "sentinel.txt" })).content[0].text, /EDITED_REMOTE/);
	assert.equal(readFileSync(join(h.local, "sentinel.txt"), "utf8"), "LOCAL_FILE_SENTINEL");
	assert.equal(readFileSync(join(h.remote, "sentinel.txt"), "utf8"), "EDITED_REMOTE_FILE_SENTINEL");
	const result = await h.execute("ssh_bash", { command: "hostname; pwd; printf REMOTE_COMMAND_SENTINEL" });
	assert.match(result.structuredContent.output, /REMOTE_HOST_SENTINEL/);
	assert.ok(result.structuredContent.output.includes(h.remote));
	assert.equal(process.cwd().includes("cmux-ssh-e2e-"), false, "Pi itself never chdirs to remote");
	for (const target of [undefined, "local"]) {
		const result = await h.execute("cmux_open_terminal", { command: target ? "printf LOCAL_HELPER_SENTINEL; pwd" : "hostname; pwd", target, focus: false });
		const created = h.calls.filter(c => c.args.includes("surface.create")).at(-1);
		const params = JSON.parse(created.args.at(-1));
		assert.equal(params.remote_context, "local"); assert.equal(params.focus, false);
		const shell = params.initial_command.replace("/usr/bin/ssh", h.fakeSsh);
		const run = spawnSync("/bin/sh", ["-c", shell], { encoding: "utf8", env: { ...process.env, PATH: "/usr/bin:/bin" } });
		assert.equal(run.status, 0, run.stderr);
		assert.ok(run.stdout.includes(target ? "LOCAL_HELPER_SENTINEL" : "REMOTE_HOST_SENTINEL"));
		assert.ok(run.stdout.includes(target ? h.local : h.remote));
		assert.match(result.content[0].text, /not command completion/);
	}
	const branch = h.manager.getBranch();
	assert.deepEqual(branch.at(-1).data.target, h.target);
	await h.emit("session_start"); assert.equal(h.runtime.snapshot().state, "configured");
	await assert.rejects(h.execute("ssh_write", { path: "wrong.txt", content: "no fallback" }), /not ready/);
	assert.equal(existsSync(join(h.local, "wrong.txt")), false);
	await h.request(h.connectText); await h.execute("ssh_connect", h.target); // new explicit input, no restore auto-connect
	const child = await h.execute("cmux_start_pi", { placement: "tab", related: true, prompt: "work on remote project" });
	assert.equal(child.details.cwd, h.local);
	const startup = JSON.parse(h.calls.filter(c => c.args.includes("surface.create")).at(-1).args.at(-1)).initial_command;
	assert.ok(startup.includes(SSH_LAUNCH_ENV)); assert.equal(startup.includes("/usr/bin/ssh"), false);
});

test("missing fields are clarified one at a time; suggestions/manual answers never authorize guessed fields", async t => {
	const h = fixture(t); await h.emit("session_start");
	writeFileSync(join(h.home, ".ssh/config"), "Host fixture-a fixture-b\n  HostName ignored\n");
	let messages = await h.request(`Connect in ${JSON.stringify(h.remote)}`);
	assert.match(messages.at(-1).message.content, /Which SSH destination/);
	const found = await h.execute("ssh_discover"); assert.match(found.content[0].text, /fixture-a/);
	await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/); assert.equal(h.sshCalls.length, 0);
	await h.request("fixture"); await h.execute("ssh_connect", h.target);
	assert.equal(h.sshCalls.length, 1);
	messages = await h.request("Connect to fixture"); assert.match(messages.at(-1).message.content, /Use ssh_connect without another question/);
	await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/, "a host-only request grants home, not another path");
	await h.execute("ssh_connect", { destination: "fixture" });
	assert.equal(h.runtime.snapshot().target.remoteCwd, h.home);
	messages = await h.request("Connect to fixture in relative"); assert.match(messages.at(-1).message.content, /absolute remote directory/);
	await assert.rejects(h.execute("ssh_connect", { destination: "fixture" }), /explicit current/);
	await h.request(JSON.stringify(h.remote)); await h.execute("ssh_connect", h.target);
	await h.request("Connect to fixture"); await h.request("cancel");
	await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/);
	await h.request(h.connectText, { source: "extension" }); await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/);
	await h.request(h.connectText, { streamingBehavior: "steer" }); await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/);
	await h.request("Summarize this quoted request: " + h.connectText); await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/);
});

for (const explicit of [false, true]) {
	test(`remote home ${explicit ? "~" : "default"} resolves in the remote shell and persists only the absolute directory`, async t => {
		const h = fixture(t); await h.emit("session_start");
		const text = "Connect to fixture" + (explicit ? " in ~" : "");
		const messages = await h.request(text);
		assert.match(messages.at(-1).message.content, /Use ssh_connect without another question/);
		await h.execute("ssh_connect", explicit ? { destination: "fixture", remoteCwd: "~" } : { destination: "fixture" });
		assert.equal(h.sshCalls.length, 2);
		assert.equal(h.confirmations.length, 0);
		assert.deepEqual(h.runtime.snapshot().target, { destination: "fixture", remoteCwd: h.home });
		const entries = h.manager.getBranch().filter(entry => entry.customType === "pi-cmux.ssh-target");
		assert.equal(entries.length, 2);
		assert.equal(entries[0].data.kind, "pending"); assert.equal(entries[0].data.target, undefined);
		assert.equal(entries[1].data.target.remoteCwd, h.home);
		await h.emit("turn_start");
		await h.execute("ssh_write", { path: "home-check.txt", content: "REMOTE_HOME" });
		assert.equal(readFileSync(join(h.home, "home-check.txt"), "utf8"), "REMOTE_HOME");
		assert.equal(existsSync(join(h.local, "home-check.txt")), false);
		const callsBeforeResume = h.sshCalls.length;
		await h.emit("session_start");
		assert.equal(h.runtime.snapshot().state, "configured", "restoration does not resolve home or reconnect");
		assert.equal(h.sshCalls.length, callsBeforeResume);
	});
}

test("explicit invalid paths require clarification rather than silently selecting home", async t => {
	const h = fixture(t); await h.emit("session_start");
	for (const path of ["relative", "~/project", "~someone", '""']) {
		const messages = await h.request(`Connect to fixture in ${path}`);
		assert.match(messages.at(-1).message.content, /Ask only this missing field/);
		await assert.rejects(h.execute("ssh_connect", { destination: "fixture" }), /explicit current/);
		assert.equal(h.sshCalls.length, 0);
	}
	await h.request("~"); await h.execute("ssh_connect", { destination: "fixture", remoteCwd: "~" });
	assert.equal(h.runtime.snapshot().target.remoteCwd, h.home);
});

test("the explicit ssh-bind command shares the remote-home default", async t => {
	const h = fixture(t); await h.emit("session_start"); h.ctx.isIdle = () => true;
	await h.commands.get("ssh-bind").handler('{"destination":"fixture"}', h.ctx);
	assert.equal(h.runtime.snapshot().target.remoteCwd, h.home);
	assert.equal(h.runtime.snapshot().state, "ready");
	assert.equal(h.sshCalls.length, 2);
});

test("disable controls preserve local tools, block saved remote intent, and avoid discovery/config I/O", async t => {
	const h = fixture(t, { env: { PI_CMUX_SSH: "0" } }); await h.emit("session_start");
	assert.deepEqual(h.registeredTools.filter(name => ["read", "write", "edit", "bash"].includes(name)), []);
	await h.execute("write", { path: "local.txt", content: "local when disabled without intent" });
	await h.request(h.connectText); await assert.rejects(h.execute("ssh_connect", h.target), /disabled/);
	assert.match((await h.execute("ssh_discover")).content[0].text, /disabled/);
	await assert.rejects(h.execute("ssh_alias_save", { alias: "work", hostname: "fixture" }), /disabled/);
	assert.equal(h.sshCalls.length, 0); assert.equal(h.calls.length, 0);
	h.manager.appendCustomEntry("pi-cmux.ssh-tool-selection", { version: 1, kind: "capture", sessionId: h.manager.getSessionId(), localCwd: h.local,
		localTools: ["read", "write", "edit", "bash"], exact: true });
	h.manager.appendCustomEntry("pi-cmux.ssh-target", { version: 1, kind: "target", sessionId: h.manager.getSessionId(), localCwd: h.local, target: h.target });
	await h.emit("session_start");
	for (const event of ["session_start", "session_tree"]) {
		await h.emit(event);
		for (const name of ["read", "write", "edit", "bash"]) {
			await assert.rejects(h.execute(name, { path: "no-fallback", content: "no", command: "touch no-fallback" }), /blocked/);
		}
		await assert.rejects(h.emit("user_bash", { command: "touch no-fallback" }), /not ready/);
	}
	assert.equal(existsSync(join(h.local, "no-fallback")), false);
	h.ctx.isIdle = () => true;
	await h.commands.get("ssh-clear").handler("", h.ctx);
	assert.equal(h.pi.getActiveTools().includes("write"), true);
	await h.execute("write", { path: "local-again", content: "explicitly cleared" });
	assert.equal(readFileSync(join(h.local, "local-again"), "utf8"), "explicitly cleared");
	assert.equal(h.sshCalls.length, 0);
});

for (const kind of ["pending", "invalid"]) {
	test(`disabled SSH blocks restored ${kind} intent without registering core tools`, async t => {
		const h = fixture(t, { env: { PI_CMUX_SSH: "0" } });
		h.manager.appendCustomEntry("pi-cmux.ssh-target", kind === "pending"
			? { version: 1, kind: "pending", sessionId: h.manager.getSessionId(), localCwd: h.local, destination: "fixture" }
			: { version: 999, kind: "target" });
		await h.emit("session_start");
		assert.deepEqual(h.registeredTools.filter(name => ["read", "write", "edit", "bash"].includes(name)), []);
		for (const name of ["read", "write", "edit", "bash"]) {
			await assert.rejects(h.execute(name, { path: "no-fallback", content: "no", command: "touch no-fallback" }), /blocked/);
		}
		await assert.rejects(h.emit("user_bash", { command: "touch no-fallback" }), /not ready/);
		assert.equal(existsSync(join(h.local, "no-fallback")), false);
		assert.equal(h.sshCalls.length, 0);
	});
}

test("failed home lookup cannot make core tools local on reload", async t => {
	const h = fixture(t, { authFail: true }); await h.emit("session_start");
	await h.request("Connect to fixture");
	await assert.rejects(h.execute("ssh_connect", { destination: "fixture" }), /outside chat/);
	assert.equal(h.sshCalls.length, 1);
	for (const event of [undefined, "session_start", "session_tree"]) {
		if (event) await h.emit(event);
		assert.equal(h.runtime.snapshot().state, "disconnected");
		await assert.rejects(h.execute("write", { path: "must-not-be-local", content: "no" }), /blocked/);
		assert.equal(existsSync(join(h.local, "must-not-be-local")), false);
	}
	assert.equal(h.sshCalls.length, 1);
});

test("authentication failure and cancelled inputs do not reconnect, expose secrets or cause local fallback", async t => {
	const h = fixture(t, { authFail: true }); await h.emit("session_start");
	await h.request(h.connectText); await assert.rejects(h.execute("ssh_connect", h.target), /outside chat/);
	assert.equal(h.sshCalls.length, 1); assert.equal(h.runtime.snapshot().state, "disconnected");
	await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/); assert.equal(h.sshCalls.length, 1);
	await h.request(h.connectText);
	await assert.rejects(h.execute("ssh_connect", h.target, AbortSignal.abort()), /cancelled/);
	assert.equal(h.sshCalls.length, 1);
	assert.equal(JSON.stringify(h.manager.getBranch()).includes("privateKey"), false);
});

test("optional alias saving requires exact fresh UI preview; declining still permits requested one-off connection", async t => {
	const h = fixture(t); await h.emit("session_start");
	await h.request(h.connectText + " and save alias work");
	await h.execute("ssh_alias_save", { alias: "work", hostname: "fixture" });
	assert.equal(h.confirmations.length, 1); assert.match(h.confirmations[0].preview, /\nHost work\n  HostName fixture\n/);
	assert.equal(existsSync(join(h.home, ".ssh/config")), false);
	await h.execute("ssh_connect", h.target); assert.equal(h.sshCalls.length, 1);
	const saved = fixture(t, { confirm: true }); await saved.emit("session_start");
	await saved.request("Save alias work for dev@fixture port 2222");
	await saved.execute("ssh_alias_save", { alias: "work", hostname: "fixture", user: "dev", port: 2222 });
	assert.equal(readFileSync(join(saved.home, ".ssh/config"), "utf8"), "\nHost work\n  HostName fixture\n  User dev\n  Port 2222\n");
	assert.equal(saved.sshCalls.length, 0);
	await assert.rejects(saved.execute("ssh_alias_save", { alias: "work", hostname: "fixture", user: "dev", port: 2222 }), /explicit current/);
});

test("unbound native workspace is not authority to launch remote Pi or browser", async t => {
	const h = fixture(t, { remoteWorkspace: { enabled: true, transport: "ssh", backend: "native-ssh" } });
	await h.emit("session_start");
	browserExtension(h.pi, () => ({ track() { assert.fail("must not bind"); }, forget() {}, stop() {} }));
	for (const placement of ["workspace", "tab", "right"]) {
		await assert.rejects(h.execute("cmux_start_pi", { placement, prompt: "local Pi" }), /placement/);
	}
	await assert.rejects(h.execute("cmux_open_browser", { url: "http://localhost:3000" }), /placement/);
	assert.equal(h.calls.some(c => c.file === "git" || c.args.includes("surface.create") || c.args.includes("surface.split") || c.args.includes("pane.create")), false);
	assert.equal(h.sshCalls.length, 0);
});

test("independent discovery/alias disable controls and transformed prompts fail closed", async t => {
	const h = fixture(t, { env: { PI_CMUX_SSH_DISCOVERY: "0", PI_CMUX_SSH_ALIAS_SAVE: "0" } });
	await h.emit("session_start");
	await h.request(h.connectText + " and save alias work");
	assert.match((await h.execute("ssh_discover")).content[0].text, /disabled/);
	await assert.rejects(h.execute("ssh_alias_save", { alias: "work", hostname: "fixture" }), /explicit current/);
	assert.equal(h.confirmations.length, 0); assert.equal(h.calls.length, 0);
	await h.execute("ssh_connect", h.target); assert.equal(h.sshCalls.length, 1);
	await h.request(h.connectText);
	await h.emit("before_agent_start", { messageType: "user", prompt: h.connectText + " expanded file content" });
	await assert.rejects(h.execute("ssh_connect", h.target), /explicit current/);
});

test("SSH question strings use the existing i18n provider with English fallback", async t => {
	const h = fixture(t); await h.emit("session_start");
	const listeners = new Map();
	h.pi.events = { emit() {}, on: (name, fn) => listeners.set(name, fn) };
	initI18n(h.pi);
	const locale = listeners.get("pi-core/i18n/localeChanged");
	try {
		locale({ locale: "es" });
		const messages = await h.request("Conecta a fixture en relative");
		assert.match(messages.at(-1).message.content, /directorio remoto absoluto/);
	} finally { locale({ locale: "en" }); }
});
