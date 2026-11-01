import assert from "node:assert/strict";
import { test } from "node:test";
import {
	SSH_TARGET_ENTRY, matchesWorkspaceObservation, parseLocalContext, parseSshSessionRecord,
	parseSshTarget, parseWorkspaceAssociation, restoreSshTarget,
} from "../lib/ssh/target.ts";

const context = { sessionId: "session-1", localCwd: "/local/agent" };
const target = { destination: "dev-alias", remoteCwd: "/remote/project" };
const association = { workspaceId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", backend: "native-ssh" };
const record = (extra = {}) => ({ version: 1, ...context, kind: "target", target, ...extra });
const entry = (data) => ({ type: "custom", customType: SSH_TARGET_ENTRY, data });

test("target parsing preserves literal alias and POSIX cwd, separate from local context", () => {
	for (const destination of ["dev-alias", "User_2@Dev.Example.", "127.0.0.1", "::1", "user@2001:db8::1", "user@[2001:db8::1]", "_ssh-alias"]) {
		const remoteCwd = "/projects/Équipe's \"work\"/$HOME/../literal space";
		assert.deepEqual(parseSshTarget({ destination, remoteCwd }), { destination, remoteCwd });
	}
	assert.deepEqual(parseLocalContext(context), context);
	assert.equal(parseSshSessionRecord(record()).localCwd, "/local/agent");
	assert.equal(parseSshSessionRecord(record()).target.remoteCwd, "/remote/project");
});

test("strict destinations reject SSH options, credentials, URI, port/path ambiguity and shell syntax", () => {
	for (const destination of [undefined, null, 1, "", "-oProxyCommand=x", "user@-host", "-user@host", "ssh://host", "user:password@host", "host:22", "host:path", "user@@host", "@host", "host@", "host name", " host", "host\n", "host\0", "host\u0085", "höst", "host*", "host?", "host[ab]", "$(id)", "host;id", "host|id", "host&", "host`id`", "host\\x", "host/x", "host#x", "host%jump", "host!", "host'", 'host"', "[garbage:colon]", "bad::ipv6", "[::1]:22", "[127.0.0.1]", "fe80::1%en0", "a".repeat(513)]) {
		assert.throws(() => parseSshTarget({ destination, remoteCwd: "/x" }), { message: "Invalid SSH target metadata" });
	}
});

test("remote cwd is absolute literal POSIX data, never tilde/local expansion", () => {
	for (const remoteCwd of [undefined, null, 1, "", "relative", "~", "~/project", "C:\\work", "/a\n", "/a\r", "/a\0", "/a\u007f", "/a\u009f", "/" + "x".repeat(4096)]) {
		assert.throws(() => parseSshTarget({ destination: "dev", remoteCwd }));
	}
	for (const remoteCwd of ["/", "//literal", "/~/$USER/a'b;*", "/" + "x".repeat(4095)]) {
		assert.equal(parseSshTarget({ destination: "dev", remoteCwd }).remoteCwd, remoteCwd);
	}
	for (const value of [{ ...context, sessionId: "" }, { ...context, sessionId: "a\nsecret" }, { ...context, sessionId: "a".repeat(129) }, { ...context, localCwd: "relative" }, { ...context, localCwd: "/local\n" }]) {
		assert.throws(() => parseLocalContext(value));
	}
});

test("records and snapshots whitelist, clone and deeply freeze nonsecret values", () => {
	const input = record({ target: { ...target, password: "do-not-keep", options: ["-i", "private-key"] }, association: { ...association, token: "secret" }, ready: true, authorization: true });
	const parsed = parseSshSessionRecord(input);
	assert.deepEqual(parsed, { version: 1, ...context, kind: "target", target, association: { ...association, workspaceId: association.workspaceId.toLowerCase() } });
	assert.notEqual(parsed, input); assert.notEqual(parsed.target, input.target); assert.notEqual(parsed.association, input.association);
	assert.ok(Object.isFrozen(parsed)); assert.ok(Object.isFrozen(parsed.target)); assert.ok(Object.isFrozen(parsed.association));
	input.target.destination = "other"; input.association.backend = "tmux-mirror";
	assert.equal(parsed.target.destination, "dev-alias"); assert.equal(parsed.association.backend, "native-ssh");
	assert.throws(() => { parsed.target.destination = "evil"; }, TypeError);
	assert.equal(JSON.stringify(parsed).includes("secret"), false);
	assert.deepEqual(parseSshSessionRecord({ ...record(), kind: "clear", password: "secret" }), { version: 1, ...context, kind: "clear" });
});

test("runtime validation does not trust prototypes, accessors, arrays or error messages", () => {
	let read = false;
	const getter = { remoteCwd: "/remote", get destination() { read = true; throw new Error("password"); } };
	for (const value of [getter, Object.create(target), [], null, "secret", new Date()]) {
		assert.throws(() => parseSshTarget(value), { message: "Invalid SSH target metadata" });
	}
	assert.equal(read, false);
	const proxy = new Proxy({}, { getPrototypeOf() { throw new Error("credential"); } });
	assert.throws(() => parseSshTarget(proxy), { message: "Invalid SSH target metadata" });
	for (const value of [record({ version: 2 }), record({ kind: "ready" }), record({ target: undefined }), record({ association: null }), record({ association: { workspaceId: "surface:1", backend: "native-ssh" } }), record({ association: { ...association, backend: "cmux-tui" } })]) {
		assert.throws(() => parseSshSessionRecord(value));
	}
});

test("pending home resolution persists only destination intent and cannot restore an older target", () => {
	const pending = { version: 1, ...context, kind: "pending", destination: "dev-alias" };
	const parsed = parseSshSessionRecord({ ...pending, target, ready: true, remoteCwd: "~" });
	assert.deepEqual(parsed, pending); assert.ok(Object.isFrozen(parsed));
	assert.deepEqual(restoreSshTarget(context, [entry(record()), entry(pending)]), { kind: "pending" });
	assert.deepEqual(restoreSshTarget(context, [entry({ ...pending, sessionId: "foreign" })]), { kind: "invalid", reason: "foreign-session" });
	for (const destination of [undefined, "-unsafe", "user:secret@host"]) {
		assert.throws(() => parseSshSessionRecord({ ...pending, destination }));
	}
});

test("latest matching branch entry is authoritative, including clear, invalid and foreign records", () => {
	const saved = entry(record());
	assert.deepEqual(restoreSshTarget(context, []), { kind: "absent" });
	assert.deepEqual(restoreSshTarget(context, [saved]), { kind: "target", target });
	assert.deepEqual(restoreSshTarget(context, [saved, { type: "custom_message", customType: SSH_TARGET_ENTRY, data: null }, { type: "custom", customType: "other", data: null }]), { kind: "target", target });
	assert.deepEqual(restoreSshTarget(context, [saved, entry({ version: 1, ...context, kind: "clear" })]), { kind: "clear" });
	for (const bad of [null, undefined, {}, record({ version: 99 }), record({ target: { ...target, destination: "-oSecret" } })]) {
		assert.deepEqual(restoreSshTarget(context, [saved, entry(bad)]), { kind: "invalid", reason: "invalid-saved-state" });
	}
	assert.deepEqual(restoreSshTarget(context, [saved, entry(record({ sessionId: "foreign" }))]), { kind: "invalid", reason: "foreign-session" });
	assert.deepEqual(restoreSshTarget(context, [saved, entry(record({ localCwd: "/elsewhere" }))]), { kind: "invalid", reason: "local-context-mismatch" });
	assert.deepEqual(restoreSshTarget(context, [saved, entry({ version: 1, sessionId: "foreign", localCwd: context.localCwd, kind: "clear" })]), { kind: "invalid", reason: "foreign-session" });
	assert.deepEqual(restoreSshTarget(context, null), { kind: "invalid", reason: "invalid-saved-state" });
});

test("workspace evidence must pin exact UUID, backend, connected state and literal destination", () => {
	const pin = parseWorkspaceAssociation(association);
	const good = { ...association, destination: target.destination, enabled: true, transport: "ssh", connected: true };
	assert.ok(matchesWorkspaceObservation(target, pin, good));
	for (const bad of [undefined, null, {}, { ...good, enabled: false }, { ...good, enabled: undefined }, { ...good, transport: "local" }, { ...good, transport: undefined }, { ...good, connected: false }, { ...good, connected: "true" }, { ...good, workspaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, { ...good, destination: "DEV-ALIAS" }, { ...good, destination: "resolved.example" }, { ...good, backend: "legacy-relay" }, { ...good, backend: undefined }, { title: "dev-alias", status: "SSH connected", connected: true }, { ...good, workspaceId: "workspace:1" }]) {
		assert.equal(matchesWorkspaceObservation(target, pin, bad), false);
	}
});
