#!/usr/bin/env node
// node --test /home/osso/Repos/pi-claude-bridge/tests/int-claude-usage-command.mjs
// PI_USAGE_TEST_RUNTIME=source selects source explicitly; installed is the default.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "tests/fixtures/claude-usage-command.ts");
const RUNTIME = process.env.PI_USAGE_TEST_RUNTIME ?? "installed";
assert.ok(["installed", "source"].includes(RUNTIME), "select installed or source explicitly");
const PI_REPO = "/home/osso/Repos/pi";
const TIMEOUT = 30_000;
const RPC_ARGS = [
	"--mode",
	"rpc",
	"--no-session",
	"--no-supervisor",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"-e",
	FIXTURE,
	"--model",
	"claude-bridge/claude-haiku-4-5",
];
const command =
	RUNTIME === "installed"
		? { executable: "/home/osso/.local/share/pi/pi", args: RPC_ARGS }
		: {
				executable: process.execPath,
				args: [
					"--import",
					join(PI_REPO, "node_modules/tsx/dist/loader.mjs"),
					join(PI_REPO, "packages/coding-agent/src/cli.ts"),
					...RPC_ARGS,
				],
			};

function writeFixtureHome(rotation) {
	const home = mkdtempSync(join(tmpdir(), "bridge-usage-rpc-"));
	const agentDir = join(home, "agent");
	const claudeDir = join(home, ".claude");
	const cwd = join(home, "workspace");
	for (const path of [agentDir, claudeDir, cwd]) mkdirSync(path);
	const credential = (name) =>
		JSON.stringify({ claudeAiOauth: { accessToken: `fixture-only-${name}`, expiresAt: 4_102_444_800_000 } });
	writeFileSync(join(claudeDir, ".active-profile"), "alpha");
	writeFileSync(join(claudeDir, ".credentials.json"), credential("alpha"), { mode: 0o600 });
	for (const name of ["alpha", "beta"])
		writeFileSync(join(claudeDir, `${name}.credentials.json`), credential(name), { mode: 0o600 });
	writeFileSync(
		join(agentDir, "claude-bridge.json"),
		JSON.stringify({
			startupNoticeShown: new Date().toLocaleDateString("en-CA"),
			askClaude: { enabled: false },
			provider: rotation ? { accountProfiles: ["alpha", "beta"] } : {},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ packages: [], retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" }),
	);
	return { home, agentDir, claudeDir, cwd, auditPath: join(home, "audit.jsonl") };
}

function readAccountSnapshot(path) {
	if (!existsSync(path)) return null;
	return Object.fromEntries(
		readdirSync(path)
			.sort()
			.map((name) => {
				const file = join(path, name);
				const stat = lstatSync(file);
				if (stat.isSymbolicLink()) return [name, { link: readlinkSync(file), mode: stat.mode, mtime: stat.mtimeMs }];
				if (stat.isDirectory()) return [name, readAccountSnapshot(file)];
				const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
				return [name, { digest, mode: stat.mode, mtime: stat.mtimeMs }];
			}),
	);
}
function readAccounts(paths) {
	return {
		claude: readAccountSnapshot(paths.claudeDir),
		profiles: readAccountSnapshot(join(paths.home, ".config/pi-claude-bridge")),
	};
}
function readAudit(paths) {
	if (!existsSync(paths.auditPath)) return [];
	return readFileSync(paths.auditPath, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}
function isolatedEnvironment(paths, rotation) {
	// Deliberate allowlist: no inherited API keys, NODE_OPTIONS, auth brokers or user settings.
	return {
		PATH: "/usr/bin:/bin",
		HOME: paths.home,
		PI_CODING_AGENT_DIR: paths.agentDir,
		CLAUDE_CONFIG_DIR: paths.claudeDir,
		XDG_CONFIG_HOME: join(paths.home, ".config"),
		XDG_CACHE_HOME: join(paths.home, ".cache"),
		XDG_DATA_HOME: join(paths.home, ".local/share"),
		XDG_STATE_HOME: join(paths.home, ".local/state"),
		TMPDIR: paths.home,
		TZ: "America/Chicago",
		BRIDGE_USAGE_AUDIT: paths.auditPath,
		BRIDGE_USAGE_ROTATION: rotation ? "1" : "0",
		CLAUDE_BRIDGE_DEBUG: "0",
		CLAUDE_BRIDGE_DEBUG_PATH: join(paths.home, "bridge-debug.log"),
		TSX_TSCONFIG_PATH: join(PI_REPO, "tsconfig.json"),
	};
}

function spawnRpc(paths, rotation) {
	const child = spawn(command.executable, command.args, {
		cwd: paths.cwd,
		env: isolatedEnvironment(paths, rotation),
		stdio: ["pipe", "pipe", "pipe"],
	});
	const closed = once(child, "close");
	const events = [];
	const pending = new Map();
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let stderr = "";
	let requestId = 0;
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	const rejectPending = (error) => {
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	child.on("error", rejectPending);
	child.stdin.on("error", rejectPending);
	child.on("close", (code, signal) => rejectPending(new Error(`RPC child closed (${code}, ${signal}); ${stderr}`)));
	child.stdout.on("data", (chunk) => {
		buffer += decoder.write(chunk);
		while (buffer.includes("\n")) {
			const newline = buffer.indexOf("\n");
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (!line) continue;
			let packet;
			try {
				packet = JSON.parse(line);
			} catch {
				rejectPending(new Error("RPC stdout contained a non-JSON record"));
				continue;
			}
			if (packet.type !== "response") {
				events.push(packet);
				continue;
			}
			pending.get(packet.id)?.resolve(packet);
			pending.delete(packet.id);
		}
	});
	async function send(body) {
		const id = `usage-${++requestId}`;
		const response = new Promise((resolveResponse, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`RPC timeout: ${body.type}; ${stderr}`));
			}, TIMEOUT);
			pending.set(id, {
				resolve: (packet) => {
					clearTimeout(timer);
					resolveResponse(packet);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
		});
		child.stdin.write(`${JSON.stringify({ ...body, id })}\n`);
		const packet = await response;
		assert.equal(packet.success, true, packet.error);
		return packet.data;
	}
	async function stop() {
		if (child.exitCode !== null || child.signalCode !== null) {
			await closed;
			return;
		}
		child.kill("SIGTERM");
		const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
		try {
			await closed;
		} finally {
			clearTimeout(timer);
		}
	}
	return { send, stop, events, readStderr: () => stderr };
}

async function startFixture(t, rotation = false) {
	const paths = writeFixtureHome(rotation);
	const rpc = spawnRpc(paths, rotation);
	t.after(async () => {
		try {
			await rpc.stop();
		} finally {
			rmSync(paths.home, { recursive: true, force: true });
		}
	});
	const state = await rpc.send({ type: "get_state" });
	assert.equal(state.model?.provider, "claude-bridge");
	const { commands } = await rpc.send({ type: "get_commands" });
	assert.ok(
		commands.some((command) => command.name === "usage"),
		"real Pi /usage must be registered",
	);
	assert.ok(
		readAudit(paths).some((record) => record.kind === "start"),
		"actual bridge fixture loaded",
	);
	return { paths, rpc };
}

async function readUsageOutcome(rpc, priorCount, eventOffset) {
	// Older installed RPC acknowledges prompt acceptance before the command settles.
	const deadline = Date.now() + 2000;
	while (true) {
		const { messages } = await rpc.send({ type: "get_messages" });
		const reports = messages.slice(priorCount).filter((message) => message.customType === "claude-usage");
		const notices = rpc.events
			.slice(eventOffset)
			.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
			.map((event) => event.message);
		if (reports.length || notices.length || Date.now() >= deadline) return { messages, reports, notices };
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
}

async function assertUsage({ paths, rpc }, account) {
	const before = readAccounts(paths);
	const priorAudit = readAudit(paths);
	const { messages: priorMessages } = await rpc.send({ type: "get_messages" });
	const eventOffset = rpc.events.length;
	await rpc.send({ type: "prompt", message: "/usage" });
	const { messages, reports, notices } = await readUsageOutcome(rpc, priorMessages.length, eventOffset);
	const audit = readAudit(paths).slice(priorAudit.length);
	assert.equal(
		reports.length,
		1,
		`Expected one displayed claude-usage report; notifications: ${JSON.stringify(notices)}; audit: ${JSON.stringify(audit)}`,
	);
	const report = reports[0];
	assert.equal(report.role, "custom");
	assert.equal(report.display, true);
	assert.equal(
		report.content,
		[
			`Claude account: ${account}`,
			"Subscription quota (not session token usage)",
			"5-hour: 42.5% — resets 2026-10-09T03:00:00.000Z (UTC)",
			"7-day: 90% — reset unavailable",
			"7-day Opus: unavailable",
			"7-day Sonnet: 0% — resets 2026-10-10T03:00:00.000Z (UTC)",
		].join("\n"),
	);
	const displayed = rpc.events
		.slice(eventOffset)
		.filter((event) => event.type === "message_end" && event.message?.customType === "claude-usage");
	assert.equal(displayed.length, 1, "RPC emits one custom report to display");
	assert.deepEqual(
		readAudit(paths).slice(priorAudit.length),
		[{ kind: "fetch", account }],
		"exactly one usage fetch; no SDK inference",
	);
	assert.deepEqual(
		readAccounts(paths),
		before,
		"usage cannot mutate account files, permissions, timestamps or profile directories",
	);
	assert.equal(
		rpc.events.slice(eventOffset).some((event) => event.type === "agent_start"),
		false,
	);
	assert.equal(
		JSON.stringify({ messages, events: rpc.events, stderr: rpc.readStderr() }).includes("fixture-only-"),
		false,
		"no synthetic token in process output",
	);
}

test(
	`${RUNTIME}: /usage displays current account/windows without mutation or inference`,
	{ timeout: 60_000 },
	async (t) => {
		await assertUsage(await startFixture(t), "alpha");
	},
);
test(`${RUNTIME}: /reload then /usage fetches and displays exactly once`, { timeout: 60_000 }, async (t) => {
	const fixture = await startFixture(t, true);
	await assertUsage(fixture, "alpha");
	await triggerQuota(fixture);
	await assertUsage(fixture, "beta");
	await fixture.rpc.send({ type: "prompt", message: "/reload" });
	const lifecycle = readAudit(fixture.paths).filter((record) => record.kind === "start" || record.kind === "shutdown");
	assert.deepEqual(
		lifecycle.map((record) => [record.kind, record.reason]),
		[
			["start", "startup"],
			["shutdown", "reload"],
			["start", "reload"],
		],
	);
	await assertUsage(fixture, "alpha");
});
async function triggerQuota(fixture) {
	await fixture.rpc.send({ type: "prompt", message: "Trigger the controlled quota fixture" });
	const deadline = Date.now() + TIMEOUT;
	while ((await fixture.rpc.send({ type: "get_state" })).isStreaming) {
		assert.ok(Date.now() < deadline, "controlled quota turn must finish");
		await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
	}
	assert.deepEqual(
		readAudit(fixture.paths).filter((record) => record.kind === "quota"),
		[{ kind: "quota", account: "alpha" }],
	);
	const { messages } = await fixture.rpc.send({ type: "get_messages" });
	assert.match(
		messages.filter((message) => message.role === "assistant").at(-1)?.errorMessage ?? "",
		/Claude rate limit \(five_hour\)/,
	);
	assert.equal(readFileSync(join(fixture.paths.claudeDir, ".active-profile"), "utf8"), "alpha");
}

test(`${RUNTIME}: actual provider quota rejection changes /usage selection to beta`, { timeout: 60_000 }, async (t) => {
	const fixture = await startFixture(t, true);
	await assertUsage(fixture, "alpha");
	await triggerQuota(fixture);
	await assertUsage(fixture, "beta");
});
