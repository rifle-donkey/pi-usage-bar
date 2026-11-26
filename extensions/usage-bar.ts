/**
 * usage-bar: shows subscription usage in the input box's top border (Pi only; OMP not supported).
 *
 *   ──────────── plus · 5h 35% (3h 41m) · 7d 9% (2d 12h) · ✦ 2 exp 18d 22h ─
 *
 * Shown for the active Anthropic, Codex or Cursor OAuth model, or a GitHub Copilot model.
 * Data comes from read-only, undocumented endpoints. OAuth tokens come from Pi's model
 * registry. Copilot uses the GitHub CLI after checking the configured account.
 *
 * The extension wraps whatever editor factory is configured (for example editor-selection) and
 * overrides only its top border; the scroll indicator still wins when the editor is scrolled.
 */
import { createHash } from "node:crypto";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { configNotice, createCopilot, quotaNotice, type CopilotProblem } from "../src/copilot.ts";
import {
	buildSegments,
	chatgptAccountId,
	fitSegments,
	hasElapsedReset,
	mergeResets,
	parseAnthropicUsage,
	parseCodexResetCredits,
	parseCodexUsage,
	parseCursorUsage,
	type Quota,
	type Segment,
	type UsageSnapshot,
} from "../src/usage.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type Model = NonNullable<ExtensionContext["model"]>;
type Provider = "anthropic" | "openai-codex" | "cursor" | "github-copilot";

const TIMEOUT_MS = 10_000;
/** Minimum gap between automatic refreshes (turn end, model switch). */
const MIN_REFRESH_MS = 60_000;
/** Background refresh period while idle. */
const PERIODIC_REFRESH_MS = 5 * 60_000;
/** Redraw period so countdowns stay current. */
const TICK_MS = 60_000;
/** Slack so a fetch that finished just after a tick still counts as due on the fifth tick. */
const TICK_SLACK_MS = TICK_MS / 2;
const SEPARATOR = " · ";
const CODEX_BASE = "https://chatgpt.com/backend-api";
const ANTHROPIC_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CURSOR_USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

interface Refresh {
	promise: Promise<void>;
	explicit: boolean;
	controller?: AbortController;
}

interface CacheEntry {
	value?: { snapshot: UsageSnapshot; quota?: Quota };
	fetchedAt?: number;
	failed: boolean;
	problem?: CopilotProblem;
	inFlight?: Refresh;
	discarded?: boolean;
	cursorDigest?: string;
}

/** Narrow view of the pi-tui Editor internals this extension relies on. */
interface BorderedEditor {
	renderTopBorder?: (width: number, hiddenLineCount: number) => string;
	borderColor?: (text: string) => string;
}

function usesOAuth(ctx: ExtensionContext, model: Model | undefined): boolean {
	try {
		return !!model && ctx.modelRegistry.isUsingOAuth(model);
	} catch {
		return false;
	}
}

function supportedProvider(ctx: ExtensionContext, model: Model | undefined): Provider | undefined {
	const provider = model?.provider;
	if (provider === "github-copilot" || provider === "cursor") return provider;
	if ((provider === "anthropic" || provider === "openai-codex") && usesOAuth(ctx, model)) return provider;
	return undefined;
}

async function getJson(url: string, headers: Record<string, string>, live: () => boolean): Promise<unknown> {
	if (!live()) return;
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!live()) return;
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

async function fetchAnthropic(token: string, live: () => boolean): Promise<UsageSnapshot | undefined> {
	const usage = await getJson(ANTHROPIC_USAGE_URL, {
		Authorization: `Bearer ${token}`,
		"anthropic-beta": "oauth-2025-04-20",
		Accept: "application/json",
	}, live);
	if (live()) return parseAnthropicUsage(usage);
}

async function fetchCodex(token: string, live: () => boolean): Promise<UsageSnapshot | undefined> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	const accountId = chatgptAccountId(token);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const creditsRequest = getJson(`${CODEX_BASE}/wham/rate-limit-reset-credits`, headers, live);
	creditsRequest.catch(() => {}); // Optional; avoid an unhandled rejection if usage fails first.
	const usage = await getJson(`${CODEX_BASE}/wham/usage`, headers, live);
	if (!live()) return;
	// Anchor relative reset times to when the usage response arrived, not to the credit request.
	const snapshot = parseCodexUsage(usage, Date.now());
	let list;
	try {
		const credits = await creditsRequest;
		if (!live()) return;
		list = parseCodexResetCredits(credits);
	} catch {
		// The credit list is optional; keep the count from the usage response.
	}
	return { ...snapshot, resets: mergeResets(snapshot.resets, list) };
}

/** Use the unverified JWT subject only as a local cache key, never to authorize requests. */
function cursorAccountDigest(token: string): string {
	let identity = token;
	const parts = token.split(".");
	if (parts.length === 3 && parts[1]) {
		try {
			const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
			if (typeof payload === "object" && payload !== null && Object.hasOwn(payload, "sub")) {
				const { sub } = payload as { sub: unknown };
				if (typeof sub === "string" && sub) identity = sub;
			}
		} catch {
			// Without a usable claim, compare whole tokens.
		}
	}
	return createHash("sha256").update(identity).digest("hex");
}

async function fetchCursor(token: string, controller: AbortController, live: () => boolean): Promise<UsageSnapshot | undefined> {
	const { signal } = controller;
	const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const clear = () => clearTimeout(timeout);
	signal.addEventListener("abort", clear, { once: true });
	try {
		const response = await fetch(CURSOR_USAGE_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				"Connect-Protocol-Version": "1",
			},
			body: "{}",
			redirect: "error",
			signal,
		});
		if (!live()) return;
		signal.throwIfAborted();
		if (!response.ok) throw new Error("Cursor usage request failed");
		const data: unknown = await response.json();
		signal.throwIfAborted();
		return parseCursorUsage(data);
	} finally {
		clear();
		signal.removeEventListener("abort", clear);
	}
}

function isDue(entry: CacheEntry, interval: number): boolean {
	return entry.fetchedAt === undefined || Date.now() - entry.fetchedAt >= interval;
}

function discard(entry: CacheEntry): void {
	const work = entry.inFlight;
	if (!work) return;
	entry.inFlight = undefined;
	entry.discarded = true;
	work.controller?.abort();
}

export default function usageStatus(pi: ExtensionAPI): void {
	const cache = new Map<Provider, CacheEntry>();
	const copilot = createCopilot((command, args, options) => pi.exec(command, args, options));
	let latestCtx: ExtensionContext | undefined;
	let activeModel: Model | undefined;
	let activeProvider: Provider | undefined;
	let installedFactory: EditorFactory | undefined;
	let requestRender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let installCheck: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;
	let shutdownGeneration = 0;
	let accountGeneration = 0;
	let stopped = false;
	let cursorAllowed = false;
	let cursorCheck: { due: boolean; force: boolean } | undefined;

	function entryFor(provider: Provider): CacheEntry {
		let entry = cache.get(provider);
		if (!entry) cache.set(provider, entry = { failed: false });
		return entry;
	}

	function advanceGeneration(): void {
		generation++;
		for (const entry of cache.values()) {
			if (!entry.inFlight?.explicit || stopped) discard(entry);
		}
		if (cursorCheck?.due) entryFor("cursor").discarded = true;
		cursorCheck = undefined;
		copilot.abortPrompt(stopped);
	}

	function liveness(provider: Provider, explicit: boolean): () => boolean {
		const startedIn = generation;
		const shutdown = shutdownGeneration;
		const account = accountGeneration;
		return () => !stopped && shutdown === shutdownGeneration &&
			(provider !== "github-copilot" || account === accountGeneration) && (explicit || startedIn === generation);
	}

	function refresh(
		ctx: ExtensionContext, provider: Provider,
		{ force = false, explicit = false, cursorToken }: { force?: boolean; explicit?: boolean; cursorToken?: string } = {},
	): Promise<void> {
		if (stopped || (!explicit && provider !== activeProvider)) return Promise.resolve();
		const entry = entryFor(provider);
		if (entry.inFlight) {
			// advanceGeneration has already detached older automatic work. A command can
			// take over a current attempt so it finishes even if the model changes next.
			if (explicit) entry.inFlight.explicit = true;
			return entry.inFlight.promise;
		}
		if (!force && !isDue(entry, MIN_REFRESH_MS)) return Promise.resolve();
		const automaticLive = liveness(provider, false);
		const explicitLive = liveness(provider, true);
		const controller = provider === "cursor" ? new AbortController() : undefined;
		const live = () => entry.inFlight === work && (work.explicit ? explicitLive() : automaticLive());
		const promise = Promise.resolve().then(async () => {
			if (!live()) return;
			try {
				if (provider === "github-copilot") {
					const result = await copilot.query(live);
					if (!live() || !result) return;
					if ("problem" in result) {
						entry.problem = result.problem;
						entry.failed = result.problem === "refresh failed";
						if (!entry.failed) entry.value = undefined;
					} else {
						entry.value = result;
						entry.failed = false;
						entry.problem = undefined;
					}
				} else {
					let snapshot: UsageSnapshot | undefined;
					if (provider === "cursor") {
						if (!cursorToken || !controller) return;
						snapshot = await fetchCursor(cursorToken, controller, live);
					} else {
						const auth = await ctx.modelRegistry.getProviderAuth(provider);
						if (!live()) return;
						const token = auth?.auth.apiKey;
						if (!token) throw new Error("No credential");
						snapshot = provider === "anthropic" ? await fetchAnthropic(token, live) : await fetchCodex(token, live);
					}
					if (!live() || !snapshot) return;
					entry.value = { snapshot };
					entry.failed = false;
				}
			} catch {
				if (!live()) return;
				entry.failed = true;
				if (provider === "github-copilot") entry.problem = "refresh failed";
			}
			entry.fetchedAt = Date.now();
			requestRender?.();
		}).finally(() => {
			if (entry.inFlight === work) entry.inFlight = undefined;
		});
		const work: Refresh = { promise, explicit, controller };
		entry.inFlight = work;
		return promise;
	}

	// Check even when no request is due on activation and on each tick. Use the checked token
	// directly for the request, so a delayed response cannot be attributed to a different login.
	async function checkCursor(ctx: ExtensionContext, probe: boolean, due: boolean, force: boolean): Promise<void> {
		if (stopped || activeProvider !== "cursor") return;
		const entry = entryFor("cursor");
		if (!probe) {
			if (!due || entry.inFlight) return;
			if (cursorCheck) {
				cursorCheck.due = true;
				cursorCheck.force ||= force;
				return;
			}
		}
		const check = { due: due || !!cursorCheck?.due, force: force || !!cursorCheck?.force };
		cursorCheck = check;
		const live = liveness("cursor", false);
		let token: string | undefined;
		let lookupFailed = false;
		try {
			const auth = await ctx.modelRegistry.getProviderAuth("cursor");
			if (auth?.source === "OAuth" && typeof auth.auth?.apiKey === "string") token = auth.auth.apiKey;
		} catch {
			lookupFailed = true;
		}
		if (!live() || cursorCheck !== check) return;
		cursorCheck = undefined;
		const hadValue = !!entry.value || entry.failed;
		const wasAllowed = cursorAllowed;
		if (lookupFailed) {
			// A failed lookup cannot confirm the login, but it does not prove a change.
			cursorAllowed = false;
			if (hadValue && wasAllowed) requestRender?.();
			return;
		}
		if (!usesOAuth(ctx, activeModel)) token = undefined;
		const digest = token ? cursorAccountDigest(token) : undefined;
		cursorAllowed = digest !== undefined;
		if (digest !== entry.cursorDigest || !digest) {
			discard(entry);
			entry.cursorDigest = digest;
			entry.discarded = false;
			entry.value = undefined;
			entry.failed = false;
			entry.fetchedAt = undefined;
			if (hadValue && wasAllowed) requestRender?.();
			if (!token) return;
			check.force = true;
		} else if (!wasAllowed && hadValue) {
			requestRender?.();
		}
		if (!token || (!check.due && !check.force)) return;
		await refresh(ctx, "cursor", { force: check.force, cursorToken: token });
	}

	async function setupCopilot(ctx: ExtensionContext, explicit: boolean): Promise<void> {
		await copilot.setup(ctx.ui, explicit, liveness("github-copilot", explicit), async (valid, changed) => {
			const entry = entryFor("github-copilot");
			if (valid || changed) {
				accountGeneration++;
				discard(entry);
			}
			if (changed) {
				entry.value = undefined;
				entry.failed = false;
				entry.problem = undefined;
				entry.fetchedAt = undefined;
			}
			const live = liveness("github-copilot", explicit);
			if (!valid) entry.problem = "config missing or invalid";
			if ((changed || !valid) && activeProvider === "github-copilot") requestRender?.();
			if (valid && live()) {
				if (activeProvider === "github-copilot") entry.discarded = false;
				await refresh(ctx, "github-copilot", { force: true, explicit });
			}
			return live();
		});
	}

	function label(maxWidth: number): string | undefined {
		const ctx = latestCtx;
		if (!ctx || !activeProvider) return undefined;
		if (activeProvider === "cursor" && (!cursorAllowed || !usesOAuth(ctx, activeModel))) return undefined;
		const theme = ctx.ui.theme;
		const entry = cache.get(activeProvider);
		const preserveStale = activeProvider === "cursor" || activeProvider === "github-copilot";
		let segments: Segment[] | undefined;
		if (entry?.value) {
			const { plan, items } = buildSegments(entry.value.snapshot, Date.now());
			const stale: Segment = { text: "stale", tone: "muted" };
			if (entry.failed && preserveStale) {
				for (let count = items.length; count >= 0; count--) {
					const fitted = fitSegments(count === items.length ? plan : undefined,
						[...items.slice(0, count), stale], maxWidth - 2, visibleWidth, SEPARATOR);
					if (fitted?.at(-1) === stale) {
						segments = fitted;
						break;
					}
				}
			} else {
				if (entry.failed) items.push(stale);
				segments = fitSegments(plan, items, maxWidth - 2, visibleWidth, SEPARATOR);
			}
		} else {
			const text = entry?.problem === "config missing or invalid" ? "copilot setup needed"
				: entry?.problem === "account mismatch" ? "account mismatch"
				: entry?.failed ? "usage unavailable" : undefined;
			if (text) segments = fitSegments(undefined, [{ text, tone: "muted" }], maxWidth - 2, visibleWidth);
		}
		if (!segments) return undefined;
		const body = segments.map((segment) => theme.fg(segment.tone, segment.text)).join(theme.fg("dim", SEPARATOR));
		return ` ${body} `;
	}

	function decorate<T>(editor: T): T {
		const target = editor as unknown as BorderedEditor;
		const original = target.renderTopBorder;
		if (typeof original !== "function") return editor;
		target.renderTopBorder = function (this: BorderedEditor, width: number, hiddenLineCount: number): string {
			const base = original.call(this, width, hiddenLineCount);
			if (hiddenLineCount > 0 || width < 12) return base;
			// Leave at least three border cells on the left and one on the right.
			const text = label(width - 4);
			if (!text) return base;
			const color = this.borderColor ?? ((value: string) => value);
			const fill = Math.max(0, width - 1 - visibleWidth(text));
			return color("─".repeat(fill)) + text + color("─");
		};
		return editor;
	}

	function installEditor(ctx: ExtensionContext): void {
		const current = ctx.ui.getEditorComponent();
		if (!ctx.hasUI || (current && current === installedFactory)) return;
		const base = current;
		const factory: EditorFactory = (tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			return decorate(base ? base(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings));
		};
		installedFactory = factory;
		ctx.ui.setEditorComponent(factory);
	}

	function update(ctx: ExtensionContext, model: Model | undefined, sessionStart = false): void {
		latestCtx = ctx;
		activeModel = model;
		const provider = supportedProvider(ctx, model);
		const switched = activeProvider !== provider;
		if (switched) advanceGeneration();
		const activated = sessionStart || switched;
		activeProvider = provider;
		if (activated) cursorAllowed = false;
		requestRender?.();
		if (!provider) return;
		const entry = entryFor(provider);
		const force = sessionStart || (activated && !!entry.discarded);
		if (activated) entry.discarded = false;
		if (provider === "cursor") {
			void checkCursor(ctx, activated, force || isDue(entry, MIN_REFRESH_MS), force).catch(() => {});
			return;
		}
		void refresh(ctx, provider, { force }).catch(() => {});
		if (activated && provider === "github-copilot") void setupCopilot(ctx, false).catch(() => {});
	}

	/**
	 * Another extension (for example editor-selection) may replace the editor after this
	 * extension's session_start handler, possibly after awaiting. Re-wrap whenever the
	 * configured factory is no longer ours: shortly after startup, after resources_discover
	 * (fires once all session_start handlers finished on startup/reload), and on later events.
	 */
	function ensureEditor(): void {
		if (latestCtx) installEditor(latestCtx);
	}

	pi.on("session_start", (_event, ctx) => {
		stopped = false;
		advanceGeneration();
		if (timer) clearInterval(timer);
		if (installCheck) clearTimeout(installCheck);
		if (!ctx.hasUI) {
			timer = undefined;
			installCheck = undefined;
			latestCtx = undefined;
			activeModel = undefined;
			activeProvider = undefined;
			requestRender = undefined;
			return;
		}
		installEditor(ctx);
		installCheck = setTimeout(() => {
			installCheck = undefined;
			if (latestCtx === ctx) installEditor(ctx);
		}, 0);
		update(ctx, ctx.model, true);
		timer = setInterval(() => {
			const current = latestCtx;
			const provider = activeProvider;
			ensureEditor();
			if (!current || !provider) return;
			const entry = entryFor(provider);
			const { value, fetchedAt } = entry;
			const due = isDue(entry, PERIODIC_REFRESH_MS - TICK_SLACK_MS) ||
				(value !== undefined && fetchedAt !== undefined && hasElapsedReset(value.snapshot, fetchedAt, Date.now()));
			if (provider === "cursor") void checkCursor(current, true, due, due).catch(() => {});
			else if (due && entry.problem !== "config missing or invalid") void refresh(current, provider, { force: true }).catch(() => {});
			requestRender?.();
		}, TICK_MS);
		timer.unref?.();
	});

	pi.on("resources_discover", () => {
		ensureEditor();
	});

	pi.on("agent_start", () => {
		ensureEditor();
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI || stopped) return;
		ensureEditor();
		update(ctx, event.model);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI || stopped) return;
		update(ctx, ctx.model);
	});

	pi.on("session_shutdown", () => {
		stopped = true;
		shutdownGeneration++;
		advanceGeneration();
		if (timer) clearInterval(timer);
		if (installCheck) clearTimeout(installCheck);
		timer = undefined;
		installCheck = undefined;
		latestCtx = undefined;
		activeModel = undefined;
		activeProvider = undefined;
		requestRender = undefined;
	});

	pi.registerCommand("copilot-credits", {
		description: "Refresh and show GitHub Copilot quota details; `setup` sets the Copilot account",
		handler: async (args, ctx) => {
			if (!ctx.hasUI || stopped) return;
			const action = args.trim();
			if (action === "setup") {
				await setupCopilot(ctx, true);
				return;
			}
			if (action) {
				ctx.ui.notify("Usage: /copilot-credits [setup]", "warning");
				return;
			}
			const live = liveness("github-copilot", true);
			await refresh(ctx, "github-copilot", { force: true, explicit: true });
			if (!live()) return;
			const { problem, value } = entryFor("github-copilot");
			if (problem === "config missing or invalid") configNotice(ctx.ui);
			else quotaNotice(ctx.ui, value?.quota, problem);
		},
	});
}
