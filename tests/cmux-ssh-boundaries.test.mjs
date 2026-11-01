import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import registerCmuxSsh from "../extensions/cmux-ssh.ts";

const versions = [
	["pinned Pi", resolve("node_modules/@earendil-works/pi-coding-agent")],
	["Pi 1.4.0", process.env.PI_CMUX_TEST_PI_140_DIR ?? "/Users/javimolina/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent"],
];
const local = ["read", "bash", "grep"];
const controls = ["ssh_connect", "ssh_discover", "ssh_alias_save"];
const target = { destination: "fixture", remoteCwd: "/remote/project" };

// Real SDK factory loading, tool declarations and file-backed session replay.
// Only transport is fake. Stop the core request loop before auth/provider/model execution.
async function fixture(t, root, sshFirst) {
	const sdk = await import(pathToFileURL(join(root, "dist/index.js")));
	const ai = await import(pathToFileURL(resolve(root, "../pi-ai/dist/index.js")));
	const core = await import(pathToFileURL(resolve(root, "../pi-agent-core/dist/index.js")));
	const { loadExtensionFromFactory } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")));
	const cwd = mkdtempSync(join(tmpdir(), "cmux-ssh-boundary-"));
	let session, api, adapter, manager = sdk.SessionManager.create(cwd, join(cwd, "sessions")), calls = 0;
	const assistant = { role: "assistant", content: [{ type: "text", text: "Offline fixture" }],
		api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	manager.appendMessage(assistant); // Flush a real session file before testing clear -> exit.
	t.after(() => { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	const models = await sdk.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
		modelsStorePath: join(cwd, "catalog"), allowModelNetwork: false, refreshOnCreate: false });
	const ssh = pi => { api = pi; adapter = registerCmuxSsh(pi, { env: {}, transport: { async run(request) {
		request.assertCurrent(); calls++;
		return { exitCode: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
	} } }); };
	const display = pi => { for (const name of [...local, "write", "edit", "other"]) pi.registerTool({
		name, label: name, description: `Another owner's ${name}`, parameters: { type: "object", properties: {} },
		async execute() { return { content: [{ type: "text", text: "LOCAL" }], details: undefined }; },
	}); };
	async function open() {
		const runtime = sdk.createExtensionRuntime(), events = sdk.createEventBus(), extensions = [];
		for (const factory of sshFirst ? [ssh, display] : [display, ssh]) {
			extensions.push(await loadExtensionFromFactory(factory, cwd, events, runtime, factory === ssh ? "<ssh>" : "<display>"));
		}
		const resources = {
			getExtensions: () => ({ extensions, runtime, errors: [], warnings: [] }),
			getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
			getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
			getSystemPrompt: () => "Offline fixture", getSystemPromptSource: () => undefined,
			getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [], extendResources() {}, async reload() {},
		};
		({ session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime: models, resourceLoader: resources,
			sessionManager: manager, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }) }));
		await session.bindExtensions({ shutdownHandler() {} });
	}
	await open();
	const currentMessages = () => manager.buildSessionContext().messages;
	function persistActive() {
		const changes = ai.getToolStateChanges(ai.getCurrentTools(currentMessages()), session.agent.state.tools.map(ai.toToolDeclaration));
		if (changes.toolsAdded.length || changes.toolsRemoved.length) manager.appendMessage({ role: "system", content: "",
			...(changes.toolsAdded.length ? { toolsAdded: changes.toolsAdded } : {}),
			...(changes.toolsRemoved.length ? { toolsRemoved: changes.toolsRemoved } : {}), timestamp: Date.now() });
		session._refreshFinalizedContext();
		assert.deepEqual(ai.getCurrentTools(currentMessages()).map(tool => tool.name).sort(), api.getActiveTools().sort());
	}
	api.setActiveTools([...local, "other", ...controls]); persistActive();
	const command = (name, args = "") => session._extensionRunner.getCommand(name).handler(args, session._extensionRunner.createCommandContext());
	const direct = (name, args = {}, tools = session.agent.state.tools.slice()) => core.runToolCall(
		{ type: "toolCall", id: `boundary-${calls}`, name, arguments: args },
		{ tools, assistantMessage: assistant, context: { messages: session.messages, tools },
			beforeToolCall: ctx => session._beforeToolCall(ctx), afterToolCall: ctx => session._afterToolCall(ctx) });
	async function connect() {
		const text = "Connect to fixture in /remote/project";
		await session._extensionRunner.emitInput(text, undefined, "interactive");
		await session._extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: text }, session._baseSystemPromptOptions);
		const result = await direct("ssh_connect", target); assert.equal(result.isError, false, JSON.stringify(result));
	}
	async function requestDeclarations(context) {
		const stop = new Error("Stopped before auth/provider execution");
		let names;
		await assert.rejects(core.runAgentLoop([{ role: "user", content: "Offline request", timestamp: Date.now() }], context, {
			model: { provider: "fixture", id: "fixture" },
			convertToLlm() { assert.fail("No model conversion/request expected"); },
			prepareRequest(request) { names = ai.getCurrentTools(request.context.messages).map(tool => tool.name); throw stop; },
		}, async event => { if (event.type === "turn_start") await session._extensionRunner.emit(event); }, undefined,
		() => { assert.fail("No provider invocation expected"); }), error => error === stop);
		return names;
	}
	return { sdk, ai, connect, command, direct, persistActive, requestDeclarations,
		active: () => api.getActiveTools(), setActive: names => api.setActiveTools(names), calls: () => calls,
		turn: () => session._extensionRunner.emit({ type: "turn_start" }), adapter: () => adapter,
		context: () => ({ messages: currentMessages(), tools: session.agent.state.tools.slice() }),
		async nextTurn() { return session.agent.prepareNextTurnWithContext({ context: this.context(), message: assistant, toolResults: [] }); },
		async resume() {
			const file = manager.getSessionFile(); assert.ok(file && existsSync(file));
			session.dispose(); manager = sdk.SessionManager.open(file); await open();
		},
	};
}

for (const [version, root] of versions) for (const sshFirst of [true, false]) {
	const options = { skip: existsSync(join(root, "dist/index.js")) ? false : `${version} is not installed; no dependency installation attempted` };
	for (const boundary of ["next request after idle bind", "automatic next-turn snapshot"]) {
		test(`${version}, SSH ${sshFirst ? "first" : "last"}: F1 declares SSH data on the first ${boundary}`, options, async t => {
			const h = await fixture(t, root, sshFirst);
			if (boundary === "next request after idle bind") await h.command("ssh-bind", JSON.stringify(target));
			else await h.connect();
			assert.equal((await h.direct("ssh_bash", { command: ":" })).isError, true, "membership must not admit the transition batch");
			const context = boundary === "automatic next-turn snapshot" ? (await h.nextTurn()).context : h.context();
			const declared = await h.requestDeclarations(context);
			for (const name of ["ssh_read", "ssh_bash"]) assert.ok(declared.includes(name), `${name} missing from first request declarations`);
			for (const name of [...local, "ssh_write", "ssh_edit"]) assert.ok(!declared.includes(name), `${name} must not be declared`);
			assert.equal((await h.direct("ssh_bash", { command: ":" })).isError, false, "fresh turn releases execution admission");
		});
	}
	test(`${version}, SSH ${sshFirst ? "first" : "last"}: F2 clear survives file-backed exit/resume before another request`, options, async t => {
		const h = await fixture(t, root, sshFirst); await h.connect(); await h.turn(); h.persistActive();
		await h.command("ssh-clear");
		assert.deepEqual(h.active().filter(name => local.includes(name)).sort(), [...local].sort());
		await h.resume();
		assert.deepEqual(h.active().filter(name => local.includes(name)).sort(), [...local].sort());
		assert.equal(h.active().some(name => /^ssh_(read|write|edit|bash)$/.test(name)), false);
		await h.command("ssh-clear"); await h.resume();
		assert.deepEqual(h.active().filter(name => local.includes(name)).sort(), [...local].sort());
		assert.equal(h.calls(), 1, "restoration never revalidates or reconnects");
	});
	test(`${version}, SSH ${sshFirst ? "first" : "last"}: a newer persisted local selection supersedes clear membership`, options, async t => {
		const h = await fixture(t, root, sshFirst); await h.connect(); await h.turn(); h.persistActive();
		await h.command("ssh-clear"); h.setActive(["read", "other", ...controls]); h.persistActive(); await h.resume();
		assert.deepEqual(h.active().filter(name => local.includes(name)), ["read"]);
	});
}
