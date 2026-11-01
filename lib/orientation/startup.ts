import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childStartupBinding } from "./runtime.ts";
import { liveBinding, uuid, type Binding, type Bootstrap } from "./state.ts";

export type PiStartup =
	| { state: "bound"; surfaceId: string; sessionId: string }
	| { state: "unconfirmed"; reason: string };

const ATTEMPTS = 40;
const POLL_MS = 250;

/** Bounded read-only acknowledgement. Never creates, respawns, sends messages,
 * changes focus, or treats a missing acknowledgement as proof of failure. */
export async function waitForPiStartup(
	pi: ExtensionAPI, seed: Bootstrap | undefined, surface: unknown, check: () => void,
): Promise<PiStartup> {
	return waitForPiBinding(seed, surface, (id) => seed ? childStartupBinding(pi, seed, id) : undefined, check);
}

/** Also used by the standalone panel bootstrap, which has no parent Pi runtime. */
export async function waitForPiBinding(
	seed: Bootstrap | undefined, surface: unknown, read: (id: string) => Binding | undefined, check: () => void,
): Promise<PiStartup> {
	const id = uuid(surface);
	const validate = (): PiStartup | undefined => {
		try { check(); }
		catch (error) {
			// Preserve the completed dispatch even if verification is canceled or
			// loses its owner. Do not turn it into an apparently retryable failure.
			return { state: "unconfirmed", reason: `Pi launch was already dispatched${id ? ` to surface ${id}` : ""}; startup outcome is uncertain. Do not relaunch automatically. ${error instanceof Error ? error.message : String(error)}` };
		}
	};
	const initial = validate();
	if (initial) return initial;
	if (!seed || !id) return { state: "unconfirmed", reason: "Child creation was reported, but exact Pi startup verification requires orientation and the created surface UUID. Inspect cmux before retrying; do not relaunch automatically." };
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		const invalid = validate();
		if (invalid) return invalid;
		const binding = read(id);
		if (binding && liveBinding(binding, { ...seed, sessionId: binding.sessionId })) {
			return { state: "bound", surfaceId: id, sessionId: binding.sessionId };
		}
		if (attempt + 1 < ATTEMPTS) await new Promise<void>(resolve => setTimeout(resolve, POLL_MS));
	}
	const invalid = validate();
	if (invalid) return invalid;
	return { state: "unconfirmed", reason: `No live Pi binding for the exact launched conversation appeared on surface ${id} within 10 seconds. The child may be starting, blocked, or exited; inspect that surface before retrying. Do not relaunch automatically.` };
}
