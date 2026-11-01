import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cmuxNotifyExtension from "./cmux-notify.ts";
import cmuxSplitExtension from "./cmux-split.ts";
import cmuxStartExtension from "./cmux-start.ts";
import cmuxZoxideExtension from "./cmux-zoxide.ts";
import cmuxContinueExtension from "./cmux-continue.ts";
import cmuxOpenExtension from "./cmux-open.ts";
import cmuxBrowserExtension from "./cmux-browser.ts";
import cmuxSidebarExtension from "./cmux-sidebar.ts";
import cmuxPanelExtension from "./cmux-panel.ts";
import cmuxDoctorExtension from "./cmux-doctor.ts";
import cmuxAutotitleExtension from "./cmux-autotitle.ts";
import cmuxSwitcherExtension from "./cmux-switcher.ts";
import { initI18n } from "./i18n.ts";
import registerOrientation from "../lib/orientation/runtime.ts";
import registerMessaging from "./cmux-messages.ts";
import registerCmuxSsh from "./cmux-ssh.ts";
import { execCmux } from "./cmux-core.ts";
import { uuid } from "../lib/orientation/state.ts";

async function hasCmuxCaller(pi: ExtensionAPI): Promise<boolean> {
	const surfaceId = uuid(process.env.CMUX_SURFACE_ID);
	if (!surfaceId) return false;
	try {
		// A reachable socket (or inherited environment) does not establish a caller.
		const result = await execCmux(pi, ["--json", "--id-format", "both", "identify"]);
		if (!result.ok) return false;
		const caller = JSON.parse(result.stdout)?.caller;
		return Boolean(uuid(caller?.window_id) && uuid(caller?.workspace_id)
			&& uuid(caller?.pane_id) && uuid(caller?.surface_id) === surfaceId);
	} catch {
		return false;
	}
}

export default async function piCmuxExtensionBundle(pi: ExtensionAPI) {
	// Diagnostic-only exception: no ordinary tools/events outside a verified caller.
	cmuxDoctorExtension(pi);
	if (!await hasCmuxCaller(pi)) return;
	initI18n(pi);
	registerCmuxSsh(pi); // Consume one-shot target before orientation adds branch entries.
	registerOrientation(pi);
	cmuxNotifyExtension(pi);
	cmuxSplitExtension(pi);
	cmuxStartExtension(pi);
	cmuxZoxideExtension(pi);
	cmuxContinueExtension(pi);
	cmuxOpenExtension(pi);
	cmuxBrowserExtension(pi);
	cmuxSidebarExtension(pi);
	cmuxPanelExtension(pi);
	cmuxAutotitleExtension(pi);
	cmuxSwitcherExtension(pi);
	registerMessaging(pi);
}
