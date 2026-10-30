import assert from "node:assert/strict";
import { test } from "node:test";
import { createEventBus, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import registerCmuxSsh from "../extensions/cmux-ssh.ts";

const coreNames = ["read", "write", "edit", "bash"];
const sshNames = coreNames.map(name => `ssh_${name}`);

function assertSshDefinitions(extension) {
	for (const name of coreNames) assert.equal(extension.tools.has(name), false);
	for (const name of sshNames) {
		const { definition } = extension.tools.get(name);
		assert.equal(definition.name, name);
		assert.equal(definition.exposure, "direct");
		assert.equal(definition.defaultActive, false);
		assert.match(definition.description, /SSH target/);
		assert.match(definition.promptSnippet, /remote/i);
		assert.ok(definition.promptGuidelines.length > 0);
	}
	assert.equal(extension.handlers.has("tool_call"), true);
}

for (const enabled of [true, false]) {
	for (const sshFirst of [true, false]) {
		test(`${enabled ? "enabled" : "disabled"} SSH never owns core names (SSH loads ${sshFirst ? "first" : "last"})`, async () => {
			const runtime = createExtensionRuntime(), events = createEventBus();
			const ssh = pi => registerCmuxSsh(pi, { env: { PI_CMUX_SSH: enabled ? "1" : "0" } });
			const display = pi => {
				for (const name of coreNames) pi.registerTool({
					name, label: name, description: "Another extension's core-tool override",
					parameters: { type: "object", properties: {} },
					async execute() { return { content: [{ type: "text", text: "other extension" }], details: undefined }; },
				});
			};
			const factories = sshFirst ? [ssh, display] : [display, ssh];
			const extensions = [];
			for (const factory of factories) {
				extensions.push(await loadExtensionFromFactory(factory, process.cwd(), events, runtime, factory === ssh ? "<ssh>" : "<display>"));
			}
			for (const name of coreNames) {
				const owners = extensions.filter(extension => extension.tools.has(name));
				assert.deepEqual(owners.map(extension => extension.path), ["<display>"]);
			}
			assertSshDefinitions(extensions.find(extension => extension.path === "<ssh>"));
		});
	}
}

test("default SSH registration owns only inactive-by-default remote data tools", async () => {
	const extension = await loadExtensionFromFactory(pi => registerCmuxSsh(pi, { env: {} }),
		process.cwd(), createEventBus(), createExtensionRuntime(), "<ssh>");
	assertSshDefinitions(extension);
});
