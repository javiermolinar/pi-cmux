import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import cmuxNotifyExtension from "./cmux-notify.ts";
import cmuxSplitExtension from "./cmux-split.ts";
import cmuxZoxideExtension from "./cmux-zoxide.ts";
import cmuxReviewExtension from "./cmux-review.ts";
import cmuxContinueExtension from "./cmux-continue.ts";
import cmuxOpenExtension from "./cmux-open.ts";

export default function piCmuxExtensionBundle(pi: ExtensionAPI) {
	cmuxNotifyExtension(pi);
	cmuxSplitExtension(pi);
	cmuxZoxideExtension(pi);
	cmuxReviewExtension(pi);
	cmuxContinueExtension(pi);
	cmuxOpenExtension(pi);
}
