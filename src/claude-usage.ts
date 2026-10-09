import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readUsageCredentials } from "./account-profiles.js";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_ATTEMPTS = 3;
const MAX_WAIT_MS = 5000;
const REQUEST_TIMEOUT_MS = 5000;
const BACKOFF_MS = 250;
const MAX_DATE_TIMESTAMP_MS = 8.64e15;
const WINDOWS = [
	["five_hour", "5-hour", false],
	["seven_day", "7-day", false],
	["seven_day_opus", "7-day Opus", true],
	["seven_day_sonnet", "7-day Sonnet", true],
] as const;

type UsageUI = Pick<ExtensionContext, "ui">;
export interface UsageRequest {
	args: string;
	ctx: UsageUI;
	handled?: Promise<void>;
}
export interface UsageAccount {
	home: string;
	name: string;
	profile?: string;
	configDir?: string;
}
interface UsageRuntime {
	fetch: typeof globalThis.fetch;
	now: () => number;
	random: () => number;
	sleep: (delay: number) => Promise<void>;
}
class UsageError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCurrentAccessToken(account: UsageAccount, now: number): string {
	let credentials: unknown;
	try {
		credentials = readUsageCredentials(account.home, account.profile, account.configDir);
	} catch (error) {
		// The credential reader emits only fixed, sanitized messages.
		throw new UsageError(error instanceof Error ? error.message : "Cannot read Claude credentials");
	}
	const oauth = isRecord(credentials) ? credentials.claudeAiOauth : undefined;
	if (!isRecord(oauth)) throw new UsageError("Missing Claude OAuth access token for current account");
	const token = oauth.accessToken;
	if (typeof token !== "string" || !token.trim()) {
		throw new UsageError("Missing Claude OAuth access token for current account");
	}
	if (oauth.expiresAt !== undefined) {
		if (typeof oauth.expiresAt !== "number" || !Number.isFinite(oauth.expiresAt)) {
			throw new UsageError("Invalid Claude credentials: access token expiry");
		}
		if (oauth.expiresAt <= now) throw new UsageError("Expired Claude OAuth access token for current account");
	}
	return token;
}

function retryAfterMs(value: string | null, now: number): number | undefined {
	if (value === null) return undefined;
	const seconds = Number(value);
	if (value.trim() && Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const deadline = Date.parse(value);
	return Number.isFinite(deadline) ? Math.max(0, deadline - now) : undefined;
}

function httpUsageError(status: number, delay: number | undefined, now: number): UsageError {
	if (status === 401) return new UsageError("Claude usage HTTP 401: current account OAuth token expired or rejected");
	const retry = delay === undefined ? "" : `; retry after ${Math.ceil(delay / 1000)} seconds`;
	const deadline = delay !== undefined && delay <= MAX_DATE_TIMESTAMP_MS - now ? ` (${new Date(now + delay).toISOString()})` : "";
	return new UsageError(`Claude usage HTTP ${status}${retry}${deadline}`);
}

async function fetchUsageResponse(token: string, runtime: UsageRuntime): Promise<Response | undefined> {
	try {
		return await runtime.fetch(USAGE_URL, {
			headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
	} catch {
		// The caller handles network failure with bounded retries and a sanitized error.
		return undefined;
	}
}

async function fetchSubscriptionUsage(token: string, runtime: UsageRuntime): Promise<unknown> {
	const waitDeadline = runtime.now() + MAX_WAIT_MS;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const backoff = BACKOFF_MS * 2 ** attempt * (1 + runtime.random());
		const response = await fetchUsageResponse(token, runtime);
		if (response?.ok) return readUsageResponse(response);
		const now = runtime.now();
		const delay = response ? retryAfterMs(response.headers.get("Retry-After"), now) : undefined;
		const failure = response
			? httpUsageError(response.status, delay, now)
			: new UsageError("Claude usage network request failed after bounded attempts");
		const isServerError = response !== undefined && response.status >= 500 && response.status <= 599;
		const isTransient = response === undefined || response.status === 429 || isServerError;
		const wait = Math.max(backoff, delay ?? 0);
		const hasTime = now + wait <= waitDeadline;
		const hasAttempts = attempt + 1 < MAX_ATTEMPTS;
		const canRetry = isTransient && hasTime && hasAttempts;
		if (!canRetry) throw failure;
		await runtime.sleep(wait);
	}
	throw new UsageError("Claude usage request failed");
}

async function readUsageResponse(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		throw new UsageError("Invalid Claude usage response: expected JSON subscription windows");
	}
}

function renderWindow(value: unknown, label: string): string {
	if (value === null) return `${label}: unavailable`;
	if (!isRecord(value)) throw new UsageError("Invalid Claude usage response: expected subscription window");
	const percent = value.utilization;
	const reset = value.resets_at;
	const validPercent = typeof percent === "number" && percent >= 0 && percent <= 100;
	if (!validPercent) throw new UsageError("Invalid Claude usage response: invalid percent");
	return `${label}: ${percent}% — ${renderReset(reset)}`;
}

function renderReset(reset: unknown): string {
	if (reset === null) return "reset unavailable";
	const isoWithTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
	if (typeof reset !== "string" || !isoWithTimezone.test(reset)) {
		throw new UsageError("Invalid Claude usage response: invalid reset");
	}
	const deadline = Date.parse(reset);
	if (!Number.isFinite(deadline)) throw new UsageError("Invalid Claude usage response: invalid reset");
	return `resets ${new Date(deadline).toISOString()} (UTC)`;
}

function renderSubscriptionUsage(name: string, response: unknown): string {
	if (!isRecord(response)) throw new UsageError("Invalid Claude usage response: expected subscription windows");
	const windows = WINDOWS.map(([field, label, optional]) => {
		const isAbsentOptional = optional && !Object.hasOwn(response, field);
		return renderWindow(isAbsentOptional ? null : response[field], label);
	});
	return [`Claude account: ${name}`, "Subscription quota (not session token usage)", ...windows].join("\n");
}

export async function reportClaudeUsage(
	args: string,
	ctx: UsageUI,
	readAccount: () => UsageAccount | undefined,
	sendReport: (report: string) => void,
	overrides: Partial<UsageRuntime> = {},
): Promise<void> {
	if (typeof args !== "string" || args.trim()) {
		ctx.ui.notify("Unsupported /usage arguments for Claude; use /usage without arguments. Claude quota reset is unsupported.", "warning");
		return;
	}
	const runtime: UsageRuntime = {
		fetch: globalThis.fetch, now: Date.now, random: Math.random,
		sleep: delay => new Promise(resolve => setTimeout(resolve, delay)), ...overrides,
	};
	try {
		const account = readAccount();
		if (account === undefined) throw new UsageError("No selected Claude account profile available for subscription usage");
		const token = readCurrentAccessToken(account, runtime.now());
		const response = await fetchSubscriptionUsage(token, runtime);
		sendReport(renderSubscriptionUsage(account.name, response));
	} catch (error) {
		const message = error instanceof UsageError ? error.message : "Cannot read Claude current account for subscription usage";
		ctx.ui.notify(message, "error");
	}
}
