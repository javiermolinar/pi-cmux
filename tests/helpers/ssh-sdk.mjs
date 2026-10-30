import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import registerCmuxSsh from "../../extensions/cmux-ssh.ts";
import { OpenSshTransport } from "../../lib/ssh/transport.ts";

export const piVersions = [
	["Pi 1.3.0", resolve("node_modules/@earendil-works/pi-coding-agent")],
	["Pi 1.4.0", process.env.PI_CMUX_TEST_PI_140_DIR ?? join(homedir(), ".pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent")],
];
export const installed = root => existsSync(join(root, "dist/index.js"));
export const coreNames = ["read", "write", "edit", "bash"];
export const controls = ["ssh_connect", "ssh_discover", "ssh_alias_save"];

// Real Pi factory loader, AgentSession, hooks, nested dispatch and QuickJS.
// The display-equivalent fixture owns all four core names using Pi's schemas
// and operations. It models the ownership conflict, not real-package rendering.
// Only SSH spawn is substituted: scripts run in isolated local temp directories.
// No provider, cmux, network, credentials or actual SSH executable is used.
export async function sshSdk(t, root, sshFirst, options = {}) {
	const sdk = await import(pathToFileURL(join(root, "dist/index.js")));
	const { loadExtensionFromFactory } = await import(pathToFileURL(join(root, "dist/core/extensions/loader.js")));
	const { runToolCall } = await import(pathToFileURL(resolve(root, "../pi-agent-core/dist/index.js")));
	const cwd = mkdtempSync(join(realpathSync(tmpdir()), "cmux-ssh-sdk-"));
	const remote = join(cwd, "remote ' $HOME café"), home = join(cwd, "remote-home");
	for (const path of [remote, home]) mkdirSync(path);
	const localCalls = [], spawns = [], definitions = new Map();
	let api, adapter, session, loaded, fail = false;
	t.after(() => { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); });
	const manager = sdk.SessionManager.inMemory(cwd);
	const assistant = { role: "assistant", content: [{ type: "text", text: "Offline fixture" }],
		api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	manager.appendMessage(assistant);
	options.restore?.(manager, cwd, remote);
	const transport = new OpenSshTransport((_file, args) => {
		spawns.push(args);
		return spawn("/bin/sh", ["-c", fail ? "exit 255" : args.at(-1)], {
			stdio: "pipe", env: { PATH: "/usr/bin:/bin", HOME: home },
		});
	});
	const ssh = pi => { api = pi; adapter = registerCmuxSsh(pi, { env: options.env ?? {}, transport }); };
	const display = pi => {
		for (const create of [sdk.createReadToolDefinition, sdk.createWriteToolDefinition, sdk.createEditToolDefinition, sdk.createBashToolDefinition]) {
			const tool = create(cwd);
			const definition = { ...tool, async execute(...args) { localCalls.push(tool.name); return tool.execute(...args); } };
			definitions.set(tool.name, definition); pi.registerTool(definition);
		}
		for (const name of ["grep", "other", "later"]) pi.registerTool({
			name, label: name, description: `Display fixture ${name}`, parameters: { type: "object", properties: {} },
			...(name === "grep" ? { exposure: "deferred" } : {}),
			async execute() { localCalls.push(name); return { content: [{ type: "text", text: "LOCAL" }], details: undefined }; },
		});
	};
	async function load() {
		const runtime = sdk.createExtensionRuntime(), events = sdk.createEventBus(), extensions = [];
		for (const factory of sshFirst ? [ssh, display] : [display, ssh]) {
			extensions.push(await loadExtensionFromFactory(factory, cwd, events, runtime, factory === ssh ? "<ssh>" : "<display>"));
		}
		extensions.push(await loadExtensionFromFactory(sdk.createCodemodeExtension({ mode: "only" }), cwd, events, runtime, "<codemode>"));
		return { extensions, runtime, errors: [], warnings: [] };
	}
	loaded = await load();
	const resources = {
		getExtensions: () => loaded, getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }), getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }), getSystemPrompt: () => "Offline fixture",
		getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
		extendResources() {}, async reload() { loaded = await load(); },
	};
	const models = await sdk.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null,
		modelsStorePath: join(cwd, "catalog"), allowModelNetwork: false, refreshOnCreate: false });
	({ session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime: models, resourceLoader: resources,
		sessionManager: manager, settingsManager: sdk.SettingsManager.inMemory({ compaction: { enabled: false } }) }));
	await session.bindExtensions({ shutdownHandler() {} });
	const baseline = [...coreNames, "grep", "other", "codemode", ...controls];
	if (!options.restore) api.setActiveTools(options.active ?? baseline);
	const direct = (name, args = {}, tools = session.agent.state.tools.slice(), signal) => runToolCall(
		{ type: "toolCall", id: `sdk-${spawns.length}-${localCalls.length}`, name, arguments: args },
		{ tools, signal, assistantMessage: assistant, context: { messages: session.messages, tools },
			beforeToolCall: ctx => session._beforeToolCall(ctx), afterToolCall: ctx => session._afterToolCall(ctx) });
	const request = async text => {
		await session._extensionRunner.emitInput(text, undefined, "interactive");
		await session._extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: text }, session._baseSystemPromptOptions);
	};
	return { cwd, remote, home, baseline, manager, session, localCalls, spawns, definitions, direct, request,
		api: () => api, adapter: () => adapter, fail: value => { fail = value; },
		all: () => [...session._toolRegistry.values()],
		cached: () => session.agent.state.tools.slice(),
		nested: (name, args = {}) => session._executeNestedToolCall("sdk-parent", name, args, {}),
		turn: () => session._extensionRunner.emit({ type: "turn_start" }),
		command: (name, args = "") => session._extensionRunner.getCommand(name).handler(args, session._extensionRunner.createCommandContext()),
		async connect(destination = "fixture", remoteCwd = remote) {
			await request(`Connect to ${destination} in ${JSON.stringify(remoteCwd)}`);
			const result = await direct("ssh_connect", { destination, remoteCwd });
			assert.equal(result.isError, false, JSON.stringify(result));
		},
	};
}
