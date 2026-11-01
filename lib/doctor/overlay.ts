import { Key, matchesKey, SelectList, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { DoctorReport, DoctorStatus } from "../../extensions/cmux-doctor.ts";

export type DoctorChoice = "refresh" | "install" | "open" | "hide" | "close";
export interface DoctorStyle {
	accent(text: string): string;
	muted(text: string): string;
	dim(text: string): string;
	bold(text: string): string;
	status(status: DoctorStatus, text: string): string;
}
/** Structural adapter keeps captures independent of Pi runtime/theme loading. */
export function doctorStyle(theme: { fg(color: "accent" | "muted" | "dim" | "success" | "warning" | "error", text: string): string; bold(text: string): string }): DoctorStyle {
	return {
		accent: text => theme.fg("accent", text), muted: text => theme.fg("muted", text),
		dim: text => theme.fg("dim", text), bold: text => theme.bold(text),
		status: (status, text) => theme.fg(status === "ok" ? "success" : status === "unverified" ? "muted" : status, text),
	};
}
export interface DoctorOverlayOptions {
	terminalRows?: () => number;
	requestRender?: () => void;
	onDone: (choice: DoctorChoice) => void;
	status?: string;
}
const labels: Record<DoctorStatus, string> = { ok: "OK", warning: "warning", error: "error", unverified: "unverified" };
const actions = ["refresh", "install", "open", "hide"] as const;
// Diagnostics may contain untrusted CLI/file strings. Never render terminal controls.
const clean = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "").replace(/\t/g, "  ");

/** No IO, timers or effects: input only returns a choice. The owner disposes this
 * component via custom()'s done callback before confirmations/effects occur. */
export class DoctorOverlay {
	private selected: number;
	private detailOffset = 0;
	private detailLimit = 0;
	private detailPage = 1;
	private focus: "checks" | "details" | "actions" = "checks";
	private action = 0;
	private safe = false;
	private completed = false;
	readonly report: DoctorReport;
	readonly style: DoctorStyle;
	readonly options: DoctorOverlayOptions;
	constructor(report: DoctorReport, style: DoctorStyle, options: DoctorOverlayOptions) {
		this.report = report;
		this.style = style;
		this.options = options;
		this.selected = Math.max(0, report.checks.findIndex(check => check.status === "error"));
	}
	invalidate(): void { /* Rendering is derived from current width/rows every time. */ }
	private finish(choice: DoctorChoice): void {
		if (!this.completed) { this.completed = true; this.options.onDone(choice); }
	}
	handleInput(data: string): void {
		if (this.completed) return;
		if (matchesKey(data, Key.escape)) { this.finish("close"); return; }
		if (!this.safe || (this.options.terminalRows?.() ?? process.stdout.rows ?? 24) < 18) return;
		if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab"))) {
			const order = ["checks", "details", "actions"] as const;
			this.focus = order[(order.indexOf(this.focus) + (matchesKey(data, Key.shift("tab")) ? 2 : 1)) % 3]!;
		} else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.pageUp)) {
			this.detailOffset = Math.max(0, Math.min(this.detailLimit, this.detailOffset + (matchesKey(data, Key.pageDown) ? 1 : -1) * this.detailPage));
		} else if (matchesKey(data, Key.up) || matchesKey(data, Key.down) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
			const delta = matchesKey(data, Key.up) || matchesKey(data, Key.left) ? -1 : 1;
			if (this.focus === "checks") {
				this.selected = Math.max(0, Math.min(this.report.checks.length - 1, this.selected + delta));
				this.detailOffset = 0;
			} else if (this.focus === "details") this.detailOffset = Math.max(0, Math.min(this.detailLimit, this.detailOffset + delta));
			else this.action = (this.action + delta + actions.length) % actions.length;
		} else if (matchesKey(data, Key.enter) && this.focus === "actions") {
			this.finish(actions[this.action]!); return;
		}
		this.options.requestRender?.();
	}
	render(width: number): string[] {
		width = Math.max(1, Math.floor(width));
		const height = Math.max(1, Math.min(32, Math.floor((this.options.terminalRows?.() ?? process.stdout.rows ?? 24) * .85)));
		this.safe = width >= 42 && height >= 15;
		if (!this.safe) return ["cmdoctor: too small (need 42×18)", "Esc close; actions disabled"].slice(0, height).map(line => truncateToWidth(line, width));
		const s = this.style, inner = width - 4;
		const fit = (text: string, size: number) => {
			const clipped = truncateToWidth(text, size);
			return clipped + " ".repeat(Math.max(0, size - visibleWidth(clipped)));
		};
		const row = (text: string) => s.muted("│ ") + fit(text, inner) + s.muted(" │");
		const rule = () => s.muted("├" + "─".repeat(width - 2) + "┤");
		const bodyHeight = height - 10;
		const wide = inner >= 78;
		const leftWidth = wide ? Math.floor((inner - 3) * .44) : inner;
		const detailWidth = wide ? inner - leftWidth - 3 : inner;
		const listHeight = wide ? bodyHeight : Math.max(1, Math.floor((bodyHeight - 2) / 2));
		const detailHeight = wide ? bodyHeight : bodyHeight - listHeight - 1;
		const items = this.report.checks.map((check, index) => ({ value: String(index), label: `[${labels[check.status]}] ${clean(check.title).replace(/\n/g, " ")}` }));
		const list = new SelectList(items, listHeight, {
			selectedPrefix: text => this.focus === "checks" ? s.accent(text) : s.muted(text),
			selectedText: text => s.accent(text), description: text => s.dim(text),
			scrollInfo: text => s.muted(text), noMatch: text => s.muted(text),
		});
		list.setSelectedIndex(this.selected);
		const left = list.render(leftWidth).slice(0, listHeight);
		while (left.length < listHeight) left.push("");
		const check = this.report.checks[this.selected];
		const detailText = (this.options.status ? s.accent("Last action: ") + clean(this.options.status) + "\n\n" : "") + (check ? [s.status(check.status, `[${labels[check.status]}] `) + s.bold(clean(check.title)), clean(check.detail), "", s.accent("Remediation"), clean(check.remediation ?? "No remediation required; no effect performed.")].join("\n") : "No diagnostic checks.");
		const details = wrapTextWithAnsi(detailText, detailWidth);
		this.detailPage = Math.max(1, detailHeight - 1);
		this.detailLimit = Math.max(0, details.length - this.detailPage);
		this.detailOffset = Math.min(this.detailOffset, this.detailLimit);
		const right = details.slice(this.detailOffset, this.detailOffset + this.detailPage);
		while (right.length < this.detailPage) right.push("");
		right.push(s.dim(`${this.focus === "details" ? "› " : ""}Details ${this.detailOffset + 1}/${details.length} · PgUp/PgDn`));
		const body = wide ? left.map((line, index) => fit(line, leftWidth) + s.muted(" │ ") + fit(right[index] ?? "", detailWidth))
			: [...left, s.muted("─".repeat(inner)), ...right];
		const counts = (["ok", "warning", "error", "unverified"] as const).map(status => s.status(status, `${labels[status]}:${this.report.checks.filter(check => check.status === status).length}`)).join(" ");
		const installed = this.report.checks.find(check => check.title === "Installed panel");
		const installLabel = installed?.detail.includes(": missing") ? "Install panel" : "Install/update panel";
		return [
			s.muted("╭" + "─".repeat(width - 2) + "╮"),
			row(s.accent(s.bold("cmdoctor")) + s.dim(` · autoOpen=${this.report.autoOpen.autoOpen} · read-only checks`)),
			row(s.muted(counts)), ...body.map(row), rule(),
			...(["Refresh (read-only)", installLabel, "Show Pi Agents (no focus)", "Hide right sidebar"]).map((label, index) => row((this.focus === "actions" && this.action === index ? s.accent("› " + label) : s.muted("  " + label)))),
			row(s.dim("Tab focus ↑↓ Enter act Esc close")),
			s.muted("╰" + "─".repeat(width - 2) + "╯"),
		];
	}
}
