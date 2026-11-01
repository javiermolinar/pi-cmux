import assert from "node:assert/strict";
import { test } from "node:test";
import piCmuxExtension from "../extensions/index.ts";

const SURFACE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const caller = { window_id: OTHER, workspace_id: OTHER, pane_id: OTHER, surface_id: SURFACE };

function environment(t, values) {
	for (const [key, value] of Object.entries(values)) {
		const previous = process.env[key];
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
}

for (const [name, surface, response] of [
	["ordinary terminal", undefined],
	["empty surface", ""],
	["blank surface", " \t"],
	["non-UUID surface", "surface:1"],
	["no caller despite reachable socket", SURFACE, {}],
	["selected surface is not caller identity", SURFACE, { focused: caller }],
	["legacy reference-only caller", SURFACE, { caller: { window_ref: "window:1", workspace_ref: "workspace:1", pane_ref: "pane:1", surface_ref: "surface:1" } }],
	["different caller surface", SURFACE, { caller: { ...caller, surface_id: OTHER } }],
	["missing caller window", SURFACE, { caller: { ...caller, window_id: undefined } }],
	["missing caller workspace", SURFACE, { caller: { ...caller, workspace_id: undefined } }],
	["missing caller pane", SURFACE, { caller: { ...caller, pane_id: undefined } }],
	["invalid JSON", SURFACE, "not json"],
	["null JSON", SURFACE, null],
	["cmux unavailable", SURFACE, new Error("spawn cmux ENOENT")],
	["cmux failure", SURFACE, { code: 1, killed: false, stdout: "", stderr: "no socket" }],
	["cmux timeout", SURFACE, { code: 0, killed: true, stdout: JSON.stringify({ caller }), stderr: "" }],
]) {
	test(`bundle stays completely disabled: ${name}`, async (t) => {
		environment(t, {
			CMUX_SURFACE_ID: surface, CMUX_PANEL_ID: undefined,
			CMUX_SOCKET_PATH: "/tmp/reachable-cmux.sock", CMUX_WORKSPACE_ID: OTHER,
			PI_CMUX_NOTIFY_FORCE: "1", PI_CMUX_NOTIFY_LEVEL: "all",
		});
		t.mock.method(console, "warn", () => assert.fail("disabled bundle must not warn"));
		t.mock.method(console, "error", () => assert.fail("disabled bundle must not log errors"));
		const calls = [];
		const pi = new Proxy({}, {
			get(_target, key) {
				assert.equal(key, "exec", `disabled bundle must not access pi.${String(key)}`);
				return async (...args) => {
					calls.push(args);
					if (response instanceof Error) throw response;
					if (response?.code !== undefined) return response;
					return { code: 0, killed: false, stdout: typeof response === "string" ? response : JSON.stringify(response), stderr: "" };
				};
			},
		});
		await piCmuxExtension(pi);
		assert.equal(calls.length, surface === SURFACE ? 1 : 0);
		if (calls.length) {
			assert.deepEqual(calls[0], ["cmux", ["--json", "--id-format", "both", "identify"], { timeout: 5000 }]);
		}
	});
}
