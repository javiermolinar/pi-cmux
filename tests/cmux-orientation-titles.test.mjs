import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as immediate } from "node:timers/promises";
import { test } from "node:test";
import cmuxAutotitle from "../extensions/cmux-autotitle.ts";
import { openPiSession } from "../extensions/cmux-pi.ts";
import { renameOrientedTopic } from "../lib/orientation/runtime.ts";
import { registerSshTarget } from "../lib/ssh/runtime.ts";
import { ORIENTATION_ENTRY, childBootstrap, decodeBootstrap, encodeBootstrap, marker, orientedTitle, rootOrientation } from "../lib/orientation/state.ts";
import { orientationHarness, target } from "./helpers/orientation.mjs";

const drain = async () => { for (let i = 0; i < 5; i++) await immediate(); };
const titles = (h) => h.calls.filter(c => c.args[0] === "rename-tab").map(c => c.args.at(-1));

const identity = {
	taskId: "abcd1234-1111-4111-8111-111111111111",
	conversationId: "12345678-2222-4222-8222-222222222222",
	role: "main",
};

for (const role of ["main", "chat", "review", "continue"]) {
	test(`${role} title puts the human topic before a short shared task tag`, () => {
		const value = { ...identity, role };
		assert.equal(orientedTitle(value, "Pane orientation"), `Pane orientation · ${role} [abcd]`);
		assert.equal(orientedTitle(value, "Pane orientation").includes(value.conversationId.slice(0, 8)), false);
		assert.equal(value.conversationId, identity.conversationId, "title formatting must not change identity");
	});

	test(`${role} title truncates only the topic, preserving its suffix and the 48-character bound`, () => {
		const suffix = ` · ${role} [abcd]`;
		assert.equal(orientedTitle({ ...identity, role }, "x".repeat(100)), `${"x".repeat(48 - suffix.length - 3)}...${suffix}`);
	});

	test(`${role} title removes repeated own legacy prefixes and new suffixes`, () => {
		const value = { ...identity, role }, prefix = `${marker(value)} · `, suffix = ` · ${role} [abcd]`;
		const expected = `Authentication${suffix}`;
		for (const topic of [expected, prefix.repeat(3) + "Authentication", "Authentication" + suffix.repeat(3), prefix.repeat(2) + "Authentication" + suffix.repeat(2)]) {
			assert.equal(orientedTitle(value, topic), expected);
			assert.equal(orientedTitle(value, orientedTitle(value, topic)), expected);
		}
	});
}

test("readable title handles empty, whitespace, Unicode and control characters", () => {
	for (const topic of ["", " \n\t "]) assert.equal(orientedTitle(identity, topic), "Pi · main [abcd]");
	for (const topic of ["修复认证 🛠️", "Проверка входа"]) assert.equal(orientedTitle(identity, topic), `${topic} · main [abcd]`);
	const title = orientedTitle(identity, "\u001b]0;wrong\u0007" + "long ".repeat(100));
	assert.ok(title.length <= 48);
	assert.ok(title.endsWith(" · main [abcd]"));
	assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(title), false);
});

test("related conversations share the compact tag while their status identities remain distinct", () => {
	const parent = { ...rootOrientation(randomUUID()), ...identity };
	const child = childBootstrap(parent, target(), true, "review", "Review");
	assert.equal(orientedTitle(parent, "Authentication"), "Authentication · main [abcd]");
	assert.equal(orientedTitle(child, "Check login"), "Check login · review [abcd]");
	assert.equal(marker(child).split("/")[0], marker(parent).split("/")[0]);
	assert.notEqual(marker(child), marker(parent));
	assert.equal(orientedTitle({ ...identity, taskId: "def05678-1111-4111-8111-111111111111" }, "Other task"), "Other task · main [def0]");
});

test("formatting does not strip another conversation's legacy prefix or another task's suffix", () => {
	const other = { ...identity, conversationId: "87654321-2222-4222-8222-222222222222" };
	assert.equal(orientedTitle(identity, `${marker(other)} · X`), `${marker(other)} · X · main [abcd]`);
	assert.equal(orientedTitle(identity, "X · main [def0]"), "X · main [def0] · main [abcd]");
});

for (const git of ["repository", "unavailable", "throws", "timeout"]) {
	test(`direct sessions use the project fallback when git is ${git}`, async (t) => {
		const h = orientationHarness(t, { exec: (command, _args, options) => {
			if (command !== "git") return;
			assert.equal(options.cwd, "/work/project/services/api");
			assert.ok(options.timeout > 0);
			if (git === "throws") throw new Error("git missing");
			return { code: git === "unavailable" ? 1 : 0, killed: git === "timeout", stdout: "/work/project\n", stderr: "" };
		} });
		h.ctx.cwd = "/work/project/services/api";
		await h.emit("session_start"); await drain();
		const expected = git === "repository" ? "project" : "api";
		assert.equal(h.runtime.state.topic, "Pi", "project fallback changes display, not persisted orientation metadata");
		assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, expected));
		assert.ok(h.calls.every(call => ["git", "cmux"].includes(call.command)), "no model request or new process launch");
	});
}

test("remote project fallbacks never inspect the local repository", async (t) => {
	const h = orientationHarness(t);
	const ssh = registerSshTarget(h.pi);
	await h.emit("session_start"); await drain();
	const original = { ...h.runtime.state };
	ssh.activate({ destination: "fixture", remoteCwd: "/remote/application" });
	h.calls.length = 0;
	await h.emit("session_tree"); await drain();
	assert.deepEqual(h.runtime.state, original);
	assert.equal(titles(h).at(-1), orientedTitle(original, "application"));
	assert.ok(h.calls.every(call => call.command === "cmux"), "no local git lookup or remote connection for naming");
});

test("legacy Pi defaults upgrade on resume without replacing identity", async (t) => {
	const h = orientationHarness(t);
	h.ctx.cwd = "/work/project";
	const legacy = rootOrientation(h.ctx.sessionManager.getSessionId());
	h.ctx.sessionManager.appendCustomEntry(ORIENTATION_ENTRY, legacy);
	for (const event of ["session_start", "session_tree", "session_start"]) {
		await h.emit(event); await drain();
		assert.deepEqual(h.runtime.state, legacy);
		assert.equal(titles(h).at(-1), orientedTitle(legacy, "project"));
	}
});

for (const name of ["Fix authentication", "Pi"]) {
	test(`explicit session name ${name} wins over the project fallback`, async (t) => {
		const h = orientationHarness(t);
		h.ctx.cwd = "/work/project";
		h.ctx.sessionManager.appendSessionInfo(name);
		await h.emit("session_start"); await drain();
		assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, name));
		h.ctx.sessionManager.appendSessionInfo("");
		await h.emit("session_info_changed", { name: "" }); await drain();
		assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, "project"));
	});
}

test("an available saved task title wins without enabling automatic naming", async (t) => {
	const h = orientationHarness(t);
	h.ctx.cwd = "/work/project";
	h.ctx.sessionManager.appendCustomEntry("pi-cmux.autotitle", { title: "Fix authentication" });
	await h.emit("session_start"); await drain();
	assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, "Fix authentication"));
});

for (const task of [undefined, "Review authentication"]) {
	test(`new workspace separates the project label from task ${task}`, async (t) => {
		const h = orientationHarness(t);
		t.mock.method(globalThis, "setTimeout", callback => { queueMicrotask(callback); return 0; });
		h.ctx.cwd = "/work/project";
		await h.emit("session_start"); await drain();
		const result = await openPiSession(h.pi, h.ctx.cwd, { prompt: task, focus: false });
		assert.equal(result.ok, true);
		assert.equal(result.title, orientedTitle(result.orientation, task ?? "project"));
		const creation = h.calls.find(call => call.args.includes("create"));
		assert.equal(creation.args[creation.args.indexOf("--name") + 1], "project");
		assert.equal(titles(h).at(-1), result.title);
	});
}

test("explicit launch titles remain the workspace and tab topic", async (t) => {
	const h = orientationHarness(t);
	t.mock.method(globalThis, "setTimeout", callback => { queueMicrotask(callback); return 0; });
	await h.emit("session_start"); await drain();
	const result = await openPiSession(h.pi, h.root, { title: "Pinned name", prompt: "Another task", focus: false });
	assert.equal(result.title, orientedTitle(result.orientation, "Pinned name"));
	const creation = h.calls.find(call => call.args.includes("create"));
	assert.equal(creation.args[creation.args.indexOf("--name") + 1], "Pinned name");
});

test("shutdown during project lookup cannot claim or rename a stale session", async (t) => {
	let release;
	const h = orientationHarness(t, { exec: command => command === "git"
		? new Promise(resolve => { release = () => resolve({ code: 0, stdout: "/work/project", stderr: "" }); }) : undefined });
	const starting = h.emit("session_start"); await drain();
	assert.equal(typeof release, "function");
	await h.emit("session_shutdown");
	release(); await starting; await drain();
	assert.equal(h.runtime.state, undefined);
	assert.equal(h.store.read(h.location.surfaceId), undefined);
	assert.deepEqual(titles(h), []);
});

test("manual legacy/new names stay readable across reload with autotitle disabled and origin stays visible", async (t) => {
	const parent = rootOrientation(randomUUID());
	const h = orientationHarness(t, { bootstrap: encodeBootstrap(childBootstrap(parent, target(), true, "review", "Auth")) });
	await h.emit("session_start"); await drain();
	const state = h.runtime.state, prefix = marker(state), suffix = ` · review [${state.taskId.slice(0, 4)}]`;
	assert.match(h.statuses.at(-1)[1], /←.*main.*\/cmbk/);
	assert.ok(h.statuses.at(-1)[1].includes(prefix), "status retains the distinct conversation marker");
	h.ctx.sessionManager.appendSessionInfo("Explicit topic");
	await h.emit("session_info_changed", { name: "Explicit topic" }); await drain();
	assert.equal(titles(h).at(-1), `Explicit topic${suffix}`);
	h.ctx.sessionManager.appendSessionInfo(`${prefix} · repeated`);
	await h.emit("session_info_changed", { name: `${prefix} · repeated` }); await drain();
	assert.equal(titles(h).at(-1), `repeated${suffix}`);
	h.ctx.sessionManager.appendSessionInfo(`Already readable${suffix}`);
	await h.emit("session_info_changed", { name: `Already readable${suffix}` }); await drain();
	assert.equal(titles(h).at(-1), `Already readable${suffix}`);
	await h.emit("session_start"); await drain();
	assert.deepEqual(h.runtime.state, state);
	assert.equal(titles(h).at(-1), `Already readable${suffix}`);
	await h.emit("session_shutdown"); assert.equal(h.statuses.at(-1)[1], undefined);
});

test("queued auto/manual renames end with manual title and retain one marker", async (t) => {
	let release;
	let block = false;
	const h = orientationHarness(t, { exec: (_command, args) => {
		if (args[0] === "rename-tab" && block) { block = false; return new Promise(resolve => { release = () => resolve({ code: 0, stdout: "", stderr: "" }); }); }
	} });
	await h.emit("session_start"); await drain();
	block = true;
	const auto = renameOrientedTopic(h.pi, "Automatic topic"); await drain();
	h.ctx.sessionManager.appendSessionInfo("Manual wins");
	await h.emit("session_info_changed", { name: "Manual wins" });
	release(); await auto; await drain();
	assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, "Manual wins"));
});

for (const placement of ["workspace", "right", "down", "tab"]) {
	for (const change of ["manual topic", "new session identity"]) {
		test(`${placement} launch cannot overwrite the child's ${change} after a delayed respawn reply`, async (t) => {
			let entered, finishRespawn;
			const respawnStarted = new Promise(resolve => { entered = resolve; });
			const h = orientationHarness(t, { exec: (_command, args) => {
				if (args[0] === "respawn-pane") {
					entered(args);
					return new Promise(resolve => { finishRespawn = () => resolve({ code: 0, killed: false, stdout: "{}", stderr: "" }); });
				}
			} });
			t.mock.method(globalThis, "setTimeout", (callback) => { queueMicrotask(callback); return 0; });
			await h.emit("session_start"); await drain();
			h.calls.length = 0;
			const launch = openPiSession(h.pi, h.root, { placement, role: "review", title: "Original topic", focus: false });
			const args = await respawnStarted;
			const seed = decodeBootstrap(args.at(-1).match(/PI_CMUX_ORIENTATION='([^']+)'/)[1]);
			const expected = change === "manual topic" ? orientedTitle(seed, "Manual topic") : orientedTitle(rootOrientation(randomUUID()), "New task");
			// Simulate the separate child process writing after it starts, before
			// the parent's respawn RPC reply arrives. No shared runtime queue exists.
			await h.pi.exec("cmux", ["rename-tab", "--workspace", "workspace:2", "--surface", "surface:2", "--title", expected]);
			finishRespawn();
			assert.equal((await launch).ok, true);
			const names = h.calls.filter(call => call.args[0] === "rename-tab" && call.args.includes("surface:2"));
			assert.equal(names.at(-1).args.at(-1), expected, "the child's newer title must remain the final write");
			assert.equal(names.length, 2, "one parent initialization and one child update only");
			assert.equal(names[0].args.at(-1), orientedTitle(seed, seed.topic), "parent initializes the same readable layout as the child");
			assert.ok(h.calls.indexOf(names[0]) < h.calls.findIndex(call => call.args[0] === "respawn-pane"), "parent initialization must finish before executing the child");
		});
	}
}

test("autotitle uses the orientation queue and persists undecorated topic", async (t) => {
	const old = process.env.PI_CMUX_AUTOTITLE;
	process.env.PI_CMUX_AUTOTITLE = "1";
	t.after(() => { if (old === undefined) delete process.env.PI_CMUX_AUTOTITLE; else process.env.PI_CMUX_AUTOTITLE = old; });
	const h = orientationHarness(t);
	h.ctx.model = { provider: "test", id: "model" };
	h.ctx.modelRegistry = { complete: async () => ({ stopReason: "stop", content: [{ type: "text", text: "Automatic auth" }] }) };
	h.ctx.sessionManager.appendMessage({ role: "user", content: "Fix auth", timestamp: 1 });
	h.ctx.sessionManager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Fixed" }], stopReason: "stop", timestamp: 2 });
	cmuxAutotitle(h.pi);
	await h.emit("session_start"); await h.emit("agent_settled"); await drain();
	assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, "Automatic auth"));
	const saved = h.ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "pi-cmux.autotitle").at(-1);
	assert.deepEqual(saved.data, { title: "Automatic auth" });
	await h.emit("session_start"); await drain();
	assert.equal(titles(h).at(-1), orientedTitle(h.runtime.state, "Automatic auth"));
});
