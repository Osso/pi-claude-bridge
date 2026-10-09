#!/usr/bin/env node
/**
 * Offline process/session regression: installed Pi AgentSession + bridge provider.
 * Dependencies: installed @earendil-works/pi-coding-agent (ModelRuntime SDK),
 * cc-session-io, typebox, tsx; no package changes or real Claude executable needed.
 * Runner: node --import tsx --import ./tests/lib/setup.mjs --test tests/int-quota-account-retry.mjs
 * Negative control: BRIDGE_QUOTA_RETRY_DISABLE=1 with the same runner and
 * --test-name-pattern='boundary: success' must fail the success assertion:
 * disabling Pi's retry leaves the recorded quota failure.
 * Only query() is replaced. MCP delivery, Pi tool execution/retry/persistence,
 * profile selection, and bridge transcript rebuilding remain production code.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { on } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSessionPath } from "cc-session-io";

const FILE = fileURLToPath(import.meta.url);
const TOOL_ID = "append-once-1";
const TOOL_RESULT = "append completed: durable receipt 314159";
const FINAL_TEXT = "beta continued from completed tool result";
const streamEvent = (event) => ({ type: "stream_event", event });
const quotaEvents = [
	{ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour" } },
	{ type: "result", subtype: "success", is_error: true, result: "You're out of extra usage" },
];
const readJsonl = (path) => readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));

function sendPacket(packet) {
	return new Promise((resolve, reject) => process.send(packet, (error) => error ? reject(error) : resolve()));
}

async function assertAndReportContinuedTranscript({ transcriptPath, sharedPath, prompt }) {
	// Read the actual bridge-generated JSONL through beta's shared projects link.
	assert.equal(realpathSync(transcriptPath), realpathSync(sharedPath));
	const records = readJsonl(transcriptPath);
	const blocks = records.flatMap((record) => record.message?.content ?? []);
	const toolUseIndex = blocks.findIndex((block) => block.type === "tool_use" && block.id === TOOL_ID);
	const resultIndex = blocks.findIndex((block) => block.type === "tool_result" && block.tool_use_id === TOOL_ID);
	assert.ok(toolUseIndex >= 0 && resultIndex > toolUseIndex, "continued transcript pairs prior tool use/result in order");
	assert.match(JSON.stringify(blocks[resultIndex].content), new RegExp(TOOL_RESULT));
	await sendPacket({ kind: "continued", records, prompt, sharedPath });
}

function writeInitialToolTranscript({ transcriptPath, sessionId, options, prompt }) {
	mkdirSync(dirname(transcriptPath), { recursive: true });
	const userId = randomUUID();
	const assistantId = randomUUID();
	const record = (type, uuid, parentUuid, message) => ({ type, uuid, parentUuid, sessionId, cwd: options.cwd, timestamp: new Date().toISOString(), message });
	appendFileSync(transcriptPath, JSON.stringify(record("user", userId, null, prompt.message)) + "\n");
	appendFileSync(transcriptPath, JSON.stringify(record("assistant", assistantId, userId, {
		id: "msg-append", role: "assistant", model: "claude-haiku-4-5", stop_reason: "tool_use",
		content: [{ type: "tool_use", id: TOOL_ID, name: "mcp__custom-tools__append_once", input: {} }], usage: {},
	})) + "\n");
	return { assistantId, record };
}

async function sendToolUseEvents(sessionId) {
	await sendPacket({ kind: "event", event: { type: "system", subtype: "init", session_id: sessionId } });
	for (const event of [
		{ type: "message_start", message: { id: "msg-append", usage: {} } },
		{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: TOOL_ID, name: "mcp__custom-tools__append_once", input: {} } },
		{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} },
		{ type: "message_stop" },
	]) await sendPacket({ kind: "event", event: streamEvent(event) });
	await sendPacket({ kind: "tool", toolUseId: TOOL_ID });
}

async function receiveAndPersistToolResult({ receive, transcriptPath, record, assistantId }) {
	const { result } = await receive();
	assert.equal(result.isError, false);
	assert.deepEqual(result.content, [{ type: "text", text: TOOL_RESULT }]);
	appendFileSync(transcriptPath, JSON.stringify(record("user", randomUUID(), assistantId, {
		role: "user", content: [{ type: "tool_result", tool_use_id: TOOL_ID, content: result.content }],
	})) + "\n");
	await sendPacket({ kind: "delivered", result, transcriptPath });
}

async function sendContinuedOutcome({ transcriptPath, sharedPath, prompt, mode }) {
	await assertAndReportContinuedTranscript({ transcriptPath, sharedPath, prompt });
	if (mode === "exhausted") {
		for (const event of quotaEvents) await sendPacket({ kind: "event", event });
		process.exitCode = 1;
		return;
	}
	await sendPacket({ kind: "event", event: { type: "result", subtype: "success", is_error: false, result: FINAL_TEXT } });
}

async function runSdkFixture() {
	const incoming = on(process, "message")[Symbol.asyncIterator]();
	const receive = async () => (await incoming.next()).value[0];
	try {
		const { options, prompt, mode } = await receive();
		const identity = JSON.parse(readFileSync(join(options.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "utf8")).token;
		const sessionId = options.resume ?? randomUUID();
		const transcriptPath = getSessionPath(sessionId, options.cwd, options.env.CLAUDE_CONFIG_DIR);
		const sharedPath = getSessionPath(sessionId, options.cwd, options.sharedConfigDir);
		await sendPacket({ kind: "identity", identity, pid: process.pid, sessionId, transcriptPath });
		if (identity === "beta") {
			await sendContinuedOutcome({ transcriptPath, sharedPath, prompt, mode });
			return;
		}

		assert.equal(identity, "alpha", "fixture never uses a real profile");
		const { assistantId, record } = writeInitialToolTranscript({ transcriptPath, sessionId, options, prompt });
		await sendToolUseEvents(sessionId);
		await receiveAndPersistToolResult({ receive, transcriptPath, record, assistantId });
		for (const event of quotaEvents) await sendPacket({ kind: "event", event });
		// Mimic SDK transport death after it yielded the quota/result records.
		process.exitCode = 1;
	} catch (error) {
		await sendPacket({ kind: "fixture-error", error: error.stack });
		process.exitCode = 2;
	} finally {
		await incoming.return();
		process.disconnect();
	}
}

async function connectMcp(server) {
	const pending = new Map();
	const transport = { start: async () => {}, close: async () => {}, send: async (reply) => {
		pending.get(reply.id)?.(reply);
		pending.delete(reply.id);
	} };
	await server.instance.connect(transport);
	let nextId = 0;
	const request = (method, params) => new Promise((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve);
		transport.onmessage({ jsonrpc: "2.0", id, method, params });
	});
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "quota-fixture", version: "1" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return request;
}

function forkSdkFixture(root, options) {
	const child = fork(FILE, ["--sdk-fixture"], { cwd: root, env: options.env, execArgv: [], stdio: ["ignore", "pipe", "pipe", "ipc"] });
	let stderr = "";
	child.stderr.on("data", (data) => { stderr += data; });
	const closed = new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	child.fixtureClosed = closed;
	return { child, closed, readStderr: () => stderr };
}

async function callToolAndSendResult({ request, packet, child }) {
	const reply = await request("tools/call", { name: "append_once", arguments: {}, _meta: { "claudecode/toolUseId": packet.toolUseId } });
	assert.ok(!reply.error, JSON.stringify(reply));
	child.send({ result: reply.result });
}

async function* routeChildMessages({ child, closed, readStderr, messages, options, prompt, root, mode, packets }) {
	const firstPrompt = (await prompt[Symbol.asyncIterator]().next()).value;
	child.send({ options: { cwd: options.cwd, resume: options.resume, env: { CLAUDE_CONFIG_DIR: options.env.CLAUDE_CONFIG_DIR }, sharedConfigDir: join(root, ".claude") }, prompt: firstPrompt, mode });
	let request;
	for await (const [packet] of messages) {
		packets.push(packet);
		if (packet.kind === "event") yield packet.event;
		if (packet.kind === "fixture-error") throw new Error(packet.error);
		if (packet.kind === "tool") {
			request ??= await connectMcp(options.mcpServers["custom-tools"]);
			await callToolAndSendResult({ request, packet, child });
		}
	}
	const { code, signal } = await closed;
	if (code !== 0) throw new Error(`controlled SDK child exited ${code} (${signal ?? "no signal"}): ${readStderr()}`);
}

function installChildQuery(bridge, root, mode, children, packets) {
	bridge.__test.setQuery(({ options, prompt }) => {
		const { child, closed, readStderr } = forkSdkFixture(root, options);
		children.push(child);
		// Install the listener before sending startup data; no dropped fast-child events.
		const messages = on(child, "message", { close: ["close"] });
		const generator = routeChildMessages({ child, closed, readStderr, messages, options, prompt, root, mode, packets });
		generator.interrupt = async () => { child.kill(); };
		generator.close = () => { if (child.exitCode === null && child.signalCode === null) child.kill(); };
		return generator;
	});
}

function createIsolatedProfileEnvironment() {
	const root = mkdtempSync(join(tmpdir(), "bridge-pi-quota-retry-"));
	const savedCwd = process.cwd();
	const envKeys = ["HOME", "CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "CLAUDE_BRIDGE_DEBUG_PATH"];
	const savedEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
	process.env.HOME = root;
	process.env.CLAUDE_CONFIG_DIR = join(root, ".claude");
	process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(root, "debug.log");
	process.chdir(root);
	mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	writeFileSync(join(root, ".claude", ".active-profile"), "alpha");
	writeFileSync(join(root, ".claude", ".credentials.json"), JSON.stringify({ token: "alpha" }));
	for (const name of ["alpha", "beta"]) writeFileSync(join(root, ".claude", `${name}.credentials.json`), JSON.stringify({ token: name }));
	writeFileSync(join(root, "agent", "claude-bridge.json"), JSON.stringify({ provider: { accountProfiles: ["alpha", "beta"] } }));
	return { root, savedCwd, savedEnv };
}

function resetBridgeQueryState(bridge, resetCtx) {
	bridge.__test.resetSharedSession();
	bridge.__test.resetAccountProfiles();
	bridge.__test.activeQueryContexts.clear();
	resetCtx();
}

function createAppendOnceTools(Type, effectsPath) {
	return [{
		name: "append_once", label: "Append once", description: "Append an observable receipt",
		parameters: Type.Object({}),
		execute: async () => {
			appendFileSync(effectsPath, "executed\n");
			return { content: [{ type: "text", text: TOOL_RESULT }], details: {} };
		},
	}];
}

async function createPiSession({ root, mode, bridge, piSdk, Type, effectsPath }) {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piSdk;
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: process.env.BRIDGE_QUOTA_RETRY_DISABLE !== "1", maxRetries: 3, baseDelayMs: 10 }, compaction: { enabled: false }, cacheWarming: "off" });
	const modelRuntime = await ModelRuntime.create({ authPath: join(root, mode + "-auth.json"), modelsPath: null, modelsStorePath: join(root, mode + "-models.json"), refreshOnCreate: false });
	const resourceLoader = new DefaultResourceLoader({ cwd: root, agentDir: join(root, "agent"), settingsManager,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [bridge.default], systemPrompt: "Append once, then finish from its recorded receipt.",
	});
	await resourceLoader.reload();
	const sessionManager = SessionManager.create(root, join(root, mode + "-sessions"));
	const created = await createAgentSession({ cwd: root, agentDir: join(root, "agent"), modelRuntime, resourceLoader, settingsManager, sessionManager,
		model: { id: "claude-haiku-4-5", name: "fixture", provider: "claude-bridge", api: "claude-bridge", baseUrl: "claude-bridge", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1024 },
		tools: ["append_once"], customTools: createAppendOnceTools(Type, effectsPath),
	});
	return created.session;
}

function assertRetryOutcome(mode, session, events) {
	const lastAssistant = session.messages.filter((message) => message.role === "assistant").at(-1);
	if (mode === "success") {
		assert.equal(lastAssistant.stopReason, "stop", JSON.stringify(lastAssistant));
		assert.equal(lastAssistant.content.map((block) => block.text ?? "").join(""), FINAL_TEXT);
		assert.ok(events.some((event) => event.type === "auto_retry_end" && event.success));
	} else if (mode === "exhausted") {
		assert.equal(lastAssistant.stopReason, "error");
		assert.match(lastAssistant.errorMessage, /account profiles exhausted/i);
		assert.equal(events.filter((event) => event.type === "auto_retry_start").length, 1, "exhaustion must stop Pi's retry budget early");
	} else {
		assert.ok(events.some((event) => event.type === "auto_retry_end" && !event.success && event.finalError === "Retry cancelled"));
	}
}

function assertDurableResultBeforeRetry(events, retrySnapshots) {
	const retries = events.filter((event) => event.type === "auto_retry_start");
	assert.equal(retries.length, 1, "installed AgentSession schedules exactly one retry");
	assert.match(retries[0].errorMessage, /Claude rate limit \(five_hour\)/);
	const recordedResults = retrySnapshots[0].filter((message) => message.role === "toolResult");
	assert.equal(recordedResults.length, 1, "tool result is durable before retry starts");
	assert.equal(recordedResults[0].toolCallId, TOOL_ID);
	assert.deepEqual(recordedResults[0].content, [{ type: "text", text: TOOL_RESULT }]);
}

function assertSingleToolExecution({ effectsPath, events, packets }) {
	assert.equal(readFileSync(effectsPath, "utf8"), "executed\n", "tool side effect occurs exactly once across retry");
	assert.equal(events.filter((event) => event.type === "tool_execution_start").length, 1);
	assert.equal(packets.filter((packet) => packet.kind === "delivered").length, 1, "first SDK child actually receives Pi's tool result over MCP");
}

function assertAccountProcessRotation({ mode, packets, children }) {
	const identities = packets.filter((packet) => packet.kind === "identity");
	assert.deepEqual(identities.map((packet) => packet.identity), mode === "cancelled" ? ["alpha"] : ["alpha", "beta"]);
	assert.equal(children[0].exitCode, 1, "quota/result followed by actual SDK subprocess death");
	if (mode !== "cancelled") {
		assert.notEqual(identities[0].pid, identities[1].pid, "retry starts a different process");
		assert.equal(packets.filter((packet) => packet.kind === "continued").length, 1);
	}
}

function assertPersistedSessionResult({ mode, session, SessionManager }) {
	const persisted = SessionManager.open(session.sessionFile).buildSessionContext().messages;
	const results = persisted.filter((message) => message.role === "toolResult");
	assert.equal(results.length, 1, "Pi persists one completed tool result");
	assert.equal(results[0].toolCallId, TOOL_ID);
	assert.deepEqual(results[0].content, [{ type: "text", text: TOOL_RESULT }]);
	if (mode === "success") assert.equal(persisted.at(-1).content[0].text, FINAL_TEXT);
}

function registerScenarioCleanup(t, { bridge, children, readSession }) {
	t.after(async () => {
		await readSession()?.abort();
		readSession()?.dispose();
		bridge.__test.setQuery(null);
		for (const child of children) {
			if (child.exitCode === null && child.signalCode === null) child.kill();
			await child.fixtureClosed;
		}
	});
}

function subscribeToDurableRetries({ session, mode, SessionManager }) {
	const events = [];
	const retrySnapshots = [];
	session.subscribe((event) => {
		events.push(event);
		if (event.type !== "auto_retry_start") return;
		// Reopen the file before Pi retries: an in-memory result alone is insufficient.
		retrySnapshots.push(SessionManager.open(session.sessionFile).buildSessionContext().messages);
		if (mode === "cancelled") queueMicrotask(() => session.abortRetry());
	});
	return { events, retrySnapshots };
}

async function runQuotaRetryScenario(t, { bridge, resetCtx, root, mode, piSdk, Type, SessionManager }) {
	resetBridgeQueryState(bridge, resetCtx);
	const children = [];
	const packets = [];
	let session;
	registerScenarioCleanup(t, { bridge, children, readSession: () => session });
	installChildQuery(bridge, root, mode, children, packets);
	const effectsPath = join(root, mode + "-effects.txt");
	session = await createPiSession({ root, mode, bridge, piSdk, Type, effectsPath });
	await session.bindExtensions({ mode: "rpc" });
	const { events, retrySnapshots } = subscribeToDurableRetries({ session, mode, SessionManager });
	await session.prompt("Run append_once exactly once and use the recorded receipt to finish.");
	for (const child of children) await child.fixtureClosed;
	assertRetryOutcome(mode, session, events);
	assertDurableResultBeforeRetry(events, retrySnapshots);
	assertSingleToolExecution({ effectsPath, events, packets });
	assertAccountProcessRotation({ mode, packets, children });
	assertPersistedSessionResult({ mode, session, SessionManager });
}

async function runIntegrationTests() {
	const { test } = await import("node:test");
	const { root, savedCwd, savedEnv } = createIsolatedProfileEnvironment();
	const bridge = await import("../src/index.js");
	const { resetCtx } = await import("../src/query-state.js");
	const piSdk = await import("@earendil-works/pi-coding-agent");
	const { SessionManager } = piSdk;
	const { Type } = await import("typebox");
	try {
		for (const mode of ["success", "exhausted", "cancelled"]) {
			await test(`installed Pi quota retry at completed tool boundary: ${mode}`, { timeout: 15_000 },
				(t) => runQuotaRetryScenario(t, { bridge, resetCtx, root, mode, piSdk, Type, SessionManager }));
		}
	} finally {
		process.chdir(savedCwd);
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv.includes("--sdk-fixture")) await runSdkFixture();
else await runIntegrationTests();
