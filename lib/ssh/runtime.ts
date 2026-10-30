import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SSH_TARGET_ENTRY, matchesWorkspaceObservation, parseLocalContext, parseSshSessionRecord,
	parseSshTarget, parseWorkspaceAssociation, restoreSshTarget,
	type LocalContext, type SshSessionRecord, type SshTarget, type WorkspaceAssociation,
} from "./target.ts";

export type SshTargetState = "inactive" | "configured" | "ready" | "disconnected" | "disabled";
export type SshTargetReason = "invalid-context" | "invalid-saved-state" | "foreign-session" | "local-context-mismatch"
	| "invalid-target" | "persistence-error" | "validation-failed" | "association-mismatch" | "connection-lost" | "connection-pending";
export interface SshTargetSnapshot {
	readonly state: SshTargetState;
	readonly enabled: boolean;
	readonly context?: LocalContext;
	readonly target?: SshTarget;
	readonly association?: WorkspaceAssociation;
	readonly reason?: SshTargetReason;
}
declare const validationBrand: unique symbol;
declare const dispatchBrand: unique symbol;
interface TicketContext {
	readonly context: LocalContext;
	readonly target: SshTarget;
	readonly association?: WorkspaceAssociation;
	readonly signal: AbortSignal;
}
export interface ValidationTicket extends TicketContext { readonly [validationBrand]: true }
export interface DispatchTicket extends TicketContext { readonly [dispatchBrand]: true }
export type TargetPersistence = (customType: typeof SSH_TARGET_ENTRY, record: SshSessionRecord) => unknown;

/** Session-scoped state only: no SSH/cmux/filesystem calls or implicit activation.
 * activate() and beginValidation() are trusted explicit-current-action entry points,
 * NOT consent prompts. A restored record supplies intent, never a live ticket.
 * Persistence is synchronous (Pi appendEntry); thenables are refused fail-closed.
 * Mutations are non-reentrant; subscribers/abort handlers may inspect snapshots but
 * must schedule subsequent mutations. At most 32 change listeners, no history/queue.
 */
export class SshTargetRuntime {
	readonly #persist: TargetPersistence;
	#enabled = true;
	#state: SshTargetState = "inactive";
	#reason: SshTargetReason | undefined;
	#context: LocalContext | undefined;
	#target: SshTarget | undefined;
	#association: WorkspaceAssociation | undefined;
	#blocked = false;
	#busy = false;
	#generation = 0;
	#lifecycle = 0;
	/** Inspection only: observers must not capture dispatch tickets while a mutation is busy. */
	get generation(): number { return this.#generation; }
	get lifecycle(): number { return this.#lifecycle; }
	#controller = new AbortController();
	#validation: { ticket: ValidationTicket; generation: number; sessionId: string } | undefined;
	#dispatch = new WeakMap<DispatchTicket, { generation: number; sessionId: string }>();
	#listeners = new Set<(snapshot: SshTargetSnapshot) => void>();

	constructor(persist: TargetPersistence) { this.#persist = persist; }

	snapshot(): SshTargetSnapshot {
		return Object.freeze({ state: this.#state, enabled: this.#enabled,
			...(this.#context ? { context: Object.freeze({ ...this.#context }) } : {}),
			...(this.#target ? { target: Object.freeze({ ...this.#target }) } : {}),
			...(this.#association ? { association: Object.freeze({ ...this.#association }) } : {}),
			...(this.#reason ? { reason: this.#reason } : {}) });
	}
	subscribe(listener: (snapshot: SshTargetSnapshot) => void): () => void {
		if (typeof listener !== "function" || this.#listeners.size >= 32) throw new Error("SSH target subscription unavailable");
		this.#listeners.add(listener);
		return () => { this.#listeners.delete(listener); };
	}

	/** Session start, reload and tree navigation all reconstruct from the supplied branch. */
	startSession(context: unknown, entries: readonly unknown[]): void {
		this.#change(() => {
			this.#lifecycle++;
			this.#revoke();
			this.#context = undefined; this.#target = undefined; this.#association = undefined;
			this.#blocked = false; this.#reason = undefined;
			try { this.#context = parseLocalContext(context); }
			catch { this.#fail("invalid-context", true); return; }
			const restored = restoreSshTarget(this.#context, entries);
			if (restored.kind === "invalid") { this.#fail(restored.reason, true); return; }
			if (restored.kind === "pending") { this.#fail("connection-pending", true); return; }
			if (restored.kind === "target") { this.#target = restored.target; this.#association = restored.association; }
			this.#settle();
		});
	}

	/** Saves selection only. Even replacing a ready target with itself revokes all tickets. */
	activate(target: unknown, association?: unknown): void {
		this.#change(() => {
			if (!this.#enabled) throw new Error("SSH target integration is disabled");
			this.#revoke();
			try {
				const parsed = parseSshTarget(target);
				const pin = association === undefined ? undefined : parseWorkspaceAssociation(association);
				this.#target = parsed; this.#association = pin;
			} catch { this.#fail("invalid-target", true); throw new Error("Invalid SSH target selection"); }
			this.#save("target");
		});
	}

	/** Revoke old dispatch before resolving a current explicit connection request.
	 * No unresolved/placeholder target is persisted, and tools cannot fall back locally. */
	beginResolution(destination: string): AbortSignal {
		return this.#change(() => {
			if (!this.#enabled || !this.#context) throw new Error("SSH connection cannot be resolved");
			this.#revoke(); this.#target = undefined; this.#association = undefined;
			// Persist unresolved intent, not a placeholder target. A crash/reload
			// must not silently restore local execution or an older selection.
			this.#save("pending", destination);
			return this.#controller.signal;
		});
	}

	/** This is a new explicit validation action, never an automatic resume/reconnect. */
	beginValidation(): ValidationTicket {
		return this.#change(() => {
			if (!this.#enabled || !this.#context || !this.#target || this.#blocked) throw new Error("SSH target cannot be validated");
			this.#revoke(); this.#reason = undefined; this.#state = "configured";
			const ticket = Object.freeze(this.#ticketContext()) as ValidationTicket;
			this.#validation = { ticket, generation: this.#generation, sessionId: this.#context.sessionId };
			return ticket;
		});
	}

	/** False for stale/forged/cross-runtime callbacks, with no change to newer state. */
	completeValidation(ticket: ValidationTicket, observation?: unknown): boolean {
		return this.#change(() => {
			if (!this.#liveValidation(ticket)) return false;
			if (this.#association && !matchesWorkspaceObservation(this.#target!, this.#association, observation)) {
				this.#revoke(); this.#fail("association-mismatch"); return false;
			}
			this.#validation = undefined; this.#state = "ready"; this.#reason = undefined;
			return true;
		});
	}
	failValidation(ticket: ValidationTicket): boolean {
		return this.#change(() => {
			if (!this.#liveValidation(ticket)) return false;
			this.#revoke(); this.#fail("validation-failed"); return true;
		});
	}

	captureDispatch(): DispatchTicket {
		if (this.#busy || this.#state !== "ready" || !this.#enabled || this.#blocked || !this.#context || !this.#target) {
			throw new Error("SSH target is not ready for dispatch");
		}
		const ticket = Object.freeze(this.#ticketContext()) as DispatchTicket;
		this.#dispatch.set(ticket, { generation: this.#generation, sessionId: this.#context.sessionId });
		return ticket;
	}
	/** Check synchronously immediately before effects AND after relevant awaits.
	 * Aborting is a local cancellation request, not proof a remote writer stopped.
	 */
	assertDispatch(ticket: DispatchTicket): void {
		if (this.#busy || !this.#liveDispatch(ticket)) throw new Error("SSH dispatch ticket is no longer current");
	}

	/** Async observations must carry the dispatch ticket captured before their await.
	 * Matching evidence cannot restore readiness; mismatch never adopts another host.
	 * Native association checks and native effects are not atomic in this foundation.
	 */
	observeAssociation(ticket: DispatchTicket, observation: unknown): boolean {
		return this.#change(() => {
			if (!this.#liveDispatch(ticket)) return false;
			if (!this.#association || matchesWorkspaceObservation(this.#target!, this.#association, observation)) return true;
			this.#revoke(); this.#fail("association-mismatch"); return false;
		});
	}
	disconnect(): void {
		this.#change(() => { this.#revoke(); if (this.#target || this.#reason) this.#fail("connection-lost"); else this.#settle(); });
	}
	clear(): void {
		this.#change(() => { this.#revoke(); this.#save("clear"); });
	}
	setEnabled(enabled: boolean): void {
		if (typeof enabled !== "boolean") throw new Error("Invalid SSH target enablement");
		this.#change(() => {
			if (enabled === this.#enabled) return;
			this.#revoke(); this.#enabled = enabled;
			// Disconnection reasons survive enablement: absence of a target after a
			// bad restore must not turn into inactive/local fallback.
			this.#settle();
		});
	}
	shutdown(): void {
		this.#change(() => {
			this.#lifecycle++;
			this.#revoke(); this.#context = undefined; this.#target = undefined; this.#association = undefined;
			this.#reason = undefined; this.#blocked = false; this.#settle();
		});
	}

	#ticketContext(): TicketContext {
		return { context: this.#context!, target: this.#target!,
			...(this.#association ? { association: this.#association } : {}), signal: this.#controller.signal };
	}
	#liveValidation(ticket: ValidationTicket): boolean {
		const live = this.#validation;
		return !!live && live.ticket === ticket && live.generation === this.#generation && live.sessionId === this.#context?.sessionId
			&& this.#enabled && !this.#blocked && !this.#controller.signal.aborted;
	}
	#liveDispatch(ticket: DispatchTicket): boolean {
		const live = this.#dispatch.get(ticket);
		return !!live && live.generation === this.#generation && live.sessionId === this.#context?.sessionId
			&& this.#state === "ready" && this.#enabled && !this.#blocked && !this.#controller.signal.aborted;
	}
	#revoke(): void {
		this.#generation++; this.#validation = undefined;
		this.#dispatch = new WeakMap();
		const previous = this.#controller; this.#controller = new AbortController();
		previous.abort();
	}
	#fail(reason: SshTargetReason, blocked = false): void {
		this.#reason = reason; this.#blocked ||= blocked;
		this.#state = this.#enabled ? "disconnected" : "disabled";
	}
	#settle(): void {
		this.#state = !this.#enabled ? "disabled" : this.#reason ? "disconnected" : this.#target ? "configured" : "inactive";
	}
	#save(kind: "target" | "clear" | "pending", destination?: string): void {
		try {
			if (!this.#context) throw new Error("Missing context");
			const record = parseSshSessionRecord({ version: 1, ...this.#context, kind,
				...(kind === "target" ? { target: this.#target, ...(this.#association ? { association: this.#association } : {}) }
					: kind === "pending" ? { destination } : {}) });
			const result = this.#persist(SSH_TARGET_ENTRY, record);
			if (result && (typeof result === "object" || typeof result === "function") && "then" in result) {
				// Consume an accidental async rejection, but never treat it as a save.
				void Promise.resolve(result).catch(() => {});
				throw new Error("Asynchronous persistence unsupported");
			}
			if (kind !== "target") { this.#target = undefined; this.#association = undefined; }
			this.#blocked = false; this.#reason = kind === "pending" ? "connection-pending" : undefined; this.#settle();
		} catch {
			this.#revoke(); this.#fail("persistence-error", true);
			throw new Error("SSH target metadata could not be persisted");
		}
	}
	#change<T>(operation: () => T): T {
		if (this.#busy) throw new Error("SSH target mutation is not reentrant");
		this.#busy = true;
		const before = [this.#generation, this.#state, this.#enabled, this.#reason, this.#context, this.#target, this.#association];
		try { return operation(); }
		finally {
			const after = [this.#generation, this.#state, this.#enabled, this.#reason, this.#context, this.#target, this.#association];
			if (after.some((value, index) => value !== before[index])) {
				const snapshot = this.snapshot();
				for (const listener of [...this.#listeners]) {
					try { listener(snapshot); } catch { /* Observers cannot break state transitions. */ }
				}
			}
			this.#busy = false;
		}
	}
}

const runtimes = new WeakMap<ExtensionAPI, SshTargetRuntime>();
export function getSshTargetRuntime(pi: ExtensionAPI): SshTargetRuntime | undefined { return runtimes.get(pi); }

/** The bundle registers one inert runtime; selection and validation remain explicit. */
export function registerSshTarget(pi: ExtensionAPI): SshTargetRuntime {
	const existing = runtimes.get(pi);
	if (existing) return existing;
	const runtime = new SshTargetRuntime((type, record) => pi.appendEntry(type, record));
	runtimes.set(pi, runtime);
	const reset = (_event: unknown, ctx: ExtensionContext) => {
		try { runtime.startSession({ sessionId: ctx.sessionManager.getSessionId(), localCwd: ctx.cwd }, ctx.sessionManager.getBranch()); }
		catch { runtime.startSession(undefined, []); }
		if (runtime.snapshot().reason) ctx.ui.notify("SSH target unavailable; explicit selection or validation is required", "warning");
	};
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_shutdown", () => runtime.shutdown());
	return runtime;
}
