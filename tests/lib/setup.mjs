/**
 * Unit-suite preload: redirect the bridge's debug log to a throwaway directory.
 *
 * src/index.ts resolves DEBUG_LOG_PATH into a module-level const at import time
 * (and mkdirs it when CLAUDE_BRIDGE_DEBUG=1), so the override has to be in place
 * before any test imports the module. Doing that per test file is easy to forget,
 * and forgetting is invisible: the suite still passes everywhere except on a
 * developer machine with CLAUDE_BRIDGE_DEBUG=1, where the tests instead append
 * fixture data to the real bridge log in pi's agent dir.
 *
 * Wiring this as `node --import ./tests/lib/setup.mjs` guarantees it runs first
 * in every test child process. tests/unit-debug-path.mjs asserts it took effect.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const logDir = mkdtempSync(join(tmpdir(), "claude-bridge-test-log-"));
process.env.CLAUDE_BRIDGE_DEBUG_PATH = join(logDir, "claude-bridge.log");

// A unit test that streams without setting its own HOME would otherwise load the developer's
// real claude-bridge.json accountProfiles, read real Claude credentials and write test quota
// rejections into the real shared account state. Test files that need a specific home still
// override these after import.
const home = mkdtempSync(join(tmpdir(), "claude-bridge-test-home-"));
process.env.HOME = home;
// Inherited from a parent Pi; cleared so both resolve under HOME like a fresh install.
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.CLAUDE_CONFIG_DIR;

process.on("exit", () => {
	rmSync(logDir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});
