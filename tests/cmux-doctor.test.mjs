import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doctor, { collectDoctorReport, formatDoctorReport, REQUIRED_DOCTOR_METHODS } from "../extensions/cmux-doctor.ts";
import { resolvePanelSettings } from "../lib/panel-settings.ts";
import { renderInstalledPanel } from "../lib/panel-install.mjs";

const workspace = "11111111-1111-4111-8111-111111111111";
const surface = "22222222-2222-4222-8222-222222222222";
const windowId = "33333333-3333-4333-8333-333333333333";
const pane = "44444444-4444-4444-8444-444444444444";
// Independent native-advertisement fixture: do not derive expected coverage
// from the implementation inventory, or omitted workflow dependencies pass.
const caps = () => ({ protocol: "cmux-socket", version: 2, methods: [
  "system.identify", "workspace.list", "workspace.create", "workspace.rename", "workspace.select",
  "pane.list", "surface.list", "surface.create", "surface.split", "surface.respawn", "surface.focus", "tab.action",
  "pane.create", "browser.eval", "browser.design_mode.status", "agent.message.send", "agent.message.list", "agent.message.settings",
  "extension.sidebar.snapshot", "system.tree", "notification.create", "surface.trigger_flash",
], capabilities: ["events.v1"], access_mode: "full", socket_path: "/fixture/cmux.sock" });
const success = value => ({ code: 0, killed: false, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "cmdoctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), cwd = join(root, "project"), sidebarDir = join(root, "sidebars");
  for (const dir of [agentDir, join(cwd, ".pi"), sidebarDir]) mkdirSync(dir, { recursive: true });
  return { root, cwd, agentDir, sidebarDir, env: { CMUX_WORKSPACE_ID: workspace, CMUX_SURFACE_ID: surface } };
}
function fakePi(capabilityResult = success(caps()), locality = { enabled: false }, calls = []) {
  return { exec: async (cmd, args, options) => {
    calls.push(args);
    assert.equal(cmd, "cmux");
    assert.equal(options.timeout, 5000);
    if (args.includes("system.capabilities")) {
      if (capabilityResult instanceof Error) throw capabilityResult;
      return capabilityResult;
    }
    if (args.includes("--version")) return success("cmux fixture");
    if (args.includes("identify")) return success({ caller: { window_id: windowId, workspace_id: workspace, pane_id: pane, surface_id: surface, workspace_ref: "workspace:1", surface_ref: "surface:1" } });
    if (args.includes("workspace.list")) return success({ workspaces: [{ id: workspace, remote: locality }] });
    if (args.join(" ") === "sidebar templates --json") return success({ templates: [] });
    assert.fail(`Unexpected/non-read-only command: ${args.join(" ")}`);
  } };
}
function snapshot(path) {
  return Object.fromEntries(readdirSync(path, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const file = join(entry.parentPath ?? entry.path, entry.name);
    return [file, readFileSync(file, "utf8")];
  }));
}

test("registration is command-only and does not probe", () => {
  const names = [];
  doctor({ registerCommand: (name, spec) => { names.push(name); assert.equal(typeof spec.handler, "function"); }, exec: () => assert.fail("registration probe"), on: () => assert.fail("event"), registerTool: () => assert.fail("tool") });
  assert.deepEqual(names, ["cmdoctor"]);
});

test("read-only report, native capabilities, caller and default settings", async t => {
  const options = fixture(t);
  writeFileSync(join(options.sidebarDir, "agent-state-panel.js"), renderInstalledPanel());
  const before = snapshot(options.root), calls = [];
  const report = await collectDoctorReport(fakePi(undefined, undefined, calls), options.cwd, options);
  assert.deepEqual(snapshot(options.root), before);
  assert.equal(report.autoOpen.autoOpen, false);
  assert.equal(report.autoOpen.source, "default");
  for (const title of ["Capability query", "Caller/locality", "Installed panel"]) assert.equal(report.checks.find(check => check.title === title)?.status, "ok");
  assert.equal(report.checks.find(check => check.title === "Custom sidebar availability")?.status, "unverified");
  assert.ok(calls.some(args => args.includes("system.capabilities")));
  assert.ok(!calls.some(args => args.includes("right-sidebar")));
  assert.match(formatDoctorReport(report), /default false/);
});

for (const [name, result, expected] of [
  ["socket/auth failure", { code: 1, killed: false, stdout: "", stderr: "socket authentication denied" }, /socket authentication denied/],
  ["timeout", { code: 0, killed: true, stdout: "partial", stderr: "" }, /killed=true/],
  ["ambiguous successful exit", { ...success(caps()), stderr: "socket authentication failed" }, /socket authentication failed/],
  ["executable missing", new Error("spawn cmux ENOENT"), /ENOENT/],
  ["malformed", success("{bad"), /Capability query response/],
  ["unexpected", success({ methods: [] }), /Unexpected system.capabilities shape/],
  ["invalid method entries", success({ ...caps(), methods: [3] }), /Unexpected system.capabilities shape/],
]) test(`visible capability error: ${name}`, async t => {
  const options = fixture(t);
  const report = await collectDoctorReport(fakePi(result), options.cwd, options);
  assert.match(formatDoctorReport(report), expected);
  assert.ok(report.checks.some(check => check.status === "error" && check.remediation));
  assert.ok(report.checks.filter(check => check.title.startsWith("Required RPC:")).every(check => check.status === "unverified"));
});

test("RPC requirements use package messaging methods and real sidebar advertisements", () => {
  assert.deepEqual(REQUIRED_DOCTOR_METHODS.Messaging, ["agent.message.send", "agent.message.list", "agent.message.settings"]);
  assert.deepEqual(REQUIRED_DOCTOR_METHODS["Sidebar data"], ["extension.sidebar.snapshot"]);
  assert.ok(!Object.values(REQUIRED_DOCTOR_METHODS).flat().some(method => method.startsWith("sidebar.set_") || method === "surface.rename"));
});

test("active and optional workflow dependencies each have independent coverage or an explicit limitation", async t => {
  const options = fixture(t), calls = [];
  const report = await collectDoctorReport(fakePi(undefined, undefined, calls), options.cwd, options);
  for (const title of ["Required RPC: Layout/navigation", "Required RPC: Notifications (opt-in)",
    "Required RPC: Sidebar flash (optional)", "Required capability: Browser annotation event stream"]) {
    assert.equal(report.checks.find(check => check.title === title)?.status, "ok", title);
  }
  const sidebar = report.checks.find(check => check.title === "CLI support: Sidebar status/progress/log");
  assert.equal(sidebar?.status, "unverified");
  for (const command of ["set-status", "clear-status", "log", "set-progress", "clear-progress"]) assert.ok(sidebar.detail.includes(command), command);
  assert.match(sidebar.detail, /not.*advertis|not.*establish|unverified/i);
  assert.deepEqual(calls.map(args => args[0]), ["--version", "--json", "--json", "--json", "sidebar"], "no mutating capability probes");
});

for (const [missing, title] of [
  ["system.tree", "Required RPC: Layout/navigation"],
  ["notification.create", "Required RPC: Notifications (opt-in)"],
  ["surface.trigger_flash", "Required RPC: Sidebar flash (optional)"],
  ["events.v1", "Required capability: Browser annotation event stream"],
]) test(`missing workflow advertisement ${missing} is visibly flagged`, async t => {
  const options = fixture(t), response = caps();
  response.methods = response.methods.filter(method => method !== missing);
  response.capabilities = response.capabilities.filter(capability => capability !== missing);
  const report = await collectDoctorReport(fakePi(success(response)), options.cwd, options);
  const check = report.checks.find(check => check.title === title);
  assert.equal(check?.status, "error");
  assert.ok(check.detail.includes(missing));
  assert.ok(check.remediation);
});

test("missing RPC groups are errors, not successful behavior checks", async t => {
  const options = fixture(t);
  const report = await collectDoctorReport(fakePi(success({ ...caps(), methods: ["system.identify"] })), options.cwd, options);
  for (const check of report.checks.filter(check => check.title.startsWith("Required RPC:"))) {
    assert.equal(check.status, "error");
    assert.match(check.detail, /Missing\/unsupported/);
  }
});

test("remote and absent/mismatched caller are unverified", async t => {
  const options = fixture(t);
  for (const [env, remote] of [[{}, { enabled: false }], [options.env, { enabled: true }], [{ ...options.env, CMUX_SURFACE_ID: pane }, { enabled: false }]]) {
    const report = await collectDoctorReport(fakePi(undefined, remote), options.cwd, { ...options, env });
    assert.equal(report.checks.find(check => check.title === "Caller/locality")?.status, "unverified");
  }
});

test("settings strict precedence and fail-closed errors use only fixture directories", t => {
  const options = fixture(t);
  const global = join(options.agentDir, "settings.json"), project = join(options.cwd, ".pi", "settings.json");
  const setting = autoOpen => JSON.stringify({ "pi-cmux": { panel: { autoOpen } } });
  assert.equal(resolvePanelSettings(options.cwd, options).source, "default");
  writeFileSync(global, setting(true));
  assert.equal(resolvePanelSettings(options.cwd, options).source, "global");
  writeFileSync(project, setting(false));
  assert.deepEqual([resolvePanelSettings(options.cwd, options).autoOpen, resolvePanelSettings(options.cwd, options).source], [false, "project"]);
  writeFileSync(project, setting("true"));
  assert.equal(resolvePanelSettings(options.cwd, options).source, "invalid");
  writeFileSync(global, "invalid json");
  writeFileSync(project, setting(true));
  const invalid = resolvePanelSettings(options.cwd, options);
  assert.equal(invalid.autoOpen, false);
  assert.equal(invalid.errors[0].path, global);
});

test("bundle outside cmux exposes only doctor, with no tools or events", async () => {
  const { default: bundle } = await import("../extensions/index.ts");
  const saved = process.env.CMUX_SURFACE_ID;
  delete process.env.CMUX_SURFACE_ID;
  try {
    const commands = [];
    await bundle({ registerCommand: name => commands.push(name), registerTool: () => assert.fail("unrelated tool"), on: () => assert.fail("unrelated event"), exec: () => assert.fail("no caller probe without env") });
    assert.deepEqual(commands, ["cmdoctor"]);
  } finally {
    if (saved === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = saved;
  }
});

test("bundle failed verified-caller guard exposes only doctor", async () => {
  const { default: bundle } = await import("../extensions/index.ts");
  const saved = process.env.CMUX_SURFACE_ID;
  process.env.CMUX_SURFACE_ID = surface;
  try {
    const commands = [];
    await bundle({ registerCommand: name => commands.push(name), registerTool: () => assert.fail("unrelated tool"), on: () => assert.fail("unrelated event"), exec: async () => success({ caller: { surface_id: pane } }) });
    assert.deepEqual(commands, ["cmdoctor"]);
  } finally {
    if (saved === undefined) delete process.env.CMUX_SURFACE_ID;
    else process.env.CMUX_SURFACE_ID = saved;
  }
});

test("modified panel is inspected without executing JavaScript", async t => {
  const options = fixture(t);
  const content = "throw new Error('must never execute');";
  writeFileSync(join(options.sidebarDir, "agent-state-panel.js"), content);
  const report = await collectDoctorReport(fakePi(), options.cwd, options);
  assert.match(report.checks.find(check => check.title === "Installed panel").detail, /modified/);
  assert.equal(readFileSync(join(options.sidebarDir, "agent-state-panel.js"), "utf8"), content);
});
