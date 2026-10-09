import {
	chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync,
	renameSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const credentialSnapshots = new Map<string, { isolated: string; saved: string | undefined }>();

function validateProfileName(name: string): void {
	if (typeof name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) {
		throw new Error("Invalid profile name: use letters, digits, underscores or hyphens");
	}
}

/** First unattempted name in explicit order; undefined means exhausted. No wraparound. */
export function nextAccountProfile(names: readonly string[], attempted: Iterable<string>): string | undefined {
	const unique = new Set<string>();
	for (const name of names) {
		validateProfileName(name);
		if (unique.has(name)) throw new Error("Duplicate profile name");
		unique.add(name);
	}
	const tried = new Set(attempted);
	return names.find(name => !tried.has(name));
}

function profilePaths(home: string, name: string) {
	validateProfileName(name);
	if (!isAbsolute(home)) throw new Error("Account profiles require an absolute home directory");
	const original = join(home, ".claude");
	const root = join(home, ".config", "pi-claude-bridge");
	const profiles = join(root, "profiles");
	const configDir = join(profiles, name);
	return {
		root, profiles, configDir, original,
		saved: join(original, `${name}.credentials.json`),
		isolated: join(configDir, ".credentials.json"),
	};
}

function inspectPath(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function restrictDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	if (!lstatSync(path).isDirectory()) throw new Error("Account profile path must be a directory, not a symlink");
	chmodSync(path, 0o700);
}

function requireRegularFile(path: string): void {
	const stat = inspectPath(path);
	if (stat && !stat.isFile()) throw new Error("Credentials must be a regular file, not a symlink");
}

function readCredentials(path: string): string {
	requireRegularFile(path);
	const content = readFileSync(path, "utf8");
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		throw new Error("Invalid credentials: expected a nonempty JSON object");
	}
	const isObject = value !== null && typeof value === "object";
	const isCredentialRecord = isObject && !Array.isArray(value) && Object.keys(value).length > 0;
	if (!isCredentialRecord) {
		throw new Error("Invalid credentials: expected a nonempty JSON object");
	}
	return content;
}

function readSavedSnapshot(path: string): string | undefined {
	requireRegularFile(path);
	return inspectPath(path) ? readFileSync(path, "utf8") : undefined;
}

function readSeedCredentials(original: string, saved: string, name: string): string {
	const marker = join(original, ".active-profile");
	const active = inspectPath(marker) ? readFileSync(marker, "utf8").trim() : undefined;
	return readCredentials(active === name ? join(original, ".credentials.json") : saved);
}

function writeCredentials(path: string, content: string, initialize = false): void {
	requireRegularFile(path);
	// Replace atomically so an interrupted write cannot truncate the saved refresh token.
	const tempDir = mkdtempSync(join(dirname(path), ".bridge-credentials-"));
	try {
		chmodSync(tempDir, 0o700);
		const tempFile = join(tempDir, "credentials.json");
		writeFileSync(tempFile, content, { mode: 0o600 });
		if (initialize) {
			try {
				// Publish a complete file only if another prepare has not initialized it.
				linkSync(tempFile, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		} else {
			renameSync(tempFile, path);
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
}

function shareConfigEntry(original: string, shared: string): void {
	const stat = inspectPath(shared);
	if (!stat) {
		symlinkSync(original, shared, "dir");
		return;
	}
	if (!stat.isSymbolicLink() || resolve(dirname(shared), readlinkSync(shared)) !== original) {
		throw new Error("Account profile config path conflicts with the original config entry");
	}
}

function shareConfig(original: string, configDir: string): void {
	mkdirSync(join(original, "projects"), { recursive: true, mode: 0o700 });
	for (const entry of readdirSync(original)) {
		// Native Claude atomically replaces this generated stamp; only the policy stays shared.
		if (entry === "policy-limits.json.stamp.json") continue;
		if (entry === ".credentials.json" || entry.endsWith(".credentials.json") || entry === ".active-profile") continue;
		shareConfigEntry(join(original, entry), join(configDir, entry));
	}
}

function reportFileError<T>(operation: string, name: string, action: () => T): T {
	try {
		return action();
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code) {
			// Never include parser messages, credential contents, or raw filesystem errors.
			throw new Error(`Cannot ${operation} credentials for profile ${name}: ${code}`);
		}
		throw error;
	}
}

/** Read only: isolated CC credentials take precedence; never initialize a profile. */
export function readUsageCredentials(home: string, profile?: string, configDir?: string): unknown {
	try {
		if (profile === undefined) {
			return JSON.parse(readCredentials(join(configDir ?? join(home, ".claude"), ".credentials.json")));
		}
		const paths = profilePaths(home, profile);
		const content = inspectPath(paths.isolated)
			? readCredentials(paths.isolated)
			: readSeedCredentials(paths.original, paths.saved, profile);
		return JSON.parse(content);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error("Missing Claude credentials for current account");
		}
		throw new Error("Invalid or unreadable Claude credentials for current account");
	}
}

/** Account selection shared by every bridge process. `rejected` holds Unix-second reset times. */
export interface AccountState {
	current?: string;
	rejected: Record<string, number>;
}

interface ProcessAccountState extends AccountState {
	/** Milliseconds; the newest selection across processes wins. */
	updatedAt: number;
}

/** One file per process, so every file has a single writer and concurrent updates are never lost. */
export function accountStateDir(home: string): string {
	return join(home, ".config", "pi-claude-bridge", "account-state");
}

function parseProcessAccountState(content: string): ProcessAccountState | undefined {
	let value: unknown;
	try {
		value = JSON.parse(content);
	} catch {
		return undefined;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const { current, rejected, updatedAt } = value as { current?: unknown; rejected?: unknown; updatedAt?: unknown };
	if (current !== undefined && typeof current !== "string") return undefined;
	if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return undefined;
	if (!rejected || typeof rejected !== "object" || Array.isArray(rejected)) return undefined;
	const entries = Object.entries(rejected);
	if (entries.some(([, resetsAt]) => typeof resetsAt !== "number" || !Number.isFinite(resetsAt))) return undefined;
	const state: ProcessAccountState = { rejected: Object.fromEntries(entries) as Record<string, number>, updatedAt };
	if (typeof current === "string") state.current = current;
	return state;
}

function listProcessStateFiles(home: string): string[] {
	const dir = accountStateDir(home);
	if (!inspectPath(dir)) return [];
	return readdirSync(dir).filter((name) => /^\d+\.json$/.test(name)).map((name) => join(dir, name));
}

/** A file version: replaced only by rename, so a new write always has a new inode. */
function fileVersion(path: string): string | undefined {
	const stat = inspectPath(path);
	return stat ? `${stat.ino}:${stat.mtimeMs}` : undefined;
}

/** Merged state plus the version of each file merged into it. */
function readMergedAccountState(home: string): { state: AccountState | undefined; merged: Map<string, string> } {
	const merged = new Map<string, string>();
	const files = listProcessStateFiles(home);
	if (files.length === 0) return { state: undefined, merged };
	const rejected: Record<string, number> = {};
	let newest: ProcessAccountState | undefined;
	for (const path of files) {
		// Version before content: a write landing in between leaves a newer version that pruning keeps.
		const version = fileVersion(path);
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch (error) {
			// Pruned by another process between listing and reading.
			if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
			throw error;
		}
		const state = parseProcessAccountState(content);
		if (!state) throw new Error(`Invalid Claude account state in ${path}; delete it to reset account selection`);
		if (version) merged.set(path, version);
		for (const [name, resetsAt] of Object.entries(state.rejected)) {
			rejected[name] = Math.max(rejected[name] ?? -Infinity, resetsAt);
		}
		if (state.current !== undefined && (!newest || state.updatedAt > newest.updatedAt)) newest = state;
	}
	return { state: { ...(newest?.current === undefined ? {} : { current: newest.current }), rejected }, merged };
}

/** Every process's state merged: latest reset per account, newest selection. Undefined before any write. */
export function readAccountState(home: string): AccountState | undefined {
	return readMergedAccountState(home).state;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Writes this process's file, then prunes files of exited processes whose exact merged version is carried
 * in `state`. A file rewritten after the read has a new version and stays for a later merge.
 */
function writeAccountState(home: string, state: AccountState, merged: Map<string, string>): void {
	const dir = accountStateDir(home);
	restrictDirectory(dirname(dir));
	restrictDirectory(dir);
	const tempDir = mkdtempSync(join(dir, ".write-"));
	try {
		const tempFile = join(tempDir, "state.json");
		writeFileSync(tempFile, `${JSON.stringify({ ...state, updatedAt: Date.now() })}\n`, { mode: 0o600 });
		renameSync(tempFile, join(dir, `${process.pid}.json`));
	} finally {
		rmSync(tempDir, { recursive: true, force: true });
	}
	for (const [path, version] of merged) {
		const pid = Number(path.slice(path.lastIndexOf("/") + 1, -".json".length));
		if (pid === process.pid || isProcessAlive(pid)) continue;
		if (fileVersion(path) === version) rmSync(path, { force: true });
	}
}

/** Applies `change` to the merged state and publishes the result as this process's state. */
export function updateAccountState(home: string, change: (state: AccountState | undefined) => AccountState): void {
	const { state, merged } = readMergedAccountState(home);
	writeAccountState(home, change(state), merged);
}

/** Initialize once; subsequent queries use the persistent, CC-owned credentials. */
export function prepareAccountProfile(home: string, name: string): string {
	const paths = profilePaths(home, name);
	return reportFileError("read/prepare", name, () => {
		for (const dir of [paths.root, paths.profiles, paths.configDir]) restrictDirectory(dir);
		shareConfig(paths.original, paths.configDir);
		const snapshot = credentialSnapshots.get(paths.isolated);
		const saved = snapshot ? snapshot.saved : readSavedSnapshot(paths.saved);
		if (!inspectPath(paths.isolated)) {
			const content = readSeedCredentials(paths.original, paths.saved, name);
			if (saved !== undefined) chmodSync(paths.saved, 0o600);
			writeCredentials(paths.isolated, content, true);
		}
		const content = readCredentials(paths.isolated);
		chmodSync(paths.isolated, 0o600);
		// Keep both baselines when prepares overlap: pending refreshes and external changes stay visible.
		if (!snapshot) credentialSnapshots.set(paths.isolated, { isolated: content, saved });
		return paths.configDir;
	});
}

/** Call after the query settles (including failure) to save SDK-refreshed credentials. */
export function persistAccountProfile(home: string, name: string): void {
	const paths = profilePaths(home, name);
	reportFileError("read/persist", name, () => {
		const content = readCredentials(paths.isolated);
		const snapshot = credentialSnapshots.get(paths.isolated);
		if (snapshot === undefined) throw new Error("Account profile must be prepared before persisting credentials");
		if (content === snapshot.isolated) return;
		if (readSavedSnapshot(paths.saved) !== snapshot.saved) {
			throw new Error(`Named credentials changed since prepare for profile ${name}; refusing to overwrite`);
		}
		// Optimistic check only: a noncooperating writer can still change the file between
		// this check and rename. Atomic replacement prevents truncation, not that race.
		writeCredentials(paths.saved, content);
		credentialSnapshots.set(paths.isolated, { isolated: content, saved: content });
	});
}
