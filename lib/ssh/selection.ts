import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SshTargetRuntime, SshTargetSnapshot } from "./runtime.ts";
import { SSH_TARGET_ENTRY, parseLocalContext, parseSshSessionRecord, restoreSshTarget, type LocalContext } from "./target.ts";

export const SSH_SELECTION_ENTRY = "pi-cmux.ssh-tool-selection";
export const GUARDED_LOCAL_TOOLS = ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] as const;
export type GuardedLocalTool = typeof GUARDED_LOCAL_TOOLS[number];
const counterparts: Partial<Record<GuardedLocalTool, string>> = {
	read: "ssh_read", write: "ssh_write", edit: "ssh_edit", bash: "ssh_bash",
};
export const SSH_DATA_TOOLS = ["ssh_read", "ssh_write", "ssh_edit", "ssh_bash"] as const;
const guarded = (name: string): name is GuardedLocalTool => (GUARDED_LOCAL_TOOLS as readonly string[]).includes(name);
const remote = (name: string) => (SSH_DATA_TOOLS as readonly string[]).includes(name);
export type SshSelectionRecord = Readonly<LocalContext & { version: 1 } & (
	{ kind: "capture"; localTools: readonly GuardedLocalTool[]; exact: boolean }
	| { kind: "clear"; localTools?: readonly GuardedLocalTool[]; exact?: boolean }
)>;
function data(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)
		|| ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Invalid SSH selection metadata");
	const out: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw new Error("Invalid SSH selection metadata");
		const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
		if (!("value" in descriptor)) throw new Error("Invalid SSH selection metadata");
		out[key] = descriptor.value;
	}
	return out;
}
export function parseSshSelectionRecord(value: unknown): SshSelectionRecord {
	const v = data(value), owner = parseLocalContext(v);
	// Accept old clear tombstones, but new clears persist the known restored membership.
	const membership = v.kind === "capture" || "localTools" in v || "exact" in v;
	const keys = membership ? ["version", "sessionId", "localCwd", "kind", "localTools", "exact"]
		: ["version", "sessionId", "localCwd", "kind"];
	if (v.version !== 1 || !["capture", "clear"].includes(v.kind as string)
		|| Object.keys(v).sort().join() !== keys.sort().join()) throw new Error("Invalid SSH selection metadata");
	if (v.kind === "clear" && !membership) return Object.freeze({ version: 1, ...owner, kind: "clear" });
	if (typeof v.exact !== "boolean" || !Array.isArray(v.localTools)
		|| v.localTools.length > GUARDED_LOCAL_TOOLS.length) throw new Error("Invalid SSH selection metadata");
	// Copy own data elements only; never invoke getters from malformed transcript data.
	const names: GuardedLocalTool[] = [];
	for (let i = 0; i < v.localTools.length; i++) {
		const item = Object.getOwnPropertyDescriptor(v.localTools, String(i));
		if (!item || !("value" in item) || typeof item.value !== "string" || !guarded(item.value) || names.includes(item.value)) {
			throw new Error("Invalid SSH selection metadata");
		}
		names.push(item.value);
	}
	return Object.freeze({ version: 1, ...owner, kind: v.kind as "capture" | "clear", localTools: Object.freeze(names), exact: v.exact });
}
export type SelectionRestore = { kind: "missing" | "invalid" }
	| { kind: "clear"; record?: Extract<SshSelectionRecord, { kind: "clear" }>; restoreLocal?: boolean }
	| { kind: "capture"; record: Extract<SshSelectionRecord, { kind: "capture" }> };
/** Branch order matters: a target clear ends an episode even if its selection-clear write was lost. */
export function restoreSshSelection(owner: LocalContext, entries: readonly unknown[]): SelectionRestore {
	try {
		parseLocalContext(owner);
		if (!Array.isArray(entries)) return { kind: "invalid" };
		let newerToolDeclaration = false;
		for (let i = entries.length - 1; i >= 0; i--) {
			const raw = entries[i];
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
			const entry = data(raw);
			if (entry.type === "message") {
				const message = data(entry.message);
				if (message.role === "system" && [message.toolsAdded, message.toolsRemoved]
					.some(names => Array.isArray(names) && names.length > 0)) newerToolDeclaration = true;
			}
			if (entry.type !== "custom") continue;
			if (entry.customType === SSH_TARGET_ENTRY) {
				const record = parseSshSessionRecord(entry.data);
				if (record.sessionId !== owner.sessionId || record.localCwd !== owner.localCwd) return { kind: "invalid" };
				if (record.kind === "clear") return { kind: "clear" };
			}
			if (entry.customType !== SSH_SELECTION_ENTRY) continue;
			const record = parseSshSelectionRecord(entry.data);
			if (record.sessionId !== owner.sessionId || record.localCwd !== owner.localCwd) return { kind: "invalid" };
			return record.kind === "clear"
				? { kind: "clear", record, restoreLocal: !!record.localTools && !newerToolDeclaration }
				: { kind: "capture", record };
		}
		return { kind: "missing" };
	} catch { return { kind: "invalid" }; }
}
export function hasRemoteIntent(snapshot: SshTargetSnapshot): boolean {
	return !!snapshot.target || !!snapshot.reason || !["inactive", "disabled"].includes(snapshot.state);
}

/** Owns membership, not definitions. Observers inspect revisions and reconcile tools only:
 * no runtime mutations, ticket capture, transport, or promises while runtime is busy.
 * This is not a sandbox: already-admitted third-party work cannot be retroactively cancelled.
 */
export class SshToolSelectionController {
	#owner?: LocalContext;
	#live = false;
	#epoch = 0;
	#lifecycle = -1;
	#capture?: Extract<SshSelectionRecord, { kind: "capture" }>;
	#persisted = false;
	#pending = false;
	#admittedGeneration?: number;
	#problem?: string;
	#fault = false;
	private readonly pi: ExtensionAPI;
	readonly runtime: SshTargetRuntime;
	constructor(pi: ExtensionAPI, runtime: SshTargetRuntime) {
		this.pi = pi; this.runtime = runtime;
		runtime.subscribe(snapshot => {
			if (runtime.lifecycle !== this.#lifecycle) { this.close(); return; }
			if (snapshot.state !== "ready") this.#admittedGeneration = undefined;
			// Never rely on the runtime's swallowed observer errors for synchronization.
			try { this.reconcile(); }
			catch { this.#fault = true; this.#admittedGeneration = undefined; this.#problem = "SSH tool selection could not be synchronized; file/shell calls remain blocked"; }
		});
	}
	close(): void {
		this.#live = false; this.#epoch++; this.#owner = undefined; this.#capture = undefined;
		this.#persisted = false; this.#pending = false; this.#admittedGeneration = undefined;
		this.#fault = false; this.#problem = undefined;
	}
	start(ctx: ExtensionContext): void {
		this.close();
		const owner = parseLocalContext({ sessionId: ctx.sessionManager.getSessionId(), localCwd: ctx.cwd });
		const state = this.runtime.snapshot();
		if (state.context?.sessionId !== owner.sessionId || state.context.localCwd !== owner.localCwd) return;
		this.#owner = owner; this.#lifecycle = this.runtime.lifecycle; this.#live = true;
		const branch = ctx.sessionManager.getBranch();
		const saved = restoreSshSelection(owner, branch);
		if (hasRemoteIntent(state)) {
			if (saved.kind === "capture") { this.#capture = saved.record; this.#persisted = true; }
			else {
				// Legacy sessions can retain only membership actually reconstructed by Pi.
				// Invalid metadata cannot authorize even that inference.
				this.#capture = this.record(saved.kind === "missing" ? this.pi.getActiveTools().filter(guarded) : [], false);
			}
			if (!this.#capture.exact) this.#problem = "Exact pre-SSH tool selection is unavailable; clear restores only known local membership. Select any missing tools explicitly";
		} else if (saved.kind === "clear" && saved.restoreLocal && saved.record?.localTools
			&& restoreSshTarget(owner, branch).kind === "clear") {
			// setActiveTools is not durable until a request declares it. Recover a
			// clear performed after the transcript’s last tool delta, not an older one.
			try {
				const active = this.pi.getActiveTools().filter(name => !remote(name) && !guarded(name));
				this.pi.setActiveTools([...active, ...saved.record.localTools]);
				if (!saved.record.exact) this.#problem = "Exact local tool selection could not be restored; unknown/missing membership remains disabled";
			} catch (error) {
				this.#fault = true; this.#problem = "Cleared SSH tool selection could not be restored; file/shell admission remains blocked";
				throw error;
			}
		}
		this.reconcile(); this.report(ctx);
	}
	assertContext(ctx: ExtensionContext): void {
		const current = this.runtime.snapshot().context;
		if (!this.#live || this.runtime.lifecycle !== this.#lifecycle || !this.#owner || ctx.signal?.aborted
			|| ctx.cwd !== this.#owner.localCwd || ctx.sessionManager.getSessionId() !== this.#owner.sessionId
			|| current?.sessionId !== this.#owner.sessionId || current.localCwd !== this.#owner.localCwd) {
			throw new Error("SSH tool selection context is stale or shutting down");
		}
	}
	lease(ctx: ExtensionContext): () => void {
		this.assertContext(ctx); const epoch = this.#epoch;
		return () => { this.assertContext(ctx); if (epoch !== this.#epoch) throw new Error("SSH selection lifecycle changed"); };
	}
	isLocal(ctx: ExtensionContext): boolean {
		this.assertContext(ctx);
		return !this.#fault && !this.#pending && !hasRemoteIntent(this.runtime.snapshot());
	}
	/** Call after authorization/child branch eligibility, but before ANY supported connection effect. */
	prepare(ctx: ExtensionContext): void {
		this.assertContext(ctx);
		if (!this.runtime.snapshot().enabled) throw new Error("SSH integration is disabled");
		if (this.#fault) throw new Error("SSH selection is unavailable; clear explicitly before retrying");
		if (!this.#capture) {
			const local = !hasRemoteIntent(this.runtime.snapshot()) && !this.#pending;
			this.#capture = this.record(local ? this.pi.getActiveTools().filter(guarded) : [], local);
		}
		this.#pending = true;
		try {
			if (!this.#persisted) { this.save(this.#capture); this.#persisted = true; }
			this.reconcile();
		} catch {
			this.#fault = true;
			this.#problem = "SSH selection capture failed; connection was blocked. Use /ssh-clear to recover";
			throw new Error(this.#problem);
		}
	}
	assertUserShell(ctx: ExtensionContext): void {
		this.assertContext(ctx);
		if (this.#fault) throw new Error("SSH shell admission is blocked until tool selection is recovered with idle /ssh-clear");
	}
	assertRemote(name: string, ctx: ExtensionContext): void {
		this.assertContext(ctx);
		const snapshot = this.runtime.snapshot();
		if (this.#fault || snapshot.state !== "ready" || this.#admittedGeneration !== this.runtime.generation
			|| !this.mapped().includes(name) || !this.pi.getActiveTools().includes(name)) {
			throw new Error("SSH tool is not ready/selected for this generation; wait for a fresh model turn after connection and check tool filters");
		}
	}
	turnStart(ctx: ExtensionContext): void {
		this.assertContext(ctx);
		if (!this.#fault && this.runtime.snapshot().state === "ready") this.#admittedGeneration = this.runtime.generation;
		this.reconcile(); this.report(ctx);
	}
	clear(ctx: ExtensionContext): void {
		this.assertContext(ctx);
		// A redundant clear in ordinary local mode must not deselect local owners.
		const hadIntent = this.#pending || hasRemoteIntent(this.runtime.snapshot());
		const saved = this.#capture ?? this.record(hadIntent ? [] : this.pi.getActiveTools().filter(guarded), !hadIntent);
		this.#capture = saved;
		this.#pending = true; this.#admittedGeneration = undefined;
		try {
			// Revoke/persist the target tombstone first. Observers cannot restore any locals.
			this.runtime.clear();
			this.save({ version: 1, ...this.#owner!, kind: "clear", localTools: saved.localTools, exact: saved.exact });
			const active = this.pi.getActiveTools().filter(name => !remote(name) && !guarded(name));
			this.pi.setActiveTools([...active, ...saved.localTools]);
			if (!saved.exact) ctx.ui.notify("Exact local tool selection could not be restored; unknown/missing membership remains disabled", "warning");
			this.#capture = undefined; this.#persisted = false; this.#pending = false;
			this.#fault = false; this.#problem = undefined;
		} catch {
			this.#fault = true;
			this.#problem = "SSH clear/selection restoration failed; file/shell admission remains blocked. Retry idle /ssh-clear";
			throw new Error(this.#problem);
		}
	}
	reconcile(): void {
		if (!this.#live) return;
		try {
			const active = this.pi.getActiveTools();
			const intent = this.#pending || hasRemoteIntent(this.runtime.snapshot());
			// Pi snapshots declarations before turn_start. Publish membership on
			// readiness; assertRemote independently gates this response batch’s effects.
			const canDeclare = !this.#fault && this.runtime.snapshot().state === "ready";
			const expected = intent && canDeclare ? this.mapped() : [];
			const next = [...active.filter(name => !remote(name) && !(intent && guarded(name))), ...expected];
			if (next.length !== active.length || next.some(name => !active.includes(name))) this.pi.setActiveTools(next);
			if (expected.some(name => !this.pi.getActiveTools().includes(name))) {
				this.#admittedGeneration = undefined;
				this.#problem = "Required SSH counterparts are filtered, hidden or unavailable; file/shell calls remain blocked. Check Pi tool configuration or /ssh-clear";
				this.pi.setActiveTools(this.pi.getActiveTools().filter(name => !remote(name) && !guarded(name)));
			}
		} catch (error) {
			// Hooks can be logged/continued by Pi too, so failed synchronization must
			// revoke our own admission before any observer or hook returns/throws.
			this.#fault = true; this.#admittedGeneration = undefined;
			this.#problem = "SSH tool selection could not be synchronized; file/shell calls remain blocked";
			throw error;
		}
	}
	report(ctx: ExtensionContext): void { if (this.#problem) ctx.ui.notify(this.#problem, "warning"); }
	private mapped(): string[] { return (this.#capture?.localTools ?? []).flatMap(name => counterparts[name] ? [counterparts[name]!] : []); }
	private record(localTools: readonly GuardedLocalTool[], exact: boolean): Extract<SshSelectionRecord, { kind: "capture" }> {
		return parseSshSelectionRecord({ version: 1, ...this.#owner!, kind: "capture", localTools, exact }) as Extract<SshSelectionRecord, { kind: "capture" }>;
	}
	private save(record: SshSelectionRecord): void {
		const result: unknown = this.pi.appendEntry(SSH_SELECTION_ENTRY, parseSshSelectionRecord(record));
		if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
			void Promise.resolve(result).catch(() => {});
			throw new Error("Synchronous SSH selection persistence required");
		}
	}
}

export function registerSshSelection(pi: ExtensionAPI, runtime: SshTargetRuntime): SshToolSelectionController {
	const controller = new SshToolSelectionController(pi, runtime);
	pi.on("session_start", (_event, ctx) => controller.start(ctx));
	pi.on("session_tree", (_event, ctx) => controller.start(ctx));
	pi.on("session_shutdown", () => controller.close());
	pi.on("turn_start", (_event, ctx) => controller.turnStart(ctx));
	pi.on("before_agent_start", (_event, ctx) => { controller.assertContext(ctx); controller.reconcile(); controller.report(ctx); });
	pi.on("tool_call", (event, ctx) => {
		if (!guarded(event.toolName)) return;
		try { if (controller.isLocal(ctx)) return; } catch { /* Stale local contexts also fail closed. */ }
		return { block: true, reason: "Local file/shell calls are blocked by SSH intent or a stale lifecycle; use selected ready SSH tools or idle /ssh-clear" };
	});
	return controller;
}
