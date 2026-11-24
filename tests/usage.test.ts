// Run: node --test tests/
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildSegments,
	chatgptAccountId,
	fitSegments,
	formatDuration,
	hasElapsedReset,
	mergeResets,
	parseAnthropicUsage,
	parseCodexResetCredits,
	parseCodexUsage,
	percentTone,
	windowLabel,
} from "../src/usage.ts";

const NOW = Date.parse("2026-11-11T21:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("formatDuration", () => {
	assert.equal(formatDuration(0), "now");
	assert.equal(formatDuration(-5), "now");
	assert.equal(formatDuration(Number.NaN), "now");
	assert.equal(formatDuration(30_000), "1m");
	assert.equal(formatDuration(41 * MIN), "41m");
	assert.equal(formatDuration(3 * HOUR + 41 * MIN), "3h 41m");
	assert.equal(formatDuration(2 * DAY + 12 * HOUR + 59 * MIN), "2d 12h");
});

test("windowLabel", () => {
	assert.equal(windowLabel(18_000), "5h");
	assert.equal(windowLabel(604_800), "7d");
	assert.equal(windowLabel(60), "1h");
	assert.equal(windowLabel(86_400), "1d");
});

test("percentTone", () => {
	assert.equal(percentTone(0), "muted");
	assert.equal(percentTone(69.9), "muted");
	assert.equal(percentTone(70), "warning");
	assert.equal(percentTone(90), "error");
});

test("parseAnthropicUsage reads five_hour and seven_day", () => {
	const snapshot = parseAnthropicUsage({
		five_hour: { utilization: 82.0, resets_at: "2026-11-11T23:40:00.393310+00:00" },
		seven_day: { utilization: 16, resets_at: "2026-11-16T22:00:00Z" },
		seven_day_opus: null,
	});
	assert.equal(snapshot.plan, undefined);
	assert.deepEqual(
		snapshot.windows.map((w) => [w.label, w.usedPercent]),
		[
			["5h", 82],
			["7d", 16],
		],
	);
	assert.equal(snapshot.windows[0]!.resetsAt, Date.parse("2026-11-11T23:40:00.393Z"));
});

test("parseAnthropicUsage tolerates a missing window and clamps", () => {
	const snapshot = parseAnthropicUsage({ five_hour: null, seven_day: { utilization: 140, resets_at: "bad" } });
	assert.equal(snapshot.windows.length, 1);
	assert.equal(snapshot.windows[0]!.usedPercent, 100);
	assert.equal(snapshot.windows[0]!.resetsAt, undefined);
});

test("parseAnthropicUsage rejects unrecognized shapes", () => {
	assert.throws(() => parseAnthropicUsage(null));
	assert.throws(() => parseAnthropicUsage([]));
	assert.throws(() => parseAnthropicUsage({ five_hour: { utilization: "82" } }));
	assert.throws(() => parseAnthropicUsage({ error: { type: "authentication_error" } }));
});

const codexUsage = {
	plan_type: "plus",
	rate_limit: {
		allowed: true,
		limit_reached: false,
		primary_window: { used_percent: 35, limit_window_seconds: 18000, reset_after_seconds: 12834, reset_at: 1794444446 },
		secondary_window: { used_percent: 9, limit_window_seconds: 604800, reset_after_seconds: 215347, reset_at: 1794646959 },
	},
	rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 },
};

test("parseCodexUsage reads plan, windows and reset count", () => {
	const snapshot = parseCodexUsage(codexUsage, NOW);
	assert.equal(snapshot.plan, "plus");
	assert.deepEqual(
		snapshot.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]),
		[
			["5h", 35, 1794444446_000],
			["7d", 9, 1794646959_000],
		],
	);
	assert.deepEqual(snapshot.resets, { available: 2 });
});

test("parseCodexUsage falls back to reset_after_seconds and accepts milliseconds", () => {
	const snapshot = parseCodexUsage(
		{
			rate_limit: {
				primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 60 },
				secondary_window: { used_percent: 1, limit_window_seconds: 604800, reset_at: 1794646959_000 },
			},
		},
		NOW,
	);
	assert.equal(snapshot.windows[0]!.resetsAt, NOW + 60_000);
	assert.equal(snapshot.windows[1]!.resetsAt, 1794646959_000);
	assert.equal(snapshot.plan, undefined);
	assert.equal(snapshot.resets, undefined);
});

test("parseCodexUsage rejects unrecognized shapes", () => {
	assert.throws(() => parseCodexUsage({}, NOW));
	assert.throws(() => parseCodexUsage({ rate_limit: { primary_window: { used_percent: 5 } } }, NOW));
	assert.throws(() => parseCodexUsage("x", NOW));
});

test("parseCodexResetCredits picks the earliest available expiry", () => {
	const credits = parseCodexResetCredits({
		available_count: 2,
		credits: [
			{ id: "a", status: "available", expires_at: "2026-12-01T20:48:10.491148Z" },
			{ id: "b", status: "redeemed", expires_at: "2026-11-12T00:00:00Z" },
			{ id: "c", status: "available", expires_at: "2026-11-30T19:02:04.355295Z" },
			"junk",
		],
	});
	assert.equal(credits.available, 2);
	assert.equal(credits.earliestExpiry, Date.parse("2026-11-30T19:02:04.355Z"));
});

test("parseCodexResetCredits counts available credits without a reported count", () => {
	const credits = parseCodexResetCredits({ credits: [{ id: "a" }, { id: "b", status: "expired" }] });
	assert.deepEqual(credits, { available: 1, earliestExpiry: undefined });
	assert.throws(() => parseCodexResetCredits({ credits: "none" }));
});

test("mergeResets prefers the usage count and the list expiry", () => {
	assert.equal(mergeResets(undefined, undefined), undefined);
	assert.deepEqual(mergeResets({ available: 2 }, { available: 3, earliestExpiry: 5 }), { available: 2, earliestExpiry: 5 });
	assert.deepEqual(mergeResets(undefined, { available: 3, earliestExpiry: 5 }), { available: 3, earliestExpiry: 5 });
	assert.deepEqual(mergeResets({ available: 2 }, undefined), { available: 2, earliestExpiry: undefined });
});

test("chatgptAccountId decodes the JWT claim and tolerates garbage", () => {
	const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acc-1" } })).toString(
		"base64url",
	);
	assert.equal(chatgptAccountId(`h.${payload}.s`), "acc-1");
	assert.equal(chatgptAccountId("not-a-jwt"), undefined);
	assert.equal(chatgptAccountId("a.!!!.c"), undefined);
	const other = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
	assert.equal(chatgptAccountId(`h.${other}.s`), undefined);
});

test("buildSegments matches the OMP layout", () => {
	const snapshot = {
		plan: "plus",
		windows: [
			{ label: "5h", usedPercent: 35, resetsAt: NOW + 3 * HOUR + 41 * MIN },
			{ label: "7d", usedPercent: 92, resetsAt: NOW + 2 * DAY + 12 * HOUR },
		],
		resets: { available: 2, earliestExpiry: NOW + 18 * DAY + 22 * HOUR },
	};
	const { plan, items } = buildSegments(snapshot, NOW);
	assert.deepEqual(plan, { text: "plus", tone: "accent" });
	assert.deepEqual(items, [
		{ text: "5h 35% (3h 41m)", tone: "muted" },
		{ text: "7d 92% (2d 12h)", tone: "error" },
		{ text: "✦ 2 exp 18d 22h", tone: "accent" },
	]);
	const full = fitSegments(plan, items, 200)!.map((s) => s.text).join(" · ");
	assert.equal(full, "plus · 5h 35% (3h 41m) · 7d 92% (2d 12h) · ✦ 2 exp 18d 22h");
});

test("buildSegments omits zero credits and unknown reset times", () => {
	const { plan, items } = buildSegments(
		{ windows: [{ label: "5h", usedPercent: 12.6 }], resets: { available: 0, earliestExpiry: NOW } },
		NOW,
	);
	assert.equal(plan, undefined);
	assert.deepEqual(items, [{ text: "5h 13%", tone: "muted" }]);
});

test("fitSegments drops the plan first, then trailing items", () => {
	const plan = { text: "plus", tone: "accent" as const };
	const items = [
		{ text: "aaaa", tone: "muted" as const },
		{ text: "bbbb", tone: "muted" as const },
	];
	// "plus · aaaa · bbbb" = 18, "aaaa · bbbb" = 11, "aaaa" = 4
	assert.equal(fitSegments(plan, items, 18)!.length, 3);
	assert.deepEqual(fitSegments(plan, items, 17)!.map((s) => s.text), ["aaaa", "bbbb"]);
	assert.deepEqual(fitSegments(plan, items, 10)!.map((s) => s.text), ["aaaa"]);
	assert.equal(fitSegments(plan, items, 3), undefined);
	assert.equal(fitSegments(undefined, [], 100), undefined);
});

test("hasElapsedReset", () => {
	assert.equal(hasElapsedReset({ windows: [{ label: "5h", usedPercent: 1, resetsAt: NOW - 1 }] }, NOW), true);
	assert.equal(hasElapsedReset({ windows: [{ label: "5h", usedPercent: 1, resetsAt: NOW + 1 }] }, NOW), false);
	assert.equal(hasElapsedReset({ windows: [{ label: "5h", usedPercent: 1 }] }, NOW), false);
});
