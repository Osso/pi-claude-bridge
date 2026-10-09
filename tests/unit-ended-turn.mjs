/**
 * A pi run that ends on a tool (end_turn returns terminate:true) leaves the Claude Code turn
 * parked on that tool call: pi never makes the provider call that would answer it. The next
 * prompt used to answer it with the new user message attached as a mid-turn steer, so CC showed
 * the model "the user sent a new message while you were working ... address it as you continue
 * this turn" instead of a user turn, and the model answered only in thinking.
 *
 * The bridge now closes the parked turn at agent_end: it answers the call with the recorded
 * result and its PostToolBatch hook stops CC before another model request
 * (tests/int-cc-contracts.mjs pins that contract). The next prompt is then a fresh query.
 */
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const { default: activate, __test } = await import("../src/index.js");
const { resetCtx } = await import("../src/query-state.js");

const PI_SESSION = "pi-main";
const END_TURN = { name: "end_turn", description: "End the turn", parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] } };
const user = (text, timestamp) => ({ role: "user", content: text, timestamp });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
const streamEvent = (event) => ({ type: "stream_event", event });
const success = (text) => ({ type: "result", subtype: "success", is_error: false, result: text });

let provider;
let handlers;
let queries;

/** Connects to the bridge's real MCP server the way the Agent SDK does. */
async function connectClient(server) {
	const pending = new Map();
	const transport = { start: async () => {}, close: async () => {}, send: async (msg) => pending.get(msg.id)?.(msg) };
	await server.instance.connect(transport);
	let nextId = 0;
	const request = (method, params) => new Promise((resolve) => {
		const id = ++nextId;
		pending.set(id, resolve);
		transport.onmessage({ jsonrpc: "2.0", id, method, params });
	});
	await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
	transport.onmessage({ jsonrpc: "2.0", method: "notifications/initialized" });
	return (name, args, toolUseId) => request("tools/call", { name, arguments: args, _meta: { "claudecode/toolUseId": toolUseId } });
}

/** Stand-in for one Claude Code turn. Records every prompt message the bridge writes to it. */
function fakeQuery(options, prompt, body) {
	const record = { options, prompts: [], hookDecisions: [], reaskedModel: false };
	queries.push(record);
	// Aborting fails the prompt stream; the SDK's stdin pump just stops reading.
	void (async () => {
		for await (const message of prompt) record.prompts.push(message);
	})().catch(() => {});
	const generator = body(record);
	generator.interrupt = async () => {};
	generator.close = () => {};
	return generator;
}

/** A turn that calls end_turn, waits for its result like CC, then runs CC's PostToolBatch hook. */
async function* endTurnCall(record, sessionId) {
	yield { type: "system", subtype: "init", session_id: sessionId };
	yield streamEvent({ type: "message_start", message: { id: `msg-${sessionId}`, usage: {} } });
	yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_end", name: "mcp__custom-tools__end_turn", input: {} } });
	yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"reason":"answered"}' } });
	yield streamEvent({ type: "content_block_stop", index: 0 });
	yield streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} });
	yield streamEvent({ type: "message_stop" });
	const callTool = await connectClient(Object.values(record.options.mcpServers)[0]);
	await callTool("end_turn", { reason: "answered" }, "toolu_end");
	for (const matcher of record.options.hooks?.PostToolBatch ?? []) {
		for (const hook of matcher.hooks) {
			record.hookDecisions.push(await hook({ hook_event_name: "PostToolBatch", tool_calls: [] }, undefined, { signal: new AbortController().signal }));
		}
	}
	// Without continue:false, CC would send the tool result back to the model.
	record.reaskedModel = !record.hookDecisions.some((decision) => decision?.continue === false);
	yield success("");
}

async function* textAnswer(record, sessionId, text) {
	yield { type: "system", subtype: "init", session_id: sessionId };
	yield { type: "assistant", message: { id: `msg-${sessionId}-text`, content: [{ type: "text", text }] } };
	yield success(text);
}

function piRunMessages() {
	const assistant = {
		role: "assistant",
		content: [{ type: "toolCall", id: "toolu_end", name: "end_turn", arguments: { reason: "answered" } }],
		api: provider.models[0].api, provider: provider.models[0].provider, model: provider.models[0].id,
		stopReason: "toolUse", timestamp: 2,
	};
	const result = { role: "toolResult", toolCallId: "toolu_end", toolName: "end_turn", content: [{ type: "text", text: "Turn ended: answered" }], isError: false, timestamp: 3 };
	return [user("how does it work?", 1), assistant, result];
}

/** Session transcripts the bridge itself wrote (the fake CC writes none). */
function fdTranscripts() {
	const root = join(homedir(), ".claude", "projects");
	if (!existsSync(root)) return [];
	return readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".jsonl"));
}

const turn = (messages) => provider.streamSimple(provider.models[0], { messages, tools: [END_TURN] }, { sessionId: PI_SESSION });
const piContext = { sessionManager: { getSessionId: () => PI_SESSION } };

beforeEach(() => {
	__test.resetSharedSession();
	__test.activeQueryContexts.clear();
	resetCtx();
	queries = [];
	handlers = new Map();
	activate({
		events: new EventEmitter(),
		on: (event, handler) => handlers.set(event, handler),
		registerProvider: (_name, config) => { provider = config; },
		registerTool: () => {},
	});
	const scripts = [
		(record) => endTurnCall(record, "cc-session"),
		(record) => textAnswer(record, "cc-session", "It samples nightly turns."),
	];
	__test.setQuery(({ options, prompt }) => fakeQuery(options, prompt, scripts.shift()));
});
afterEach(async () => {
	await settle();
	__test.setQuery(null);
});

describe("a pi run that ended on a tool", () => {
	it("closes the parked Claude Code turn without another model request", async () => {
		const run = piRunMessages();
		assert.equal((await turn(run.slice(0, 1)).result()).stopReason, "toolUse");

		await handlers.get("agent_end")({ type: "agent_end", messages: run }, piContext);
		await settle();

		const [closed] = queries;
		assert.equal(closed.reaskedModel, false, "CC would have asked the model again after end_turn");
		assert.deepEqual(closed.hookDecisions.filter((d) => d?.continue === false).length, 1);
	});

	it("sends the next prompt as a new user turn, not a steer into the ended turn", async () => {
		const run = piRunMessages();
		await turn(run.slice(0, 1)).result();
		await handlers.get("agent_end")({ type: "agent_end", messages: run }, piContext);
		await settle();

		const answer = await turn([...run, user("explain it simply", 4)]).result();

		assert.equal(queries.length, 2, "the prompt was written into the ended turn instead of a new query");
		assert.equal(queries[0].prompts.length, 1, "the ended turn received the next prompt as a mid-turn steer");
		assert.match(JSON.stringify(queries[1].prompts[0]), /explain it simply/);
		assert.equal(queries[1].options.resume, "cc-session", "the new turn must resume the same session");
		// CC already recorded the ended turn; re-importing pi's history would flush the prompt cache.
		const written = fdTranscripts();
		assert.deepEqual(written, [], `the bridge rewrote the session transcript: ${written.join(", ")}`);
		assert.equal(answer.content.find((part) => part.type === "text")?.text, "It samples nightly turns.");
	});

	it("lets the user abort a Claude Code that never finishes the ended turn", async () => {
		let closed = false;
		let unblock;
		__test.setQuery(({ options, prompt }) => {
			const generator = fakeQuery(options, prompt, async function* (record) {
				yield { type: "system", subtype: "init", session_id: "cc-stalled" };
				yield streamEvent({ type: "message_start", message: { id: "msg-stalled", usage: {} } });
				yield streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_end", name: "mcp__custom-tools__end_turn", input: {} } });
				yield streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"reason":"answered"}' } });
				yield streamEvent({ type: "content_block_stop", index: 0 });
				yield streamEvent({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: {} });
				yield streamEvent({ type: "message_stop" });
				const callTool = await connectClient(Object.values(record.options.mcpServers)[0]);
				await callTool("end_turn", { reason: "answered" }, "toolu_end");
				// CC got the result but never runs its hook or ends the turn.
				await new Promise((resolve) => { unblock = resolve; });
			});
			generator.close = () => { closed = true; unblock?.(); };
			return generator;
		});
		const run = piRunMessages();
		const controller = new AbortController();
		await provider.streamSimple(provider.models[0], { messages: run.slice(0, 1), tools: [END_TURN] }, { sessionId: PI_SESSION, signal: controller.signal }).result();

		let ended = false;
		const agentEnd = Promise.resolve(handlers.get("agent_end")({ type: "agent_end", messages: run }, piContext)).then(() => { ended = true; });
		await settle();
		assert.equal(ended, false, "agent_end returned before CC settled");

		controller.abort();
		await agentEnd;
		assert.equal(closed, true, "aborting left the stalled CC process running");
	});

	it("still steers a message the user sent while the run was going", async () => {
		const run = piRunMessages();
		await turn(run.slice(0, 1)).result();

		// No agent_end: pi drained a steer at the tool boundary of a run that is still going.
		void turn([...run, user("also check the logs", 4)]);
		await settle();

		assert.equal(queries.length, 1);
		assert.equal(queries[0].prompts.length, 2);
		assert.match(JSON.stringify(queries[0].prompts[1]), /also check the logs/);
	});
});
