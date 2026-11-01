import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSshTargetRuntime, type DispatchTicket } from "./runtime.ts";
import { SSH_TARGET_ENTRY, parseLocalContext, parseSshTarget, restoreSshTarget, type SshTarget } from "./target.ts";
import { shellEscape } from "../../extensions/cmux-core.ts";

export const SSH_LAUNCH_ENV = "PI_CMUX_SSH_LAUNCH";
const TTL = 60_000;
const consumed = new Set<string>();
const registered = new WeakSet<ExtensionAPI>();
const receivers = new WeakSet<ExtensionAPI>();

export function hasSshIntent(pi: ExtensionAPI): boolean {
	const snapshot = getSshTargetRuntime(pi)?.snapshot();
	return !!snapshot && snapshot.state !== "inactive"
		&& (snapshot.state !== "disabled" || !!snapshot.target || !!snapshot.reason);
}
export function assertNoSshWorkflow(pi: ExtensionAPI, workflow: string): void {
	if (hasSshIntent(pi)) throw new Error(`SSH ${workflow} is unsupported; no local repository, path or browser will be used`);
}

/** Hold across caller preparation as well as the shared launch boundary. */
export function capturePiLaunch(pi: ExtensionAPI, cwd: string) {
	const runtime = getSshTargetRuntime(pi);
	let changed = false;
	const unsubscribe = runtime?.subscribe(() => { changed = true; });
	let ticket: DispatchTicket | undefined;
	try {
		if (hasSshIntent(pi)) {
			ticket = runtime!.captureDispatch();
			if (ticket.context.localCwd !== cwd) throw new Error("SSH Pi launches require the same local project cwd");
			if (ticket.association) throw new Error("Associated remote-owned Pi placement is unsupported");
		}
	} catch (error) { unsubscribe?.(); throw error; }
	return { ticket, close: () => unsubscribe?.(), check: () => {
		if (changed || getSshTargetRuntime(pi) !== runtime) throw new Error("Pi launch target/session changed");
		if (ticket) runtime!.assertDispatch(ticket);
	} };
}

function sessionFile(value: unknown): string {
	if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error("Invalid SSH resume file");
	return value;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
		|| Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new Error("Invalid SSH launch bootstrap");
	return value as Record<string, unknown>;
}

/** Selection only: no association, ready state, credentials, IDs from orientation or arbitrary env. */
export function encodeSshLaunch(ticket: DispatchTicket, resumeFile?: string): string {
	return Buffer.from(JSON.stringify({ version: 1, nonce: randomUUID(), issuedAt: Date.now(),
		parentSessionId: ticket.context.sessionId, localCwd: ticket.context.localCwd,
		target: parseSshTarget(ticket.target), ...(resumeFile === undefined ? {} : { sessionFile: sessionFile(resumeFile) }) })).toString("base64url");
}

/** A local shell/Pi only. Strip inherited bootstrap even for unrelated local launches. */
export function withSshLaunchEnvironment(command: string, bootstrap?: string): string {
	return bootstrap
		? `exec /usr/bin/env -u ${SSH_LAUNCH_ENV} ${SSH_LAUNCH_ENV}=${shellEscape(bootstrap)} /bin/sh -c ${shellEscape(command)}`
		: `unset ${SSH_LAUNCH_ENV}; ${command}`;
}

/** Consume before any await/child launch, including invalid input. Never validates/connects SSH.
 * The environment is a trusted local launch channel, not an authentication protocol. */
export function consumeSshLaunch(pi: ExtensionAPI, ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	env: Record<string, string | undefined> = process.env,
	beforeAccept?: (ctx: Pick<ExtensionContext, "cwd" | "sessionManager">) => void): boolean {
	const raw = env[SSH_LAUNCH_ENV];
	delete env[SSH_LAUNCH_ENV];
	if (raw === undefined) return false;
	const runtime = getSshTargetRuntime(pi);
	if (!runtime) throw new Error("SSH launch requires the shared target runtime");
	try {
		if (receivers.has(pi)) throw new Error("Bootstrap receiver already consumed");
		receivers.add(pi);
		if (!raw.length || raw.length > 16_384 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("Invalid bootstrap encoding");
		const decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
		const keys = ["version", "nonce", "issuedAt", "parentSessionId", "localCwd", "target"];
		if (Object.hasOwn(decoded ?? {}, "sessionFile")) keys.push("sessionFile");
		const v = exact(decoded, keys);
		if (v.version !== 1 || typeof v.nonce !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v.nonce)
			|| consumed.has(v.nonce) || consumed.size >= 1024) throw new Error("Invalid/replayed bootstrap");
		consumed.add(v.nonce); // Burn even a subsequently refused envelope.
		if (!Number.isSafeInteger(v.issuedAt) || Date.now() < (v.issuedAt as number) || Date.now() - (v.issuedAt as number) > TTL) throw new Error("Expired bootstrap");
		const parent = parseLocalContext({ sessionId: v.parentSessionId, localCwd: v.localCwd });
		const child = parseLocalContext({ sessionId: ctx.sessionManager.getSessionId(), localCwd: ctx.cwd });
		if (parent.sessionId === child.sessionId || parent.localCwd !== child.localCwd) throw new Error("Bootstrap owner/cwd mismatch");
		const target: SshTarget = parseSshTarget(exact(v.target, ["destination", "remoteCwd"]));
		if (v.sessionFile !== undefined && sessionFile(v.sessionFile) !== ctx.sessionManager.getSessionFile()) throw new Error("Bootstrap resume mismatch");
		// Pi initializes model/thinking metadata before session_start, even for a
		// fresh conversation. Never adopt messages, custom entries or other history.
		const branch = ctx.sessionManager.getBranch();
		if (v.sessionFile === undefined && branch.some(entry => entry.type !== "model_change" && entry.type !== "thinking_level_change")) {
			throw new Error("Fresh bootstrap on an existing session");
		}
		const restored = restoreSshTarget(child, branch);
		if (restored.kind === "clear" || restored.kind === "pending" || restored.kind === "invalid") throw new Error("Bootstrap conflicts with saved intent");
		const state = runtime.snapshot();
		if (state.context?.sessionId !== child.sessionId || state.context.localCwd !== child.localCwd
			|| !state.enabled || state.reason || state.association || !["inactive", "configured"].includes(state.state)
			|| (state.target && (state.target.destination !== target.destination || state.target.remoteCwd !== target.remoteCwd))) throw new Error("Bootstrap conflicts with shared session state");
		// Strict fresh-branch eligibility above must run BEFORE selection metadata is appended.
		beforeAccept?.(ctx);
		runtime.activate(target); // persists to the CHILD local session; configured, never ready
		return true;
	} catch {
		// Block fallback but retain a valid local owner so explicit selection can recover.
		// This synthetic invalid entry is not persisted into the session branch.
		try {
			runtime.startSession({ sessionId: ctx.sessionManager.getSessionId(), localCwd: ctx.cwd },
				[{ type: "custom", customType: SSH_TARGET_ENTRY, data: {} }]);
		} catch { runtime.startSession(undefined, []); }
		throw new Error("SSH launch bootstrap refused; select the target explicitly");
	}
}

/** Opt-in helper; central registration belongs to step07. Register after registerSshTarget. */
export function registerSshLaunchBootstrap(pi: ExtensionAPI, beforeAccept?: (ctx: ExtensionContext) => void,
	onRefused?: (ctx: ExtensionContext) => void): void {
	if (registered.has(pi)) return;
	if (!getSshTargetRuntime(pi)) throw new Error("Register the shared SSH target runtime first");
	registered.add(pi);
	// Remove immediately so startup hooks cannot pass it on to grandchildren.
	const env = { [SSH_LAUNCH_ENV]: process.env[SSH_LAUNCH_ENV] };
	delete process.env[SSH_LAUNCH_ENV];
	let first = true;
	pi.on("session_start", (_event, ctx) => {
		if (!first) return;
		first = false;
		try { consumeSshLaunch(pi, ctx, env, () => beforeAccept?.(ctx)); }
		catch {
			// Refusal reconstructs a blocked runtime lifecycle. Reopen only that
			// matching startup context so idle explicit recovery remains possible.
			onRefused?.(ctx);
			ctx.ui.notify("SSH launch bootstrap refused; explicit target selection is required", "warning");
		}
	});
}
