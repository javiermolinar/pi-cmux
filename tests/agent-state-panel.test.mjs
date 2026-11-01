import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../examples/sidebars/agent-state-panel.js", import.meta.url), "utf8");
const installedRuntime = "/Applications/cmux.app/Contents/Resources/CmuxSwiftRenderUI_CmuxSwiftRenderUI.bundle/Contents/Resources/SidebarRuntime.js";
const runtimePath = process.env.CMUX_SIDEBAR_RUNTIME ?? installedRuntime;

const fixture = () => [
  { id: "ws-1", title: "Same title", selected: true, status: "working", branch: "main", dirty: true, unread: 0,
    tabs: [{ id: "panel-1", surfaceId: "surface-1", latestPrompt: "Fix the race", hasUnread: true }],
    agents: [
      { id: "a-1", name: "Pi", title: "Investigate", status: "working", surfaceId: "surface-1", lastActivityAt: 100 },
      { id: "a-2", name: "Codex", title: "Tests", status: "needs_input", panelId: "unresolved-panel" },
    ] },
  { id: "ws-2", title: "Same title", selected: false, status: "todo", tabs: [],
    agents: [{ id: "a-1", name: "Pi", title: "Review change", status: "ended" },
      { id: "idle", status: "idle" }, { id: "future", status: "future_state" }] },
  { id: "empty", title: "Untracked", status: "todo", tabs: [] },
];

// Portable logic tests: intentionally don't pretend this stub is a renderer.
function logic(workspaces = fixture(), config) {
  const state = { workspaces, clock: { epoch: 220 } };
  const actions = [];
  const ctx = vm.createContext({
    ...(config ? { PI_PANEL_LAUNCH: config } : {}),
    data: new Proxy({}, { get: (_, key) => () => state[key] }),
    signal: (initial) => { let value = initial; return [() => value, (next) => { value = next; }]; },
    computed: (fn) => fn,
    sidebar: () => {},
    cmux: (method, params) => actions.push({ method, params: JSON.parse(JSON.stringify(params)) }),
  });
  vm.runInContext(source, ctx);
  return { state, actions, run: (code) => vm.runInContext(code, ctx),
    json: (code) => JSON.parse(vm.runInContext(`JSON.stringify(${code})`, ctx)) };
}

test("all states have distinct symbols; unexpected/missing states stay unknown", () => {
  const h = logic();
  assert.deepEqual(h.json("STATE_ORDER.map(s => STATES[s].symbol)"), ["!", "●", "✓", "○", "?"]);
  assert.deepEqual(h.json("totals()"), { needs_input: 1, working: 1, ended: 1, idle: 1, unknown: 1 });
  for (const status of [undefined, "", "needs-attention", "toString", "__proto__", "error"]) {
    assert.equal(h.run(`agentState({status:${JSON.stringify(status)}})`), "unknown");
  }
});

test("workspace rollups combine separate lane/unread evidence without changing agent states", () => {
  const h = logic();
  const rollup = (w) => h.run(`workspaceState(${JSON.stringify(w)})`);
  assert.equal(rollup({ status: "todo" }), "unknown");
  assert.equal(rollup({ agents: [{ status: "idle" }] }), "idle");
  assert.equal(rollup({ agents: [{ status: "idle" }, {}] }), "unknown");
  assert.equal(rollup({ status: "done" }), "ended");
  assert.equal(rollup({ status: "review" }), "ended");
  assert.equal(rollup({ status: "todo", agents: [{ status: "ended" }] }), "ended");
  assert.equal(rollup({ status: "working", agents: [{ status: "ended" }] }), "working");
  assert.equal(rollup({ unread: 1, agents: [{ status: "working" }] }), "needs_input");
  assert.equal(rollup({ status: "needs-attention" }), "needs_input");
  assert.equal(rollup({ tabs: [{ hasUnread: true }], agents: [{ status: "idle" }] }), "needs_input");
  assert.equal(h.run("agentState(data.workspaces()[0].agents[0])"), "working");
});

test("scope/search retain complete rollups and stable composite keys, including duplicate titles/agent IDs", () => {
  const h = logic();
  const keys = h.json("entries().map(e => e.key)");
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes("a:ws-1:a-1") && keys.includes("a:ws-2:a-1"));
  h.run('setQuery("fix the race")');
  assert.deepEqual(h.json("entries().filter(e => e.kind === 'agent').map(e => e.a.id)"), ["a-1"]);
  assert.equal(h.run("workspaceState(entries()[0].w)"), "needs_input");
  assert.equal(h.run("totals().needs_input"), 1);
  h.run('setQuery(""); setScopeAll(false)');
  assert.deepEqual(h.json("groups().map(g => g.w.id)"), ["ws-1"]);
  assert.equal(h.run("totals().ended"), 0);
  h.run('setQuery("no match")');
  assert.equal(h.run("entries().length"), 0);
});

test("workspaces without tracked agents stay hidden in both scopes and search; idle/ended agents remain", () => {
  const workspaces = fixture();
  workspaces.push({ id: "empty-list", title: "Untracked list", agents: [], selected: false,
    status: "working", unread: 2, tabs: [{ hasUnread: true }] });
  const h = logic(workspaces);
  assert.deepEqual(h.json("groups().map(g => g.w.id)"), ["ws-1", "ws-2"]);
  assert.ok(h.json("entries().filter(e => e.kind === 'agent').map(e => e.a.id)").includes("idle"));
  assert.ok(h.json("entries().filter(e => e.kind === 'agent').map(e => e.a.status)").includes("ended"));
  h.run('setQuery("untracked")');
  assert.equal(h.run("entries().length"), 0, "matching workspace titles must not reveal empty workspaces");
  h.run('setQuery(""); setScopeAll(false)');
  h.state.workspaces.forEach(w => { w.selected = w.id === "empty-list"; });
  assert.equal(h.run("entries().length"), 0);
  assert.equal(h.run("totals().working"), 0);
  h.state.workspaces[3].agents.push({ id: "new", status: "idle" });
  assert.deepEqual(h.json("groups().map(g => g.w.id)"), ["empty-list"]);
  h.state.workspaces[3].agents = [];
  assert.equal(h.run("entries().length"), 0);
  assert.equal(h.actions.length, 0);
});

test("empty workspaces do not consume the workspace display cap", () => {
  const h = logic([
    ...Array.from({ length: 20 }, (_, i) => ({ id: `empty-${i}`, title: `Empty ${i}`, agents: [] })),
    { id: "tracked", title: "Tracked", agents: [{ id: "idle", status: "idle" }] },
  ]);
  assert.deepEqual(h.json("entries().map(e => e.key)"), ["w:tracked", "a:tracked:idle"]);
});

test("attention filter combines explicit input/unread evidence with search/scope and preserves rollups", () => {
  const h = logic();
  const workspaces = h.state.workspaces;
  workspaces[1].status = "needs-attention";
  workspaces[1].unread = 3;
  assert.equal(h.run("attentionOnly()"), false);
  h.run("setAttentionOnly(true)");
  assert.deepEqual(h.json("groups().map(g => g.w.id)"), ["ws-1"]);
  assert.deepEqual(h.json("totals()"), { needs_input: 1, working: 1, ended: 0, idle: 0, unknown: 0 });
  assert.equal(h.run("countAgents(data.workspaces()[1].agents).ended"), 1, "workspace rollups remain complete");
  h.run('setQuery("Review change")');
  assert.equal(h.run("entries().length"), 0, "search cannot bypass attention evidence");
  assert.equal(h.run("totals().working"), 1, "header totals are independent of search");
  h.run('setQuery(""); setScopeAll(false)');
  workspaces[0].selected = false;
  workspaces[1].selected = true;
  assert.equal(h.run("entries().length"), 0, "workspace lane/unread count cannot identify an agent");
  workspaces[1].agents[0].surfaceId = "ended-surface";
  workspaces[1].tabs = [{ id: "ended-panel", surfaceId: "ended-surface", hasUnread: true }];
  assert.deepEqual(h.json("groups().map(g => g.w.id)"), ["ws-2"]);
  assert.equal(h.run("totals().ended"), 1, "unread keeps the actual ended state");
  workspaces[1].agents[0].panelId = "stale-panel";
  assert.equal(h.run("entries().length"), 0, "unread on another/stale surface cannot leak in");
  h.run('setScopeAll(true); toggleWorkspace("ws-1"); setAttentionOnly(false)');
  assert.equal(h.run('workspaceCollapsed("ws-1")'), true);
  assert.equal(h.run("totals().idle"), 1);
  assert.deepEqual(h.json("groups().map(g => g.w.id)"), ["ws-1", "ws-2"]);
  assert.equal(h.actions.length, 0);
});

test("folding is local per workspace, preserves totals and lets search reveal agents", () => {
  const h = logic();
  const totals = h.json("totals()");
  h.run('toggleWorkspace("ws-1")');
  assert.equal(h.run('workspaceCollapsed("ws-1")'), true);
  assert.deepEqual(h.json("entries().filter(e => e.kind === 'agent').map(e => e.w.id)"), ["ws-2", "ws-2", "ws-2"]);
  assert.deepEqual(h.json("totals()"), totals);
  assert.equal(h.run("countAgents(entries()[0].w.agents).working"), 1);
  h.run('setQuery("fix the race")');
  assert.equal(h.run('workspaceCollapsed("ws-1")'), false);
  assert.equal(h.run("entries().filter(e => e.kind === 'agent').length"), 1);
  h.run('toggleWorkspace("ws-1"); setQuery("")');
  assert.equal(h.run('workspaceCollapsed("ws-1")'), true, "search doesn't overwrite fold choice");
  h.run('setScopeAll(false); setScopeAll(true)');
  assert.equal(h.run('workspaceCollapsed("ws-1")'), true);
  h.run('toggleWorkspace("ws-1")');
  assert.equal(h.run("entries().filter(e => e.kind === 'agent').length"), 5);
  h.run('toggleWorkspace("ws-1")');
  h.state.workspaces = h.state.workspaces.filter(w => w.id !== "ws-1");
  h.run('toggleWorkspace("ws-2"); toggleWorkspace("removed")');
  assert.deepEqual(h.json("collapsedWorkspaces()"), ["ws-2"], "toggle prunes removed workspace IDs");
  assert.equal(h.actions.length, 0, "folding never selects workspaces or dispatches cmux actions");
});

test("native panel binding maps legacy Bonsplit IDs to one live RPC surface without guessing", () => {
  const h = logic();
  const w = h.state.workspaces[0];
  w.tabs[0].focused = true;
  w.agents[0].panelId = "panel-1";
  w.agents[0].surfaceId = "legacy-bonsplit-id";
  assert.equal(h.run("currentAgent(data.workspaces()[0], data.workspaces()[0].agents[0])"), true);
  h.run('jumpAgent("ws-1", "a-1")');
  assert.deepEqual(h.actions.splice(0), [
    { method: "workspace.select", params: { workspace_id: "ws-1" } },
    { method: "surface.focus", params: { workspace_id: "ws-1", surface_id: "surface-1" } },
  ]);
  w.tabs.push({ id: "panel-1", surfaceId: "ambiguous" });
  h.run('jumpAgent("ws-1", "a-1")');
  assert.deepEqual(h.actions.splice(0), [{ method: "workspace.select", params: { workspace_id: "ws-1" } }]);
  w.tabs.pop();
  w.agents[0].panelId = "stale-panel";
  w.agents[0].surfaceId = "surface-1";
  assert.equal(h.run("currentAgent(data.workspaces()[0], data.workspaces()[0].agents[0])"), false,
    "a stale explicit panel binding must not fall back to another surface match");
  w.agents[0].panelId = "panel-1";
  delete w.tabs[0].surfaceId;
  h.run('jumpAgent("ws-1", "a-1")');
  assert.deepEqual(h.actions.splice(0), [{ method: "workspace.select", params: { workspace_id: "ws-1" } }]);
});

test("current agent requires the selected workspace and an exact focused surface match", () => {
  const h = logic();
  const current = () => h.run("currentAgent(data.workspaces()[0], data.workspaces()[0].agents[0])");
  assert.equal(current(), false, "missing focused metadata is not evidence");
  h.state.workspaces[0].tabs[0].focused = true;
  assert.equal(current(), true);
  h.state.workspaces[0].selected = false;
  assert.equal(current(), false, "other workspaces can retain a focused tab");
  h.state.workspaces[0].selected = true;
  h.state.workspaces[0].tabs[0].focused = false;
  assert.equal(current(), false);
  h.state.workspaces[0].tabs[0].focused = true;
  h.state.workspaces[0].agents[0].surfaceId = "missing";
  assert.equal(current(), false);
  assert.equal(h.run("currentAgent(data.workspaces()[0], data.workspaces()[0].agents[1])"), false,
    "panelId never substitutes for surfaceId");
  h.state.workspaces[0].tabs = [];
  assert.equal(current(), false);
});

test("caps bound the scene without truncating workspace counts; search reaches hidden agents/workspaces", () => {
  const workspaces = Array.from({ length: 30 }, (_, i) => ({ id: `w-${i}`, title: `Workspace ${i}`,
    agents: Array.from({ length: 20 }, (_, j) => ({ id: `a-${j}`, title: `Task ${j}`, status: "idle" })) }));
  const h = logic(workspaces);
  assert.equal(h.run("entries().length"), 12 * 8); // header + 6 agents + overflow note
  assert.equal(h.run("totals().idle"), 600);
  assert.equal(h.run("countAgents(entries()[0].w.agents).idle"), 20);
  h.run('setQuery("task 19")');
  assert.equal(h.run("entries().filter(e => e.kind === 'agent').length"), 12);
  h.run('setQuery("workspace 29")');
  assert.equal(h.run("groups()[0].w.id"), "w-29");
});

test("actions re-resolve exact live IDs, never panel IDs or an inferred selected surface", () => {
  const h = logic();
  assert.equal(h.actions.length, 0);
  h.run('jumpAgent("ws-1", "a-1")');
  assert.deepEqual(h.actions.splice(0), [
    { method: "workspace.select", params: { workspace_id: "ws-1" } },
    { method: "surface.focus", params: { workspace_id: "ws-1", surface_id: "surface-1" } },
  ]);
  h.run('jumpAgent("ws-1", "a-2")');
  assert.deepEqual(h.actions.splice(0), [{ method: "workspace.select", params: { workspace_id: "ws-1" } }]);
  h.state.workspaces[0].agents[0].surfaceId = "moved-surface";
  h.state.workspaces[0].tabs[0].surfaceId = "moved-surface";
  h.run('jumpAgent("ws-1", "a-1")');
  assert.equal(h.actions.splice(0)[1].params.surface_id, "moved-surface");
  h.state.workspaces[0].tabs = [];
  h.run('jumpAgent("ws-1", "a-1")');
  assert.equal(h.actions.splice(0).length, 1);
  h.state.workspaces = [];
  h.run('jumpAgent("ws-1", "a-1"); jumpWorkspace("ws-1")');
  assert.equal(h.actions.length, 0);
});

test("agent labels prefer task/prompt text, omit redundant Pi metadata and preserve useful details", () => {
  const h = logic();
  const w = h.state.workspaces[0], a = w.agents[0];
  const title = () => h.run("agentTitle(data.workspaces()[0], data.workspaces()[0].agents[0])");
  const meta = () => h.run("agentMeta(data.workspaces()[0], data.workspaces()[0].agents[0])");
  assert.equal(title(), "Investigate");
  assert.equal(meta(), "! unread");
  a.title = " \n ";
  assert.equal(title(), "Fix the race");
  w.tabs[0].latestPrompt = "  Ship\n the fix  ";
  assert.equal(title(), "Ship the fix");
  w.tabs[0].latestPrompt = "";
  assert.equal(title(), "Untitled session");
  h.run('setQuery("untitled session")');
  assert.ok(h.json("entries().filter(e => e.kind === 'agent').map(e => e.a.id)").includes("a-1"));
  a.name = " PI "; a.children = [{ running: true }, { running: false }];
  assert.equal(meta(), "! unread · 1 sub working");
  a.name = "Codex";
  assert.equal(meta(), "Codex · ! unread · 1 sub working");
  a.name = ""; a.kind = "pi";
  w.tabs = [];
  assert.equal(meta(), "1 sub working · workspace only");
  assert.equal(h.actions.length, 0);
});

test("sidebar aliases stay stable per workspace/session, remain searchable and reset without cmux writes", () => {
  const h = logic();
  h.run('beginSessionName("ws-1", "a-1"); setRenameDraft("Sidebar UI"); saveSessionName()');
  assert.equal(h.run("agentTitle(data.workspaces()[0], data.workspaces()[0].agents[0])"), "Sidebar UI");
  assert.equal(h.run("agentTitle(data.workspaces()[1], data.workspaces()[1].agents[0])"), "Review change",
    "duplicate agent IDs in another workspace do not share aliases");
  h.state.workspaces[0].agents[0].title = "Changed task title";
  h.state.workspaces[0].tabs[0].latestPrompt = "ok lets go";
  assert.equal(h.run("agentTitle(data.workspaces()[0], data.workspaces()[0].agents[0])"), "Sidebar UI");
  for (const query of ["sidebar ui", "changed task title", "ok lets go"]) {
    h.run(`setQuery(${JSON.stringify(query)})`);
    assert.equal(h.run("entries().filter(e => e.kind === 'agent').length"), 1);
  }
  h.run('setQuery(""); resetSessionName("ws-1", "a-1")');
  assert.equal(h.run("agentTitle(data.workspaces()[0], data.workspaces()[0].agents[0])"), "Changed task title");
  assert.notEqual(h.run('sessionKey("a:b", "c")'), h.run('sessionKey("a", "b:c")'));
  assert.equal(h.actions.length, 0);
});

test("sidebar naming validates input, cancels cleanly and refuses sessions removed while editing", () => {
  const h = logic();
  h.run('beginSessionName("ws-1", "a-1")');
  for (const name of ["", "   ", "x".repeat(81), "bad\nname", "bad\u0000name"]) {
    h.run(`setRenameDraft(${JSON.stringify(name)}); saveSessionName()`);
    assert.equal(h.run("sessionAliases().length"), 0);
    assert.match(h.run("renameError()"), /1–80/);
  }
  h.run('cancelSessionName()');
  assert.equal(h.run("renameTarget()"), null);
  h.run('beginSessionName("ws-1", "a-1"); setRenameDraft("Safe $(text) <only>"); saveSessionName()');
  assert.equal(h.run("agentTitle(data.workspaces()[0], data.workspaces()[0].agents[0])"), "Safe $(text) <only>");
  h.run('beginSessionName("ws-1", "a-1"); setRenameDraft("Late edit")');
  h.state.workspaces[0].agents = [];
  h.run("saveSessionName()");
  assert.match(h.run("renameError()"), /no longer tracked/);
  assert.equal(h.run("sessionAliases()[0].name"), "Safe $(text) <only>");
  h.run('cancelSessionName(); beginSessionName("missing", "missing")');
  assert.equal(h.run("renameTarget()"), null);
  h.run('beginSessionName("ws-2", "a-1"); setRenameDraft("Other session"); saveSessionName()');
  assert.equal(h.run("sessionAliases().length"), 1, "saving prunes aliases for removed sessions");
  assert.equal(h.actions.length, 0);
});

test("optional time/git/progress data is safe and unread is not treated as proof of agent input", () => {
  const h = logic();
  assert.equal(h.run("ageText({})"), "");
  assert.equal(h.run('ageText({status:"working", sinceEpoch:100})'), "2m");
  assert.equal(h.run('ageText({status:"ended", lastActivityAt:100})'), "2m ago");
  assert.equal(h.run('ageText({status:"idle", lastActivityAt:999})'), "0s ago");
  assert.equal(h.run('workspaceMeta({branch:"feature",dirty:true,unread:2,progress:{value:1.5}})'), "feature* · 2 unread · 100%");
});

function scene(config) {
  const nodes = new Map();
  const actions = [];
  const logs = [];
  const ctx = vm.createContext({
    ...(config ? { PI_PANEL_LAUNCH: config } : {}),
    __host_applyOps: (json) => {
      for (const op of JSON.parse(json)) {
        if (op.op === "create") nodes.set(op.id, { id: op.id, type: op.type, props: {}, children: [] });
        else if (op.op === "update") nodes.get(op.id).props[op.key] = op.value;
        else if (op.op === "children") nodes.get(op.id).children = op.children;
        else if (op.op === "append") nodes.get(op.id).children.push(op.child);
        else if (op.op === "remove") nodes.delete(op.id);
      }
    },
    __host_action: (json) => actions.push(JSON.parse(json)),
    __host_log: (message) => logs.push(message),
    __host_clipboardWrite: () => false,
  });
  vm.runInContext(readFileSync(runtimePath, "utf8"), ctx);
  vm.runInContext(source, ctx);
  return { nodes, actions, logs, run: (code) => vm.runInContext(code, ctx),
    set: (key, value) => ctx.__setData(key, JSON.stringify(value)),
    text: (text) => [...nodes.values()].find((n) => n.props.text === text),
    dispatch: (id, event, payload = null) => ctx.__dispatch(id, event, JSON.stringify(payload)) };
}

const launchFixture = () => [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Source", selected: true,
  directory: "/tmp/project's $(touch should-not-exist)", status: "todo", tabs: [] }];
const launchConfig = { version: 1, node: "/absolute/node", pi: "/absolute/pi", cmux: "/absolute/cmux",
  bridge: "/checkout's path/launch.mjs", agentDir: "/home/.pi/agent" };

test("New Pi requires installed bridge, explicit Create, local source and valid directory; dispatch is single-shot", () => {
  const raw = logic(launchFixture());
  raw.run("openLaunchForm(); createPiWorkspace()");
  assert.equal(raw.actions.length, 0);
  const h = logic(launchFixture(), launchConfig);
  h.run("openLaunchForm()");
  assert.equal(h.actions.length, 0, "opening a form is not creation");
  assert.equal(h.run("launchDirectory()"), launchFixture()[0].directory);
  h.run("createPiWorkspace(); createPiWorkspace(); openLaunchForm(); createPiWorkspace()");
  assert.equal(h.actions.length, 1, "duplicate clicks do not rearm creation");
  const { method, params } = h.actions[0];
  assert.equal(method, "workspace.create");
  assert.equal(params.workspace_id, launchFixture()[0].id);
  assert.equal(params.working_directory, launchFixture()[0].directory);
  assert.match(params.initial_command, /^exec '\/absolute\/node'/);
  assert.ok(params.initial_command.includes("'\\''"), "single quotes are escaped in literal arguments");
  assert.ok(!params.initial_command.includes("--continue") && !params.initial_command.includes("--session"));
  assert.equal(h.run("launchSent()"), true);
  assert.match(h.run("launchMessage()"), /Request sent.*inspect/);
  for (const directory of ["relative", "", "/bad\npath", "/" + "a".repeat(1024)]) {
    const invalid = logic(launchFixture(), launchConfig);
    invalid.run(`openLaunchForm(); setLaunchDirectory(${JSON.stringify(directory)}); createPiWorkspace()`);
    assert.equal(invalid.actions.length, 0);
  }
  for (const remote of [true, { connected: false }]) {
    const ws = launchFixture(); ws[0].remote = remote;
    const h = logic(ws, launchConfig);
    h.run('openLaunchForm(); setLaunchDirectory("/tmp"); createPiWorkspace()');
    assert.equal(h.actions.length, 0);
  }
  const stale = logic(launchFixture(), launchConfig);
  stale.run("openLaunchForm()"); stale.state.workspaces = [];
  stale.run("createPiWorkspace()");
  assert.equal(stale.actions.length, 0);
});

test("native bootstrap command preserves quoted paths and request JSON as literal argv", t => {
  const root = mkdtempSync(join(tmpdir(), "pi-panel-argv-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bridge = join(root, "capture's args.mjs");
  writeFileSync(bridge, "console.log(JSON.stringify(process.argv.slice(2)))");
  const config = { ...launchConfig, node: process.execPath, bridge };
  const h = logic(launchFixture(), config);
  h.run("openLaunchForm(); createPiWorkspace()");
  const result = spawnSync("/bin/sh", ["-c", h.actions[0].params.initial_command], { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const [actualConfig, request] = JSON.parse(result.stdout).map(JSON.parse);
  assert.deepEqual(actualConfig, config);
  assert.deepEqual(request, { version: 1, sourceWorkspaceId: launchFixture()[0].id, cwd: launchFixture()[0].directory });
});

const runtimeOptions = { skip: !existsSync(runtimePath) && "Set CMUX_SIDEBAR_RUNTIME to cmux's SidebarRuntime.js for scene checks" };
test("installed real JS runtime mounts, updates retained rows, filters, scopes and dispatches exact actions", runtimeOptions, () => {
  const h = scene();
  assert.ok(h.text("No agents in scope"));
  h.set("clock", { epoch: 220 });
  h.set("workspaces", fixture());
  assert.ok(!h.text("Untracked"));
  assert.ok(!h.text("No tracked agents"));
  const title = h.text("Investigate");
  assert.ok(title);
  assert.ok(h.text("main*"));
  assert.ok(h.text("! unread"));
  assert.ok(!h.text("Pi · ! unread"));
  assert.ok(h.text("Working"), "per-agent state labels remain visible");
  for (const legend of ["! Attention", "● Working", "✓ Review", "○ Idle", "? Unknown"]) {
    assert.ok(!h.text(legend), "no footer legend: " + legend);
  }
  assert.equal([...h.nodes.values()].filter(n => n.type === "divider").length, 1);
  assert.ok(!h.text("Compact") && !h.text("Details"));
  const row = [...h.nodes.values()].find((n) => n.props.help?.includes("Focus exact agent surface"));
  assert.ok(row);
  const next = fixture();
  next[0].agents[0].title = "Updated task";
  next[0].agents[0].status = "ended";
  h.set("workspaces", next);
  assert.equal(h.text("Updated task").id, title.id); // kept identity; live binding
  h.dispatch(row.id, "tap");
  assert.deepEqual(h.actions.map(({ method, params }) => ({ method, params })), [
    { method: "workspace.select", params: { workspace_id: "ws-1" } },
    { method: "surface.focus", params: { workspace_id: "ws-1", surface_id: "surface-1" } },
  ]);
  const search = [...h.nodes.values()].find((n) => n.type === "textfield");
  assert.equal(search.props.autofocus, false);
  h.dispatch(search.id, "edit", { text: "impossible" });
  assert.ok(h.text("No matches"));
  assert.ok(!h.text("Updated task"));
  h.dispatch(search.id, "edit", { text: "" });
  h.dispatch(h.text("This workspace").id, "tap");
  assert.ok(!h.text("Review change"));
  const untracked = { id: "empty", title: "Untracked", selected: true, agents: [] };
  h.set("workspaces", [untracked]);
  assert.ok(!h.text("Untracked"));
  assert.ok(h.text("No agents in scope"));
  h.set("workspaces", [{ ...untracked, agents: [{ id: "idle", title: "Idle task", status: "idle" }] }]);
  assert.ok(h.text("Untracked"));
  assert.ok(h.text("Idle task"));
  h.set("workspaces", [{ ...untracked, agents: [{ id: "idle", title: "Ended task", status: "ended" }] }]);
  assert.ok(h.text("Ended task"));
  h.set("workspaces", [untracked]);
  assert.ok(!h.text("Untracked"));
  assert.ok(!h.text("Ended task"));
  h.dispatch(search.id, "edit", { text: "Untracked" });
  assert.ok(h.text("No matches"));
  assert.ok(!h.text("Untracked"));
  h.dispatch(search.id, "edit", { text: "" });
  h.set("workspaces", []);
  assert.ok(h.text("No agents in scope"));
  assert.deepEqual(h.logs, []);
});

test("installed runtime session context menu names/cancels/resets exact rows without navigation", runtimeOptions, () => {
  const h = scene();
  const workspaces = fixture();
  h.set("workspaces", workspaces);
  const row = [...h.nodes.values()].find(n => n.props.help?.includes("Focus exact agent surface"));
  const menu = row.children.map(id => h.nodes.get(id)).find(n => n.type === "contextMenu");
  assert.ok(menu, "menu is attached to the agent row, not a global control");
  const buttons = menu.children.map(id => h.nodes.get(id));
  const nameButton = buttons.find(n => n.props.text === "Name in sidebar…");
  const resetButton = buttons.find(n => n.props.text === "Use automatic name");
  const titleId = h.text("Investigate").id;
  h.dispatch(nameButton.id, "tap");
  let field = [...h.nodes.values()].find(n => n.props.placeholder === "Sidebar session name");
  assert.equal(field.props.text, "Investigate");
  assert.notEqual(field.props.autofocus, false, "explicit naming action may focus its editor");
  h.dispatch(field.id, "edit", { text: "Discarded" });
  h.dispatch(field.id, "cancel");
  assert.ok(!h.text("Name session"));
  assert.equal(h.text("Investigate").id, titleId);
  h.dispatch(nameButton.id, "tap");
  field = [...h.nodes.values()].find(n => n.props.placeholder === "Sidebar session name");
  h.dispatch(field.id, "submit", { text: "Sidebar UI" });
  assert.equal(h.text("Sidebar UI").id, titleId);
  assert.ok(!h.text("Name session"));
  workspaces[0].agents[0].title = "New automatic title";
  workspaces[0].tabs[0].latestPrompt = "ok";
  h.set("workspaces", workspaces);
  assert.equal(h.text("Sidebar UI").id, titleId);
  assert.match(row.props.help, /New automatic title/);
  h.dispatch(resetButton.id, "tap");
  assert.equal(h.text("New automatic title").id, titleId);
  assert.equal(h.actions.length, 0);
  assert.deepEqual(h.logs, []);
});

test("installed runtime attention toggle reacts to status/unread updates without navigation", runtimeOptions, () => {
  const h = scene();
  const workspaces = fixture();
  h.set("workspaces", workspaces);
  const button = [...h.nodes.values()].find(n => n.props.help === "Filter agents needing input or with unread surface notifications");
  assert.ok(button);
  assert.equal(button.props.background, null);
  h.dispatch(button.id, "tap");
  assert.equal(button.props.background, "#D9770620");
  assert.ok(h.text("Investigate"));
  assert.ok(h.text("Tests"));
  assert.ok(!h.text("Review change"));
  assert.ok(h.text("! 1  ● 1"));
  workspaces[0].tabs[0].hasUnread = false;
  h.set("workspaces", workspaces);
  assert.ok(!h.text("Investigate"));
  assert.ok(h.text("Tests"));
  workspaces[0].agents[1].status = "idle";
  h.set("workspaces", workspaces);
  assert.ok(h.text("No agents need attention"));
  assert.ok(h.text("No attention items"));
  assert.ok(!h.text("Tests"));
  h.dispatch(button.id, "tap");
  assert.equal(button.props.background, null);
  assert.ok(h.text("Investigate"));
  assert.ok(h.text("Review change"));
  assert.ok(!h.text("No agents need attention"));
  assert.equal(h.actions.length, 0);
  assert.deepEqual(h.logs, []);
});

test("installed runtime keeps task labels reactive without rendering Pi as the agent name", runtimeOptions, () => {
  const h = scene();
  const workspaces = fixture();
  const a = workspaces[0].agents[0];
  delete a.title;
  h.set("workspaces", workspaces);
  assert.ok(!h.text("Pi"));
  const label = h.text("Fix the race");
  assert.ok(label);
  workspaces[0].tabs[0].latestPrompt = "Latest task";
  h.set("workspaces", workspaces);
  assert.equal(h.text("Latest task").id, label.id);
  a.title = "Named task";
  h.set("workspaces", workspaces);
  assert.equal(h.text("Named task").id, label.id);
  delete a.title;
  workspaces[0].tabs[0].latestPrompt = "";
  h.set("workspaces", workspaces);
  assert.ok([...h.nodes.values()].some(n => n.id === label.id && n.props.text === "Untitled session"));
  assert.ok(!h.text("Pi"));
  assert.ok(h.text("! unread"));
  assert.deepEqual(h.logs, []);
});

test("installed runtime folds groups independently and updates exact current-agent highlighting", runtimeOptions, () => {
  const h = scene();
  const workspaces = fixture();
  workspaces[0].tabs[0].focused = true;
  workspaces[0].agents[0].panelId = "panel-1";
  workspaces[0].agents[0].surfaceId = "legacy-bonsplit-id";
  h.set("workspaces", workspaces);
  const rowFor = () => [...h.nodes.values()].find(n => n.props.help?.includes("Focus exact agent surface"));
  let row = rowFor();
  assert.equal(row.props.background, "#0A84FF20");
  assert.match(row.props.help, /Current agent surface/);
  assert.equal(h.text("Investigate").props.weight, "semibold");
  const fold = [...h.nodes.values()].find(n => n.props.help === "Collapse agents · ws-1");
  const headerId = fold.id;
  h.dispatch(fold.id, "tap");
  assert.equal(h.nodes.get(headerId).props.text, "›");
  assert.ok(!h.text("Investigate"));
  assert.ok(h.text("Review change"));
  assert.equal(h.actions.length, 0);
  const search = [...h.nodes.values()].find(n => n.type === "textfield");
  h.dispatch(search.id, "edit", { text: "fix the race" });
  assert.ok(h.text("Investigate"));
  assert.equal(rowFor().props.background, "#0A84FF20");
  h.dispatch(search.id, "edit", { text: "" });
  assert.ok(!h.text("Investigate"));
  h.dispatch(headerId, "tap");
  row = rowFor();
  const rowId = row.id;
  const titleId = h.text("Investigate").id;
  workspaces[0].selected = false;
  workspaces[1].selected = true;
  h.set("workspaces", workspaces);
  assert.equal(rowFor().id, rowId);
  assert.equal(h.text("Investigate").id, titleId);
  assert.equal(row.props.background, null);
  assert.equal(h.text("Investigate").props.weight, "regular");
  workspaces[0].selected = true;
  workspaces[1].selected = false;
  workspaces[0].tabs[0].id = "moved-panel";
  workspaces[0].tabs[0].surfaceId = "moved";
  h.set("workspaces", workspaces);
  assert.equal(row.props.background, null, "stale panels cannot stay highlighted");
  workspaces[0].agents[0].panelId = "moved-panel";
  h.set("workspaces", workspaces);
  assert.equal(row.props.background, "#0A84FF20");
  assert.deepEqual(h.logs, []);
});

test("installed panel has no New Pi button; retained internal form helper still passes its fixture checks", runtimeOptions, () => {
  const h = scene(launchConfig);
  h.set("workspaces", launchFixture());
  assert.ok(!h.text("+ New Pi"));
  assert.ok(!h.text("New independent Pi workspace"));
  assert.equal(h.actions.length, 0);
  h.run("openLaunchForm()");
  const field = [...h.nodes.values()].find((n) => n.props.placeholder === "Absolute local directory");
  assert.equal(field.props.autofocus, false);
  assert.equal(field.props.text, launchFixture()[0].directory);
  h.dispatch(h.text("Cancel").id, "tap");
  assert.ok(!h.text("New independent Pi workspace"));
  assert.equal(h.actions.length, 0);
  h.run("openLaunchForm()");
  h.dispatch(h.text("Create").id, "tap");
  h.dispatch(h.text("Sent").id, "tap");
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].method, "workspace.create");
  assert.ok(h.text("Request sent · inspect the new workspace before retrying"));
});

test("installed runtime stays bounded through many live replacements and empty/populated transitions", runtimeOptions, () => {
  const h = scene();
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `w${i}`, title: `Work ${i}`,
    agents: Array.from({ length: 30 }, (_, j) => ({ id: `a${j}`, name: "Pi", status: "working" })) }));
  h.set("workspaces", many);
  const initialSize = h.nodes.size;
  assert.ok(initialSize < 2500);
  assert.ok(h.text("+18 workspaces · narrow search"));
  assert.ok(h.text("+24 agents · narrow search"));
  for (let i = 0; i < 10; i++) {
    h.set("workspaces", []);
    h.set("workspaces", many);
    assert.equal(h.nodes.size, initialSize);
  }
  assert.deepEqual(h.logs, []);
});
