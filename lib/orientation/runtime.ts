import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { execCmux, getProjectName } from "../../extensions/cmux-core.ts";
import { locateSurface } from "./navigation.ts";
import { hasSshIntent } from "../ssh/launch.ts";
import { getSshTargetRuntime } from "../ssh/runtime.ts";
import { childNavigationHint, navigationHints, NAVIGATION_MESSAGE, resolveReturnShortcut } from "./hints.ts";
import {
	BINDING_TTL_MS, BOOTSTRAP_ENV, ORIENTATION_ENTRY, BindingStore, childBootstrap, decodeBootstrap,
	liveBinding, marker, orientedTitle, parseOrientation, rootOrientation, topicText, uuid,
	type Binding, type Bootstrap, type Orientation, type Role, type Target,
} from "./state.ts";

const runtimes = new WeakMap<ExtensionAPI, OrientationRuntime>();
export interface RelationOptions { related?: boolean; role?: "chat" | "review" | "continue" }
export interface ChildConversation {
	taskId: string;
	conversationId: string;
	role: Role;
	parentConversationId: string;
	parentSessionId: string;
	surfaceId: string;
	placement: "workspace" | "right" | "down" | "tab";
	sessionId?: string;
	binding: "unconfirmed" | "bound" | "unknown";
}

/** Best-effort direct children of the current conversation, not a process/task monitor. */
export function conversationChildren(pi: ExtensionAPI): ChildConversation[] {
	return currentConversation(pi) ? runtimes.get(pi)!.children() : [];
}

export function rememberChildConversation(pi: ExtensionAPI, seed: Bootstrap | undefined, surface: unknown, placement: ChildConversation["placement"]): void {
	const own = currentConversation(pi), origin = seed?.origin, surfaceId = uuid(surface);
	if (!own || !seed || !origin || !surfaceId || surfaceId === own.target.surfaceId
		|| origin.sessionId !== own.state.sessionId || origin.conversationId !== own.state.conversationId
		|| origin.taskId !== own.state.taskId || origin.role !== own.state.role || origin.target.surfaceId !== own.target.surfaceId) return;
	runtimes.get(pi)!.rememberChild({ taskId: seed.taskId, conversationId: seed.conversationId, role: seed.role,
		parentConversationId: origin.conversationId, parentSessionId: origin.sessionId, surfaceId, placement, binding: "unconfirmed" });
}

export function validateRelation(options: RelationOptions): void {
	if (options.related !== undefined && typeof options.related !== "boolean") throw new Error("related must be a boolean");
	if (options.role !== undefined && !["chat", "review", "continue"].includes(options.role)) throw new Error("Invalid conversation role");
	if (options.related === false && (options.role === "review" || options.role === "continue")) throw new Error("review/continue roles require related=true");
}
function ownsBinding(runtime: OrientationRuntime): boolean {
	const binding = runtime.target && runtime.store.read(runtime.target.surfaceId);
	return Boolean(runtime.state && binding && binding.token === runtime.token && binding.pid === process.pid && liveBinding(binding, runtime.state));
}

export function prepareOrientation(pi: ExtensionAPI, options: RelationOptions, topic: string): Bootstrap | undefined {
	validateRelation(options);
	const related = options.related ?? (options.role === "review" || options.role === "continue");
	const runtime = runtimes.get(pi);
	// Standalone legacy launch extensions can be loaded without the bundle.
	if (!runtime || !runtime.eligible) return undefined;
	if (!runtime.state || !runtime.target) {
		if (related) throw new Error("Related launches require an active pi-cmux orientation runtime with UUID targeting");
		return undefined;
	}
	if (!ownsBinding(runtime)) throw new Error("The source conversation binding is no longer live");
	return childBootstrap(runtime.state, runtime.target, related, options.role ?? "chat", topic);
}

/** Read-only current ownership for integrations; labels/related roles never grant authority. */
export function currentConversation(pi: ExtensionAPI): { state: Orientation; target: Target } | undefined {
	const runtime = runtimes.get(pi);
	if (!runtime?.state || !runtime.target || !runtime.eligible || !ownsBinding(runtime)) return;
	return { state: { ...runtime.state }, target: { ...runtime.target } };
}

/** Startup evidence only: the exact launched conversation reached orientation startup.
 * This does not establish prompt processing, task readiness, or completion. */
export function childStartupBinding(pi: ExtensionAPI, seed: Bootstrap, surfaceId: string): Binding | undefined {
	const runtime = runtimes.get(pi), id = uuid(surfaceId);
	if (!runtime || !id || id === runtime.target?.surfaceId || !ownsBinding(runtime)) return;
	const binding = runtime.store.read(id);
	if (!binding || !liveBinding(binding, { ...seed, sessionId: binding.sessionId })) return;
	return binding;
}

export function renameOrientedTopic(pi: ExtensionAPI, topic: string, signal?: AbortSignal): Promise<boolean> | undefined {
	const runtime = runtimes.get(pi);
	return runtime?.state ? runtime.renameTopic(topic, signal) : undefined;
}

export class OrientationRuntime {
	eligible = false;
	state: Orientation | undefined;
	target: Target | undefined;
	readonly token = randomUUID();
	readonly returnShortcut = resolveReturnShortcut(process.env.PI_CMUX_RETURN_KEY);
	private generation = 0;
	private readonly childConversations = new Map<string, ChildConversation>();
	private timer: ReturnType<typeof setInterval> | undefined;
	private consumedBootstrap = false;
	private context: ExtensionContext | undefined;
	private lifecycle = new AbortController();
	private renameQueue: Promise<unknown> = Promise.resolve();
	private titleVersion = 0;
	private topic = "Pi";
	private fallbackTopic = "Pi";
	readonly pi: ExtensionAPI;
	readonly store: BindingStore;
	constructor(pi: ExtensionAPI, store: BindingStore) { this.pi = pi; this.store = store; }

	rememberChild(child: ChildConversation): void {
		this.childConversations.set(child.conversationId, { ...child });
		// Bound memory; no prompts, cross-process registry, or recovery scan.
		if (this.childConversations.size > 64) this.childConversations.delete(this.childConversations.keys().next().value!);
	}
	children(): ChildConversation[] {
		return [...this.childConversations.values()].map(child => {
			const binding = this.store.read(child.surfaceId);
			if (binding && liveBinding(binding, { ...child, sessionId: child.sessionId ?? binding.sessionId })) {
				child.sessionId ??= binding.sessionId;
				child.binding = "bound";
			} else if (binding || child.sessionId) child.binding = "unknown";
			return { ...child };
		});
	}
	stop(): void {
		this.childConversations.clear();
		this.generation++;
		this.lifecycle.abort();
		this.lifecycle = new AbortController();
		this.context?.ui.setStatus("cmux-orientation", undefined);
		this.context = undefined;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.target) this.store.remove(this.target.surfaceId, this.token);
		this.state = undefined;
		this.target = undefined;
	}
	showOrigin(error?: string): void {
		if (!this.state || !this.context) return;
		const origin = this.state.origin;
		this.context.ui.setStatus("cmux-orientation", `${marker(this.state)}${origin ? ` ← ${marker(origin)} · /cmbk${error ? " (origin unavailable)" : ""}` : " · no origin"}`);
	}
	async renameTopic(topic: string, signal?: AbortSignal): Promise<boolean> {
		if (!this.state || !this.target || signal?.aborted) return false;
		this.topic = topicText(topic) || this.fallbackTopic;
		const version = ++this.titleVersion, generation = this.generation;
		const state = this.state, target = this.target;
		const jobSignal = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
		const work = this.renameQueue.then(async () => {
			if (jobSignal.aborted || generation !== this.generation || version !== this.titleVersion) return false;
			const identified = await execCmux(this.pi, ["--json", "--id-format", "both", "identify"], jobSignal);
			if (!identified.ok || jobSignal.aborted || generation !== this.generation || version !== this.titleVersion) return false;
			const caller = JSON.parse(identified.stdout)?.caller;
			const windowId = uuid(caller?.window_id), workspaceId = uuid(caller?.workspace_id), surfaceId = uuid(caller?.surface_id);
			if (!windowId || !workspaceId || surfaceId !== target.surfaceId || !ownsBinding(this)) return false;
			const result = await execCmux(this.pi, ["rename-tab", "--window", windowId, "--workspace", workspaceId,
				"--surface", target.surfaceId, "--title", orientedTitle(state, this.topic)], jobSignal);
			return result.ok && !jobSignal.aborted && generation === this.generation && version === this.titleVersion;
		});
		this.renameQueue = work.catch(() => false);
		return work.catch(() => false);
	}
	async returnToOrigin(): Promise<Target> {
		const state = this.state, origin = state?.origin, generation = this.generation;
		if (!state || !origin) throw new Error("This conversation has no recorded origin");
		const binding = this.store.read(origin.target.surfaceId);
		if (!liveBinding(binding, origin)) throw new Error("Origin Pi session is unavailable or the terminal now hosts another conversation");
		const result = await execCmux(this.pi, ["--json", "--id-format", "both", "tree", "--all"], this.lifecycle.signal);
		if (generation !== this.generation || this.state !== state) throw new Error("Conversation changed during return");
		if (!result.ok || result.stdout.length > 5_000_000) throw new Error(result.error || "Cannot inspect cmux origin topology");
		const target = locateSurface(JSON.parse(result.stdout), origin.target.surfaceId);
		const current = this.store.read(target.surfaceId);
		if (!liveBinding(current, origin) || current.token !== binding.token) throw new Error("Origin conversation changed during return");
		const focused = await execCmux(this.pi, ["--json", "--id-format", "both", "rpc", "surface.focus", JSON.stringify({
			window_id: target.windowId, workspace_id: target.workspaceId, surface_id: target.surfaceId,
		})], this.lifecycle.signal);
		if (generation !== this.generation || this.state !== state) throw new Error("Conversation changed during return");
		if (!focused.ok) throw new Error(focused.error || "cmux surface.focus is unavailable");
		const response = JSON.parse(focused.stdout);
		if (uuid(response?.window_id) !== target.windowId || uuid(response?.workspace_id) !== target.workspaceId || uuid(response?.surface_id) !== target.surfaceId) throw new Error("cmux did not confirm the exact origin target");
		this.showOrigin();
		return target;
	}
	navigationMessage(ctx: ExtensionContext) {
		const state = this.state;
		if (!state || state.sessionId !== ctx.sessionManager.getSessionId()) return;
		const hints = navigationHints(state);
		if (!hints) return;
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type !== "custom_message" || entry.customType !== NAVIGATION_MESSAGE) continue;
			const details = entry.details as { sessionId?: unknown; conversationId?: unknown; shortcutKey?: unknown } | undefined;
			if (details?.sessionId !== state.sessionId || details.conversationId !== state.conversationId) continue;
			if (details.shortcutKey === (this.returnShortcut.key ?? null)) return;
			break; // A configuration change supersedes even an older matching note.
		}
		return { message: {
			customType: NAVIGATION_MESSAGE, display: true,
			content: childNavigationHint(hints, this.returnShortcut),
			details: { ...hints, sessionId: state.sessionId, conversationId: state.conversationId, shortcutKey: this.returnShortcut.key ?? null },
		} };
	}
	manualTitle(ctx: ExtensionContext): void {
		if (this.state) void this.renameTopic(ctx.sessionManager.getSessionName() || this.fallbackTopic);
	}
	private renew(): void {
		if (!this.state || !this.target) return;
		const previous = this.store.read(this.target.surfaceId);
		if (previous && previous.token !== this.token) { this.stop(); return; }
		const binding: Binding = { ...this.state, version: 1, token: this.token, pid: process.pid, expiresAt: Date.now() + BINDING_TTL_MS };
		this.store.write(this.target.surfaceId, binding);
	}
	async reset(ctx: ExtensionContext): Promise<void> {
		this.stop();
		const generation = this.generation;
		let seed: Bootstrap | undefined;
		if (!this.consumedBootstrap) {
			this.consumedBootstrap = true;
			const raw = process.env[BOOTSTRAP_ENV];
			delete process.env[BOOTSTRAP_ENV];
			if (raw) seed = decodeBootstrap(raw);
		}
		this.eligible = ctx.mode === "tui" && Boolean(uuid(process.env.CMUX_SURFACE_ID));
		if (!this.eligible) return;
		const owner = ctx.sessionManager.getSessionId();
		const result = await execCmux(this.pi, ["--json", "--id-format", "both", "identify"]);
		if (generation !== this.generation) return;
		if (!result.ok) throw new Error(result.error || "Cannot identify cmux conversation");
		const caller = JSON.parse(result.stdout)?.caller;
		const windowId = uuid(caller?.window_id), workspaceId = uuid(caller?.workspace_id), paneId = uuid(caller?.pane_id), surfaceId = uuid(caller?.surface_id);
		if (!windowId || !workspaceId || !paneId || !surfaceId || surfaceId !== uuid(process.env.CMUX_SURFACE_ID)) throw new Error("cmux orientation requires UUID-bearing caller identity");
		let state: Orientation | undefined = seed ? { ...seed, sessionId: owner } : undefined;
		if (!state) {
			for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
				if (entry.type !== "custom" || entry.customType !== ORIENTATION_ENTRY) continue;
				state = parseOrientation(entry.data, owner);
				if (!state && (entry.data as { sessionId?: unknown } | undefined)?.sessionId === owner) throw new Error("Invalid saved cmux orientation metadata");
				if (state) break;
			}
		}
		const restored = Boolean(state) && !seed;
		const remote = getSshTargetRuntime(this.pi)?.snapshot().target;
		const project = topicText(hasSshIntent(this.pi)
			? basename(remote?.remoteCwd ?? "") || "Pi"
			: await getProjectName(this.pi, ctx.cwd)) || "Pi";
		if (generation !== this.generation) return;
		state ??= rootOrientation(owner);
		// Upgrade old generic defaults without changing saved task/conversation IDs.
		this.fallbackTopic = state.topic && state.topic !== "Pi" ? state.topic : project;
		this.state = state;
		this.context = ctx;
		this.target = { windowId, workspaceId, paneId, surfaceId };
		try {
			// Replace a previous process's claim only at explicit session activation.
			this.store.write(surfaceId, { ...state, version: 1, token: this.token, pid: process.pid, expiresAt: Date.now() + BINDING_TTL_MS });
			if (!restored) this.pi.appendEntry(ORIENTATION_ENTRY, state);
			this.timer = setInterval(() => { try { this.renew(); } catch { this.stop(); } }, 5000);
			this.timer.unref();
			this.showOrigin();
			let topic = seed ? state.topic : ctx.sessionManager.getSessionName() || this.fallbackTopic;
			if (!seed && !ctx.sessionManager.getSessionName()) {
				for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
					if (entry.type !== "custom" || entry.customType !== "pi-cmux.autotitle") continue;
					const saved = (entry.data as { title?: unknown } | undefined)?.title;
					if (typeof saved === "string" && saved) topic = saved;
					break;
				}
			}
			void this.renameTopic(topic);
		} catch (error) { this.stop(); throw error; }
	}
}

export default function registerOrientation(pi: ExtensionAPI, store = new BindingStore(join(getAgentDir(), "pi-cmux", "orientation"))): OrientationRuntime {
	const runtime = new OrientationRuntime(pi, store);
	runtimes.set(pi, runtime);
	const reset = async (_event: unknown, ctx: ExtensionContext) => {
		try { await runtime.reset(ctx); }
		catch (error) { runtime.stop(); ctx.ui.notify(`cmux orientation unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning"); }
	};
	pi.on("session_start", reset);
	pi.on("session_tree", reset);
	pi.on("session_info_changed", (_event, ctx) => runtime.manualTitle(ctx));
	pi.on("before_agent_start", (_event, ctx) => runtime.navigationMessage(ctx));
	pi.on("session_shutdown", () => runtime.stop());
	const returnHandler = async (ctx: ExtensionContext) => {
		try {
			await runtime.returnToOrigin();
			ctx.ui.notify("Returned to the originating conversation", "info");
		} catch (error) {
			runtime.showOrigin("unavailable");
			ctx.ui.notify(`Cannot return to origin: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};
	pi.registerCommand("cmbk", { description: "Return to the originating Pi conversation (exact cmux tab)", handler: async (_args, ctx) => returnHandler(ctx) });
	const shortcut = runtime.returnShortcut;
	if (shortcut.invalid) console.warn("pi-cmux: invalid PI_CMUX_RETURN_KEY; /cmbk is still available");
	else if (shortcut.key) pi.registerShortcut(shortcut.key as Parameters<ExtensionAPI["registerShortcut"]>[0], { description: "Return to the originating cmux conversation", handler: returnHandler });
	return runtime;
}
