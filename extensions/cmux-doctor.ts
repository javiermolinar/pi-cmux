import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { getCallerInfo, resolvePathExecutable, type CmuxCallerContext } from "./cmux-core.ts";
import { hideDoctorPanel, installDoctorPanel, openDoctorPanel, type DoctorActionOptions } from "../lib/doctor/actions.ts";
import type { DoctorChoice, DoctorOverlayOptions } from "../lib/doctor/overlay.ts";
import { assertLocalWorkspace } from "../lib/ssh/terminal.ts";
import { uuid } from "../lib/orientation/state.ts";
import { METHODS as MESSAGING_METHODS } from "../lib/messaging/client.ts";
import { inspectInstalledPanel } from "../lib/panel-install.mjs";
import { resolvePanelSettings, type PanelSettingsResolution } from "../lib/panel-settings.ts";

export type DoctorStatus = "ok" | "warning" | "error" | "unverified";
export interface DoctorCheck {
	status: DoctorStatus;
	title: string;
	detail: string;
	remediation?: string;
}
export interface DoctorReport {
	checks: DoctorCheck[];
	autoOpen: PanelSettingsResolution;
	/** Present only after exact environment identity and local ownership checks. */
	caller?: CmuxCallerContext;
}
export interface DoctorOptions {
	/** Explicit paths support isolated fixtures without changing process HOME. */
	agentDir?: string;
	sidebarDir?: string;
	env?: NodeJS.ProcessEnv;
}

/** Advertisement requirements only: these checks never exercise mutating methods. */
export const REQUIRED_DOCTOR_METHODS: Readonly<Record<string, readonly string[]>> = {
	"Identity/locality": ["system.identify", "workspace.list"],
	"Surfaces/workspaces": ["workspace.create", "workspace.rename", "workspace.select", "pane.list", "surface.list", "surface.create", "surface.split", "surface.respawn", "surface.focus", "tab.action"],
	"Browser": ["pane.create", "browser.eval", "browser.design_mode.status"],
	"Messaging": MESSAGING_METHODS,
	"Sidebar data": ["extension.sidebar.snapshot"],
	// /cmbk and /cm discover/revalidate targets through `tree --all`.
	"Layout/navigation": ["system.tree"],
	"Notifications (opt-in)": ["notification.create"],
	"Sidebar flash (optional)": ["surface.trigger_flash"],
};
const REQUIRED_DOCTOR_CAPABILITIES: Readonly<Record<string, readonly string[]>> = {
	"Browser annotation event stream": ["events.v1"],
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string" && item.trim().length > 0);
}
const probeRemediation = "Check cmux installation/PATH, running app, socket access and authentication; rerun /cmdoctor. No repair was attempted.";

/** Read-only collection. No probes or filesystem access occur until explicitly called. */
export async function collectDoctorReport(pi: ExtensionAPI, cwd: string, options: DoctorOptions = {}): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const add = (status: DoctorStatus, title: string, detail: string, remediation?: string) => checks.push({ status, title, detail, ...(remediation ? { remediation } : {}) });
	// Preserve the command, exit status, killed flag and both streams, unlike a boolean health check.
	async function probe(args: string[]): Promise<string | undefined> {
		const title = `Probe: cmux ${args.join(" ")}`;
		try {
			const result = await pi.exec("cmux", args, { timeout: 5000 });
			if (result.killed || result.code !== 0) {
				add("error", title, `exit=${result.code}; killed=${result.killed} (timeout limit 5000ms). stderr: ${result.stderr || "(empty)"}; stdout: ${result.stdout || "(empty)"}`, probeRemediation);
				return undefined;
			}
			// Do not turn ambiguous CLI/socket errors into a healthy capability check.
			if (result.stderr.trim()) {
				add("error", title, `exit=0 but probe emitted stderr: ${result.stderr}; stdout: ${result.stdout || "(empty)"}`, probeRemediation);
				return undefined;
			}
			if (result.stdout.length > 1_048_576) throw new Error("Response exceeds 1 MiB inspection limit");
			return result.stdout;
		} catch (error) {
			add("error", title, message(error), probeRemediation);
			return undefined;
		}
	}

	try { add("ok", "cmux executable", resolvePathExecutable("cmux", "Diagnostics")); }
	catch (error) { add("error", "cmux executable", message(error), "Install cmux and expose its executable on the Pi process PATH."); }
	const version = await probe(["--version"]);
	if (version !== undefined) add(version.trim() ? "ok" : "unverified", "cmux version", version.trim() || "Empty version response", version.trim() ? undefined : probeRemediation);

	let methods: string[] | undefined;
	let advertisedCapabilities: string[] | undefined;
	const capabilities = await probe(["--json", "rpc", "system.capabilities", "{}"]);
	if (capabilities !== undefined) {
		try {
			const data: unknown = JSON.parse(capabilities);
			if (!object(data) || !(typeof data.protocol === "string" || typeof data.protocol === "number")
				|| !String(data.protocol).trim()
				|| !(typeof data.version === "string" && data.version.trim()
					|| typeof data.version === "number" && Number.isInteger(data.version) && data.version > 0)
				|| !strings(data.methods) || !strings(data.capabilities)
				|| typeof data.access_mode !== "string" || !data.access_mode.trim()
				|| typeof data.socket_path !== "string" || !data.socket_path.trim()) {
				throw new Error("Unexpected system.capabilities shape; expected {protocol,version,methods:string[],capabilities:string[],access_mode,socket_path}");
			}
			methods = data.methods;
			advertisedCapabilities = data.capabilities;
			add("ok", "Capability query", `protocol=${data.protocol}; version=${data.version}; access_mode=${data.access_mode}; socket_path=${data.socket_path}. Advertised methods only, not verified behavior or authorization.`);
		} catch (error) {
			add("error", "Capability query response", `${message(error)}; observed: ${capabilities}`, "Use a cmux version exposing the native system.capabilities response; inspect the reported response before retrying.");
		}
	}
	for (const [group, required] of Object.entries(REQUIRED_DOCTOR_METHODS)) {
		const missing = methods ? required.filter(method => !methods.includes(method)) : [];
		add(!methods ? "unverified" : missing.length ? "error" : "ok", `Required RPC: ${group}`,
			!methods ? `No valid capability evidence. Required: ${required.join(", ")}`
				: missing.length ? `Missing/unsupported advertised methods: ${missing.join(", ")}`
				: `Advertised: ${required.join(", ")}. Behavior and permissions not exercised.`,
			!methods ? probeRemediation : missing.length ? "Upgrade/use a compatible cmux build; affected workflows are unsupported by this advertisement." : undefined);
	}

	for (const [group, required] of Object.entries(REQUIRED_DOCTOR_CAPABILITIES)) {
		const missing = advertisedCapabilities ? required.filter(capability => !advertisedCapabilities.includes(capability)) : [];
		add(!advertisedCapabilities ? "unverified" : missing.length ? "error" : "ok", `Required capability: ${group}`,
			!advertisedCapabilities ? `No valid capability evidence. Required: ${required.join(", ")}`
				: missing.length ? `Missing/unsupported advertised capabilities: ${missing.join(", ")}`
				: `Advertised: ${required.join(", ")}. Browser annotations use cmux events with the version-1 stream; CLI flags, stream behavior and permissions were not exercised.`,
			!advertisedCapabilities ? probeRemediation : missing.length ? "Use a cmux build supporting the version-1 event stream for browser annotations; no stream or workflow was started." : undefined);
	}
	// Legacy status/progress/log verbs have no known RPC advertisement contract.
	// Do not guess workspace.status (task lanes) or run mutating support probes.
	add("unverified", "CLI support: Sidebar status/progress/log",
		"set-status, clear-status, log, set-progress and clear-progress are used by sidebar status/token workflows. Their CLI/server compatibility is not established by system.capabilities; these legacy commands are unverified. notify (opt-in) and trigger-flash (optional) CLI flags likewise are not exercised by their native RPC advertisements.",
		"Check cmux CLI/version compatibility when sidebar feedback or notifications fail. No status, progress, log, notification or flash was emitted to test support.");

	let verifiedCaller: CmuxCallerContext | undefined;
	const env = options.env ?? process.env;
	const workspaceId = uuid(env.CMUX_WORKSPACE_ID), surfaceId = uuid(env.CMUX_SURFACE_ID);
	if (!workspaceId || !surfaceId) {
		add("unverified", "Caller/locality", "CMUX_WORKSPACE_ID or CMUX_SURFACE_ID is absent or not a UUID.", "Invoke from a local cmux terminal; inherited socket access alone does not verify a caller.");
	} else {
		try {
			const identified = await getCallerInfo(pi);
			if (!identified.ok) throw new Error(identified.error);
			const caller = identified.caller;
			if (!uuid(caller.window_id) || !uuid(caller.pane_id) || caller.workspace_id !== workspaceId || caller.surface_id !== surfaceId
				|| (env.CMUX_WINDOW_ID !== undefined && uuid(env.CMUX_WINDOW_ID) !== caller.window_id)
				|| (env.CMUX_PANE_ID !== undefined && uuid(env.CMUX_PANE_ID) !== caller.pane_id)) {
				throw new Error("Identified caller does not match exact CMUX environment UUIDs (or lacks window/pane UUIDs)");
			}
			await assertLocalWorkspace(pi, caller);
			if (uuid(env.CMUX_WORKSPACE_ID) !== workspaceId || uuid(env.CMUX_SURFACE_ID) !== surfaceId
				|| (env.CMUX_WINDOW_ID !== undefined && uuid(env.CMUX_WINDOW_ID) !== caller.window_id)
				|| (env.CMUX_PANE_ID !== undefined && uuid(env.CMUX_PANE_ID) !== caller.pane_id)) throw new Error("Caller environment changed during verification");
			verifiedCaller = { ...caller };
			add("ok", "Caller/locality", `Verified local workspace ${workspaceId}, surface ${surfaceId}.`);
		} catch (error) {
			add("unverified", "Caller/locality", message(error), "Use a verified local cmux surface. Remote, stale or ambiguous placement is unsupported; no workflow was launched.");
		}
	}

	const target = join(options.sidebarDir ?? join(homedir(), ".config", "cmux", "sidebars"), "agent-state-panel.js");
	try {
		const panel = inspectInstalledPanel(target);
		add(panel.status === "current" ? "ok" : "warning", "Installed panel", `${target}: ${panel.status}${panel.version === undefined ? "" : `; managed version=${panel.version}`}${panel.hash ? `; sha256=${panel.hash}` : ""}${panel.kind ? `; ${panel.kind}` : ""}. File inspected as text only.`,
			panel.status === "current" ? undefined : "Install/update the bundled panel explicitly; inspect and preserve modified files before replacement. No files were changed.");
	} catch (error) { add("error", "Installed panel", `${target}: ${message(error)}`, "Check file readability; installed JavaScript was not evaluated."); }

	const templates = await probe(["sidebar", "templates", "--json"]);
	if (templates !== undefined) {
		try {
			JSON.parse(templates);
			add("unverified", "Custom sidebar availability", "Template query returned JSON, but no verified schema/beta-state contract is available. CLI right-sidebar support is not an advertised RPC method.", "Check custom-sidebar beta availability in cmux manually; no installed JavaScript was evaluated.");
		} catch (error) { add("error", "Custom sidebar availability", `Malformed template JSON: ${message(error)}; observed: ${templates}`, "Check cmux custom-sidebar support/version manually."); }
	} else add("unverified", "Custom sidebar availability", "Template probe failed; availability is not established.", "See probe error above; check cmux custom-sidebar beta support manually.");
	const autoOpen = resolvePanelSettings(cwd, { agentDir: options.agentDir });
	add(autoOpen.errors.length ? "error" : "ok", "pi-cmux.panel.autoOpen", `${autoOpen.autoOpen}; source=${autoOpen.source}${autoOpen.path ? ` (${autoOpen.path})` : " (default false)"}. Global then project; project boolean overrides global.${autoOpen.errors.map(error => ` ${error.path}: ${error.detail}`).join("")}`,
		`${autoOpen.errors.length ? "Correct invalid/unreadable settings explicitly; auto-open fails closed. " : ""}Configure explicitly in global agent settings.json or project .pi/settings.json: {\"pi-cmux\":{\"panel\":{\"autoOpen\":true}}}. Default is false. Doctor never edits settings.`);
	return { checks, autoOpen, ...(verifiedCaller ? { caller: verifiedCaller } : {}) };
}

export function formatDoctorReport(report: DoctorReport): string {
	return ["cmdoctor — read-only diagnostics", ...report.checks.map(check =>
		`[${check.status}] ${check.title}: ${check.detail}${check.remediation ? `\n  Next: ${check.remediation}` : ""}`)].join("\n");
}

export interface DoctorDependencies {
	collector?: typeof collectDoctorReport;
	collectorOptions?: DoctorOptions;
	uiOptions?: Pick<DoctorOverlayOptions, "terminalRows">;
	/** Fixture seam; never called outside interactive TUI mode. */
	showOverlay?: (report: DoctorReport, status?: string) => Promise<DoctorChoice>;
	actionOptions?: Partial<DoctorActionOptions>;
	install?: typeof installDoctorPanel;
	open?: typeof openDoctorPanel;
	hide?: typeof hideDoctorPanel;
}
const activeDoctors = new WeakSet<ExtensionAPI>();

/** Human command only: no hooks, tools, probes or effects at registration. */
export default function cmuxDoctorExtension(pi: ExtensionAPI, deps: DoctorDependencies = {}): void {
	pi.registerCommand("cmdoctor", {
		description: "cmux diagnostics and explicit panel actions",
		handler: async (_args, ctx) => {
			const text = (value: string) => pi.sendMessage({ customType: "cmux-doctor", content: value, display: true }, { triggerTurn: false });
			if (activeDoctors.has(pi)) { text("cmdoctor is already open; no action performed."); return; }
			activeDoctors.add(pi);
			const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile(), cwd = ctx.cwd;
			let invalidated = false;
			const unsubscribe: (() => void)[] = [];
			const check = () => {
				if (invalidated) throw new Error("Doctor session changed; no further actions allowed");
				(ctx as unknown as { signal?: AbortSignal }).signal?.throwIfAborted();
				if (ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== sessionId || ctx.sessionManager.getSessionFile() !== sessionFile) {
					throw new Error("Doctor session changed; no further actions allowed");
				}
			};
			try {
				// A replaced session can leave the captured context pointing at its old
				// SessionManager. Temporary lifecycle subscriptions fence that case too.
				unsubscribe.push(pi.on("session_start", () => { invalidated = true; }));
				unsubscribe.push(pi.on("session_shutdown", () => { invalidated = true; }));
				const collect = () => (deps.collector ?? collectDoctorReport)(pi, cwd, deps.collectorOptions);
				let report = await collect();
				check();
				const initialCaller = report.caller ? { ...report.caller } : undefined;
				// Explicit allow-list: no terminal components in RPC/print/JSON/headless.
				if ((ctx as unknown as { mode?: string }).mode !== "tui" || !ctx.hasUI || typeof ctx.ui.custom !== "function") {
					text(formatDoctorReport(report)); return;
				}
				let status: string | undefined;
				for (;;) {
					check();
					let choice: DoctorChoice;
					try {
						if (deps.showOverlay) choice = await deps.showOverlay(report, status);
						else {
							const { DoctorOverlay, doctorStyle } = await import("../lib/doctor/overlay.ts");
							check();
							choice = await ctx.ui.custom<DoctorChoice>((tui, theme, _keys, done) => new DoctorOverlay(report, doctorStyle(theme), {
								...deps.uiOptions, status, onDone: done, requestRender: () => tui.requestRender(),
							}), { overlay: true, overlayOptions: { width: 96, maxHeight: "85%", anchor: "center", margin: 1 } });
						}
					} catch (error) {
						check();
						text(`${formatDoctorReport(report)}\nCustom UI unavailable: ${message(error)}`); return;
					}
					check();
					if (!choice || choice === "close") return;
					if (choice === "refresh") {
						report = await collect(); check(); status = "Refreshed read-only diagnostics."; continue;
					}
					// custom() has completed/disposed the overlay. Prompts/effects are outside it.
					const injectedCheck = deps.actionOptions?.check;
					const options: DoctorActionOptions = {
						sidebarDir: deps.collectorOptions?.sidebarDir, env: deps.collectorOptions?.env,
						...deps.actionOptions,
						check: () => { check(); injectedCheck?.(); },
						confirm: deps.actionOptions?.confirm ?? ((title, detail) => ctx.ui.confirm(title, detail)),
					};
					try {
						if (choice === "install") status = await (deps.install ?? installDoctorPanel)(options);
						else if (choice === "open") status = await (deps.open ?? openDoctorPanel)(pi, initialCaller, options);
						else if (choice === "hide") status = await (deps.hide ?? hideDoctorPanel)(pi, initialCaller, options);
						check();
					} catch (error) {
						try { check(); }
						catch (stale) { throw new Error(`${message(stale)}. Last action outcome may be uncertain: ${message(error)}`); }
						status = message(error);
					}
				}
			} catch (error) { text(`cmdoctor stopped: ${message(error)}. No automatic retry.`); }
			finally {
				for (const dispose of unsubscribe) dispose();
				activeDoctors.delete(pi);
			}
		},
	});
}
