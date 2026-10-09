#!/usr/bin/env node
// A tool whose result ends pi's turn (`terminate: true`) leaves Claude Code's MCP
// handler parked: pi never makes the provider call that delivers the result.
// Print mode then shuts down without a signal, so unless session_shutdown closes
// the query the live Claude Code child keeps pi's event loop — and the process —
// alive indefinitely.

import { test } from "node:test";
import assert from "node:assert";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

function claudeDescendants(pid) {
	let children = [];
	try {
		children = execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).trim().split("\n").filter(Boolean).map(Number);
	} catch {}
	return children.flatMap((child) => {
		let command = "";
		try { command = execFileSync("ps", ["-o", "command=", "-p", String(child)], { encoding: "utf8" }).trim(); } catch {}
		return [...(basename(command.split(" ")[0]) === "claude" ? [child] : []), ...claudeDescendants(child)];
	});
}

test("print mode exits after a terminating tool call", { timeout: 120_000 }, async () => {
	const agentDir = mkdtempSync(join(tmpdir(), "bridge-terminate-"));
	const cleanPath = process.env.PATH.split(":").filter((p) => !p.includes("node_modules")).join(":");
	const pi = spawn("pi", [
		"--no-session", "-ne", "-e", DIR, "-e", join(DIR, "tests/fixtures/terminating-tool-extension.ts"),
		"--model", "claude-bridge/claude-haiku-4-5", "-p", "Call FinishTool now. Do not write any text.",
	], {
		cwd: DIR,
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, PATH: cleanPath, PI_CODING_AGENT_DIR: agentDir, CLAUDE_BRIDGE_DEBUG: "1",
			CLAUDE_BRIDGE_DEBUG_PATH: join(agentDir, "debug.log") },
	});
	let output = "";
	pi.stdout.on("data", (d) => { output += d; });
	pi.stderr.on("data", (d) => { output += d; });

	let seen = [];
	const poll = setInterval(() => { seen = [...new Set([...seen, ...claudeDescendants(pi.pid)])]; }, 200);
	const exitCode = await new Promise((resolve) => {
		const timer = setTimeout(() => resolve("timeout"), 60_000);
		pi.on("exit", (code) => { clearTimeout(timer); resolve(code); });
	});
	clearInterval(poll);
	try {
		assert.ok(seen.length > 0 || exitCode !== "timeout", "expected a Claude Code child while the turn ran");
		assert.equal(exitCode, 0, `pi did not exit after the terminating tool (debug log: ${agentDir}/debug.log)\n${output.slice(-2000)}`);
		const alive = seen.filter((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
		assert.deepEqual(alive, [], "Claude Code outlived pi");
	} finally {
		// A survivor bills API requests until something stops it.
		for (const pid of [pi.pid, ...seen]) { try { process.kill(pid, "SIGKILL"); } catch {} }
	}
});
