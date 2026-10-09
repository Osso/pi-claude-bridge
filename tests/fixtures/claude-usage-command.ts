import assert from "node:assert/strict";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Query, SDKRateLimitEvent, SDKResultSuccess } from "@anthropic-ai/claude-agent-sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activateBridge, { __test } from "../../src/index.js";

type QuotaMessage =
	| Pick<SDKRateLimitEvent, "type" | "rate_limit_info">
	| Pick<SDKResultSuccess, "type" | "subtype" | "is_error" | "result">;
type QuotaQuery = AsyncGenerator<QuotaMessage, void> & Pick<Query, "close" | "interrupt">;

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const auditPath = process.env.BRIDGE_USAGE_AUDIT;
if (!auditPath || !process.env.HOME?.includes("bridge-usage-rpc-")) {
	throw new Error("Usage fixture requires disposable test HOME and audit path");
}
function audit(record: object) {
	assert.ok(auditPath, "fixture audit path required");
	appendFileSync(auditPath, `${JSON.stringify(record)}\n`);
}

export default function (pi: ExtensionAPI) {
	// Install before activating the actual bridge; no request reaches a network.
	globalThis.fetch = async (input, options) => {
		assert.equal(String(input), USAGE_URL, "fixture only permits subscription usage");
		const headers = new Headers(options?.headers);
		const account = ["alpha", "beta"].find((name) => headers.get("Authorization") === `Bearer fixture-only-${name}`);
		assert.ok(account, "usage must use a synthetic fixture account");
		assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
		audit({ kind: "fetch", account });
		return Response.json({
			five_hour: { utilization: 42.5, resets_at: "2026-10-09T05:00:00+02:00" },
			seven_day: { utilization: 90, resets_at: null },
			seven_day_opus: null,
			seven_day_sonnet: { utilization: 0, resets_at: "2026-10-10T03:00:00Z" },
		});
	};
	__test.setQuery(({ options }) => {
		audit({ kind: "query" });
		assert.equal(process.env.BRIDGE_USAGE_ROTATION, "1", "/usage must never start inference");
		const configDir = options?.env?.CLAUDE_CONFIG_DIR;
		assert.ok(configDir, "controlled provider must select an isolated account directory");
		const credentials = JSON.parse(readFileSync(join(configDir, ".credentials.json"), "utf8"));
		const account = credentials.claudeAiOauth.accessToken === "fixture-only-alpha" ? "alpha" : "beta";
		assert.equal(credentials.claudeAiOauth.accessToken, `fixture-only-${account}`);
		audit({ kind: "quota", account });
		const stream = (async function* (): AsyncGenerator<QuotaMessage, void> {
			yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } };
			yield { type: "result", subtype: "success", is_error: true, result: "You're out of extra usage" };
		})();
		// No SDK process/resources exist: close/interrupt only terminate this generator.
		const quotaQuery: QuotaQuery = Object.assign(stream, {
			close() {
				void stream.return(undefined);
			},
			interrupt: async () => {
				await stream.return(undefined);
				return undefined;
			},
		});
		// Controlled test-only SDK boundary: this quota path uses iteration, close and interrupt.
		// Messages intentionally omit unused SDK metadata; no other Query controls are implemented.
		return quotaQuery as unknown as Query;
	});
	activateBridge(pi);
	pi.on("session_start", (event) => audit({ kind: "start", reason: event.reason }));
	pi.on("session_shutdown", (event) => audit({ kind: "shutdown", reason: event.reason }));
	// /reload is TUI-only; expose that exact lifecycle through the documented RPC command context.
	pi.registerCommand("reload", {
		description: "Test-only RPC entry to Pi reload lifecycle",
		handler: async (_args, ctx) => {
			await ctx.reload();
		},
	});
}
