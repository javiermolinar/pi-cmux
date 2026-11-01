import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { openPiSession, resolvePiPlacement } from "../extensions/cmux-pi.ts";
import cmuxStart from "../extensions/cmux-start.ts";
import { conversationChildren, prepareOrientation, rememberChildConversation } from "../lib/orientation/runtime.ts";
import { BINDING_TTL_MS, childBootstrap, rootOrientation } from "../lib/orientation/state.ts";
import { orientationHarness, target } from "./helpers/orientation.mjs";

async function setup(t) {
	const h = orientationHarness(t);
	await h.emit("session_start");
	return h;
}
function remember(h, options = {}, placement = "right", surfaceId = randomUUID()) {
	const seed = prepareOrientation(h.pi, options, "Private task contents");
	rememberChildConversation(h.pi, seed, surfaceId, placement);
	return { seed, surfaceId };
}
function bind(h, child, overrides = {}) {
	const binding = { ...child.seed, sessionId: randomUUID(), token: randomUUID(), pid: process.pid,
		expiresAt: Date.now() + BINDING_TTL_MS, ...overrides };
	h.store.write(child.surfaceId, binding);
	return binding;
}

for (const [options, expected] of [
	[{}, "workspace"], [{ focus: false }, "workspace"], [{ role: "chat" }, "workspace"],
	[{ related: true }, "right"], [{ role: "review" }, "right"],
	[{ related: true, focus: false }, "tab"], [{ role: "review", focus: false }, "tab"],
	[{ role: "continue" }, "tab"],
]) test(`task-aware default ${JSON.stringify(options)} → ${expected}`, async t => {
	const h = await setup(t), before = h.calls.length;
	assert.equal(resolvePiPlacement(h.pi, options), expected);
	assert.equal(h.calls.length, before, "placement must not create, focus or scan cmux");
});

for (const placement of ["workspace", "right", "down", "tab"]) test(`explicit ${placement} always wins`, async t => {
	const h = await setup(t);
	remember(h, { related: true });
	for (const options of [{}, { role: "review" }, { role: "continue" }, { related: true, focus: false }]) {
		assert.equal(resolvePiPlacement(h.pi, { ...options, placement }), placement);
	}
});

test("remembered same-task splits put subsequent collaborators in tabs, even if startup is uncertain", async t => {
	const h = await setup(t);
	remember(h, { related: true });
	assert.equal(resolvePiPlacement(h.pi, { role: "review" }), "tab");
	assert.equal(resolvePiPlacement(h.pi, {}), "workspace");
	assert.equal(conversationChildren(h.pi)[0].binding, "unconfirmed");
});

test("background tabs, handoffs, unrelated splits and explicit workspaces do not consume the first collaborator split", async t => {
	const h = await setup(t);
	remember(h, {}, "right");
	remember(h, { related: true }, "tab");
	remember(h, { role: "continue" }, "tab");
	remember(h, { related: true }, "workspace");
	assert.equal(resolvePiPlacement(h.pi, { role: "review" }), "right");
	remember(h, { role: "review" }, "down");
	assert.equal(resolvePiPlacement(h.pi, { related: true }), "tab");
});

test("successful launches remember exact children and reuse the workspace for additional agents", async t => {
	const h = await setup(t);
	const first = await openPiSession(h.pi, h.root, { role: "review", prompt: "Review" });
	const second = await openPiSession(h.pi, h.root, { related: true, prompt: "Investigate" });
	assert.equal(first.ok, true); assert.equal(second.ok, true);
	assert.equal(first.placement, "right"); assert.equal(second.placement, "tab");
	const children = conversationChildren(h.pi);
	assert.equal(children.length, 2);
	assert.equal(children[0].conversationId, first.orientation.conversationId);
	assert.equal(children[0].parentConversationId, h.runtime.state.conversationId);
	assert.equal(children[0].parentSessionId, h.runtime.state.sessionId);
	assert.equal(children[0].surfaceId, first.created.surface_id);
	assert.equal(children[0].taskId, h.runtime.state.taskId);
	assert.equal(h.calls.some(c => c.args.includes("create")), false, "no sidebar workspace for collaborators");
});

test("child snapshots validate exact live identity and never equate a lost binding with task completion", async t => {
	const h = await setup(t), child = remember(h, { role: "review" });
	const claim = bind(h, child);
	let [snapshot] = conversationChildren(h.pi);
	assert.equal(snapshot.binding, "bound"); assert.equal(snapshot.sessionId, claim.sessionId);
	snapshot.surfaceId = randomUUID(); snapshot.binding = "unknown";
	assert.equal(conversationChildren(h.pi)[0].binding, "bound", "snapshots cannot mutate tracking");
	assert.equal(conversationChildren(h.pi)[0].surfaceId, child.surfaceId);
	h.store.remove(child.surfaceId, claim.token);
	assert.equal(conversationChildren(h.pi)[0].binding, "unknown");
	assert.equal(resolvePiPlacement(h.pi, { related: true }), "tab", "do not automatically replace uncertain children");
	bind(h, child); // Same seed but a different Pi session is not the observed child session.
	assert.equal(conversationChildren(h.pi)[0].binding, "unknown");
	bind(h, child, { sessionId: claim.sessionId });
	assert.equal(conversationChildren(h.pi)[0].binding, "bound");
});

for (const [label, overrides] of [
	["task", { taskId: randomUUID() }], ["conversation", { conversationId: randomUUID() }],
	["role", { role: "main" }], ["expired", { expiresAt: 1 }], ["dead process", { pid: 2147483647 }],
]) test(`child tracking rejects ${label} binding evidence`, async t => {
	const h = await setup(t), child = remember(h, { role: "review" });
	bind(h, child, overrides);
	const [snapshot] = conversationChildren(h.pi);
	assert.equal(snapshot.binding, "unknown"); assert.equal(snapshot.sessionId, undefined);
});

test("tracking requires exact parent ownership and exact created UUIDs, never labels", async t => {
	const h = await setup(t), seed = prepareOrientation(h.pi, { related: true }, "Review");
	for (const surface of [undefined, "surface:2", h.location.surfaceId]) rememberChildConversation(h.pi, seed, surface, "right");
	const foreign = childBootstrap(rootOrientation(randomUUID()), target(), true, "review", "Review");
	rememberChildConversation(h.pi, foreign, randomUUID(), "right");
	assert.deepEqual(conversationChildren(h.pi), []);
	const own = h.store.read(h.location.surfaceId);
	h.store.write(h.location.surfaceId, { ...own, token: randomUUID() });
	rememberChildConversation(h.pi, seed, randomUUID(), "right");
	assert.deepEqual(conversationChildren(h.pi), []);
});

test("memory is bounded, contains no prompts, and clears on session replacement without closing children", async t => {
	const h = await setup(t);
	for (let i = 0; i < 70; i++) remember(h, { related: true });
	assert.equal(conversationChildren(h.pi).length, 64);
	assert.doesNotMatch(JSON.stringify(conversationChildren(h.pi)), /Private task contents|topic|prompt/);
	const child = remember(h, { related: true }), claim = bind(h, child);
	h.ctx.sessionManager = SessionManager.inMemory(h.root);
	await h.emit("session_start");
	assert.deepEqual(conversationChildren(h.pi), []);
	assert.equal(h.store.read(child.surfaceId).token, claim.token, "parent reset leaves children alone");
	assert.equal(h.calls.some(c => c.args.includes("close-workspace") || c.args.includes("surface.close")), false);
});

test("launch results expose best-effort child relationships without claiming readiness", async t => {
	const h = await setup(t);
	t.mock.method(globalThis, "setTimeout", callback => { queueMicrotask(callback); return 0; });
	cmuxStart(h.pi);
	const result = await h.tools.get("cmux_start_pi").execute("placement-test", { role: "review", prompt: "Review only" }, undefined, undefined, h.ctx);
	assert.equal(result.details.placement, "right");
	assert.equal(result.details.children[0].binding, "unconfirmed");
	assert.equal(result.details.children[0].parentConversationId, h.runtime.state.conversationId);
	assert.equal(result.details.startup.state, "unconfirmed");
});

test("standalone launch policy works without pretending to have a cross-process task registry", () => {
	const pi = {};
	assert.equal(resolvePiPlacement(pi, {}), "workspace");
	assert.equal(resolvePiPlacement(pi, { role: "review" }), "right");
	assert.deepEqual(conversationChildren(pi), []);
});
