import assert from "node:assert/strict";
import { setImmediate as waitForImmediate } from "node:timers/promises";
import { test } from "node:test";
import cmuxNotifyExtension from "../extensions/cmux-notify.ts";
import cmuxSidebarExtension from "../extensions/cmux-sidebar.ts";

function createHarness(extension) {
	const handlers = new Map();
	const execCalls = [];
	const pi = {
		on(eventName, handler) {
			const eventHandlers = handlers.get(eventName) ?? [];
			eventHandlers.push(handler);
			handlers.set(eventName, eventHandlers);
		},
		async exec(command, args, options) {
			execCalls.push({ command, args, options });
			return { stdout: "", stderr: "", code: 0, killed: false };
		},
	};

	extension(pi);

	return {
		execCalls,
		async emit(eventName, event = {}, ctx = createContext()) {
			for (const handler of handlers.get(eventName) ?? []) {
				await handler(event, ctx);
			}
		},
	};
}

function createContext(idle = true, mode = "tui") {
	return {
		mode,
		isIdle: () => idle,
		sessionManager: {
			getBranch: () => [],
		},
	};
}

async function withEnvironment(overrides, callback) {
	const previous = new Map();
	for (const [name, value] of Object.entries({
		PI_CMUX_NOTIFY_FORCE: undefined,
		CMUX_SURFACE_ID: undefined,
		CMUX_PANEL_ID: undefined,
		...overrides,
	})) {
		previous.set(name, process.env[name]);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}

	try {
		return await callback();
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

function assistantMessage(stopReason, text, usage) {
	return {
		role: "assistant",
		stopReason,
		content: [{ type: "text", text }],
		usage,
	};
}

function editResult(path) {
	return {
		type: "tool_result",
		toolName: "edit",
		input: { path, edits: [] },
		content: [{ type: "text", text: "Updated" }],
		details: {},
		isError: false,
	};
}

function cmuxCalls(calls, subcommand) {
	return calls.filter((call) => call.command === "cmux" && call.args[0] === subcommand);
}

for (const [level, expectedSubtitles] of [
	[undefined, []],
	["", []],
	["   ", []],
	["invalid", []],
	["disabled", []],
	["all", ["Waiting", "Task Complete", "Error", "Error"]],
	[" ALL ", ["Waiting", "Task Complete", "Error", "Error"]],
	["medium", ["Task Complete", "Error", "Error"]],
	["low", ["Error", "Error"]],
]) {
	test(`notification level ${JSON.stringify(level) ?? "unset"} respects opt-in and filtering`, async () => {
		await withEnvironment(
			{
				PI_CMUX_NOTIFY_LEVEL: level,
				CMUX_SURFACE_ID: "test-surface",
				PI_CMUX_NOTIFY_DEBOUNCE_MS: "0",
				PI_CMUX_NOTIFY_THRESHOLD_MS: "999999",
			},
			async () => {
				const harness = createHarness(cmuxNotifyExtension);
				for (const [stopReason, changedFile] of [
					["stop", false],
					["stop", true],
					["error", false],
					["aborted", false],
				]) {
					await harness.emit("agent_start");
					if (changedFile) await harness.emit("tool_result", editResult("/repo/changed.ts"));
					await harness.emit("agent_end", { messages: [assistantMessage(stopReason, "Result")] });
					await harness.emit("agent_settled");
				}
				const subtitles = cmuxCalls(harness.execCalls, "notify").map(({ args }) => args[args.indexOf("--subtitle") + 1]);
				assert.deepEqual(subtitles, expectedSubtitles);
			},
		);
	});
}

test("notifications wait for idle settlement and use the final low-level result", async () => {
	await withEnvironment(
		{
			PI_CMUX_NOTIFY_DEBOUNCE_MS: "0",
			PI_CMUX_NOTIFY_INCLUDE_RESPONSE: "1",
			PI_CMUX_NOTIFY_LEVEL: "all",
			PI_CMUX_NOTIFY_THRESHOLD_MS: "999999",
			CMUX_SURFACE_ID: "test-surface",
		},
		async () => {
			const harness = createHarness(cmuxNotifyExtension);
			const failed = assistantMessage("error", "temporary provider failure");
			const succeeded = assistantMessage("stop", "Final response");

			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("tool_result", editResult("/repo/retry.ts"));
			await harness.emit("agent_end", { type: "agent_end", messages: [failed] });
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 0);

			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
			await harness.emit("agent_settled", { type: "agent_settled" }, createContext(false));
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 0);

			await harness.emit("agent_settled", { type: "agent_settled" });
			const notifications = cmuxCalls(harness.execCalls, "notify");
			assert.equal(notifications.length, 1);
			assert.deepEqual(notifications[0].args, [
				"notify",
				"--title",
				"Pi",
				"--subtitle",
				"Task Complete",
				"--body",
				"Updated retry.ts\nFinal response",
			]);

			await harness.emit("agent_settled", { type: "agent_settled" });
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 1);
		},
	);
});

test("notifications stay silent outside cmux surfaces", async () => {
	await withEnvironment(
		{
			PI_CMUX_NOTIFY_DEBOUNCE_MS: "0",
			PI_CMUX_NOTIFY_LEVEL: "all",
			CMUX_SURFACE_ID: undefined,
			CMUX_PANEL_ID: undefined,
		},
		async () => {
			const harness = createHarness(cmuxNotifyExtension);
			const succeeded = assistantMessage("stop", "Done");

			// Headless/embedded modes (SDK, --print, JSON, RPC) stay silent.
			for (const mode of ["print", "json", "rpc", "sdk"]) {
				await harness.emit("agent_start", { type: "agent_start" }, createContext(true, mode));
				await harness.emit("tool_result", editResult("/repo/headless.ts"), createContext(true, mode));
				await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
				await harness.emit("agent_settled", { type: "agent_settled" }, createContext(true, mode));
				assert.equal(cmuxCalls(harness.execCalls, "notify").length, 0, `mode=${mode} should not notify`);
			}

			// Interactive TUI in a terminal outside cmux (no surface/panel env) stays silent too.
			await harness.emit("agent_start", { type: "agent_start" }, createContext(true, "tui"));
			await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
			await harness.emit("agent_settled", { type: "agent_settled" }, createContext(true, "tui"));
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 0);
		},
	);
});

test("PI_CMUX_NOTIFY_FORCE restores notifications outside cmux surfaces", async () => {
	await withEnvironment(
		{
			PI_CMUX_NOTIFY_DEBOUNCE_MS: "0",
			PI_CMUX_NOTIFY_LEVEL: "all",
			PI_CMUX_NOTIFY_FORCE: "1",
			CMUX_SURFACE_ID: undefined,
			CMUX_PANEL_ID: undefined,
		},
		async () => {
			const harness = createHarness(cmuxNotifyExtension);
			const succeeded = assistantMessage("stop", "Done");

			await harness.emit("agent_start", { type: "agent_start" }, createContext(true, "print"));
			await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
			await harness.emit("agent_settled", { type: "agent_settled" }, createContext(true, "print"));
			assert.equal(cmuxCalls(harness.execCalls, "notify").length, 1);
		},
	);
});

for (const mode of ["tui", "print", "json", "rpc", "sdk"]) {
	for (const source of ["CMUX_SURFACE_ID", "CMUX_PANEL_ID"]) {
		test(`${mode} notifications with inherited ${source}`, async () => {
			await withEnvironment({ [source]: "test-surface", PI_CMUX_NOTIFY_LEVEL: "all" }, async () => {
				const h = createHarness(cmuxNotifyExtension);
				const ctx = createContext(true, mode);
				await h.emit("agent_start", {}, ctx);
				await h.emit("tool_result", editResult("/repo/result.ts"), ctx);
				await h.emit("agent_end", { messages: [assistantMessage("stop", "Done")] }, ctx);
				await h.emit("agent_settled", {}, ctx);
				const notifications = cmuxCalls(h.execCalls, "notify");
				assert.equal(notifications.length, mode === "tui" ? 1 : 0);
				if (mode === "tui") assert.equal(notifications[0].args.at(-1), "Updated result.ts");
			});
		});
	}
}

for (const [level, expected] of [[undefined, 0], ["disabled", 0], ["all", 1], ["low", 0]]) {
	test(`force preserves notification level ${String(level)}`, async () => {
		await withEnvironment({ PI_CMUX_NOTIFY_FORCE: "1", PI_CMUX_NOTIFY_LEVEL: level }, async () => {
			const h = createHarness(cmuxNotifyExtension);
			const ctx = createContext(true, "rpc");
			await h.emit("agent_start", {}, ctx);
			await h.emit("agent_end", { messages: [assistantMessage("stop", "Done")] }, ctx);
			await h.emit("agent_settled", {}, ctx);
			assert.equal(cmuxCalls(h.execCalls, "notify").length, expected);
		});
	});
}

test("blank cmux surface identifiers do not enable notifications", async () => {
	await withEnvironment({ CMUX_SURFACE_ID: " ", CMUX_PANEL_ID: "\t", PI_CMUX_NOTIFY_LEVEL: "all" }, async () => {
		const h = createHarness(cmuxNotifyExtension);
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistantMessage("stop", "Done")] });
		await h.emit("agent_settled");
		assert.equal(cmuxCalls(h.execCalls, "notify").length, 0);
	});
});

test("sidebar finalizes once after settlement and preserves retry activity", async () => {
	await withEnvironment(
		{
			CMUX_WORKSPACE_ID: "workspace:test",
			PI_CMUX_SIDEBAR: "1",
			PI_CMUX_SIDEBAR_FINAL_CLEAR_MS: "60000",
			PI_CMUX_SIDEBAR_STATUS_KEY: "pi-cmux-test",
			PI_CMUX_SIDEBAR_TOKENS: "1",
		},
		async () => {
			const harness = createHarness(cmuxSidebarExtension);
			const firstUsage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
			const finalUsage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
			const failed = assistantMessage("error", "temporary provider failure", firstUsage);
			const succeeded = assistantMessage("stop", "Done", finalUsage);

			await harness.emit("session_start", { type: "session_start" });
			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("tool_result", editResult("/repo/retry.ts"));
			await harness.emit("message_end", { type: "message_end", message: failed });
			await harness.emit("agent_end", { type: "agent_end", messages: [failed] });
			await waitForImmediate();

			const finalStatusValues = new Set(["Pi error", "Pi cancelled", "Pi done", "Pi waiting"]);
			const finalStatuses = () =>
				cmuxCalls(harness.execCalls, "set-status").filter((call) => finalStatusValues.has(call.args[2]));
			assert.equal(finalStatuses().length, 0);
			assert.equal(cmuxCalls(harness.execCalls, "trigger-flash").length, 0);

			await harness.emit("agent_start", { type: "agent_start" });
			await harness.emit("message_end", { type: "message_end", message: succeeded });
			await harness.emit("agent_end", { type: "agent_end", messages: [succeeded] });
			await harness.emit("agent_settled", { type: "agent_settled" }, createContext(false));
			await waitForImmediate();
			assert.equal(finalStatuses().length, 0);

			await harness.emit("agent_settled", { type: "agent_settled" });
			await waitForImmediate();
			assert.equal(finalStatuses().length, 1);
			assert.equal(finalStatuses()[0].args[2], "Pi done");
			assert.equal(cmuxCalls(harness.execCalls, "trigger-flash").length, 1);

			const finalLogs = cmuxCalls(harness.execCalls, "log").filter((call) => call.args.includes("Updated retry.ts · tok ↑13 ↓6"));
			assert.equal(finalLogs.length, 1);

			await harness.emit("agent_settled", { type: "agent_settled" });
			await waitForImmediate();
			assert.equal(finalStatuses().length, 1);
			assert.equal(cmuxCalls(harness.execCalls, "trigger-flash").length, 1);

			await harness.emit("session_shutdown", { type: "session_shutdown" });
		},
	);
});
