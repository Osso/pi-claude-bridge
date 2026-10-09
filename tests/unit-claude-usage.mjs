import { after, afterEach, beforeEach, it, mock } from "node:test";
import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { default as activate, __test } from "../src/index.ts";
import { AccountProfileManager } from "../src/query-state.ts";
import { reportClaudeUsage } from "../src/claude-usage.ts";

const originalEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
const reset = "2026-10-09T03:00:00.000Z";
const windows = { five_hour: { utilization: 42.5, resets_at: reset }, seven_day: { utilization: 90, resets_at: null }, seven_day_opus: null, seven_day_sonnet: { utilization: 0, resets_at: reset } };
const liveToken = "secret-live-token";
const credential = (token, expiresAt = Date.now() + 60_000) => JSON.stringify({ claudeAiOauth: { accessToken: token, expiresAt } });
let home;
let bus;
let provider;
let notices;
let messages;
let calls;
let extension;
let extensions;
const livePath = () => join(home, ".claude", ".credentials.json");
const isolatedPath = name => join(home, ".config", "pi-claude-bridge", "profiles", name, ".credentials.json");
function configure(names) {
	writeFileSync(join(home, "agent", "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "2026-10-08", provider: names === undefined ? {} : { accountProfiles: names } }));
	bus = createEventBus();
	extension = activateOnBus();
}
function activateOnBus(activateFn = activate) {
	const handlers = new Map();
	const sent = [];
	activateFn({
		events: bus,
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		registerProvider(_id, config) { provider = config; }, registerTool() {},
		sendMessage(message, options) {
			assert.equal(message.customType, "claude-usage");
			assert.equal(message.display, true);
			assert.equal(options?.triggerTurn, undefined, "quota report must not trigger inference");
			messages.push(message);
			sent.push(message);
		},
	});
	const activated = {
		messages: sent,
		async shutdown(reason = "reload", sessionId = "usage-test") {
			const ctx = { sessionManager: { getSessionId: () => sessionId } };
			for (const handler of handlers.get("session_shutdown") ?? []) {
				await handler({ type: "session_shutdown", reason }, ctx);
			}
		},
	};
	extensions.push(activated);
	return activated;
}
function snapshot(path) {
	return Object.fromEntries(readdirSync(path).sort().map(name => {
		const file = join(path, name);
		const stat = statSync(file);
		return [name, stat.isDirectory() ? snapshot(file) : { content: readFileSync(file, "utf8"), mode: stat.mode, mtime: stat.mtimeMs }];
	}));
}
function usageRequest(args = "") {
	return { args, ctx: { ui: { notify(text, level) { notices.push({ text, level }); } } } };
}
async function dispatch(args = "") {
	const payload = usageRequest(args);
	bus.emit("claude-bridge:usage-request", payload);
	assert.ok(payload.handled instanceof Promise, "listener synchronously claims routed request");
	await payload.handled;
	return notices.at(-1)?.text ?? messages.at(-1)?.content;
}
async function rejectOne() {
	__test.setQuery(() => {
		const stream = (async function* () {
			yield { type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } };
			yield { type: "result", subtype: "success", is_error: true, result: "You're out of extra usage" };
		})();
		stream.close = () => {};
		stream.interrupt = async () => {};
		return stream;
	});
	await provider.streamSimple(provider.models[0], { messages: [{ role: "user", content: "work", timestamp: 1 }], tools: [] }, { sessionId: "usage-test" }).result();
}
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "bridge-usage-"));
	process.env.HOME = home;
	process.env.PI_CODING_AGENT_DIR = join(home, "agent");
	process.env.CLAUDE_CONFIG_DIR = join(home, ".claude");
	mkdirSync(join(home, ".claude", "projects"), { recursive: true });
	mkdirSync(join(home, "agent"));
	writeFileSync(join(home, ".claude", ".active-profile"), "alpha");
	writeFileSync(livePath(), credential(liveToken));
	for (const name of ["alpha", "beta"]) writeFileSync(join(home, ".claude", `${name}.credentials.json`), credential(`secret-${name}`));
	__test.setQuery(() => assert.fail("Unexpected SDK query in usage test"));
	__test.resetAccountProfiles();
	__test.resetSharedSession();
	extensions = [];
	notices = [];
	messages = [];
	calls = [];
	mock.method(globalThis, "fetch", async (url, options) => { calls.push({ url, options }); return Response.json(windows); });
	configure();
});
afterEach(async () => {
	for (const activated of extensions) await activated.shutdown();
	__test.setQuery(null);
	mock.restoreAll();
	rmSync(home, { recursive: true, force: true });
});
after(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
});

it("routed empty args display current subscription percentages and timezone resets, without inference", async () => {
	const before = snapshot(home);
	const text = await dispatch("  ");
	assert.match(text, /alpha/);
	assert.match(text, /subscription quota/i);
	assert.match(text, /not session token/i);
	assert.match(text, /5.hour: 42\.5%/i);
	assert.match(text, /7.day: 90%.*reset unavailable/i);
	assert.match(text, /Opus: unavailable/i);
	assert.match(text, /Sonnet: 0%/i);
	assert.ok(text.includes(reset));
	assert.equal(calls[0].url, "https://api.anthropic.com/api/oauth/usage");
	assert.equal(calls[0].options.headers.Authorization, `Bearer ${liveToken}`);
	assert.equal(calls[0].options.headers["anthropic-beta"], "oauth-2025-04-20");
	assert.deepEqual(snapshot(home), before);
	assert.equal(notices.length, 0);
	assert.equal(messages.length, 1);
	assert.ok(!text.includes(liveToken));
});
it("repeated activation and delivery fetch and display each request only once", async () => {
	const duplicate = activateOnBus();
	const request = usageRequest();
	bus.emit("claude-bridge:usage-request", request);
	assert.ok(request.handled instanceof Promise);
	bus.emit("claude-bridge:usage-request", request);
	await request.handled;
	bus.emit("claude-bridge:usage-request", request);
	await request.handled;
	assert.equal(calls.length, 1);
	assert.equal(messages.length, 1);
	assert.match(messages[0].content, /5.hour: 42\.5%/i);
	assert.equal(extension.messages.length, 1);
	assert.equal(duplicate.messages.length, 0);
	assert.equal(notices.length, 0);
});
it("independent module activations on a shared bus deliver one report", async () => {
	const { default: activateFresh, __test: freshTest } = await import("../src/index.ts?usage-duplicate");
	freshTest.setQuery(() => assert.fail("Unexpected SDK query in duplicate usage module"));
	const duplicate = activateOnBus(activateFresh);
	await dispatch();
	assert.equal(calls.length, 1);
	assert.equal(messages.length, 1);
	assert.equal(extension.messages.length, 1);
	assert.equal(duplicate.messages.length, 0);
});
it("already handled requests preserve the claim without fetch or display", async () => {
	const handled = Promise.resolve();
	const request = { ...usageRequest(), handled };
	bus.emit("claude-bridge:usage-request", request);
	await request.handled;
	assert.equal(request.handled, handled);
	assert.equal(calls.length, 0);
	assert.equal(messages.length, 0);
	assert.equal(notices.length, 0);
});
it("shutdown removes the old listener before a fresh activation owns reports", async () => {
	const old = extension;
	await old.shutdown();
	const unclaimed = usageRequest();
	bus.emit("claude-bridge:usage-request", unclaimed);
	assert.equal(unclaimed.handled, undefined);
	assert.equal(calls.length, 0);

	const { default: activateFresh, __test: freshTest } = await import("../src/index.ts?usage-reload");
	freshTest.setQuery(() => assert.fail("Unexpected SDK query in reloaded usage module"));
	const fresh = activateOnBus(activateFresh);
	await old.shutdown();
	await dispatch();
	assert.equal(calls.length, 1);
	assert.equal(messages.length, 1);
	assert.equal(old.messages.length, 0);
	assert.equal(fresh.messages.length, 1);
	assert.match(fresh.messages[0].content, /Claude account: alpha/);
});
it("child shutdown removes only its listener and leaves the parent reporting", async () => {
	const { default: activateChild, __test: childTest } = await import("../src/index.ts?usage-child");
	childTest.setQuery(() => assert.fail("Unexpected SDK query in child usage module"));
	const child = activateOnBus(activateChild);
	await child.shutdown("quit", "usage-child");
	await dispatch();
	assert.equal(calls.length, 1);
	assert.equal(messages.length, 1);
	assert.equal(extension.messages.length, 1);
	assert.equal(child.messages.length, 0);

	await extension.shutdown("quit", "usage-parent");
	const unclaimed = usageRequest();
	bus.emit("claude-bridge:usage-request", unclaimed);
	assert.equal(unclaimed.handled, undefined);
	assert.equal(calls.length, 1);
	assert.equal(messages.length, 1);
});
it("duplicate listeners notify unsupported args only once without fetching", async () => {
	activateOnBus();
	await dispatch("reset");
	assert.equal(calls.length, 0);
	assert.equal(messages.length, 0);
	assert.equal(notices.length, 1);
	assert.equal(notices[0].level, "warning");
});
for (const marker of ["beta", undefined]) {
	it(`no rotation config labels custom beta credentials as ${marker ?? "current"} without mutations`, async () => {
		const custom = join(home, "custom");
		mkdirSync(custom);
		writeFileSync(join(custom, ".credentials.json"), credential("secret-beta"));
		if (marker !== undefined) writeFileSync(join(custom, ".active-profile"), marker);
		process.env.CLAUDE_CONFIG_DIR = custom;
		const before = snapshot(home);
		const text = await dispatch();
		assert.equal(calls[0].options.headers.Authorization, "Bearer secret-beta");
		assert.equal(text.split("\n")[0], `Claude account: ${marker ?? "current"}`);
		assert.deepEqual(snapshot(home), before);
		assert.equal(process.env.CLAUDE_CONFIG_DIR, custom);
	});
}
it("selected active profile uses live credentials before initialization", async () => {
	configure(["alpha", "beta"]);
	const before = snapshot(home);
	await dispatch();
	assert.equal(calls[0].options.headers.Authorization, `Bearer ${liveToken}`);
	assert.deepEqual(snapshot(home), before);
});
it("selected nonactive profile reads named credentials without initializing dirs", async () => {
	configure(["beta"]);
	const before = snapshot(home);
	assert.match(await dispatch(), /beta/);
	assert.equal(calls[0].options.headers.Authorization, "Bearer secret-beta");
	assert.deepEqual(snapshot(home), before);
});
it("rotation-selected profile prefers CC-owned isolated credentials over global and named", async () => {
	configure(["alpha", "beta"]);
	await rejectOne();
	mkdirSync(join(isolatedPath("beta"), ".."), { recursive: true });
	writeFileSync(isolatedPath("beta"), credential("cc-refreshed-secret"));
	const before = snapshot(home);
	assert.match(await dispatch(), /beta/);
	assert.equal(calls[0].options.headers.Authorization, "Bearer cc-refreshed-secret");
	assert.deepEqual(snapshot(home), before);
	assert.match(await dispatch(), /beta/);
});
it("already selected isolated account does not depend on a readable global marker", async () => {
	configure(["alpha", "beta"]);
	await rejectOne();
	await rejectOne();
	const marker = join(home, ".claude", ".active-profile");
	rmSync(marker);
	mkdirSync(marker);
	assert.match(await dispatch(), /Claude account: beta/);
	assert.equal(calls[0].options.headers.Authorization, "Bearer secret-beta");
});
it("all-exhausted reports last selected beta, not active alpha or another account", async () => {
	configure(["alpha", "beta"]);
	await rejectOne();
	await rejectOne();
	const before = snapshot(home);
	assert.match(await dispatch(), /beta/);
	assert.equal(calls[0].options.headers.Authorization, "Bearer secret-beta");
	assert.deepEqual(snapshot(home), before);
});
it("manager read-only getter retains last selected on exhausted selection", () => {
	const manager = new AccountProfileManager(["alpha", "beta"], "alpha");
	assert.equal(manager.selectedProfile, "alpha");
	assert.equal(manager.reject("alpha", undefined, 0), "beta");
	assert.equal(manager.reject("beta", undefined, 0), undefined);
	assert.equal(manager.selectedProfile, "beta");
	assert.equal(manager.select(1), undefined);
	assert.equal(manager.selectedProfile, "beta");
});
for (const args of ["reset", "unknown", "alpha", "reset --force", null]) {
	it(`unsupported args ${args} notify without HTTP, reset credit calls, or custom message`, async () => {
		assert.match(await dispatch(args), /unsupported.*Claude/i);
		assert.equal(calls.length, 0);
		assert.equal(messages.length, 0);
		assert.equal(notices.at(-1).level, "warning");
	});
}
it("empty rotation configuration does not report another active account", async () => {
	configure([]);
	assert.match(await dispatch(), /no selected.*profile/i);
	assert.equal(calls.length, 0);
});
for (const [label, optionalWindows] of [
	["absent", {}],
	["explicit null", { seven_day_opus: null, seven_day_sonnet: null }],
]) {
	it(`base windows with ${label} optional model windows render unavailable`, async () => {
		const payload = { five_hour: windows.five_hour, seven_day: windows.seven_day, ...optionalWindows };
		mock.method(globalThis, "fetch", async () => Response.json(payload));
		assert.equal(await dispatch(), [
			"Claude account: alpha",
			"Subscription quota (not session token usage)",
			`5-hour: 42.5% — resets ${reset} (UTC)`,
			"7-day: 90% — reset unavailable",
			"7-day Opus: unavailable",
			"7-day Sonnet: unavailable",
		].join("\n"));
		assert.equal(notices.length, 0);
		assert.equal(messages.length, 1);
	});
}
for (const field of ["seven_day_opus", "seven_day_sonnet"]) {
	for (const value of ["not a window", { utilization: "42", resets_at: reset }]) {
		it(`rejects malformed present optional ${field}: ${JSON.stringify(value)}`, async () => {
			mock.method(globalThis, "fetch", async () => Response.json({ ...windows, [field]: value }));
			assert.match(await dispatch(), /invalid.*usage response/i);
			assert.equal(messages.length, 0);
			assert.equal(notices.at(-1).level, "error");
		});
	}
}
for (const field of ["five_hour", "seven_day"]) {
	it(`rejects missing core window ${field}`, async () => {
		const payload = { ...windows };
		delete payload[field];
		mock.method(globalThis, "fetch", async () => Response.json(payload));
		assert.match(await dispatch(), /invalid.*usage response/i);
		assert.equal(messages.length, 0);
		assert.equal(notices.at(-1).level, "error");
	});
}
it("all null windows explicitly unavailable", async () => {
	mock.method(globalThis, "fetch", async () => Response.json(Object.fromEntries(Object.keys(windows).map(key => [key, null]))));
	assert.equal((await dispatch()).match(/: unavailable/g).length, 4);
});
for (const [name, value, message] of [
	["missing token", { claudeAiOauth: {} }, /missing.*token/i],
	["expired token", { claudeAiOauth: { accessToken: liveToken, expiresAt: 1 } }, /expired.*token/i],
	["invalid expiry", { claudeAiOauth: { accessToken: liveToken, expiresAt: "not-date" } }, /invalid.*credentials/i],
]) {
	it(`explicit ${name} without fetch or inference`, async () => {
		writeFileSync(livePath(), JSON.stringify(value));
		assert.match(await dispatch(), message);
		assert.equal(calls.length, 0);
		assert.equal(messages.length, 0);
	});
}
it("expired isolated credentials cannot fall back to fresh named or live account", async () => {
	configure(["alpha"]);
	mkdirSync(join(isolatedPath("alpha"), ".."), { recursive: true });
	writeFileSync(isolatedPath("alpha"), credential("expired-secret", 1));
	const before = snapshot(home);
	assert.match(await dispatch(), /expired.*token/i);
	assert.equal(calls.length, 0);
	assert.deepEqual(snapshot(home), before);
});
it("missing credentials explicit without initialization", async () => {
	rmSync(livePath());
	const before = snapshot(home);
	assert.match(await dispatch(), /missing.*credentials/i);
	assert.equal(calls.length, 0);
	assert.deepEqual(snapshot(home), before);
});
it("malformed credentials do not expose parser text or secrets", async () => {
	writeFileSync(livePath(), `{"secret":"${liveToken}`);
	const text = await dispatch();
	assert.match(text, /invalid.*credentials/i);
	assert.ok(!text.includes(liveToken));
});
for (const [label, value] of [
	["missing fields", {}], ["array", []],
	["invalid percent", { ...windows, five_hour: { utilization: 101, resets_at: reset } }],
	["string percent", { ...windows, five_hour: { utilization: "42", resets_at: reset } }],
	["secret reset", { ...windows, five_hour: { utilization: 5, resets_at: liveToken } }],
]) {
	it(`rejects malformed API ${label} without secret output`, async () => {
		mock.method(globalThis, "fetch", async () => Response.json(value));
		const text = await dispatch();
		assert.match(text, /invalid.*usage response/i);
		assert.equal(messages.length, 0);
		assert.ok(!text.includes(liveToken));
	});
}
it("reset offset is rendered as explicit UTC timezone", async () => {
	mock.method(globalThis, "fetch", async () => Response.json({ ...windows, five_hour: { utilization: 50, resets_at: "2026-10-09T05:00:00+02:00" } }));
	assert.match(await dispatch(), /5-hour: 50%.*2026-10-09T03:00:00\.000Z \(UTC\)/);
});
it("reset without timezone is invalid, not interpreted in host timezone", async () => {
	mock.method(globalThis, "fetch", async () => Response.json({ ...windows, five_hour: { utilization: 50, resets_at: "2026-10-09T03:00:00" } }));
	assert.match(await dispatch(), /invalid.*usage response/i);
});
it("malformed JSON response sanitized", async () => {
	mock.method(globalThis, "fetch", async () => new Response(liveToken));
	assert.match(await dispatch(), /invalid.*usage response/i);
});
for (const status of [400, 401, 403]) {
	it(`HTTP ${status} explicit single attempt without body output`, async () => {
		let attempts = 0;
		mock.method(globalThis, "fetch", async () => { attempts++; return new Response(liveToken, { status }); });
		const text = await dispatch();
		assert.match(text, new RegExp(`HTTP ${status}`));
		if (status === 401) assert.match(text, /expired|rejected/i);
		assert.ok(!text.includes(liveToken));
		assert.equal(messages.length, 0);
		assert.equal(attempts, 1);
	});
}
for (const retryAfter of ["3600", new Date(Date.now() + 3_600_000).toUTCString()]) {
	it(`long 429 Retry-After ${retryAfter} returns actionable result without retry or sleep`, async () => {
		let attempts = 0;
		mock.method(globalThis, "fetch", async () => { attempts++; return new Response(liveToken, { status: 429, headers: { "Retry-After": retryAfter } }); });
		const text = await dispatch();
		assert.match(text, /HTTP 429.*retry.*after/i);
		assert.ok(!text.includes(liveToken));
		assert.equal(attempts, 1);
	});
}
async function reportWithRetry(fetchImpl) {
	let now = 1_000_000;
	const waits = [];
	let attempts = 0;
	await reportClaudeUsage("", { ui: { notify(text, level) { notices.push({ text, level }); } } }, () => ({ home, name: "alpha" }), text => messages.push({ content: text }), {
		fetch: async (...args) => { attempts++; return fetchImpl(attempts, ...args); },
		now: () => now, random: () => 0.5,
		sleep: async delay => { assert.ok(delay <= 5000); waits.push(delay); now += delay; },
	});
	return { attempts, waits, text: notices.at(-1)?.text ?? messages.at(-1)?.content };
}
it("short 429 respects deadline before second request", async () => {
	const result = await reportWithRetry(attempt => attempt === 1 ? new Response("", { status: 429, headers: { "Retry-After": "2" } }) : Response.json(windows));
	assert.equal(result.attempts, 2);
	assert.ok(result.waits[0] >= 2000);
	assert.match(result.text, /42\.5%/);
});
it("transient 5xx retry with bounded exponential jitter", async () => {
	const result = await reportWithRetry(attempt => attempt < 3 ? new Response(liveToken, { status: 503 }) : Response.json(windows));
	assert.equal(result.attempts, 3);
	assert.equal(result.waits.length, 2);
	assert.ok(result.waits[1] > result.waits[0]);
	assert.match(result.text, /42\.5%/);
});
it("network failure retries bounded without leaking exception secrets", async () => {
	const result = await reportWithRetry(() => { throw new Error(`fetch ${liveToken}`); });
	assert.equal(result.attempts, 3);
	assert.match(result.text, /network/i);
	assert.ok(!result.text.includes(liveToken));
});
it("repeated short 429 respects total five-second wait boundary", async () => {
	const result = await reportWithRetry(() => new Response("", { status: 429, headers: { "Retry-After": "3" } }));
	assert.equal(result.attempts, 2);
	assert.deepEqual(result.waits, [3000]);
	assert.match(result.text, /HTTP 429/);
});
it("long 5xx Retry-After prevents premature retry", async () => {
	const result = await reportWithRetry(() => new Response(liveToken, { status: 503, headers: { "Retry-After": "3600" } }));
	assert.equal(result.attempts, 1);
	assert.deepEqual(result.waits, []);
	assert.match(result.text, /HTTP 503/);
});
