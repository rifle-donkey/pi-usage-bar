/**
 * usage-bar: shows subscription usage in the input box's top border (Pi only; OMP not supported).
 *
 *   ──────────── plus · 5h 35% (3h 41m) · 7d 9% (2d 12h) · ✦ 2 exp 18d 22h ─
 *
 * Shown only while the active model is `anthropic/*` or `openai-codex/*` signed in with OAuth
 * (a subscription). Data comes from read-only, undocumented endpoints:
 *   - anthropic:    GET https://api.anthropic.com/api/oauth/usage
 *   - openai-codex: GET https://chatgpt.com/backend-api/wham/usage
 *                   GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits
 * Tokens come from Pi's model registry (refreshed by Pi). Responses and tokens are never logged.
 *
 * The extension wraps whatever editor factory is configured (for example editor-selection) and
 * overrides only its top border; the scroll indicator still wins when the editor is scrolled.
 */
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildSegments,
	chatgptAccountId,
	fitSegments,
	hasElapsedReset,
	mergeResets,
	parseAnthropicUsage,
	parseCodexResetCredits,
	parseCodexUsage,
	type Segment,
	type UsageSnapshot,
} from "../src/usage.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;
type Model = NonNullable<ExtensionContext["model"]>;
type Provider = "anthropic" | "openai-codex";

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

interface CacheEntry {
	snapshot?: UsageSnapshot;
	fetchedAt: number;
	failed: boolean;
	inFlight?: Promise<void>;
}

/** Narrow view of the pi-tui Editor internals this extension relies on. */
interface BorderedEditor {
	renderTopBorder?: (width: number, hiddenLineCount: number) => string;
	borderColor?: (text: string) => string;
}

function supportedProvider(ctx: ExtensionContext, model: Model | undefined): Provider | undefined {
	if (!model) return undefined;
	if (model.provider !== "anthropic" && model.provider !== "openai-codex") return undefined;
	try {
		return ctx.modelRegistry.isUsingOAuth(model) ? model.provider : undefined;
	} catch {
		return undefined;
	}
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
	const response = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	return response.json();
}

async function fetchAnthropic(token: string): Promise<UsageSnapshot> {
	return parseAnthropicUsage(
		await getJson(ANTHROPIC_USAGE_URL, {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
			Accept: "application/json",
		}),
	);
}

async function fetchCodex(token: string): Promise<UsageSnapshot> {
	const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
	const accountId = chatgptAccountId(token);
	if (accountId) headers["ChatGPT-Account-Id"] = accountId;
	const creditsRequest = getJson(`${CODEX_BASE}/wham/rate-limit-reset-credits`, headers);
	creditsRequest.catch(() => {}); // Optional; avoid an unhandled rejection if usage fails first.
	const usage = await getJson(`${CODEX_BASE}/wham/usage`, headers);
	// Anchor relative reset times to when the usage response arrived, not to the credit request.
	const snapshot = parseCodexUsage(usage, Date.now());
	let list;
	try {
		list = parseCodexResetCredits(await creditsRequest);
	} catch {
		// The credit list is optional; keep the count from the usage response.
	}
	return { ...snapshot, resets: mergeResets(snapshot.resets, list) };
}

export default function usageStatus(pi: ExtensionAPI): void {
	const cache = new Map<Provider, CacheEntry>();
	let latestCtx: ExtensionContext | undefined;
	let activeProvider: Provider | undefined;
	let installedFactory: EditorFactory | undefined;
	let requestRender: (() => void) | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let installCheck: ReturnType<typeof setTimeout> | undefined;
	let generation = 0;

	function refresh(ctx: ExtensionContext, provider: Provider, force = false): Promise<void> {
		const entry = cache.get(provider) ?? { fetchedAt: 0, failed: false };
		cache.set(provider, entry);
		if (entry.inFlight) return entry.inFlight;
		if (!force && Date.now() - entry.fetchedAt < MIN_REFRESH_MS) return Promise.resolve();
		const startedIn = generation;
		entry.inFlight = (async () => {
			try {
				const auth = await ctx.modelRegistry.getProviderAuth(provider);
				const token = auth?.auth.apiKey;
				if (!token) throw new Error("No credential");
				const snapshot = provider === "anthropic" ? await fetchAnthropic(token) : await fetchCodex(token);
				if (startedIn !== generation) return;
				entry.snapshot = snapshot;
				entry.failed = false;
			} catch {
				if (startedIn !== generation) return;
				entry.failed = true;
			} finally {
				entry.fetchedAt = Date.now();
				entry.inFlight = undefined;
			}
			requestRender?.();
		})();
		return entry.inFlight;
	}

	function label(maxWidth: number): string | undefined {
		const ctx = latestCtx;
		if (!ctx || !activeProvider) return undefined;
		const theme = ctx.ui.theme;
		const entry = cache.get(activeProvider);
		const now = Date.now();
		let segments: Segment[] | undefined;
		if (entry?.snapshot) {
			const { plan, items } = buildSegments(entry.snapshot, now);
			if (entry.failed) items.push({ text: "stale", tone: "muted" });
			segments = fitSegments(plan, items, maxWidth - 2, visibleWidth, SEPARATOR);
		} else if (entry?.failed) {
			segments = fitSegments(undefined, [{ text: "usage unavailable", tone: "muted" }], maxWidth - 2, visibleWidth);
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

	function update(ctx: ExtensionContext, model: Model | undefined, force = false): void {
		latestCtx = ctx;
		activeProvider = supportedProvider(ctx, model);
		requestRender?.();
		if (activeProvider) void refresh(ctx, activeProvider, force).catch(() => {});
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
		if (!ctx.hasUI) return;
		generation++;
		installEditor(ctx);
		if (installCheck) clearTimeout(installCheck);
		installCheck = setTimeout(() => {
			installCheck = undefined;
			if (latestCtx === ctx) installEditor(ctx);
		}, 0);
		update(ctx, ctx.model, true);
		if (timer) clearInterval(timer);
		timer = setInterval(() => {
			const current = latestCtx;
			ensureEditor();
			if (!current || !activeProvider) return;
			const entry = cache.get(activeProvider);
			const stale = !entry || Date.now() - entry.fetchedAt >= PERIODIC_REFRESH_MS - TICK_SLACK_MS;
			const elapsed = entry?.snapshot ? hasElapsedReset(entry.snapshot, Date.now()) : false;
			if (stale || elapsed) void refresh(current, activeProvider, true).catch(() => {});
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
		if (!ctx.hasUI) return;
		ensureEditor();
		update(ctx, event.model);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!ctx.hasUI) return;
		update(ctx, ctx.model);
	});

	pi.on("session_shutdown", () => {
		generation++;
		if (timer) clearInterval(timer);
		if (installCheck) clearTimeout(installCheck);
		timer = undefined;
		installCheck = undefined;
		latestCtx = undefined;
		activeProvider = undefined;
		requestRender = undefined;
	});
}
