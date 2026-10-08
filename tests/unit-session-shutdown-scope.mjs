/**
 * session_shutdown tears down only the session that is shutting down.
 *
 * One pi process hosts the parent session and its child agents, each its own
 * AgentSession sharing this module. pi's agents-core emits session_shutdown for
 * every child when it finishes (shutdownChildSession), so a handler that closes
 * every open query kills the parent's live turn whenever a child completes.
 * Observed: the parent's query was interrupted 13 ms after a child's
 * agent_complete; it was marked abandoned, so its completion never ended pi's
 * stream, and the turn sat on "Thinking..." until pi's 20-minute
 * thinking-phase watchdog aborted it.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { QueryContext } from "../src/query-state.js";

const { default: activate, __test } = await import("../src/index.js");
const { activeQueryContexts, isQueryAbandoned, resetSharedSession } = __test;

function activateWithMockPi() {
	const handlers = new Map();
	activate({
		on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
		registerProvider: () => {},
		registerTool: () => {},
	});
	return (event, ...args) => { for (const handler of handlers.get(event) ?? []) handler(...args); };
}

/** A query parked mid-turn: CC asked for a tool and is waiting on the answer. */
function parkedQuery(piSessionId, toolCallId) {
	const events = [];
	const sdkQuery = {
		interrupt: () => { events.push("interrupt"); return Promise.resolve(); },
		close: () => { events.push("close"); },
	};
	const c = new QueryContext();
	c.activeQuery = sdkQuery;
	c.piSessionId = piSessionId;
	c.turnToolCallIds = [toolCallId];
	c.pendingToolCalls.set(toolCallId, { toolName: "read", resolve: () => { events.push("release"); } });
	c.promptStream = { fail: () => { events.push("fail"); } };
	activeQueryContexts.add(c);
	return { c, sdkQuery, events };
}

const shutdownCtx = (piSessionId) => ({ sessionManager: { getSessionId: () => piSessionId } });

beforeEach(() => {
	resetSharedSession();
	activeQueryContexts.clear();
});

describe("session_shutdown", () => {
	it("a finishing child agent leaves the parent's live query running", () => {
		const emit = activateWithMockPi();
		const parent = parkedQuery("pi-parent", "call_parent");
		const child = parkedQuery("pi-child", "call_child");

		emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, shutdownCtx("pi-child"));

		assert.deepEqual(parent.events, [], "the parent's query is not interrupted, closed or released");
		assert.equal(parent.c.activeQuery, parent.sdkQuery, "the parent still owns its query");
		assert.ok(activeQueryContexts.has(parent.c), "the parent's tool results still route to it");
		assert.equal(isQueryAbandoned(parent.sdkQuery), false,
			"an abandoned query's completion never ends pi's stream");

		assert.deepEqual(child.events.sort(), ["close", "fail", "interrupt", "release"],
			"the child's own query is still torn down");
		assert.equal(activeQueryContexts.has(child.c), false);
	});
});
