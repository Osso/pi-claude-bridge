// Test extension: a tool whose result ends pi's turn (`terminate: true`), so pi
// never makes the follow-up provider call that would deliver the result to
// Claude Code.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const params = Type.Object({});
	pi.registerTool<typeof params>({
		name: "FinishTool",
		label: "Finish the turn",
		description: "Ends the turn. Use this when asked to call FinishTool.",
		parameters: params,
		async execute() {
			return { content: [{ type: "text" as const, text: "finished" }], details: {}, terminate: true };
		},
	});
}
