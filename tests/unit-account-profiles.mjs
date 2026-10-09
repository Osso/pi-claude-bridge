import { it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as api from "../src/account-profiles.ts";
const { nextAccountProfile, prepareAccountProfile, persistAccountProfile } = api;
const names = ["allison", "gc", "default"];
const credentials = token => JSON.stringify({ claudeAiOauth: { accessToken: token, refreshToken: `refresh-${token}` } });
const mode = path => statSync(path).mode & 0o777;

function withHome(fn) {
	const home = mkdtempSync(join(tmpdir(), "account-profiles-"));
	try {
		mkdirSync(join(home, ".claude", "projects"), { recursive: true });
		writeFileSync(join(home, ".claude", ".credentials.json"), credentials("global-active"));
		writeFileSync(join(home, ".claude", ".active-profile"), "default");
		for (const name of names) writeFileSync(join(home, ".claude", `${name}.credentials.json`), credentials(name));
		return fn(home);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

it("exports the bounded account-profile helper", () => {
	for (const name of ["nextAccountProfile", "prepareAccountProfile", "persistAccountProfile"]) assert.equal(typeof api[name], "function", name);
});

it("selects each explicit candidate once in order and stops at exhaustion", () => {
	const attempted = new Set();
	for (const name of names) {
		assert.equal(nextAccountProfile(names, attempted), name);
		attempted.add(name);
	}
	assert.equal(nextAccountProfile(names, attempted), undefined);
	assert.equal(nextAccountProfile([], []), undefined);
	assert.equal(nextAccountProfile(names, ["gc", "unknown"]), "allison");
	assert.deepEqual(names, ["allison", "gc", "default"]);
});

it("rejects unsafe or duplicate profile names without exposing supplied text", () => withHome(home => {
	for (const name of ["", "..", "../secret-token", "/absolute", "a/b", "a\\b", "a\nsecret-token"]) {
		assert.throws(() => nextAccountProfile([name], []), /Invalid profile name/);
		assert.throws(() => prepareAccountProfile(home, name), /Invalid profile name/);
		assert.throws(() => persistAccountProfile(home, name), /Invalid profile name/);
	}
	assert.throws(() => nextAccountProfile(["gc", "gc"], []), /Duplicate profile name/);
	assert.throws(() => prepareAccountProfile("relative", "gc"), /absolute home/);
}));

it("isolates credentials, shares projects, and preserves the global account", () => withHome(home => {
	const dirs = names.map(name => prepareAccountProfile(home, name));
	assert.equal(new Set(dirs).size, names.length);
	for (const [index, dir] of dirs.entries()) {
		assert.equal(dir, join(home, ".config", "pi-claude-bridge", "profiles", names[index]));
		assert.equal(readFileSync(join(dir, ".credentials.json"), "utf8"), credentials(names[index] === "default" ? "global-active" : names[index]));
		assert.equal(mode(dir), 0o700);
		assert.equal(mode(join(home, ".config", "pi-claude-bridge")), 0o700);
		assert.equal(mode(join(home, ".config", "pi-claude-bridge", "profiles")), 0o700);
		assert.equal(mode(join(home, ".claude", `${names[index]}.credentials.json`)), 0o600);
		assert.equal(mode(join(dir, ".credentials.json")), 0o600);
		assert.ok(lstatSync(join(dir, "projects")).isSymbolicLink());
		assert.equal(readlinkSync(join(dir, "projects")), join(home, ".claude", "projects"));
	}
	writeFileSync(join(dirs[0], "projects", "session.jsonl"), "shared session");
	assert.equal(readFileSync(join(home, ".claude", "projects", "session.jsonl"), "utf8"), "shared session");
	assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), credentials("global-active"));
	assert.equal(readFileSync(join(home, ".claude", ".active-profile"), "utf8"), "default");
}));

it("persists refreshed credentials only to the named profile and preserves them on the next query", () => withHome(home => {
	const dir = prepareAccountProfile(home, "gc");
	writeFileSync(join(dir, ".credentials.json"), credentials("refreshed-gc"));
	chmodSync(join(home, ".claude", "gc.credentials.json"), 0o644);
	persistAccountProfile(home, "gc");
	assert.equal(readFileSync(join(home, ".claude", "gc.credentials.json"), "utf8"), credentials("refreshed-gc"));
	assert.equal(mode(join(home, ".claude", "gc.credentials.json")), 0o600);
	assert.equal(readFileSync(join(home, ".claude", "allison.credentials.json"), "utf8"), credentials("allison"));
	assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), credentials("global-active"));
	chmodSync(dir, 0o755);
	chmodSync(join(dir, ".credentials.json"), 0o644);
	assert.equal(prepareAccountProfile(home, "gc"), dir);
	assert.equal(mode(dir), 0o700);
	assert.equal(mode(join(dir, ".credentials.json")), 0o600);
	assert.equal(readFileSync(join(dir, ".credentials.json"), "utf8"), credentials("refreshed-gc"));
}));

it("reports missing or invalid credentials explicitly without secret content or damaging saved credentials", () => withHome(home => {
	assert.throws(() => prepareAccountProfile(home, "missing"), /read.*credentials.*ENOENT/i);
	assert.throws(() => persistAccountProfile(home, "gc"), /read.*credentials.*ENOENT/i);
	for (const content of ["secret-token-not-json", "null", "[]", "{}", '"secret-token"']) {
		writeFileSync(join(home, ".claude", "gc.credentials.json"), content);
		assert.throws(() => prepareAccountProfile(home, "gc"), error => {
			assert.match(error.message, /Invalid credentials/);
			assert.ok(!error.message.includes("secret-token"));
			return true;
		});
	}
	writeFileSync(join(home, ".claude", "gc.credentials.json"), credentials("gc"));
	const dir = prepareAccountProfile(home, "gc");
	writeFileSync(join(dir, ".credentials.json"), "secret-token-invalid");
	assert.throws(() => persistAccountProfile(home, "gc"), /Invalid credentials/);
	assert.equal(readFileSync(join(home, ".claude", "gc.credentials.json"), "utf8"), credentials("gc"));
}));

it("rejects conflicting projects paths and credential symlinks rather than altering their targets", () => withHome(home => {
	const dir = prepareAccountProfile(home, "gc");
	rmSync(join(dir, "projects"));
	mkdirSync(join(dir, "projects"));
	assert.throws(() => prepareAccountProfile(home, "gc"), /config path conflicts/);
	rmSync(join(dir, "projects"), { recursive: true });
	symlinkSync(join(home, ".claude", "projects"), join(dir, "projects"));
	rmSync(join(dir, ".credentials.json"));
	symlinkSync(join(home, ".claude", ".credentials.json"), join(dir, ".credentials.json"));
	assert.throws(() => prepareAccountProfile(home, "gc"), /regular file/);
	assert.throws(() => persistAccountProfile(home, "gc"), /regular file/);
	assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), credentials("global-active"));
}));

it("creates a missing original projects directory without switching global credentials", () => withHome(home => {
	rmSync(join(home, ".claude", "projects"), { recursive: true });
	const dir = prepareAccountProfile(home, "gc");
	assert.ok(existsSync(join(dir, "projects")));
	assert.equal(mode(join(home, ".claude", "projects")), 0o700);
}));

it("preserves CC-owned refreshed credentials across overlapping prepares and a new process", () => withHome(home => {
	const dir = prepareAccountProfile(home, "gc");
	const isolated = join(dir, ".credentials.json");
	writeFileSync(isolated, credentials("cc-refreshed"));
	const inode = statSync(isolated).ino;
	prepareAccountProfile(home, "gc");
	assert.equal(readFileSync(isolated, "utf8"), credentials("cc-refreshed"));
	assert.equal(statSync(isolated).ino, inode);
	execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
		`import { prepareAccountProfile } from ${JSON.stringify(new URL("../src/account-profiles.ts", import.meta.url).href)}; prepareAccountProfile(${JSON.stringify(home)}, "gc");`
	], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
	assert.equal(readFileSync(isolated, "utf8"), credentials("cc-refreshed"));
	assert.equal(statSync(isolated).ino, inode);
	rmSync(join(home, ".claude", "gc.credentials.json"));
	assert.equal(prepareAccountProfile(home, "gc"), dir);
	assert.equal(readFileSync(isolated, "utf8"), credentials("cc-refreshed"));
}));

it("does not overwrite named credentials when the query did not change isolated credentials", () => withHome(home => {
	const dir = prepareAccountProfile(home, "gc");
	const saved = join(home, ".claude", "gc.credentials.json");
	writeFileSync(saved, credentials("external-refresh"));
	const inode = statSync(saved).ino;
	persistAccountProfile(home, "gc");
	assert.equal(readFileSync(saved, "utf8"), credentials("external-refresh"));
	assert.equal(statSync(saved).ino, inode);
	writeFileSync(join(dir, ".credentials.json"), credentials("cc-refresh"));
	assert.throws(() => persistAccountProfile(home, "gc"), /credentials.*changed.*gc/i);
	assert.equal(readFileSync(saved, "utf8"), credentials("external-refresh"));
	assert.equal(statSync(saved).ino, inode);
}));

it("seeds an active profile from live credentials rather than its stale saved login", () => withHome(home => {
	const original = join(home, ".claude");
	writeFileSync(join(original, ".active-profile"), "gc\n");
	const live = join(original, ".credentials.json");
	const inode = statSync(live).ino;
	const permissions = mode(live);
	const dir = prepareAccountProfile(home, "gc");
	assert.equal(readFileSync(join(dir, ".credentials.json"), "utf8"), credentials("global-active"));
	assert.equal(readFileSync(join(original, "gc.credentials.json"), "utf8"), credentials("gc"));
	writeFileSync(join(dir, ".credentials.json"), credentials("refreshed-active"));
	persistAccountProfile(home, "gc");
	assert.equal(readFileSync(join(original, "gc.credentials.json"), "utf8"), credentials("refreshed-active"));
	assert.equal(readFileSync(live, "utf8"), credentials("global-active"));
	assert.equal(statSync(live).ino, inode);
	assert.equal(mode(live), permissions);
	assert.equal(readFileSync(join(original, ".active-profile"), "utf8"), "gc\n");
}));

it("rejects a newer external login even when another prepare overlaps the refresh", () => withHome(home => {
	const dir = prepareAccountProfile(home, "gc");
	const saved = join(home, ".claude", "gc.credentials.json");
	writeFileSync(join(dir, ".credentials.json"), credentials("isolated-refresh"));
	writeFileSync(saved, credentials("new-external-login"));
	const inode = statSync(saved).ino;
	prepareAccountProfile(home, "gc");
	for (let attempt = 0; attempt < 2; attempt++) {
		assert.throws(() => persistAccountProfile(home, "gc"), error => {
			assert.match(error.message, /credentials.*changed.*gc/i);
			assert.ok(!error.message.includes("new-external-login"));
			assert.ok(!error.message.includes("isolated-refresh"));
			return true;
		});
		assert.equal(readFileSync(saved, "utf8"), credentials("new-external-login"));
		assert.equal(statSync(saved).ino, inode);
		assert.equal(readFileSync(join(dir, ".credentials.json"), "utf8"), credentials("isolated-refresh"));
	}
}));

it("preserves pending refreshes and supports repeated writeback across same-profile prepares", () => withHome(home => {
	const dir = prepareAccountProfile(home, "gc");
	const isolated = join(dir, ".credentials.json");
	const saved = join(home, ".claude", "gc.credentials.json");
	writeFileSync(isolated, credentials("first-refresh"));
	assert.equal(prepareAccountProfile(home, "gc"), dir);
	persistAccountProfile(home, "gc");
	persistAccountProfile(home, "gc");
	assert.equal(readFileSync(saved, "utf8"), credentials("first-refresh"));
	writeFileSync(isolated, credentials("second-refresh"));
	persistAccountProfile(home, "gc");
	assert.equal(readFileSync(saved, "utf8"), credentials("second-refresh"));
}));

it("initializes one credential file across concurrent same-profile processes", () => withHome(home => {
	const dir = join(home, ".config", "pi-claude-bridge", "profiles", "gc");
	const isolated = join(dir, ".credentials.json");
	writeFileSync(join(home, ".claude", ".active-profile"), "gc");
	const worker = `
		import { prepareAccountProfile } from ${JSON.stringify(new URL("../src/account-profiles.ts", import.meta.url).href)};
		import { readFileSync, statSync } from "node:fs";
		const dir = prepareAccountProfile(${JSON.stringify(home)}, "gc");
		const path = dir + "/.credentials.json";
		console.log(JSON.stringify({ content: readFileSync(path, "utf8"), inode: statSync(path).ino }));
	`;
	const coordinator = `
		import { execFile } from "node:child_process";
		import { promisify } from "node:util";
		const execute = promisify(execFile);
		const args = ["--import", "tsx", "--input-type=module", "-e", ${JSON.stringify(worker)}];
		const results = await Promise.all([execute(process.execPath, args), execute(process.execPath, args)]);
		console.log(JSON.stringify(results.map(result => JSON.parse(result.stdout))));
	`;
	const results = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", coordinator], {
		cwd: new URL("..", import.meta.url), encoding: "utf8", timeout: 10000,
	}));
	assert.equal(results.length, 2);
	for (const result of results) {
		assert.equal(result.content, credentials("global-active"));
		assert.equal(result.inode, statSync(isolated).ino);
	}
	assert.equal(readFileSync(join(home, ".claude", "gc.credentials.json"), "utf8"), credentials("gc"));
	assert.equal(readFileSync(join(home, ".claude", ".credentials.json"), "utf8"), credentials("global-active"));
}));

it("shares all original noncredential config and observes subsequent config edits", () => withHome(home => {
	const original = join(home, ".claude");
	writeFileSync(join(original, "CLAUDE.md"), "original instructions");
	writeFileSync(join(original, "settings.json"), JSON.stringify({ permissions: { deny: ["Bash"] } }));
	mkdirSync(join(original, "agents"));
	writeFileSync(join(original, "agents", "review.md"), "review instructions");
	const dir = prepareAccountProfile(home, "gc");
	for (const entry of ["CLAUDE.md", "settings.json", "agents", "projects"]) {
		assert.ok(lstatSync(join(dir, entry)).isSymbolicLink(), entry);
		assert.equal(readlinkSync(join(dir, entry)), join(original, entry));
	}
	for (const entry of [".active-profile", ...names.map(name => `${name}.credentials.json`)]) {
		assert.equal(existsSync(join(dir, entry)), false, entry);
	}
	writeFileSync(join(original, "CLAUDE.md"), "updated instructions");
	assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "updated instructions");
	writeFileSync(join(original, "settings.local.json"), "{}");
	prepareAccountProfile(home, "gc");
	assert.equal(readFileSync(join(dir, "settings.local.json"), "utf8"), "{}");
}));

it("skips a locally generated policy stamp after native atomic replacement", () => withHome(home => {
	const original = join(home, ".claude");
	const policy = join(original, "policy-limits.json");
	const stamp = join(original, "policy-limits.json.stamp.json");
	writeFileSync(policy, JSON.stringify({ deny: ["Bash"] }));
	writeFileSync(stamp, JSON.stringify({ source: "host" }));
	const originalStampInode = statSync(stamp).ino;
	const dir = prepareAccountProfile(home, "gc");
	const localStamp = join(dir, "policy-limits.json.stamp.json");
	// Reproduce a profile prepared before stamps stopped being shared.
	rmSync(localStamp, { force: true });
	symlinkSync(stamp, localStamp);
	const temporaryStamp = join(dir, "stamp.tmp");
	writeFileSync(temporaryStamp, JSON.stringify({ source: "native" }));
	renameSync(temporaryStamp, localStamp);
	const localStampInode = statSync(localStamp).ino;
	assert.equal(prepareAccountProfile(home, "gc"), dir);
	assert.ok(lstatSync(localStamp).isFile());
	assert.equal(readFileSync(localStamp, "utf8"), JSON.stringify({ source: "native" }));
	assert.equal(statSync(localStamp).ino, localStampInode);
	assert.equal(readFileSync(stamp, "utf8"), JSON.stringify({ source: "host" }));
	assert.equal(statSync(stamp).ino, originalStampInode);
	assert.ok(lstatSync(join(dir, "policy-limits.json")).isSymbolicLink());
	assert.equal(readlinkSync(join(dir, "policy-limits.json")), policy);
	writeFileSync(policy, JSON.stringify({ deny: ["Bash", "Write"] }));
	assert.equal(readFileSync(join(dir, "policy-limits.json"), "utf8"), readFileSync(policy, "utf8"));
}));

it("does not share the generated policy stamp in a new profile", () => withHome(home => {
	writeFileSync(join(home, ".claude", "policy-limits.json.stamp.json"), "host stamp");
	const dir = prepareAccountProfile(home, "gc");
	assert.equal(existsSync(join(dir, "policy-limits.json.stamp.json")), false);
}));

const conflictingConfigFixtures = [
	["file", (target) => writeFileSync(target, "local config")],
	["directory", (target) => mkdirSync(target)],
	["symlink", (target, home) => symlinkSync(join(home, "wrong-settings"), target)],
];
for (const [kind, createConflict] of conflictingConfigFixtures) {
	it(`rejects a conflicting config ${kind} without replacing it`, () => withHome(home => {
		const original = join(home, ".claude", "settings.json");
		writeFileSync(original, "{}");
		const dir = join(home, ".config", "pi-claude-bridge", "profiles", "gc");
		mkdirSync(dir, { recursive: true });
		const target = join(dir, "settings.json");
		createConflict(target, home);
		const before = lstatSync(target);
		assert.throws(() => prepareAccountProfile(home, "gc"), /config path conflicts/);
		const after = lstatSync(target);
		assert.equal(after.ino, before.ino);
		assert.equal(after.mode, before.mode);
		if (kind === "file") assert.equal(readFileSync(target, "utf8"), "local config");
	}));
}
