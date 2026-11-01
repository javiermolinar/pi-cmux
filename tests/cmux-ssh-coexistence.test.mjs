import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { coreNames, controls, installed, piVersions, sshSdk } from "./helpers/ssh-sdk.mjs";

const ok = result => assert.equal(result.isError, false, JSON.stringify(result));
const blocked = result => assert.equal(result.isError, true, JSON.stringify(result));
const params = name => name.endsWith("bash") ? { command: "touch forbidden" }
	: name.endsWith("edit") ? { path: "sentinel.txt", edits: [{ oldText: "LOCAL", newText: "BAD" }] }
	: name.endsWith("write") ? { path: "forbidden", content: "BAD" } : { path: "sentinel.txt" };

for (const [version, root] of piVersions) for (const sshFirst of [true, false]) {
	const options = { skip: installed(root) ? false : `${version} unavailable; set PI_CMUX_TEST_PI_140_DIR to an installed package root` };
	const label = `${version}, SSH ${sshFirst ? "first" : "last"}`;
	test(`${label}: default coexistence, real local/remote effects, stale/nested/QuickJS guards and exact clear`, options, async t => {
		const h = await sshSdk(t, root, sshFirst);
		assert.equal(h.spawns.length, 0, "ordinary startup is inert without PI_CMUX_SSH=0");
		for (const name of coreNames) {
			assert.equal(h.session.getToolDefinition(name), h.definitions.get(name));
			assert.match(h.session.getAllTools().find(tool => tool.name === name).sourceInfo.path, /display/);
			blocked(await h.nested(`ssh_${name}`, params(name)));
		}
		ok(await h.direct("write", { path: "sentinel.txt", content: "LOCAL" }));
		ok(await h.nested("edit", { path: "sentinel.txt", edits: [{ oldText: "LOCAL", newText: "LOCAL_EDITED" }] }));
		ok(await h.direct("read", { path: "sentinel.txt" }));
		ok(await h.nested("bash", { command: "printf LOCAL_SHELL > local-shell" }));
		assert.equal(readFileSync(join(h.cwd, "local-shell"), "utf8"), "LOCAL_SHELL");
		const stale = h.cached(), definitions = coreNames.map(name => h.session.getToolDefinition(name));
		blocked(await h.nested("ssh_connect", { destination: "fixture", remoteCwd: h.remote }));
		await h.connect();
		const localsBefore = h.localCalls.length;
		for (const name of coreNames) {
			blocked(await h.direct(name, params(name), stale));
			blocked(await h.nested(name, params(name)));
			blocked(await h.direct(`ssh_${name}`, params(name), h.all()));
		}
		blocked(await h.nested("grep")); // deferred/inactive still callable, but guarded
		assert.equal(h.localCalls.length, localsBefore);
		await h.turn();
		ok(await h.direct("ssh_write", { path: "sentinel.txt", content: "REMOTE" }));
		ok(await h.nested("ssh_edit", { path: "sentinel.txt", edits: [{ oldText: "REMOTE", newText: "REMOTE_EDITED" }] }));
		const read = await h.direct("ssh_read", { path: "sentinel.txt" }); ok(read); assert.match(JSON.stringify(read.result), /REMOTE_EDITED/);
		const code = await h.direct("codemode", { code: 'text(ALL_TOOLS.map(t => t.name)); text(await tools.ssh_bash({command: "printf REMOTE_SHELL > remote-shell; cat remote-shell"}));' });
		ok(code); assert.match(JSON.stringify(code.result), /REMOTE_SHELL/);
		const forbidden = await h.direct("codemode", { code: 'await tools.grep({});' }); blocked(forbidden);
		assert.equal(readFileSync(join(h.remote, "sentinel.txt"), "utf8"), "REMOTE_EDITED");
		assert.equal(readFileSync(join(h.cwd, "sentinel.txt"), "utf8"), "LOCAL_EDITED");
		assert.equal(readFileSync(join(h.remote, "remote-shell"), "utf8"), "REMOTE_SHELL");
		assert.equal(existsSync(join(h.cwd, "remote-shell")), false);
		assert.equal(existsSync(join(h.cwd, "forbidden")), false);
		assert.equal(h.localCalls.length, localsBefore);
		assert.deepEqual(coreNames.map(name => h.session.getToolDefinition(name)), definitions);
		const staleRemote = h.cached();
		await h.command("ssh-clear");
		assert.deepEqual(new Set(h.api().getActiveTools()), new Set(h.baseline));
		for (const name of coreNames) blocked(await h.direct(`ssh_${name}`, params(name), staleRemote));
		ok(await h.nested("read", { path: "sentinel.txt" }));
	});

	test(`${label}: custom read-only selection, replacement, reload/tree restore no readiness, failed reconnect and cancellation`, options, async t => {
		const baseline = ["read", "bash", "grep", "other", "codemode", ...controls];
		const h = await sshSdk(t, root, sshFirst, { active: baseline });
		writeFileSync(join(h.cwd, "sentinel.txt"), "LOCAL");
		await h.connect("fixture", "~");
		assert.equal(h.adapter().runtime.snapshot().target.remoteCwd, h.home);
		await h.turn();
		assert.ok(h.api().getActiveTools().includes("ssh_read"));
		assert.ok(!h.api().getActiveTools().includes("ssh_write"));
		blocked(await h.direct("ssh_write", { path: "forbidden", content: "BAD" }, h.all()));
		const ticket = h.adapter().runtime.captureDispatch(), cached = h.cached();
		await h.connect("replacement");
		assert.throws(() => h.adapter().runtime.assertDispatch(ticket), /no longer current/);
		blocked(await h.direct("ssh_bash", { command: "touch forbidden" }, cached));
		await h.turn(); ok(await h.nested("ssh_bash", { command: ":" }));
		assert.equal(h.manager.getBranch().filter(entry => entry.customType === "pi-cmux.ssh-tool-selection").length, 1);
		const remoteLeaf = h.manager.getLeafId(), beforeReload = h.spawns.length;
		await h.session.reload();
		assert.equal(h.adapter().runtime.snapshot().state, "configured");
		assert.equal(h.spawns.length, beforeReload);
		blocked(await h.nested("grep")); blocked(await h.nested("ssh_bash", { command: ":" }));
		await h.command("ssh-validate");
		blocked(await h.nested("ssh_bash", { command: ":" }));
		await h.turn(); ok(await h.nested("ssh_bash", { command: ":" }));
		await h.command("ssh-clear");
		const beforeTree = h.spawns.length;
		const navigated = await h.session.navigateTree(remoteLeaf, { summarize: false });
		assert.equal(navigated.cancelled, false);
		assert.equal(h.adapter().runtime.snapshot().state, "configured");
		assert.equal(h.spawns.length, beforeTree);
		blocked(await h.nested("read", { path: "sentinel.txt" }));
		h.fail(true);
		await h.request(`Connect to fixture in ${JSON.stringify(h.remote)}`);
		blocked(await h.direct("ssh_connect", { destination: "fixture", remoteCwd: h.remote }));
		assert.equal(h.adapter().runtime.snapshot().state, "disconnected");
		blocked(await h.nested("grep"));
		const beforeCancel = h.spawns.length;
		await h.request(`Connect to fixture in ${JSON.stringify(h.remote)}`);
		blocked(await h.direct("ssh_connect", { destination: "fixture", remoteCwd: h.remote }, h.cached(), AbortSignal.abort()));
		assert.equal(h.spawns.length, beforeCancel);
		// Reload may reconstruct unrelated default tools; clear must retain the
		// CURRENT unrelated membership, not replay the entire old loadout.
		h.api().setActiveTools([...h.api().getActiveTools().filter(name => name !== "other"), "later"]);
		await h.command("ssh-clear");
		assert.deepEqual(new Set(h.api().getActiveTools()), new Set([...baseline.filter(name => name !== "other"), "later"]));
		assert.equal(existsSync(join(h.cwd, "forbidden")), false);
		assert.equal(readFileSync(join(h.cwd, "sentinel.txt"), "utf8"), "LOCAL");
		const localCount = h.localCalls.length;
		await h.session._extensionRunner.emit({ type: "session_shutdown", reason: "exit" });
		blocked(await h.direct("read", { path: "sentinel.txt" }));
		assert.equal(h.localCalls.length, localCount);
	});

	for (const enabled of [true, false]) for (const kind of ["target", "pending", "invalid"]) {
		test(`${label}: ${enabled ? "enabled" : "disabled"} restored ${kind} intent blocks actual nested/deferred calls`, options, async t => {
			const h = await sshSdk(t, root, sshFirst, { env: enabled ? {} : { PI_CMUX_SSH: "0" }, restore(manager, cwd, remote) {
				const owner = { version: 1, sessionId: manager.getSessionId(), localCwd: cwd };
				manager.appendCustomEntry("pi-cmux.ssh-tool-selection", { ...owner, kind: "capture", localTools: coreNames, exact: true });
				manager.appendCustomEntry("pi-cmux.ssh-target", kind === "invalid" ? { version: 999 }
					: { ...owner, kind, ...(kind === "target" ? { target: { destination: "fixture", remoteCwd: remote } } : { destination: "fixture" }) });
			} });
			writeFileSync(join(h.cwd, "sentinel.txt"), "LOCAL");
			for (const name of coreNames) {
				blocked(await h.direct(name, params(name), h.all()));
				blocked(await h.nested(name, params(name)));
				blocked(await h.direct(`ssh_${name}`, params(name), h.all()));
			}
			blocked(await h.nested("grep"));
			assert.equal(h.localCalls.length, 0); assert.equal(h.spawns.length, 0);
			assert.equal(readFileSync(join(h.cwd, "sentinel.txt"), "utf8"), "LOCAL");
			assert.equal(existsSync(join(h.cwd, "forbidden")), false);
		});
	}
}
