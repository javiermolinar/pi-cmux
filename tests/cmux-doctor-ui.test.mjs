import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DoctorOverlay, doctorStyle } from "../lib/doctor/overlay.ts";
import doctor from "../extensions/cmux-doctor.ts";

const plain = { accent: text => text, muted: text => text, dim: text => text, bold: text => text, status: (_, text) => text };
const report = () => ({ autoOpen: { autoOpen: false, source: "default", errors: [] }, checks: [
  { status: "ok", title: "Healthy", detail: "Read-only evidence" },
  { status: "error", title: "Broken check", detail: Array.from({ length: 40 }, (_, n) => `detail line ${n}: 界 diagnostic evidence`).join("\n"), remediation: "REPAIR MANUALLY; never auto-repair." },
  { status: "warning", title: "Installed panel", detail: "/fixture: missing" },
  { status: "unverified", title: "Caller/locality", detail: "No verified caller" },
] });
function screen(options = {}) {
  let rows = options.rows ?? 40; const choices = [];
  const overlay = new DoctorOverlay(report(), plain, { terminalRows: () => rows, onDone: choice => choices.push(choice), ...options });
  return { overlay, choices, resize: value => { rows = value; } };
}
const text = (overlay, width = 96) => overlay.render(width).join("\n");
const tab = overlay => overlay.handleInput("\t");
const down = overlay => overlay.handleInput("\x1b[B");
const enter = overlay => overlay.handleInput("\r");

test("active Pi theme adapter maps labels to theme colors", () => {
  const calls = [];
  const style = doctorStyle({ fg: (color, text) => { calls.push(color); return text; }, bold: text => `*${text}*` });
  for (const status of ["ok", "warning", "error", "unverified"]) style.status(status, status);
  style.accent("a"); style.muted("m"); style.dim("d");
  assert.deepEqual(calls, ["success", "warning", "error", "muted", "accent", "muted", "dim"]);
  assert.equal(style.bold("heading"), "*heading*");
});

for (const [width, rows] of [[96, 40], [96, 18], [44, 40], [44, 18], [42, 18]]) test(`bounded responsive ${width}x${rows} render and actions`, () => {
  const { overlay, choices } = screen({ rows });
  const lines = overlay.render(width), captured = lines.join("\n");
  assert.ok(lines.length <= Math.floor(rows * .85));
  assert.ok(lines.every(line => visibleWidth(line) <= width));
  assert.match(captured, /╭/); assert.match(captured, /╰/);
  for (const label of ["OK", "warning", "error", "unverified", "Refresh", "Install", "Show Pi Agents", "Hide right sidebar", "Esc"]) assert.ok(captured.includes(label), label);
  assert.match(captured, /Broken check/); assert.match(captured, /detail line/);
  assert.deepEqual(choices, []);
  tab(overlay); tab(overlay); enter(overlay);
  assert.deepEqual(choices, ["refresh"]);
});

test("selected error details/remediation scroll independently, including short narrow mode", () => {
  const { overlay } = screen({ rows: 18 });
  const initial = text(overlay, 44);
  tab(overlay); // detail focus
  for (let n = 0; n < 50; n++) overlay.handleInput("\x1b[6~"), text(overlay, 44);
  const end = text(overlay, 44);
  assert.notEqual(initial, end); assert.match(end, /REPAIR MANUALLY/);
  overlay.handleInput("\x1b[5~");
  assert.notEqual(text(overlay, 44), end);
  tab(overlay); // actions always reachable, even at end of detail
  assert.match(text(overlay, 44), /› Refresh/);
});

test("check navigation changes selected detail and resets detail scroll", () => {
  const { overlay } = screen(); text(overlay);
  overlay.handleInput("\x1b[A");
  assert.match(text(overlay), /Read-only evidence/);
  down(overlay);
  assert.match(text(overlay), /detail line 0/);
});

test("explicit action navigation returns only one choice; Esc does not select", () => {
  for (const [index, expected] of [[0, "refresh"], [1, "install"], [2, "open"], [3, "hide"]]) {
    const { overlay, choices } = screen(); text(overlay);
    enter(overlay); assert.deepEqual(choices, []);
    tab(overlay); tab(overlay);
    for (let n = 0; n < index; n++) down(overlay);
    enter(overlay); enter(overlay);
    assert.deepEqual(choices, [expected]);
  }
  const { overlay, choices } = screen(); text(overlay);
  overlay.handleInput("\x1b"); enter(overlay);
  assert.deepEqual(choices, ["close"]);
});

test("unsafe dimensions disable all actions, even after shrink, but Esc exits", () => {
  const { overlay, choices, resize } = screen();
  text(overlay); tab(overlay); tab(overlay); down(overlay);
  resize(8); enter(overlay); assert.deepEqual(choices, []);
  assert.match(text(overlay, 20), /cmdoctor/);
  enter(overlay); assert.deepEqual(choices, []);
  overlay.handleInput("\x1b"); assert.deepEqual(choices, ["close"]);
});

test("long Unicode/control-bearing diagnostics remain width-bounded", () => {
  const value = report(); value.checks[1].title = "界".repeat(120) + "\x1b[2J\nnext";
  const overlay = new DoctorOverlay(value, plain, { onDone() {}, terminalRows: () => 30 });
  assert.ok(overlay.render(44).every(line => visibleWidth(line) <= 44
    && !line.replace(/\x1b\[0m/g, "").includes("\x1b")), "only renderer-generated style resets are allowed, not diagnostic control sequences");
});

function command(deps = {}, mode = "tui") {
  let handler; const messages = [], effects = [];
  const handlers = new Map();
  const pi = { registerCommand: (_, spec) => { handler = spec.handler; }, sendMessage: (...args) => messages.push(args), exec: () => assert.fail("no real cmux calls"),
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event); } };
  let session = "id", file = "/fixture/session";
  const ctx = { mode, cwd: "/fixture", hasUI: true, sessionManager: { getSessionId: () => session, getSessionFile: () => file }, ui: { custom: () => assert.fail("use fixture overlay"), confirm: async () => assert.fail("no real prompt") } };
  doctor(pi, { collector: async () => report(), install: async () => { effects.push("install"); return "Installed fixture"; }, open: async () => { effects.push("open"); return "Opened fixture"; }, hide: async () => { effects.push("hide"); return "Hidden fixture"; }, ...deps });
  return { run: () => handler("", ctx), messages, effects, ctx, handlers, emit: event => handlers.get(event)?.(), change: (id, path = file) => { session = id; file = path; } };
}

test("opening, explicit refresh, and Esc do no effects; no implicit recollection", async () => {
  let collections = 0, menus = 0;
  const c = command({ collector: async () => { collections++; return report(); }, showOverlay: async (_, status) => {
    assert.equal(collections, menus + 1); menus++;
    if (menus === 1) { assert.equal(status, undefined); return "refresh"; }
    assert.match(status, /Refreshed read-only/); return "close";
  } });
  await c.run(); assert.equal(collections, 2); assert.deepEqual(c.effects, []); assert.deepEqual(c.messages, []);
});

test("overlay completes before confirmation and action; status re-shown without refresh", async () => {
  let inside = false, collections = 0, menus = 0;
  const c = command({ collector: async () => { collections++; return report(); }, showOverlay: async (_, status) => {
    inside = true; menus++;
    if (menus > 1) assert.match(status, /Cancelled/);
    inside = false; return menus === 1 ? "install" : "close";
  }, actionOptions: { confirm: async () => { assert.equal(inside, false); return false; } }, install: async options => {
    options.check(); assert.equal(inside, false);
    return await options.confirm("fixture", "fixture") ? "unexpected" : "Cancelled; no changes.";
  } });
  await c.run(); assert.equal(collections, 1); assert.deepEqual(c.effects, []); assert.equal(menus, 2);
});

for (const mode of ["rpc", "print", "json", "headless", undefined]) test(`text-only ${mode} sends no model turn`, async () => {
  const c = command({ showOverlay: async () => assert.fail("no terminal UI") }, mode);
  if (mode === undefined) delete c.ctx.mode;
  await c.run();
  assert.equal(c.messages.length, 1);
  assert.match(c.messages[0][0].content, /read-only diagnostics/);
  assert.deepEqual(c.messages[0][1], { triggerTurn: false });
  assert.deepEqual(c.effects, []);
});

test("hasUI false never attempts custom UI", async () => {
  const c = command({ showOverlay: async () => assert.fail("no terminal UI") });
  c.ctx.hasUI = false; await c.run();
  assert.match(c.messages[0][0].content, /read-only diagnostics/);
  assert.deepEqual(c.effects, []);
});

for (const action of ["open", "hide"]) test(`${action} receives invocation's original verified caller, not a refreshed replacement`, async () => {
  let collections = 0, menus = 0, opens = 0;
  const original = { window_id: "33333333-3333-4333-8333-333333333333", workspace_id: "11111111-1111-4111-8111-111111111111", surface_id: "22222222-2222-4222-8222-222222222222", pane_id: "44444444-4444-4444-8444-444444444444", workspace_ref: "workspace:1", surface_ref: "surface:1" };
  const c = command({ collector: async () => ({ ...report(), caller: ++collections === 1 ? original : { ...original, window_id: original.pane_id } }),
    showOverlay: async (_, status) => { menus++; if (menus === 3) assert.match(status, /uncertain/); return ["refresh", action, "close"][menus - 1]; },
    [action]: async (_, initial, options) => { options.check(); opens++; assert.deepEqual(initial, original); throw new Error("uncertain; not retried"); },
  });
  await c.run(); assert.equal(collections, 2); assert.equal(opens, 1); assert.equal(menus, 3);
});

test("custom UI unavailable retains diagnostic fallback, no effect", async () => {
  const c = command({ showOverlay: async () => { throw new Error("unsupported custom UI"); } });
  await c.run(); assert.match(c.messages[0][0].content, /Broken check/); assert.match(c.messages[0][0].content, /Custom UI unavailable/);
  assert.deepEqual(c.effects, []);
});

for (const target of ["id", "file"]) test(`session ${target} change while overlay awaits prevents action`, async () => {
  let c;
  c = command({ showOverlay: async () => { c.change(target === "id" ? "changed" : "id", target === "file" ? "/other" : "/fixture/session"); return "install"; } });
  await c.run(); assert.deepEqual(c.effects, []); assert.match(c.messages[0][0].content, /session changed/);
});

for (const event of ["session_start", "session_shutdown"]) test(`${event} invalidates a captured old context and releases temporary subscriptions`, async () => {
  let c;
  c = command({ showOverlay: async () => { c.emit(event); return "install"; } });
  await c.run();
  assert.deepEqual(c.effects, []);
  assert.match(c.messages[0][0].content, /session changed/);
  assert.equal(c.handlers.size, 0);
});

test("concurrent invocations cannot overlap menus/effects and lock is released", async () => {
  let release, menus = 0;
  const c = command({ showOverlay: () => { menus++; return new Promise(resolve => { release = resolve; }); } });
  const first = c.run();
  // Drain collector await without timers or real IO.
  await Promise.resolve(); await Promise.resolve();
  await c.run(); assert.equal(menus, 1); assert.match(c.messages[0][0].content, /already open/);
  release("close"); await first;
  const next = c.run(); await Promise.resolve(); await Promise.resolve();
  assert.equal(menus, 2); release("close"); await next;
});
