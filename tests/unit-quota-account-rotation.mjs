import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSessionPath } from "cc-session-io";

let root = mkdtempSync(join(tmpdir(), "bridge-quota-"));
const originalCwd = process.cwd();
const originalEnv = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
process.env.HOME = root;
process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.chdir(root);
mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
const { default: activate, __test } = await import("../src/index.js");
const { resetCtx } = await import("../src/query-state.js");
let provider;
let now;
const calls = [];
const scripts = [];
const credentials = (name) => join(root, ".claude", `${name}.credentials.json`);
const profileDir = (name) => join(root, ".config", "pi-claude-bridge", "profiles", name);
const ok = { type: "result", subtype: "success", is_error: false, result: "done" };
const failure = (text = "You're out of extra usage") => ({ ...ok, is_error: true, result: text });
const rejected = (resetsAt) => ({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", ...(resetsAt === undefined ? {} : { resetsAt }) } });
const user = { role: "user", content: "work", timestamp: 1 };
const gate = () => { let open; const wait = new Promise((resolve) => { open = resolve; }); return { wait, open }; };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const readTool = { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } };
const turn = (sessionId = "pi-main", messages = [user], signal) => provider.streamSimple(provider.models[0], { messages, tools: [readTool] }, { sessionId, signal });
function configure(names = ["alpha", "beta"], active = "alpha") {
	writeFileSync(join(root, ".claude", ".active-profile"), active);
	writeFileSync(join(root, ".claude", ".credentials.json"), readFileSync(credentials(active)));
	writeFileSync(join(root, "agent", "claude-bridge.json"), JSON.stringify({ startupNoticeShown: "2026-10-08", provider: { accountProfiles: names } }));
	activate({ events: new EventEmitter(), on() {}, registerProvider(_name, config) { provider = config; }, registerTool() {} });
}

beforeEach(() => {
	__test.resetSharedSession();
	__test.resetAccountProfiles();
	__test.activeQueryContexts.clear();
	resetCtx();
	calls.length = 0;
	scripts.length = 0;
	process.chdir(originalCwd);
	rmSync(root, { recursive: true, force: true });
	root = mkdtempSync(join(tmpdir(), "bridge-quota-"));
	process.env.HOME = root;
	process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	process.chdir(root);
	for (const name of ["alpha", "beta", "gamma"]) writeFileSync(credentials(name), JSON.stringify({ token: name }));
	now = 2_000_000_000_000;
	mock.method(Date, "now", () => now);
	configure();
	__test.setQuery(({ options, prompt }) => {
		const steps = scripts.shift();
		assert.ok(steps, "a bounded query script must be queued");
		calls.push(options);
		const generator = (async function* () {
			for (const step of steps) {
				if (typeof step === "function") await step(options, prompt);
				else yield step;
			}
		})();
		generator.interrupt = async () => {};
		generator.close = () => {};
		return generator;
	});
});
afterEach(async () => { await settle(); __test.setQuery(null); mock.restoreAll(); });
after(() => {
	process.chdir(originalCwd);
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key]; else process.env[key] = value;
	}
	rmSync(root, { recursive: true, force: true });
});

describe("provider quota account rotation", () => {
	it("uses included active marker and isolates only the SDK child environment", async () => {
		configure(["alpha", "beta"], "beta");
		scripts.push([ok]);
		await turn().result();
		assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
		assert.equal(process.env.CLAUDE_CONFIG_DIR, join(root, ".claude"));
		assert.equal(realpathSync(join(profileDir("beta"), "projects")), join(root, ".claude", "projects"));
	});

	it("uses first configured account when active marker is not included", async () => {
		configure(["beta", "alpha"], "gamma");
		scripts.push([ok]);
		await turn().result();
		assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
	});

	for (const rateLimitType of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet", "seven_day_overage_included"]) {
		it(`rotates on rejected ${rateLimitType} followed by failed result, keeping Pi retry text`, async () => {
			const event = rejected(now / 1000 + 60);
			event.rate_limit_info.rateLimitType = rateLimitType;
			scripts.push([event, failure()], [ok]);
			const failed = await turn().result();
			assert.equal(failed.stopReason, "error");
			assert.match(failed.errorMessage, /rate limit/i);
			assert.equal(calls.length, 1, "bridge must not replay the prompt internally");
			await turn().result();
			assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
		});
	}

	for (const [label, info, text] of [
		["long-context credits gate", { status: "rejected", overageDisabledReason: "org_level_disabled", isUsingOverage: false }, "Usage credits are required for long context requests."],
		["missing window", { status: "rejected" }, "API Error: 429"],
		["unknown window", { status: "rejected", rateLimitType: "future_window" }, "API Error: 429"],
		["overage window", { status: "rejected", rateLimitType: "overage" }, "You're out of extra usage"],
		["credits_required with subscription window", { status: "rejected", rateLimitType: "five_hour", errorCode: "credits_required" }, "Usage credits are required for long context requests."],
	]) {
		it(`does not rotate or blacklist on ${label}, preserving the rate-limit label`, async () => {
			scripts.push([{ type: "rate_limit_event", rate_limit_info: info }, failure(text)], [ok]);
			const failed = await turn().result();
			assert.equal(failed.stopReason, "error");
			assert.ok(failed.errorMessage.startsWith("Claude rate limit"));
			assert.ok(failed.errorMessage.endsWith(text));
			assert.equal((await turn().result()).stopReason, "stop");
			assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, profileDir("alpha"));
		});
	}

	it("stops explicitly after all accounts are exhausted, without retry vocabulary or another SDK query", async () => {
		scripts.push([rejected(), failure()], [rejected(), failure()]);
		await turn().result();
		const exhausted = await turn().result();
		assert.match(exhausted.errorMessage, /account profiles exhausted/i);
		assert.doesNotMatch(exhausted.errorMessage, /rate.?limit|429|overload|capacity|temporar|retry|timeout|fetch failed|network|connection/i);
		const again = await turn().result();
		assert.match(again.errorMessage, /account profiles exhausted/i);
		assert.equal(calls.length, 2);
	});

	it("unblocks at resetsAt Unix seconds, not milliseconds", async () => {
		scripts.push([rejected(now / 1000 + 60), failure()], [rejected(), failure()], [ok]);
		await turn().result();
		await turn().result();
		now += 59_000;
		assert.match((await turn().result()).errorMessage, /account profiles exhausted/i);
		now += 1_000;
		await turn().result();
		assert.equal(calls.at(-1).env.CLAUDE_CONFIG_DIR, profileDir("alpha"));
	});

	it("retains undated rejection until manager reset", async () => {
		configure(["alpha"]);
		scripts.push([rejected(), failure()], [ok]);
		await turn().result();
		now += 365 * 24 * 60 * 60 * 1000;
		assert.match((await turn().result()).errorMessage, /account profiles exhausted/i);
		__test.resetAccountProfiles();
		await turn().result();
		assert.equal(calls.length, 2);
	});

	for (const [label, steps] of [
		["ordinary capacity 429", [failure("API Error: 429 capacity")]],
		["authentication error", [failure("Authentication failed")]],
		["warning event", [{ type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", utilization: 0.9 } }, failure("API Error: 429")]],
		["rejected event followed by success", [rejected(), ok, failure("Authentication failed")]],
	]) {
		it(`does not rotate on ${label}`, async () => {
			scripts.push(steps, [ok]);
			await turn().result();
			await turn().result();
			assert.equal(calls.at(-1).env.CLAUDE_CONFIG_DIR, profileDir("alpha"));
		});
	}

	it("persists refreshed credentials before success, result failure, or iterator failure settles", async () => {
		for (const ending of [[ok], [failure("Authentication failed")], [() => { throw new Error("SDK transport failed"); }]]) {
			const refreshed = JSON.stringify({ token: `refreshed-${calls.length}` });
			scripts.push([(options) => writeFileSync(join(options.env.CLAUDE_CONFIG_DIR, ".credentials.json"), refreshed), ...ending]);
			await turn().result();
			assert.equal(readFileSync(credentials("alpha"), "utf8"), refreshed);
		}
	});

	it("cancellation after rejection does not exhaust the account and still persists refresh", async () => {
		const controller = new AbortController();
		const refreshed = JSON.stringify({ token: "cancel-refresh" });
		scripts.push([rejected(), (options) => {
			writeFileSync(join(options.env.CLAUDE_CONFIG_DIR, ".credentials.json"), refreshed);
			controller.abort();
		}, failure()], [ok]);
		assert.equal((await turn("cancelled", [user], controller.signal).result()).stopReason, "aborted");
		assert.equal(readFileSync(credentials("alpha"), "utf8"), refreshed);
		await turn().result();
		assert.equal(calls.at(-1).env.CLAUDE_CONFIG_DIR, profileDir("alpha"));
	});

	it("cancellation after the failed quota result but before iterator settlement does not rotate", async () => {
		const controller = new AbortController();
		scripts.push([rejected(), failure(), () => controller.abort()], [ok]);
		assert.equal((await turn("late-cancel", [user], controller.signal).result()).stopReason, "aborted");
		await turn().result();
		assert.equal(calls.at(-1).env.CLAUDE_CONFIG_DIR, profileDir("alpha"));
	});

	it("synchronous SDK startup failure returns an error stream and persists a refreshed token", async () => {
		__test.setQuery(({ options }) => {
			writeFileSync(join(options.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify({ token: "startup-refresh" }));
			throw new Error("SDK startup failed");
		});
		const output = await turn().result();
		assert.equal(output.stopReason, "error");
		assert.equal(output.errorMessage, "SDK startup failed");
		assert.deepEqual(JSON.parse(readFileSync(credentials("alpha"), "utf8")), { token: "startup-refresh" });
	});

	it("late concurrent alpha rejection cannot advance the already selected beta to gamma", async () => {
		configure(["alpha", "beta", "gamma"]);
		const held = gate();
		scripts.push([() => held.wait, rejected(), failure()], [rejected(), failure()], [ok], [ok]);
		const slow = turn("slow");
		await turn("fast").result();
		await turn("beta-before").result();
		held.open();
		await slow.result();
		await turn("beta-after").result();
		assert.deepEqual(calls.map((call) => call.env.CLAUDE_CONFIG_DIR), [profileDir("alpha"), profileDir("alpha"), profileDir("beta"), profileDir("beta")]);
	});

	it("retries Pi recorded tool results with the next profile and the shared session path", { timeout: 5_000 }, async () => {
		const history = [user, {
			role: "assistant", content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "file" } }],
			api: provider.models[0].api, provider: provider.models[0].provider, model: provider.models[0].id,
			stopReason: "toolUse", timestamp: 2,
		}, { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "recorded-file-content" }], isError: false, timestamp: 3 }];
		const delivered = gate();
		const streamEvent = (event) => ({ type: "stream_event", event });
		scripts.push([
			streamEvent({ type: "message_start", message: { id: "msg-read", usage: {} } }),
			streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "read-1", name: "mcp__custom-tools__read", input: {} } }),
			streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":"file"}' } }),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} }),
			streamEvent({ type: "message_stop" }),
			() => delivered.wait, rejected(), failure(),
		], [ok]);
		const toolTurn = await turn().result();
		assert.equal(toolTurn.stopReason, "toolUse");
		const resultTurn = turn("pi-main", history);
		delivered.open();
		assert.match((await resultTurn.result()).errorMessage, /rate limit/i);
		const retryTurn = turn("pi-main", history);
		assert.equal(calls.length, 2, "retry must start a fresh query immediately, before old cleanup finishes");
		await retryTurn.result();
		assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
		const state = __test.getSharedSession("pi-main");
		const globalPath = getSessionPath(state.sessionId, root, process.env.CLAUDE_CONFIG_DIR);
		const childPath = getSessionPath(state.sessionId, root, calls[1].env.CLAUDE_CONFIG_DIR);
		assert.equal(realpathSync(childPath), realpathSync(globalPath));
		assert.match(readFileSync(childPath, "utf8"), /recorded-file-content/);
	});
});

describe("persisted account selection", () => {
	const stateDir = () => join(root, ".config", "pi-claude-bridge", "account-state");
	const sharedState = async () => (await import("../src/account-profiles.js")).readAccountState(root);
	const restartProcess = () => __test.resetAccountProfiles();

	it("keeps the rotated account after a process restart instead of retrying the exhausted one", async () => {
		scripts.push([rejected(now / 1000 + 3600), failure()], [ok]);
		await turn().result();
		restartProcess();
		await turn().result();
		assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
		assert.deepEqual(await sharedState(), { current: "beta", rejected: { alpha: now / 1000 + 3600 } });
	});

	it("stays on the working account after the exhausted one resets", async () => {
		scripts.push([rejected(now / 1000 + 60), failure()], [ok], [ok]);
		await turn().result();
		await turn().result();
		now += 120_000;
		restartProcess();
		await turn().result();
		assert.equal(calls[2].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
		assert.deepEqual(await sharedState(), { current: "beta", rejected: {} });
	});

	it("skips an account another process recorded as still exhausted", async () => {
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(join(stateDir(), "1.json"), JSON.stringify({ current: "alpha", rejected: { alpha: now / 1000 + 600 }, updatedAt: now }));
		scripts.push([ok]);
		await turn().result();
		assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
	});

	it("does not persist a rejection without a reset time", async () => {
		scripts.push([rejected(), failure()], [ok]);
		await turn().result();
		assert.deepEqual(await sharedState(), { current: "beta", rejected: {} });
		restartProcess();
		await turn().result();
		assert.equal(calls[1].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
	});

	it("fails explicitly on a corrupt state file", async () => {
		mkdirSync(stateDir(), { recursive: true });
		writeFileSync(join(stateDir(), "1.json"), "{not json");
		const output = await turn().result();
		assert.equal(output.stopReason, "error");
		assert.match(output.errorMessage, /account-state\/1\.json/);
		assert.equal(calls.length, 0);
	});
});

describe("isolated one-off request account rotation", () => {
	const titleRequest = () =>
		provider.streamSimple(
			provider.models[0],
			{ systemPrompt: "Create a concise session title.", messages: [user] },
			{ cacheRetention: "none" },
		);
	const titleResult = { type: "result", subtype: "success", is_error: false, result: "Postgres Tuning" };

	beforeEach(() => {
		__test.setIsolatedQuery(({ options, prompt }) => {
			const steps = scripts.shift();
			assert.ok(steps, "a bounded query script must be queued");
			calls.push(options);
			const generator = (async function* () {
				for (const step of steps) {
					if (typeof step === "function") await step(options, prompt);
					else yield step;
				}
			})();
			generator.interrupt = async () => {};
			generator.close = () => {};
			return generator;
		});
	});
	afterEach(() => __test.setIsolatedQuery(null));

	it("runs on the selected account", async () => {
		configure(["alpha", "beta"], "beta");
		scripts.push([titleResult]);
		const output = await titleRequest().result();
		assert.equal(output.stopReason, "stop");
		assert.equal(calls[0].env.CLAUDE_CONFIG_DIR, profileDir("beta"));
	});

	it("rotates to the next account on a subscription quota rejection within the same request", async () => {
		scripts.push([rejected(now / 1000 + 3600), failure("You've hit your session limit")], [titleResult]);
		const output = await titleRequest().result();
		assert.equal(output.stopReason, "stop");
		assert.equal(output.content[0].text, "Postgres Tuning");
		assert.deepEqual(calls.map((call) => call.env.CLAUDE_CONFIG_DIR), [profileDir("alpha"), profileDir("beta")]);
		scripts.push([ok]);
		await turn().result();
		assert.equal(calls[2].env.CLAUDE_CONFIG_DIR, profileDir("beta"), "the main path shares the rotation");
	});

	it("reports exhaustion when every account is over its limit", async () => {
		scripts.push([rejected(now / 1000 + 60), failure()], [rejected(now / 1000 + 60), failure()]);
		const output = await titleRequest().result();
		assert.equal(output.stopReason, "error");
		assert.match(output.errorMessage, /exhausted/);
		assert.equal(calls.length, 2);
	});

	it("does not rotate on a failure that follows a rejection already superseded by a success", async () => {
		const authFailure = { type: "result", subtype: "success", is_error: true, result: "Invalid API key" };
		scripts.push([rejected(now / 1000 + 3600), titleResult, authFailure]);
		const output = await titleRequest().result();
		assert.equal(output.stopReason, "error");
		assert.equal(output.errorMessage, "Invalid API key");
		assert.equal(calls.length, 1);
	});

	it("does not rotate on a non-quota failure", async () => {
		scripts.push([failure("API Error: 500")]);
		const output = await titleRequest().result();
		assert.equal(output.stopReason, "error");
		assert.equal(calls.length, 1);
	});
});

describe("account state shared between processes", () => {
	const sharedStore = () => {
		let state;
		return {
			read: () => state && structuredClone(state),
			update: (change) => { state = structuredClone(change(state && structuredClone(state))); },
		};
	};

	it("an older process does not write its stale account back over another process's rotation", async () => {
		const { AccountProfileManager } = await import("../src/query-state.js");
		const store = sharedStore();
		const older = new AccountProfileManager(["alpha", "beta"], "alpha", store);
		const newer = new AccountProfileManager(["alpha", "beta"], "alpha", store);
		assert.equal(older.select(100), "alpha");
		assert.equal(newer.reject("alpha", 500, 100), "beta");
		assert.equal(older.select(101), "beta");
		assert.deepEqual(store.read(), { current: "beta", rejected: { alpha: 500 } });
	});

	it("merges rejections recorded by both processes", async () => {
		const { AccountProfileManager } = await import("../src/query-state.js");
		const store = sharedStore();
		const first = new AccountProfileManager(["alpha", "beta", "gamma"], "alpha", store);
		const second = new AccountProfileManager(["alpha", "beta", "gamma"], "alpha", store);
		assert.equal(first.reject("alpha", 500, 100), "beta");
		assert.equal(second.reject("beta", 600, 100), "gamma");
		assert.equal(first.select(101), "gamma");
		assert.deepEqual(store.read(), { current: "gamma", rejected: { alpha: 500, beta: 600 } });
	});

	it("keeps another process's dated rejection when this process holds an undated one", async () => {
		const { AccountProfileManager } = await import("../src/query-state.js");
		const store = sharedStore();
		const local = new AccountProfileManager(["alpha", "beta"], "alpha", store);
		const other = new AccountProfileManager(["alpha", "beta"], "alpha", store);
		assert.equal(local.reject("alpha", undefined, 100), "beta");
		assert.equal(other.reject("alpha", 500, 100), "beta");
		local.select(101);
		assert.deepEqual(store.read(), { current: "beta", rejected: { alpha: 500 } });
	});

	it("loses no update when real processes rewrite the state file concurrently", { timeout: 60_000 }, async () => {
		const { execFile } = await import("node:child_process");
		const { promisify } = await import("node:util");
		const { fileURLToPath } = await import("node:url");
		const { readAccountState } = await import("../src/account-profiles.js");
		const modulePath = fileURLToPath(new URL("../src/account-profiles.ts", import.meta.url));
		const writer = (name) => `
			const { updateAccountState } = await import(${JSON.stringify(modulePath)});
			for (let i = 0; i < 40; i++) {
				updateAccountState(${JSON.stringify(root)}, (state) => {
					const rejected = { ...(state?.rejected ?? {}) };
					rejected[${JSON.stringify(name)}] = (rejected[${JSON.stringify(name)}] ?? 0) + 1;
					return { rejected };
				});
			}`;
		const run = promisify(execFile);
		const names = ["p0", "p1", "p2", "p3"];
		await Promise.all(names.map((name) =>
			run(process.execPath, ["--import", "tsx", "--input-type=module", "-e", writer(name)], { cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, HOME: root } }),
		));
		assert.deepEqual(readAccountState(root), { rejected: { p0: 40, p1: 40, p2: 40, p3: 40 } });
	});

	it("keeps an update another process published and exited with while this one was writing", async () => {
		const { readAccountState, updateAccountState, accountStateDir } = await import("../src/account-profiles.js");
		const dir = accountStateDir(root);
		const exitedPid = 2 ** 22 + 3;
		updateAccountState(root, (state) => {
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, `${exitedPid}.json`), JSON.stringify({ current: "gamma", rejected: { beta: 600 }, updatedAt: Date.now() + 5 }));
			return { current: "beta", rejected: { ...(state?.rejected ?? {}), alpha: 500 } };
		});
		assert.deepEqual(readAccountState(root), { current: "gamma", rejected: { alpha: 500, beta: 600 } });
	});

	it("merges a newer selection from another process and prunes files of exited processes", async () => {
		const { readAccountState, updateAccountState, accountStateDir } = await import("../src/account-profiles.js");
		const dir = accountStateDir(root);
		mkdirSync(dir, { recursive: true });
		const deadPid = 2 ** 22 + 1;
		writeFileSync(join(dir, `${deadPid}.json`), JSON.stringify({ current: "gamma", rejected: { alpha: 900 }, updatedAt: Date.now() + 1 }));
		assert.deepEqual(readAccountState(root), { current: "gamma", rejected: { alpha: 900 } });
		updateAccountState(root, (state) => ({ ...state, rejected: { ...state.rejected, beta: 950 } }));
		assert.deepEqual(readAccountState(root), { current: "gamma", rejected: { alpha: 900, beta: 950 } });
		assert.deepEqual(readdirSync(dir), [`${process.pid}.json`]);
	});
});

it("reports an isolated call aborted while its query throws as aborted", async () => {
	const controller = new AbortController();
	__test.setIsolatedQuery(({ options }) => {
		calls.push(options);
		const generator = (async function* () {
			controller.abort();
			throw new Error("SDK interrupted");
		})();
		generator.interrupt = async () => {};
		generator.close = () => {};
		return generator;
	});
	try {
		const output = await provider
			.streamSimple(provider.models[0], { systemPrompt: "Title.", messages: [user] }, { cacheRetention: "none", signal: controller.signal })
			.result();
		assert.equal(output.stopReason, "aborted");
		assert.equal(calls.length, 1);
	} finally {
		__test.setIsolatedQuery(null);
	}
});
