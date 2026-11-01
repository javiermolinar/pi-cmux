import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { panelEnvironment, preparePanelSession } from "../examples/sidebars/launch-pi.mjs";
import { installSidebar, renderSidebar, sha256 } from "../examples/sidebars/install-agent-state-panel.mjs";

const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHILD = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SURFACE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const WINDOW = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PANE = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const caller = { window_id: WINDOW, workspace_id: CHILD, surface_id: SURFACE, pane_id: PANE,
  window_ref: "window:1", workspace_ref: "workspace:2", surface_ref: "surface:2" };
const local = { enabled: false, connected: false, transport: "local" };
const environment = { CMUX_WORKSPACE_ID: CHILD, CMUX_SURFACE_ID: SURFACE };

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-cmux-panel-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = { version: 1, node: process.execPath, pi: process.execPath, cmux: process.execPath, agentDir: root };
  const request = { version: 1, sourceWorkspaceId: SOURCE, cwd: root };
  const calls = [];
  const state = { caller, rows: [{ id: SOURCE, remote: local }, { id: CHILD, remote: local }] };
  const pi = { exec: async (command, args) => {
    calls.push({ command, args });
    return { code: 0, killed: false, stderr: "", stdout: JSON.stringify(args.includes("identify")
      ? { caller: state.caller } : { workspaces: state.rows }) };
  } };
  return { root, config, request, pi, state, calls };
}

test("bootstrap reuses local-workspace guards and creates an independent bootstrap with no origin", async t => {
  const h = fixture(t);
  const prepared = await preparePanelSession(h.config, h.request, h.pi, environment);
  assert.equal(prepared.cwd, h.root);
  assert.equal(prepared.caller.surface_id, SURFACE);
  assert.equal(prepared.seed.role, "main");
  assert.equal(prepared.seed.origin, undefined);
  assert.match(prepared.seed.conversationId, /^[a-f0-9-]{36}$/);
  assert.notEqual(prepared.seed.taskId, prepared.seed.conversationId);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls.every(c => c.args.includes("identify") || c.args.includes("workspace.list")), "preflight is read-only");
});

for (const [name, modify] of [
  ["remote source", h => { h.state.rows[0].remote = { enabled: true, connected: true }; }],
  ["missing locality", h => { delete h.state.rows[1].remote; }],
  ["stale source", h => { h.state.rows.shift(); }],
  ["duplicate source", h => { h.state.rows.push(h.state.rows[0]); }],
  ["same workspace", h => { h.request.sourceWorkspaceId = CHILD; }],
  ["bad identity", h => { h.state.caller = { ...caller, surface_id: "surface:2" }; }],
  ["relative cwd", h => { h.request.cwd = "relative"; }],
  ["cwd control character", h => { h.request.cwd += "\n"; }],
  ["not directory", h => { h.request.cwd = process.execPath; }],
  ["invalid source UUID", h => { h.request.sourceWorkspaceId = "workspace:1"; }],
  ["unpinned executable", h => { h.config.pi = "pi"; }],
]) test(`bootstrap refuses ${name} before Pi starts`, async t => {
  const h = fixture(t); modify(h);
  await assert.rejects(preparePanelSession(h.config, h.request, h.pi, environment));
  assert.ok(h.calls.every(c => c.args.includes("identify") || c.args.includes("workspace.list")));
});

test("bootstrap rejects caller identity inconsistent with its terminal environment", async t => {
  const h = fixture(t);
  await assert.rejects(preparePanelSession(h.config, h.request, h.pi, { ...environment, CMUX_SURFACE_ID: SOURCE }));
});

test("child environment removes parent session/SSH state, preserves credentials and pins minimal executable PATH", () => {
  const env = panelEnvironment({ node: "/node/bin/node", pi: "/pi/bin/pi", cmux: "/cmux/bin/cmux", agentDir: "/config/agent" },
    { PI_CMUX_ORIENTATION: "parent", PI_CMUX_SSH_LAUNCH: "remote", PI_SESSION_FILE: "parent.jsonl",
      PI_SESSION_ID: "parent", PI_MODEL: "parent-model", PI_PROVIDER: "parent-provider", PI_REASONING_LEVEL: "max",
      PATH: "/untrusted", ANTHROPIC_API_KEY: "fixture-key", CMUX_SURFACE_ID: SURFACE });
  for (const key of ["PI_CMUX_ORIENTATION", "PI_CMUX_SSH_LAUNCH", "PI_SESSION_FILE", "PI_SESSION_ID", "PI_MODEL", "PI_PROVIDER", "PI_REASONING_LEVEL"]) {
    assert.equal(env[key], undefined);
  }
  assert.equal(env.PI_CODING_AGENT_DIR, "/config/agent");
  assert.equal(env.PI_CMUX_PI_PATH_MODE, "minimal");
  assert.ok(!env.PATH.includes("untrusted"));
  assert.equal(env.ANTHROPIC_API_KEY, "fixture-key");
  assert.equal(env.CMUX_SURFACE_ID, SURFACE);
});

test("installer renders pinned launch config, refuses implicit replacement, backs up exact approved copy and rejects symlinks", t => {
  const h = fixture(t), target = join(h.root, "sidebars", "agent-state-panel.js");
  const content = renderSidebar("sidebar(() => Text('test'));", h.config);
  assert.ok(content.includes("const PI_PANEL_LAUNCH ="));
  assert.deepEqual(installSidebar(target, content), { changed: true });
  assert.deepEqual(installSidebar(target, content), { changed: false });
  assert.throws(() => installSidebar(target, "updated"), /exists.*inspect/);
  assert.throws(() => installSidebar(target, "updated", "0".repeat(64)), /exists.*inspect/);
  const result = installSidebar(target, "updated", sha256(content));
  assert.equal(readFileSync(target, "utf8"), "updated");
  assert.equal(readFileSync(result.backup, "utf8"), content);
  const link = join(h.root, "linked.js"); symlinkSync(target, link);
  assert.throws(() => installSidebar(link, "bad", sha256("updated")), /symlink/);
  assert.equal(readFileSync(target, "utf8"), "updated");
});

async function runFakeBootstrap(t, binds) {
  const h = fixture(t), bin = join(h.root, "bin's tools"); mkdirSync(bin);
  const capture = join(h.root, "capture.json"), callsPath = join(h.root, "calls.jsonl");
  const piFile = join(bin, "pi"), cmuxFile = join(bin, "cmux");
  // These are fixture executables only. Nothing reaches the actual cmux socket
  // or starts Pi; the real bridge's process/argv/environment path is exercised.
  writeFileSync(cmuxFile, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsPath)},JSON.stringify(a)+'\\n');
if(a.includes('identify')) console.log(${JSON.stringify(JSON.stringify({ caller }))});
else if(a.includes('workspace.list')) console.log(${JSON.stringify(JSON.stringify({ workspaces: [{ id: SOURCE, remote: local }, { id: CHILD, remote: local }] }))});
`, { mode: 0o755 });
  writeFileSync(piFile, `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const env=process.env;fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),ssh:env.PI_CMUX_SSH_LAUNCH,parentSession:env.PI_SESSION_FILE,orientation:env.PI_CMUX_ORIENTATION}));
${binds ? `const b=JSON.parse(Buffer.from(env.PI_CMUX_ORIENTATION,'base64url').toString());const dir=path.join(env.PI_CODING_AGENT_DIR,'pi-cmux','orientation');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'${SURFACE}.json'),JSON.stringify({version:1,taskId:b[1],conversationId:b[2],role:b[3],sessionId:'fixture-session',token:crypto.randomUUID(),pid:process.pid,expiresAt:Date.now()+20000}));setTimeout(()=>{},900);` : ""}
`, { mode: 0o755 });
  const config = { ...h.config, pi: piFile, cmux: cmuxFile };
  const bridge = fileURLToPath(new URL("../examples/sidebars/launch-pi.mjs", import.meta.url));
  const child = spawn(process.execPath, [bridge, JSON.stringify(config), JSON.stringify(h.request)], {
    env: { ...process.env, ...environment, PI_CMUX_ORIENTATION: "must-not-inherit", PI_CMUX_SSH_LAUNCH: "must-not-inherit", PI_SESSION_FILE: "must-not-inherit" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.on("data", d => { stderr += d; });
  const code = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done); });
  assert.equal(code, 0, stderr);
  const captured = JSON.parse(readFileSync(capture, "utf8"));
  const calls = readFileSync(callsPath, "utf8").trim().split("\n").map(JSON.parse);
  assert.deepEqual(captured.args, []);
  assert.equal(realpathSync(captured.cwd), realpathSync(h.root));
  assert.equal(captured.ssh, undefined);
  assert.equal(captured.parentSession, undefined);
  const seed = JSON.parse(Buffer.from(captured.orientation, "base64url").toString());
  assert.equal(seed[3], "main"); assert.equal(seed[5], null, "no inherited origin");
  assert.ok(!calls.some(a => a.includes("create") || a.includes("respawn-pane") || a.includes("send")), "bootstrap never creates/replays a second surface");
  return calls;
}

test("real bootstrap with fake CLIs starts once, verifies exact child binding and clears startup status", { timeout: 15000 }, async t => {
  const calls = await runFakeBootstrap(t, true);
  assert.equal(calls.filter(a => a[0] === "clear-status").length, 1);
  assert.equal(calls.filter(a => a[0] === "log").length, 0);
});

test("early child exit leaves an unconfirmed status and warning, never retries", { timeout: 15000 }, async t => {
  const calls = await runFakeBootstrap(t, false);
  assert.equal(calls.filter(a => a[0] === "clear-status").length, 0);
  assert.equal(calls.filter(a => a[0] === "log").length, 1);
  assert.ok(calls.some(a => a.includes("Pi startup unconfirmed · inspect before retrying")));
});
