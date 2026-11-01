import { isIP } from "node:net";
import { isAbsolute } from "node:path";

export const SSH_TARGET_ENTRY = "pi-cmux.ssh-target";
export type SshBackend = "native-ssh" | "legacy-relay" | "tmux-mirror";
export interface SshTarget { readonly destination: string; readonly remoteCwd: string }
/** Normalized request intent only; `~` must resolve before creating a saved target. */
export interface SshConnectRequest { readonly destination: string; readonly remoteCwd: string }
export interface LocalContext { readonly sessionId: string; readonly localCwd: string }
export interface WorkspaceAssociation { readonly workspaceId: string; readonly backend: SshBackend }
/** Normalized evidence from a trusted adapter, not a raw cmux response or activation request. */
export interface WorkspaceObservation extends WorkspaceAssociation {
	readonly destination: string;
	readonly enabled: boolean;
	readonly transport: "ssh";
	readonly connected: boolean;
}
export type SshSessionRecord = Readonly<LocalContext & { version: 1 } & (
	{ kind: "target"; target: SshTarget; association?: WorkspaceAssociation } | { kind: "clear" } | { kind: "pending"; destination: string }
)>;
export type TargetRestore =
	| Readonly<{ kind: "absent" | "clear" | "pending" }>
	| Readonly<{ kind: "target"; target: SshTarget; association?: WorkspaceAssociation }>
	| Readonly<{ kind: "invalid"; reason: "invalid-saved-state" | "foreign-session" | "local-context-mismatch" }>;

const controls = /[\u0000-\u001f\u007f-\u009f]/;
function invalid(): never { throw new Error("Invalid SSH target metadata"); }
// Only own data properties are read: getters, inherited fields and class instances
// are not session data. Unknown fields are discarded, never persisted or published.
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) return invalid();
	return value as Record<string, unknown>;
}
function field(value: Record<string, unknown>, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor && !("value" in descriptor)) return invalid();
	return descriptor?.value;
}
function text(value: unknown, limit: number): string {
	if (typeof value !== "string" || !value.length || value.length > limit || controls.test(value)) return invalid();
	return value;
}
function destination(value: unknown): string {
	const result = text(value, 512), parts = result.split("@");
	if (parts.length > 2) return invalid();
	if (parts.length === 2 && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(parts[0]!)) return invalid();
	const host = parts.at(-1)!;
	if (host.includes(":") || host.startsWith("[")) {
		const address = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
		if (!/^[0-9A-Fa-f:.]+$/.test(address) || isIP(address) !== 6) return invalid();
	} else if (host.length > 253 || !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(host)) return invalid();
	return result; // Alias identity is literal, not DNS/SSH-config equivalence.
}
function backend(value: unknown): SshBackend {
	if (value !== "native-ssh" && value !== "legacy-relay" && value !== "tmux-mirror") return invalid();
	return value;
}
function workspaceId(value: unknown): string {
	if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return invalid();
	return value.toLowerCase();
}

/** Parsers throw fixed, input-free errors and return fresh, deeply frozen whitelists. */
export function parseSshTarget(value: unknown): SshTarget {
	try {
		const v = object(value), remoteCwd = text(field(v, "remoteCwd"), 4096);
		if (!remoteCwd.startsWith("/")) return invalid();
		return Object.freeze({ destination: destination(field(v, "destination")), remoteCwd });
	} catch { return invalid(); }
}
/** Action requests reject extras, unlike restoration parsers. Only omitted cwd defaults home. */
export function parseSshConnectRequest(value: unknown): SshConnectRequest {
	try {
		const v = object(value);
		if (Reflect.ownKeys(v).some(key => key !== "destination" && key !== "remoteCwd")) return invalid();
		const supplied = field(v, "remoteCwd");
		const remoteCwd = supplied === undefined ? "~" : supplied;
		const parsed = parseSshTarget({ destination: field(v, "destination"), remoteCwd: remoteCwd === "~" ? "/" : remoteCwd });
		return Object.freeze({ destination: parsed.destination, remoteCwd: remoteCwd === "~" ? "~" : parsed.remoteCwd });
	} catch { return invalid(); }
}
export function parseLocalContext(value: unknown): LocalContext {
	try {
		const v = object(value), sessionId = text(field(v, "sessionId"), 128), localCwd = text(field(v, "localCwd"), 4096);
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId) || !isAbsolute(localCwd)) return invalid();
		return Object.freeze({ sessionId, localCwd });
	} catch { return invalid(); }
}
export function parseWorkspaceAssociation(value: unknown): WorkspaceAssociation {
	try {
		const v = object(value);
		return Object.freeze({ workspaceId: workspaceId(field(v, "workspaceId")), backend: backend(field(v, "backend")) });
	} catch { return invalid(); }
}
export function parseSshSessionRecord(value: unknown): SshSessionRecord {
	try {
		const v = object(value), context = parseLocalContext(v);
		if (field(v, "version") !== 1) return invalid();
		if (field(v, "kind") === "clear") return Object.freeze({ version: 1, ...context, kind: "clear" });
		if (field(v, "kind") === "pending") return Object.freeze({ version: 1, ...context, kind: "pending", destination: destination(field(v, "destination")) });
		if (field(v, "kind") !== "target") return invalid();
		const target = parseSshTarget(field(v, "target")), rawAssociation = field(v, "association");
		return Object.freeze({ version: 1, ...context, kind: "target", target,
			...(rawAssociation !== undefined ? { association: parseWorkspaceAssociation(rawAssociation) } : {}) });
	} catch { return invalid(); }
}

/** Only the latest matching custom entry on this branch is authoritative, even if invalid/foreign. */
export function restoreSshTarget(context: LocalContext, entries: readonly unknown[]): TargetRestore {
	try {
		const owner = parseLocalContext(context);
		if (!Array.isArray(entries)) return invalid();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const v = object(entry);
			if (field(v, "type") !== "custom" || field(v, "customType") !== SSH_TARGET_ENTRY) continue;
			const record = parseSshSessionRecord(field(v, "data"));
			if (record.sessionId !== owner.sessionId) return Object.freeze({ kind: "invalid", reason: "foreign-session" });
			if (record.localCwd !== owner.localCwd) return Object.freeze({ kind: "invalid", reason: "local-context-mismatch" });
			if (record.kind === "clear" || record.kind === "pending") return Object.freeze({ kind: record.kind });
			return Object.freeze({ kind: "target", target: record.target, ...(record.association ? { association: record.association } : {}) });
		}
		return Object.freeze({ kind: "absent" });
	} catch { return Object.freeze({ kind: "invalid", reason: "invalid-saved-state" }); }
}

/** Evidence supplied by a trusted adapter, not discovery or activation authority.
 * Missing/unavailable/malformed evidence is false. No host or backend is adopted.
 */
export function matchesWorkspaceObservation(target: SshTarget, association: WorkspaceAssociation, observation: unknown): boolean {
	try {
		const v = object(observation);
		return field(v, "enabled") === true && field(v, "transport") === "ssh"
			&& field(v, "connected") === true && workspaceId(field(v, "workspaceId")) === association.workspaceId
			&& backend(field(v, "backend")) === association.backend && destination(field(v, "destination")) === target.destination;
	} catch { return false; }
}
