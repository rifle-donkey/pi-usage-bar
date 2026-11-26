// Pure parsing and formatting for subscription usage. No Pi imports, so tests run with plain Node.
// The upstream endpoints are undocumented: validate every field and never log raw responses.

export interface UsageWindow {
	/** Short label such as "5h" or "7d". */
	label: string;
	/** Used percentage of the window; Cursor can report more than 100. */
	usedPercent: number;
	/** Reset time in epoch milliseconds, when known. */
	resetsAt?: number;
}

export interface ResetCredits {
	available: number;
	/** Earliest expiry among available credits, epoch milliseconds. */
	earliestExpiry?: number;
}

export interface UsageSnapshot {
	plan?: string;
	windows: UsageWindow[];
	resets?: ResetCredits;
}

export type Tone = "muted" | "accent" | "warning" | "error";

export interface Segment {
	text: string;
	tone: Tone;
}

const HOUR_S = 3600;
const DAY_S = 86_400;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

function parseTime(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/** Label a window by its length: whole days when at least one day, otherwise hours. */
export function windowLabel(seconds: number): string {
	if (seconds >= DAY_S) return `${Math.round(seconds / DAY_S)}d`;
	return `${Math.max(1, Math.round(seconds / HOUR_S))}h`;
}

// ---- Anthropic: GET https://api.anthropic.com/api/oauth/usage ----

export function parseAnthropicUsage(data: unknown): UsageSnapshot {
	if (!isRecord(data)) throw new Error("Unrecognized usage response");
	const windows: UsageWindow[] = [];
	for (const [field, label] of [
		["five_hour", "5h"],
		["seven_day", "7d"],
	] as const) {
		const bucket = data[field];
		if (!isRecord(bucket)) continue;
		const used = finite(bucket.utilization);
		if (used === undefined) continue;
		windows.push({ label, usedPercent: clampPercent(used), resetsAt: parseTime(bucket.resets_at) });
	}
	if (windows.length === 0) throw new Error("Unrecognized usage response");
	return { windows };
}

// ---- ChatGPT (openai-codex): GET https://chatgpt.com/backend-api/wham/usage ----

function parseCodexWindow(value: unknown, nowMs: number): UsageWindow | undefined {
	if (!isRecord(value)) return undefined;
	const used = finite(value.used_percent);
	const seconds = finite(value.limit_window_seconds);
	if (used === undefined || seconds === undefined || seconds <= 0) return undefined;
	const resetAt = finite(value.reset_at);
	const resetAfter = finite(value.reset_after_seconds);
	let resetsAt: number | undefined;
	if (resetAt !== undefined && resetAt > 0) {
		// Seconds in practice; accept milliseconds defensively.
		resetsAt = resetAt > 1e12 ? resetAt : resetAt * 1000;
	} else if (resetAfter !== undefined && resetAfter >= 0) {
		resetsAt = nowMs + resetAfter * 1000;
	}
	return { label: windowLabel(seconds), usedPercent: clampPercent(used), resetsAt };
}

export function parseCodexUsage(data: unknown, nowMs: number): UsageSnapshot {
	if (!isRecord(data)) throw new Error("Unrecognized usage response");
	const limit = isRecord(data.rate_limit) ? data.rate_limit : undefined;
	const windows = [limit?.primary_window, limit?.secondary_window]
		.map((window) => parseCodexWindow(window, nowMs))
		.filter((window): window is UsageWindow => window !== undefined);
	if (windows.length === 0) throw new Error("Unrecognized usage response");
	const plan = typeof data.plan_type === "string" && data.plan_type.trim() ? data.plan_type.trim() : undefined;
	const credits = isRecord(data.rate_limit_reset_credits) ? data.rate_limit_reset_credits : undefined;
	const available = finite(credits?.available_count);
	return {
		plan,
		windows,
		resets: available === undefined ? undefined : { available: Math.max(0, Math.trunc(available)) },
	};
}

// ---- ChatGPT reset credits: GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits ----

export function parseCodexResetCredits(data: unknown): ResetCredits {
	if (!isRecord(data) || !Array.isArray(data.credits)) throw new Error("Unrecognized reset credit response");
	let count = 0;
	let earliest: number | undefined;
	for (const credit of data.credits) {
		if (!isRecord(credit)) continue;
		if ((credit.status ?? "available") !== "available") continue;
		count++;
		const expiry = parseTime(credit.expires_at);
		if (expiry !== undefined && (earliest === undefined || expiry < earliest)) earliest = expiry;
	}
	const reported = finite(data.available_count);
	return {
		available: reported === undefined ? count : Math.max(0, Math.trunc(reported)),
		earliestExpiry: earliest,
	};
}

/** Prefer the usage endpoint's count; take the expiry from the credit list. */
export function mergeResets(usage: ResetCredits | undefined, list: ResetCredits | undefined): ResetCredits | undefined {
	if (!usage && !list) return undefined;
	return {
		available: usage?.available ?? list?.available ?? 0,
		earliestExpiry: list?.earliestExpiry,
	};
}

/** Read the ChatGPT account id from an OpenAI access token (JWT payload), without verifying it. */
export function chatgptAccountId(token: string): string | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const payload: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		if (!isRecord(payload)) return undefined;
		const auth = payload["https://api.openai.com/auth"];
		const id = isRecord(auth) ? auth.chatgpt_account_id : undefined;
		return typeof id === "string" && id ? id : undefined;
	} catch {
		return undefined;
	}
}

// ---- Cursor ----

export function parseCursorUsage(data: unknown): UsageSnapshot {
	if (!isRecord(data) || !isRecord(data.planUsage)) throw new Error("Unrecognized usage response");
	const end = data.billingCycleEnd;
	const resetsAt = finite(typeof end === "string" && /^\d+$/.test(end) ? Number(end) : end);
	const windows: UsageWindow[] = [];
	for (const [field, label] of [["autoPercentUsed", "cursor"], ["apiPercentUsed", "other"]] as const) {
		const value = data.planUsage[field];
		if (value == null) continue;
		const usedPercent = finite(value);
		if (usedPercent === undefined || usedPercent < 0) throw new Error("Unrecognized usage response");
		windows.push({ label, usedPercent, resetsAt });
	}
	if (windows.length === 0) throw new Error("Unrecognized usage response");
	return { windows };
}

// ---- GitHub Copilot ----

export interface Quota {
	entitlement: number;
	remaining: number;
	/** Percentage remaining, as reported by GitHub. */
	percent: number;
	reset: string;
	fetchedAt: number;
}

export function parseCopilotQuota(data: unknown, nowMs: number): { snapshot: UsageSnapshot; quota: Quota } {
	const q = isRecord(data) && isRecord(data.quota) ? data.quota : undefined;
	const reset = isRecord(data) ? data.reset : undefined;
	const entitlement = finite(q?.entitlement);
	const remaining = finite(q?.remaining);
	const percent = finite(q?.percent_remaining);
	const resetsAt = typeof reset === "string" && /^\d{4}-\d{2}-\d{2}$/.test(reset)
		? Date.parse(`${reset}T00:00:00Z`)
		: NaN;
	if (
		!isRecord(data) || data.plan !== "enterprise" || q?.unlimited !== false ||
		entitlement === undefined || entitlement <= 0 ||
		remaining === undefined || remaining < 0 || remaining > entitlement ||
		percent === undefined || percent < 0 || percent > 100 ||
		Math.abs((remaining / entitlement) * 100 - percent) > 1 ||
		typeof reset !== "string" || !Number.isFinite(resetsAt) || new Date(resetsAt).toISOString().slice(0, 10) !== reset
	) {
		throw new Error("Unrecognized quota response");
	}
	return {
		snapshot: { plan: "enterprise", windows: [{ label: "premium", usedPercent: 100 - percent, resetsAt }] },
		quota: { entitlement, remaining, percent, reset, fetchedAt: nowMs },
	};
}

// ---- Formatting ----

/** Compact remaining time: "2d 12h", "3h 41m", "41m", or "now". */
export function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "now";
	const totalMinutes = Math.floor(ms / 60_000);
	const days = Math.floor(totalMinutes / 1440);
	const hours = Math.floor((totalMinutes % 1440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${Math.max(1, minutes)}m`;
}

export function percentTone(usedPercent: number): Tone {
	if (usedPercent >= 90) return "error";
	if (usedPercent >= 70) return "warning";
	return "muted";
}

/** Segments in priority order: windows first, then reset credits, then plan. */
export function buildSegments(snapshot: UsageSnapshot, nowMs: number): { plan?: Segment; items: Segment[] } {
	const items: Segment[] = snapshot.windows.map((window) => {
		const reset = window.resetsAt === undefined ? "" : ` (${formatDuration(window.resetsAt - nowMs)})`;
		return { text: `${window.label} ${Math.round(window.usedPercent)}%${reset}`, tone: percentTone(window.usedPercent) };
	});
	const resets = snapshot.resets;
	if (resets && resets.available > 0) {
		const expiry = resets.earliestExpiry === undefined ? "" : ` exp ${formatDuration(resets.earliestExpiry - nowMs)}`;
		items.push({ text: `✦ ${resets.available}${expiry}`, tone: "accent" });
	}
	const plan = snapshot.plan ? { text: snapshot.plan, tone: "accent" as const } : undefined;
	return { plan, items };
}

/**
 * Choose the longest variant that fits `maxWidth` columns: full, then without plan,
 * then dropping trailing items. Returns undefined when not even one item fits.
 */
export function fitSegments(
	plan: Segment | undefined,
	items: Segment[],
	maxWidth: number,
	measure: (text: string) => number = (text) => text.length,
	separator = " · ",
): Segment[] | undefined {
	const width = (segments: Segment[]) =>
		segments.reduce((sum, segment) => sum + measure(segment.text), 0) +
		Math.max(0, segments.length - 1) * measure(separator);
	const candidates: Segment[][] = [];
	if (plan) candidates.push([plan, ...items]);
	for (let count = items.length; count >= 1; count--) candidates.push(items.slice(0, count));
	return candidates.find((segments) => width(segments) <= maxWidth);
}

/** Whether any known reset has passed since the last completed fetch. */
export function hasElapsedReset(snapshot: UsageSnapshot, fetchedAtMs: number, nowMs: number): boolean {
	return snapshot.windows.some(({ resetsAt }) => resetsAt !== undefined && resetsAt > fetchedAtMs && resetsAt <= nowMs);
}
