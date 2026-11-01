import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { registerSshAdapter, type SshAdapterOptions } from "../lib/ssh/adapter.ts";
import { registerSshAliasSave } from "../lib/ssh/alias-save.ts";
import { registerSshConnect, decideSshConversation, SSH_CONNECT_GUIDANCE, type SshActionAuthority, type SshConnectRequest } from "../lib/ssh/connect.ts";
import { discoverSshDestinations, type SshDiscoveryOptions } from "../lib/ssh/discovery.ts";
import { registerSshLaunchBootstrap } from "../lib/ssh/launch.ts";
import { execCmux } from "./cmux-core.ts";
import { parseSshTarget } from "../lib/ssh/target.ts";
import { t } from "./i18n.ts";

interface Supplied { destination?: string; remoteCwd?: string }
interface Grant {
	text: string; sessionId: string; cwd: string; live: boolean;
	fields?: Supplied; connect?: SshConnectRequest; alias: boolean; discovery: boolean;
	used: Set<string>; active: Set<string>; controller: AbortController;
}
/** Host-owned literal parsing, not a model classifier. Ambiguous phrasing supplies no guessed fields. */
function supplied(text: string, pending?: Supplied): Supplied | undefined {
	const request = /^(?:please\s+)?(?:connect(?:\s+me)?(?:\s+via\s+ssh)?(?:\s+to)?|con[eé]cta(?:me)?(?:\s+a)?)\b\s*(.*)$/i.exec(text);
	let rest = request?.[1]?.trim();
	if (!request) {
		if (!pending || /^(?:cancel|stop|never mind|no|cancelar)\b/i.test(text)) return;
		rest = text.replace(/^(?:use|to|in|at|en)\s+/i, "").trim();
		if (!pending.destination) {
			try { return { ...pending, destination: parseSshTarget({ destination: rest, remoteCwd: "/" }).destination }; } catch { return; }
		}
		// A known destination is pending only when an explicitly supplied path
		// was invalid. Keep that distinction: invalid is never default-home intent.
		return { ...pending, remoteCwd: unquote(rest!) };
	}
	rest = rest!.replace(/\s+(?:and|y)\s+(?:save|guardar)\b.*$/i, "");
	const parts = /^(?:(\S+)\s+)?(?:in|at|en)\s+(.+)$/i.exec(rest);
	const result: Supplied = {};
	const host = parts ? parts[1] : rest;
	if (host) { try { result.destination = parseSshTarget({ destination: host, remoteCwd: "/" }).destination; } catch { /* Ask; do not guess. */ } }
	if (parts) result.remoteCwd = unquote(parts[2]!);
	return result;
}
function unquote(value: string): string {
	if (value.startsWith('"')) { try { const parsed = JSON.parse(value); return typeof parsed === "string" ? parsed : value; } catch { return value; } }
	return value.startsWith("'") && value.endsWith("'") ? value.slice(1, -1) : value;
}
function literal(text: string, value: unknown): boolean {
	if (typeof value !== "string" || !value.length) return false;
	const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`(?:^|[^A-Za-z0-9_.@-])${escaped}(?:$|[^A-Za-z0-9_.@-])`).test(text);
}
export interface SshIntegrationOptions extends SshAdapterOptions {
	/** Trusted local configuration/test seams, never tool parameters. */
	env?: Record<string, string | undefined>;
	aliasHome?: string;
	discovery?: Pick<SshDiscoveryOptions, "homeDirectory" | "configPath" | "listWorkspaces">;
}
const registered = new WeakMap<ExtensionAPI, ReturnType<typeof registerSshAdapter>>();

/** Central registration is inert: no config scan, SSH connection or cmux mutation at startup. */
export default function registerCmuxSsh(pi: ExtensionAPI, options: SshIntegrationOptions = {}) {
	const old = registered.get(pi); if (old) return old;
	const env = options.env ?? process.env;
	const enabled = env.PI_CMUX_SSH !== "0";
	const adapter = registerSshAdapter(pi, { ...options, enabled }), runtime = adapter.runtime;
	registered.set(pi, adapter);
	// Selection startup is inert in local mode. The child captures only AFTER
	// bootstrap's strict fresh-branch check, before configured intent is saved.
	registerSshLaunchBootstrap(pi, ctx => adapter.selection!.prepare(ctx), ctx => adapter.selection!.start(ctx)); // Before orientation entries.
	let pending: Supplied | undefined, grant: Grant | undefined;
	const reset = () => { grant?.controller.abort(); pending = undefined; grant = undefined; };
	pi.on("session_start", reset); pi.on("session_tree", reset); pi.on("session_shutdown", reset);
	pi.on("input", (event, ctx) => {
		const previous = pending; reset();
		// Extension/peer messages and streaming steering do not grant a connection.
		if (!enabled || (event.source !== "interactive" && event.source !== "rpc")
			|| event.streamingBehavior || event.text.length > 8192) return;
		const text = event.text.trim(), fields = supplied(text, previous);
		const alias = /^(?:please\s+)?(?:save|guardar)\s+(?:ssh\s+)?alias\b/i.test(text)
			|| (!!fields && /\b(?:save|guardar)\s+(?:ssh\s+)?alias\b/i.test(text));
		const discovery = !!fields || /^(?:list|show|discover|listar)\b[^\n]*(?:ssh|aliases)/i.test(text);
		if (!fields && !alias && !discovery) return;
		const decision = fields && decideSshConversation(fields);
		if (decision?.kind === "question") pending = fields;
		grant = { text: event.text, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
			live: false, fields, connect: decision?.kind === "connect" ? decision.target : undefined,
			alias, discovery, used: new Set(), active: new Set(), controller: new AbortController() };
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!grant || event.messageType !== "user" || event.prompt !== grant.text
			|| grant.sessionId !== ctx.sessionManager.getSessionId() || grant.cwd !== ctx.cwd) { reset(); return; }
		grant.live = true;
		const decision = grant.fields && decideSshConversation(grant.fields);
		return { message: { customType: "pi-cmux.ssh-request", display: false, details: undefined,
			content: SSH_CONNECT_GUIDANCE + "\n" + (decision?.kind === "connect"
				? `Current direct request supplies ${JSON.stringify(decision.target)}. Use ssh_connect without another question.`
				: decision?.kind === "question" ? `Ask only this missing field: ${decision.question} Discovered aliases may be offered as suggestions via ssh_discover.`
				: "Only the explicitly requested discovery/optional alias-save action is authorized; no connection target was supplied.") } };
	});
	const live = (ctx: ExtensionContext) => enabled && !!grant?.live
		&& grant.sessionId === ctx.sessionManager.getSessionId() && grant.cwd === ctx.cwd;
	const authority: SshActionAuthority = {
		currentRequest(ctx, action, parameters) {
			if (!live(ctx) || grant!.used.has(action)) return false;
			if (action === "connect") {
				const p = parameters as SshConnectRequest;
				return !!grant!.connect && p.destination === grant!.connect.destination && p.remoteCwd === grant!.connect.remoteCwd;
			}
			const p = parameters as { alias?: string; hostname?: string; user?: string; port?: number };
			const dest = grant!.connect?.destination.split("@");
			const pair = p.user !== undefined && literal(grant!.text, `${p.user}@${p.hostname}`);
			return env.PI_CMUX_SSH_ALIAS_SAVE !== "0" && grant!.alias && literal(grant!.text, p.alias)
				&& (pair || literal(grant!.text, p.hostname) || p.hostname === dest?.at(-1))
				&& (p.user === undefined || pair || literal(grant!.text, p.user) || (dest?.length === 2 && p.user === dest[0]))
				&& (p.port === undefined || literal(grant!.text, String(p.port)));
		},
		begin(ctx, action, parameters) {
			if (!authority.currentRequest(ctx, action, parameters) || grant!.active.has(action)) throw new Error("SSH request is absent, stale or already attempted");
			const own = grant!; own.active.add(action);
			return Object.assign(() => { own.active.delete(action); own.used.add(action); }, { signal: own.controller.signal });
		},
	};
	registerSshConnect(pi, adapter, authority);
	registerSshAliasSave(pi, adapter, authority, options.aliasHome);
	pi.registerTool({
		name: "ssh_discover", label: "SSH suggestions", description: "List bounded SSH alias/current cmux connection suggestions only when requested or clarifying a direct SSH request. No connection or host selection, ssh -G, key reads or registry. Disabled controls perform no I/O.",
		parameters: { type: "object", properties: {}, additionalProperties: false } as any,
		async execute(_id, _params, signal, _update, ctx) {
			signal?.throwIfAborted();
			if (!enabled || env.PI_CMUX_SSH_DISCOVERY === "0") return { content: [{ type: "text", text: t("ssh.discovery.disabled") }], details: undefined };
			if (!live(ctx) || !grant!.discovery) throw new Error("SSH discovery requires a current direct request");
			const own = grant;
			const result = await discoverSshDestinations({ enabled: true, ...options.discovery,
				homeDirectory: options.discovery?.homeDirectory ?? homedir(),
				listWorkspaces: options.discovery?.listWorkspaces ?? (async () => {
					const result = await execCmux(pi, ["--json", "rpc", "workspace.list", "{}"], signal);
					if (!result.ok || result.stdout.length > 1_048_576) throw new Error("cmux unavailable");
					return JSON.parse(result.stdout);
				}) });
			signal?.throwIfAborted();
			if (grant !== own || !live(ctx)) throw new Error("SSH discovery request changed");
			return { content: [{ type: "text", text: JSON.stringify(result) }], details: undefined };
		},
	});
	return adapter;
}
