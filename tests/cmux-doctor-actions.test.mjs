import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, renameSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hideDoctorPanel, installDoctorPanel, openDoctorPanel } from "../lib/doctor/actions.ts";
import { renderInstalledPanel, inspectInstalledPanel, installSidebar, sha256 } from "../lib/panel-install.mjs";

const caller = Object.freeze({ window_id: "33333333-3333-4333-8333-333333333333", workspace_id: "11111111-1111-4111-8111-111111111111", pane_id: "44444444-4444-4444-8444-444444444444", surface_id: "22222222-2222-4222-8222-222222222222", workspace_ref: "workspace:1", surface_ref: "surface:1" });
function fixture(t) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "doctor-actions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sidebarDir = join(root, "sidebars"), target = join(sidebarDir, "agent-state-panel.js");
  const options = { sidebarDir, env: { CMUX_WORKSPACE_ID: caller.workspace_id, CMUX_SURFACE_ID: caller.surface_id }, check() {}, confirm: async () => true,
    identify: async () => ({ ok: true, caller: { ...caller } }), assertLocal: async () => {} };
  return { root, sidebarDir, target, options, seed(content = "user changes") { mkdirSync(sidebarDir, { recursive: true }); writeFileSync(target, content); } };
}

test("missing target cancellation creates no directories; prompt explains intent", async t => {
  const f = fixture(t);
  f.options.confirm = async (title, text) => { assert.match(title, /Install/); assert.ok(text.includes(f.target)); assert.match(text, /sha256=\(missing\)/); assert.match(text, /modified=false/); assert.match(text, /only after confirmation/); return false; };
  assert.match(await installDoctorPanel(f.options), /Cancelled/);
  assert.deepEqual(readdirSync(f.root), []);
});

test("confirmed creation uses bundled managed content, never opens", async t => {
  const f = fixture(t);
  await installDoctorPanel(f.options);
  assert.equal(readFileSync(f.target, "utf8"), renderInstalledPanel());
  assert.deepEqual(readdirSync(f.sidebarDir), ["agent-state-panel.js"]);
});

test("modified replacement explicitly confirms hash/state and preserves exact backup", async t => {
  const f = fixture(t); f.seed();
  f.options.confirm = async (_, text) => { assert.match(text, /modified=true/); assert.ok(text.includes(sha256("user changes"))); assert.match(text, /backup/); return true; };
  const status = await installDoctorPanel(f.options);
  assert.match(status, /Backup:/);
  const backup = readdirSync(f.sidebarDir).find(name => name.startsWith("agent-state-panel.js.backup-"));
  assert.equal(readFileSync(join(f.sidebarDir, backup), "utf8"), "user changes");
  assert.equal(readFileSync(f.target, "utf8"), renderInstalledPanel());
});

test("inspection hashes raw bytes and explicit byte-hash replacement preserves damaged legacy content", t => {
  const f = fixture(t), bytes = Buffer.from([0x2f, 0x2f, 0x80, 0x0a]); f.seed(bytes);
  const rawHash = createHash("sha256").update(bytes).digest("hex");
  assert.equal(inspectInstalledPanel(f.target).hash, rawHash);
  const result = installSidebar(f.target, renderInstalledPanel(), rawHash);
  assert.deepEqual(readFileSync(result.backup), bytes);
});

test("changed invalid-UTF8 bytes are refused during confirmation without writing a backup", async t => {
  const f = fixture(t), before = Buffer.from([0x2f, 0x2f, 0x80, 0x0a]), after = Buffer.from([0x2f, 0x2f, 0x81, 0x0a]);
  f.seed(before);
  assert.equal(before.toString("utf8"), after.toString("utf8"), "decoded text alone cannot distinguish these files");
  f.options.confirm = async () => { writeFileSync(f.target, after); return true; };
  await assert.rejects(installDoctorPanel(f.options), /changed/);
  assert.deepEqual(readFileSync(f.target), after);
  assert.deepEqual(readdirSync(f.sidebarDir), ["agent-state-panel.js"]);
});

for (const mode of [0o400, 0o640, 0o755]) test(`approved replacement preserves target and backup mode ${mode.toString(8)} despite umask`, async t => {
  const f = fixture(t); f.seed(); chmodSync(f.target, mode);
  const oldUmask = process.umask(0o077);
  try { await installDoctorPanel(f.options); }
  finally { process.umask(oldUmask); }
  const backup = readdirSync(f.sidebarDir).find(name => name.includes(".backup-"));
  assert.equal(statSync(f.target).mode & 0o7777, mode);
  assert.equal(statSync(join(f.sidebarDir, backup)).mode & 0o7777, mode);
});

test("a permission change while confirming refuses replacement", async t => {
  const f = fixture(t); f.seed(); chmodSync(f.target, 0o600);
  f.options.confirm = async () => { chmodSync(f.target, 0o400); return true; };
  await assert.rejects(installDoctorPanel(f.options), /changed/);
  assert.equal(readFileSync(f.target, "utf8"), "user changes");
  assert.deepEqual(readdirSync(f.sidebarDir), ["agent-state-panel.js"]);
});

test("fresh installation remains private", async t => {
  const f = fixture(t); await installDoctorPanel(f.options);
  assert.equal(statSync(f.target).mode & 0o777, 0o600);
});

test("cancelled modified replacement leaves content unchanged", async t => {
  const f = fixture(t); f.seed(); f.options.confirm = async () => false;
  await installDoctorPanel(f.options);
  assert.equal(readFileSync(f.target, "utf8"), "user changes");
  assert.equal(readdirSync(f.sidebarDir).length, 1);
});

for (const mutation of ["content", "missing-created", "same-content-new-inode", "ancestor"]) test(`stale ${mutation} is refused after confirmation`, async t => {
  const f = fixture(t);
  if (mutation !== "missing-created") f.seed();
  f.options.confirm = async () => {
    if (mutation === "content") writeFileSync(f.target, "new user changes");
    if (mutation === "missing-created") f.seed("concurrent creation");
    if (mutation === "same-content-new-inode") { const other = f.target + ".other"; writeFileSync(other, "user changes"); renameSync(other, f.target); }
    if (mutation === "ancestor") { unlinkSync(f.target); rmSync(f.sidebarDir, { recursive: true }); symlinkSync(f.root, f.sidebarDir); }
    return true;
  };
  await assert.rejects(installDoctorPanel(f.options), /changed|symlink/);
  assert.ok(!readdirSync(f.root, { recursive: true }).some(name => name.includes("backup-")));
});

for (const kind of ["symlink", "directory"]) test(`reject ${kind} target without prompting`, async t => {
  const f = fixture(t); mkdirSync(f.sidebarDir);
  if (kind === "symlink") { writeFileSync(join(f.root, "other"), "unrelated"); symlinkSync(join(f.root, "other"), f.target); }
  else mkdirSync(f.target);
  f.options.confirm = async () => assert.fail("must not prompt");
  await assert.rejects(installDoctorPanel(f.options), /symlink|non-file/);
});

test("temporary collision never deletes unrelated file or replaces target", async t => {
  const f = fixture(t); f.seed();
  const collision = f.target + ".tmp-" + process.pid; writeFileSync(collision, "unrelated");
  await assert.rejects(installDoctorPanel(f.options), /EEXIST/);
  assert.equal(readFileSync(collision, "utf8"), "unrelated");
  assert.equal(readFileSync(f.target, "utf8"), "user changes");
});

test("backup collision is exclusive and preserves all existing content", async t => {
  const f = fixture(t); f.seed();
  const original = Date.now; Date.now = () => 123456;
  try {
    const backup = f.target + ".backup-123456"; writeFileSync(backup, "unrelated backup");
    await assert.rejects(installDoctorPanel(f.options), /EEXIST/);
    assert.equal(readFileSync(backup, "utf8"), "unrelated backup");
    assert.equal(readFileSync(f.target, "utf8"), "user changes");
  } finally { Date.now = original; }
});

test("session guard after confirmation prevents creation", async t => {
  const f = fixture(t); let stale = false;
  f.options.confirm = async () => { stale = true; return true; };
  f.options.check = () => { if (stale) throw new Error("session changed"); };
  await assert.rejects(installDoctorPanel(f.options), /session changed/);
  assert.deepEqual(readdirSync(f.root), []);
});

test("open dispatches exactly once to original UUID window/workspace with no focus", async t => {
  const f = fixture(t); f.seed(renderInstalledPanel()); const calls = [];
  const pi = { exec: async (...args) => { calls.push(args); return { code: 0, killed: false, stdout: "ok", stderr: "" }; } };
  await openDoctorPanel(pi, caller, f.options);
  assert.deepEqual(calls, [["cmux", ["right-sidebar", "set", "custom", "agent-state-panel", "--workspace", caller.workspace_id, "--window", caller.window_id, "--no-focus"], { timeout: 5000 }]]);
});

test("hide dispatches once to the original window without requiring an installed panel", async t => {
  const f = fixture(t), calls = [];
  const pi = { exec: async (...args) => { calls.push(args); return { code: 0, killed: false, stdout: "ok", stderr: "" }; } };
  assert.match(await hideDoctorPanel(pi, caller, f.options), /hide requested/);
  assert.deepEqual(calls, [["cmux", ["right-sidebar", "hide", "--workspace", caller.workspace_id, "--window", caller.window_id], { timeout: 5000 }]]);
  assert.deepEqual(readdirSync(f.root), []);
});

for (const reason of ["absent", "missing-window", "env", "window-env", "pane-env", "stale-window", "remote", "unknown", "missing-panel", "symlink", "session", "env-after-await"]) test(`open refuses ${reason}, never guesses/focuses`, async t => {
  const f = fixture(t); f.seed(renderInstalledPanel()); let initial = caller;
  if (reason === "absent") initial = undefined;
  if (reason === "missing-window") initial = { ...caller, window_id: undefined };
  if (reason === "env") f.options.env.CMUX_SURFACE_ID = caller.pane_id;
  if (reason === "window-env") f.options.env.CMUX_WINDOW_ID = caller.pane_id;
  if (reason === "pane-env") f.options.env.CMUX_PANE_ID = caller.window_id;
  if (reason === "stale-window") f.options.identify = async () => ({ ok: true, caller: { ...caller, window_id: caller.pane_id } });
  if (reason === "remote" || reason === "unknown") f.options.assertLocal = async () => { throw new Error("Remote/unverified placement"); };
  if (reason === "missing-panel") unlinkSync(f.target);
  if (reason === "symlink") { unlinkSync(f.target); symlinkSync(join(f.root, "absent"), f.target); }
  if (reason === "session") { let stale = false; f.options.assertLocal = async () => { stale = true; }; f.options.check = () => { if (stale) throw new Error("session changed"); }; }
  if (reason === "env-after-await") f.options.assertLocal = async () => { f.options.env.CMUX_SURFACE_ID = caller.pane_id; };
  await assert.rejects(openDoctorPanel({ exec: () => assert.fail("effect refused") }, initial, f.options));
  if (!["missing-panel", "symlink"].includes(reason)) {
    await assert.rejects(hideDoctorPanel({ exec: () => assert.fail("hide refused") }, initial, f.options));
  }
});

for (const action of [openDoctorPanel, hideDoctorPanel]) test(`${action.name} reidentifies after awaiting locality and refuses a moved caller`, async t => {
  const f = fixture(t); f.seed(renderInstalledPanel()); let changed = false;
  f.options.assertLocal = async () => { changed = true; };
  f.options.identify = async () => ({ ok: true, caller: { ...caller, window_id: changed ? caller.pane_id : caller.window_id } });
  await assert.rejects(action({ exec: () => assert.fail("stale caller must not dispatch") }, caller, f.options), /changed during locality/);
});

for (const action of [openDoctorPanel, hideDoctorPanel]) for (const outcome of ["timeout", "throw", "stderr", "session-change"]) test(`uncertain ${outcome} never repeats ${action.name}`, async t => {
  const f = fixture(t); f.seed(renderInstalledPanel()); let calls = 0, stale = false;
  f.options.check = () => { if (stale) throw new Error("session changed"); };
  await assert.rejects(action({ exec: async () => {
    calls++;
    if (outcome === "throw") throw new Error("lost response");
    if (outcome === "session-change") stale = true;
    return { code: 0, killed: outcome === "timeout", stdout: "", stderr: outcome === "stderr" ? "ambiguous error" : "" };
  } }, caller, f.options), /uncertain; not retried/);
  assert.equal(calls, 1);
});
