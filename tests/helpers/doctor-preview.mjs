// Capture fixture only: no cmux access, settings reads, or filesystem actions.
// node tests/helpers/doctor-preview.mjs [columns=96] [rows=32]
import { DoctorOverlay, doctorStyle } from "../../lib/doctor/overlay.ts";

const width = Number(process.argv[2] || 96), rows = Number(process.argv[3] || 32);
const colors = { accent: 81, muted: 245, dim: 240, success: 114, warning: 214, error: 203 };
const style = doctorStyle({
  fg: (color, text) => `\x1b[38;5;${colors[color]}m${text}\x1b[0m`,
  bold: text => `\x1b[1m${text}\x1b[22m`,
});
const report = { autoOpen: { autoOpen: false, source: "default", errors: [] }, checks: [
  { status: "ok", title: "cmux executable", detail: "/opt/homebrew/bin/cmux" },
  { status: "ok", title: "cmux version", detail: "cmux 0.65.2 (113)" },
  { status: "error", title: "Required RPC: Messaging", detail: "Missing/unsupported advertised methods: agent.message.send, agent.message.settings.\n\nOther capability groups are advertised. No workflow was launched.", remediation: "Upgrade to a compatible cmux build, then choose Refresh. Advertisement does not establish behavior or permissions." },
  { status: "ok", title: "Caller/locality", detail: "Exact local caller verified." },
  { status: "warning", title: "Installed panel", detail: "/fixture/agent-state-panel.js: modified; sha256=fixture", remediation: "Inspect user changes before a confirmed update. The previous copy is backed up." },
  { status: "unverified", title: "Custom sidebar availability", detail: "Beta state is not observable through the current CLI contract." },
  { status: "ok", title: "pi-cmux.panel.autoOpen", detail: "false; source=default. Doctor never edits settings." },
] };
let closed = false;
const overlay = new DoctorOverlay(report, style, {
  terminalRows: () => rows,
  onDone(choice) { closed = true; process.stdout.write(`\x1b[0m\x1b[?25h\nFixture choice: ${choice} (no action)\n`); process.exit(0); },
  requestRender: render,
});
function render() {
  if (!closed) process.stdout.write("\x1b[2J\x1b[H\x1b[?25l" + overlay.render(width).join("\r\n"));
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.on("data", data => {
  if (data.toString() === "\x03") process.exit(0);
  overlay.handleInput(data.toString());
});
process.on("exit", () => process.stdout.write("\x1b[0m\x1b[?25h"));
render();
