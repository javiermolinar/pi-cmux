import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import cmuxStart from "../extensions/cmux-start.ts";
import { prepareOrientation } from "../lib/orientation/runtime.ts";
import { BINDING_TTL_MS, decodeBootstrap } from "../lib/orientation/state.ts";
import { waitForPiStartup } from "../lib/orientation/startup.ts";
import { orientationHarness } from "./helpers/orientation.mjs";
import { effectiveCommand } from "./helpers/launch-command.mjs";

const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const binding = (seed, extra = {}) => ({ ...seed, version: 1, sessionId: randomUUID(), token: randomUUID(), pid: process.pid, expiresAt: Date.now() + BINDING_TTL_MS, ...extra });
const fastTimers = (t, tick = () => {}) => t.mock.method(globalThis, "setTimeout", callback => {
	queueMicrotask(() => { tick(); callback(); });
	return 0;
});

async function setup(t) {
	const h = orientationHarness(t);
	await h.emit("session_start");
	return h;
}

test("startup confirms only the exact launched conversation on the returned UUID", async t => {
	const h = await setup(t), seed = prepareOrientation(h.pi, { related: true }, "Test startup");
	const child = binding(seed);
	h.store.write(CHILD, child);
	const before = h.calls.length;
	assert.deepEqual(await waitForPiStartup(h.pi, seed, CHILD.toUpperCase(), () => {}), { state: "bound", surfaceId: CHILD, sessionId: child.sessionId });
	assert.equal(h.calls.length, before, "acknowledgement is local and read-only");
});

for (const [name, override] of [
	["wrong conversation", { conversationId: randomUUID() }],
	["wrong task", { taskId: randomUUID() }],
	["wrong role", { role: "main" }],
	["expired", { expiresAt: 1 }],
	["dead process", { pid: 2147483647 }],
]) test(`startup rejects ${name} evidence without creating or messaging`, async t => {
	const h = await setup(t), seed = prepareOrientation(h.pi, { related: true }, "Test startup");
	h.store.write(CHILD, binding(seed, override));
	let waits = 0; fastTimers(t, () => waits++);
	const before = h.calls.length;
	const result = await waitForPiStartup(h.pi, seed, CHILD, () => {});
	assert.equal(result.state, "unconfirmed");
	assert.match(result.reason, /may be starting, blocked, or exited/);
	assert.match(result.reason, /Do not relaunch automatically/);
	assert.equal(waits, 39, "bounded polling, no unbounded watcher");
	assert.equal(h.calls.length, before);
});

test("startup accepts a delayed child binding without replaying a launch", async t => {
	const h = await setup(t), seed = prepareOrientation(h.pi, { related: true }, "Delayed startup");
	let waits = 0; fastTimers(t, () => { if (++waits === 2) h.store.write(CHILD, binding(seed)); });
	const before = h.calls.length;
	assert.equal((await waitForPiStartup(h.pi, seed, CHILD, () => {})).state, "bound");
	assert.equal(waits, 2);
	assert.equal(h.calls.length, before);
});

for (const surface of [undefined, "surface:2"]) test(`startup does not discover a substitute for ${surface}`, async t => {
	const h = await setup(t), seed = prepareOrientation(h.pi, {}, "Missing UUID");
	const before = h.calls.length;
	assert.equal((await waitForPiStartup(h.pi, seed, surface, () => {})).state, "unconfirmed");
	assert.equal(h.calls.length, before);
});

test("startup cancels after a launch without claiming the child was stopped", async t => {
	const h = await setup(t), seed = prepareOrientation(h.pi, {}, "Canceled verification");
	const controller = new AbortController(); fastTimers(t, () => controller.abort());
	const result = await waitForPiStartup(h.pi, seed, CHILD, () => controller.signal.throwIfAborted());
	assert.equal(result.state, "unconfirmed");
	assert.match(result.reason, /already dispatched.*startup outcome is uncertain.*Do not relaunch/);
});

async function launchHarness(t, mode) {
	const h = await setup(t), exec = h.pi.exec;
	fastTimers(t);
	h.pi.exec = async (cmd, args, opts) => {
		const result = await exec(cmd, args, opts);
		if (args[0] === "respawn-pane") {
			if (mode === "transport-error") return { code: 1, killed: false, stdout: "", stderr: "Socket closed before reply" };
			if (mode === "exception") throw new Error("Socket closed before reply");
			if (mode === "bound") {
				const command = effectiveCommand(args[args.indexOf("--command") + 1]);
				const seed = decodeBootstrap(command.match(/PI_CMUX_ORIENTATION='([^']+)'/)[1]);
				h.store.write(CHILD, binding(seed));
			}
		}
		return result;
	};
	cmuxStart(h.pi);
	h.invoke = () => h.tools.get("cmux_start_pi").execute("startup-test", { placement: "workspace", prompt: "Private task contents", related: true }, undefined, undefined, h.ctx);
	return h;
}

test("parent receives startup evidence rather than a command-dispatch success claim", async t => {
	const h = await launchHarness(t, "bound"), result = await h.invoke();
	assert.equal(result.details.startup.state, "bound");
	assert.match(result.content[0].text, /Exact child Pi binding observed/);
	assert.match(result.content[0].text, /task readiness and completion are not confirmed/);
	assert.equal(h.notifications.length, 0);
});

test("parent is warned when the exact child never binds; model result remains unconfirmed", async t => {
	const h = await launchHarness(t, "unconfirmed"), result = await h.invoke();
	assert.equal(result.details.startup.state, "unconfirmed");
	assert.match(result.content[0].text, /Pi startup is unconfirmed/);
	assert.doesNotMatch(result.content[0].text, /Started a/);
	assert.equal(h.notifications.at(-1)[1], "warning");
	assert.equal(h.calls.filter(c => c.args.includes("create")).length, 1);
	assert.equal(h.calls.filter(c => c.args[0] === "respawn-pane").length, 1);
	assert.equal(h.calls.some(c => c.args.includes("send") || c.args.includes("close-workspace")), false);
});

for (const mode of ["transport-error", "exception"]) test(`parent receives created targets on ${mode}, without command contents or replay`, async t => {
	const h = await launchHarness(t, mode);
	await assert.rejects(h.invoke(), /Created cmux surface surface:2 in workspace:2.*dispatch was not confirmed.*Socket closed before reply/);
	const [warning, level] = h.notifications.at(-1);
	assert.equal(level, "error");
	assert.match(warning, /surface:2.*workspace:2/);
	assert.match(warning, /Do not relaunch automatically/i);
	assert.doesNotMatch(warning, /Private task contents/);
	assert.equal(h.calls.filter(c => c.args.includes("create")).length, 1);
	assert.equal(h.calls.filter(c => c.args[0] === "respawn-pane").length, 1);
});

test("parent shutdown stops verification without late UI notification or child cleanup", async t => {
	const h = await launchHarness(t, "unconfirmed"), exec = h.pi.exec;
	let dispatched = false;
	h.pi.exec = async (...args) => {
		const result = await exec(...args);
		if (args[1][0] === "respawn-pane") dispatched = true;
		return result;
	};
	fastTimers(t, () => { if (dispatched) h.runtime.stop(); });
	const result = await h.invoke();
	assert.equal(result.details.startup.state, "unconfirmed");
	assert.match(result.details.startup.reason, /already dispatched.*Parent Pi session changed/);
	assert.equal(h.notifications.length, 0);
	assert.equal(h.calls.some(c => c.args.includes("close-workspace")), false);
});

test("a parent session change during verification never notifies its replacement", async t => {
	const h = await launchHarness(t, "unconfirmed"), exec = h.pi.exec;
	let dispatched = false;
	h.pi.exec = async (...args) => {
		const result = await exec(...args);
		if (args[1][0] === "respawn-pane") dispatched = true;
		return result;
	};
	fastTimers(t, () => {
		if (dispatched) h.ctx.sessionManager = SessionManager.inMemory(h.root);
	});
	const result = await h.invoke();
	assert.equal(result.details.startup.state, "unconfirmed");
	assert.match(result.details.startup.reason, /Parent Pi session changed during startup verification/);
	assert.equal(h.notifications.length, 0);
});
