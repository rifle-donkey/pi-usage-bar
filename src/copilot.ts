// GitHub Copilot quota and account setup. The host owns refresh scheduling and cached values.
// Never expose a config payload, login, command error, token or raw response.
import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseCopilotQuota, type Quota } from "./usage.ts";

const TIMEOUT_MS = 10_000;
const PROMPT_MS = 60_000;
const MAX_PROMPTS = 3;
const MAX_CONFIG_BYTES = 4096;
const CONFIG_PROBLEM = "config missing or invalid";
const PROMPT_TITLE = "GitHub login for the Copilot quota (the account that holds the license)";
const RETRY_TITLE = "Not a valid GitHub login. GitHub login for the Copilot quota";
// 1-39 ASCII alphanumerics; hyphens only between alphanumerics.
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const QUOTA_FILTER =
	"{plan: .copilot_plan, reset: .quota_reset_date, quota: .quota_snapshots.premium_interactions}";

interface ExecResult {
	code: number;
	stdout: string;
	killed?: boolean;
	truncated?: boolean;
}

type Exec = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<ExecResult>;

interface CopilotUI {
	notify(message: string, level?: "info" | "warning" | "error"): void;
	input(title: string, placeholder?: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<string | undefined>;
}

// `missing` means no directory entry at the path; anything else that is not a valid file is `invalid`.
type Config = { status: "ok"; account: string } | { status: "missing" } | { status: "invalid" };

const MISSING: Config = { status: "missing" };
const INVALID: Config = { status: "invalid" };

export type CopilotProblem = "account mismatch" | "refresh failed" | typeof CONFIG_PROBLEM;

class AccountMismatchError extends Error {}

function errorCode(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

// Without this flag the extension cannot open the config safely, so it fails closed.
function noFollow(): number | undefined {
	const flag = constants.O_NOFOLLOW;
	return typeof flag === "number" && flag > 0 ? flag : undefined;
}

const UNSUPPORTED_DIR = "PI_CODING_AGENT_DIR is not a supported path";
const UNSUPPORTED_PLATFORM = "this platform cannot open files without following symbolic links";

// Resolve only supported agent-directory paths. A reason never contains the override value.
function configLocation(): { path: string } | { reason: string } {
	if (noFollow() === undefined) return { reason: UNSUPPORTED_PLATFORM };
	const override = process.env.PI_CODING_AGENT_DIR;
	let dir = join(homedir(), ".pi", "agent");
	if (override) {
		if (override === "~") dir = homedir();
		else if (override.startsWith("~/")) dir = join(homedir(), override.slice(2));
		else if (override.startsWith("~") || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(override)) {
			return { reason: UNSUPPORTED_DIR };
		} else dir = override;
	}
	return { path: join(dir, ".config", "copilot-credits.json") };
}

// lstat rejects an existing link; O_NOFOLLOW closes the race between lstat and open.
async function readConfig(path: string): Promise<Config> {
	const flag = noFollow();
	if (flag === undefined) return INVALID;
	try {
		if (!(await lstat(path)).isFile()) return INVALID;
	} catch (error) {
		return errorCode(error) === "ENOENT" ? MISSING : INVALID;
	}
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | flag);
		const info = await handle.stat();
		if (!info.isFile() || info.size > MAX_CONFIG_BYTES) return INVALID;
		const buffer = new Uint8Array(MAX_CONFIG_BYTES + 1);
		let length = 0;
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > MAX_CONFIG_BYTES) return INVALID;
		const data: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)));
		if (typeof data !== "object" || data === null || Array.isArray(data)) return INVALID;
		if (!Object.hasOwn(data, "account")) return INVALID;
		const account = (data as { account?: unknown }).account;
		return typeof account === "string" && LOGIN_PATTERN.test(account) ? { status: "ok", account } : INVALID;
	} catch {
		return INVALID;
	} finally {
		await handle?.close().catch(() => {});
	}
}

// Setup may replace a regular file or an absent path, never a link or directory.
async function replaceable(path: string): Promise<boolean> {
	try {
		return (await lstat(path)).isFile();
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
}

type Published = "written" | "exists" | "failed" | "stopped";

// Publish a complete, exclusive 0600 temporary file in one step. Neither rename nor link
// follows a symlink at the final path. Existing directory permissions are not changed.
async function publish(path: string, login: string, replace: boolean, live: () => boolean): Promise<Published> {
	if (noFollow() === undefined) return "failed";
	const dir = dirname(path);
	const temp = join(dir, `.copilot-credits.${crypto.randomUUID()}.tmp`);
	let created = false;
	try {
		await mkdir(dir, { recursive: true, mode: 0o700 });
		if (!live()) return "stopped";
		const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
		created = true;
		try {
			if (!live()) return "stopped";
			await handle.writeFile(`${JSON.stringify({ account: login })}\n`);
			if (!live()) return "stopped";
			await handle.chmod(0o600);
			if (!live()) return "stopped";
			await handle.sync();
		} finally {
			await handle.close();
		}
		if (!live()) return "stopped";
		if (replace) {
			if (!(await replaceable(path)) || !live()) return "stopped";
			await rename(temp, path);
			created = false;
			return "written";
		}
		try {
			await link(temp, path);
		} catch (error) {
			if (errorCode(error) === "EEXIST") return "exists";
			throw error;
		}
		return "written";
	} catch {
		return "failed";
	} finally {
		if (created) await unlink(temp).catch(() => {});
	}
}

// Cancel, empty input, timeout or abort returns undefined; repeated invalid input returns null.
async function askLogin(ui: CopilotUI, signal: AbortSignal, live: () => boolean): Promise<string | null | undefined> {
	for (let attempt = 0; attempt < MAX_PROMPTS && live(); attempt++) {
		let answer: unknown;
		try {
			answer = await ui.input(attempt === 0 ? PROMPT_TITLE : RETRY_TITLE, "github-login", { signal, timeout: PROMPT_MS });
		} catch {
			return undefined;
		}
		if (!live() || answer == null) return undefined;
		if (typeof answer !== "string") continue;
		const login = answer.trim();
		if (!login) return undefined;
		if (LOGIN_PATTERN.test(login)) return login;
	}
	return null;
}

export function configNotice(ui: CopilotUI): void {
	const location = configLocation();
	ui.notify(
		"path" in location
			? `Copilot quota unavailable: ${CONFIG_PROBLEM}. Expected a config file at ${location.path}; ` +
				"run /copilot-credits setup or see the README."
			: `Copilot quota unavailable: ${CONFIG_PROBLEM}. ${location.reason}; see the README.`,
		"warning",
	);
}

export function quotaNotice(ui: CopilotUI, quota: Quota | undefined, problem?: CopilotProblem): void {
	if (!quota) {
		ui.notify(`Copilot quota unavailable: ${problem ?? "not refreshed"}. Check the active gh account.`, "warning");
		return;
	}
	const number = new Intl.NumberFormat().format;
	ui.notify(
		[
			`Copilot quota${problem ? " (stale: refresh failed)" : ""}`,
			`Remaining: ${number(quota.remaining)} / ${number(quota.entitlement)} (${quota.percent}%)`,
			`Used: ${number(Math.max(0, quota.entitlement - quota.remaining))}`,
			`Reset: ${quota.reset}`,
			`Last updated: ${new Date(quota.fetchedAt).toLocaleString()}`,
			"Source: undocumented GitHub Copilot interface; verify against GitHub settings.",
			"Other enterprise limits may block usage sooner.",
		].join("\n"),
		problem ? "warning" : "info",
	);
}

export function createCopilot(exec: Exec) {
	// Share one load across refreshes and commands; replace it after config publication.
	let loading: Promise<Config> | undefined;
	let prompting: { controller: AbortController; explicit: boolean } | undefined;
	let prompted = false;

	function loadConfig(): Promise<Config> {
		if (!loading) {
			const location = configLocation();
			loading = "path" in location ? readConfig(location.path) : Promise.resolve(INVALID);
		}
		return loading;
	}

	async function gh(endpoint: string, filter: string): Promise<string> {
		const result = await exec("gh", ["api", "--hostname", "github.com", endpoint, "--jq", filter], {
			timeout: TIMEOUT_MS, maxBuffer: 16_384,
		});
		if (result.code !== 0 || result.killed || result.truncated) throw new Error("GitHub CLI request failed");
		return result.stdout.trim();
	}

	async function checkAccount(expected: string): Promise<void> {
		const login = await gh("user", ".login");
		if (!LOGIN_PATTERN.test(login)) throw new Error("Unrecognized GitHub login response");
		if (login.toLowerCase() !== expected.toLowerCase()) throw new AccountMismatchError();
	}

	async function query(live: () => boolean): Promise<ReturnType<typeof parseCopilotQuota> | { problem: CopilotProblem } | undefined> {
		if (!live()) return;
		const config = await loadConfig();
		if (!live()) return;
		if (config.status !== "ok") return { problem: CONFIG_PROBLEM };
		try {
			await checkAccount(config.account);
			if (!live()) return;
			let raw: string;
			try {
				raw = await gh("copilot_internal/user", QUOTA_FILTER);
			} finally {
				// Recheck even on quota failure. A mismatch takes precedence over that failure.
				if (live()) await checkAccount(config.account);
			}
			if (!live()) return;
			return parseCopilotQuota(JSON.parse(raw), Date.now());
		} catch (error) {
			if (live()) return { problem: error instanceof AccountMismatchError ? "account mismatch" : "refresh failed" };
		}
	}

	function abortPrompt(all: boolean): void {
		if (prompting && (all || !prompting.explicit)) {
			prompting.controller.abort();
			prompting = undefined;
		}
	}

	// The host invalidates old work on adoption. The callback reports whether the new work
	// is still live after the refresh, since setup itself can advance the generation.
	async function setup(
		ui: CopilotUI, replace: boolean, stillLive: () => boolean,
		adopt: (valid: boolean, changed: boolean) => Promise<boolean>,
	): Promise<void> {
		if (!stillLive()) return;
		const before = await loadConfig();
		if (!stillLive() || (!replace && (prompted || before.status !== "missing"))) return;
		if (prompting) {
			if (replace) ui.notify("Copilot quota setup is already waiting for input.", "info");
			return;
		}
		const location = configLocation();
		if (!("path" in location)) {
			if (replace) ui.notify(`Copilot quota setup unavailable: ${location.reason}; see the README.`, "warning");
			return;
		}
		const path = location.path;
		const controller = new AbortController();
		prompting = { controller, explicit: replace };
		const live = () => stillLive() && !controller.signal.aborted;
		const refuse = () => ui.notify(`Copilot quota setup refused: ${path} is not a regular file. Remove it, then retry.`, "warning");
		try {
			if (replace && !(await replaceable(path))) {
				if (live()) refuse();
				return;
			}
			if (!live()) return;
			if (!replace) prompted = true;
			const login = await askLogin(ui, controller.signal, live);
			if (!live()) return;
			if (login === null) ui.notify("Copilot quota setup stopped: not a valid GitHub login.", "warning");
			if (!login) return;
			if (replace && !(await replaceable(path))) {
				if (live()) refuse();
				return;
			}
			if (!live()) return;
			const result = await publish(path, login, replace, live);
			if (!live() || result === "stopped") {
				if (result === "stopped" && live()) refuse();
				return;
			}
			if (result === "failed") {
				ui.notify(`Copilot quota setup failed: could not write ${path}.`, "warning");
				return;
			}
			// A competing first-start publication wins; adopt the file at the final path.
			const config = await readConfig(path);
			if (!live()) return;
			loading = Promise.resolve(config);
			const valid = config.status === "ok";
			const changed = before.status === "ok" && valid
				? before.account.toLowerCase() !== config.account.toLowerCase()
				: before.status === "ok" || valid;
			if (!(await adopt(valid, changed)) || controller.signal.aborted) return;
			if (!valid) {
				configNotice(ui);
				return;
			}
			ui.notify(
				result === "exists"
					? `Copilot quota uses the config file another session created at ${path}.`
					: `Copilot quota account saved in ${path}.`,
				"info",
			);
		} finally {
			if (prompting?.controller === controller) prompting = undefined;
		}
	}

	return { abortPrompt, loadConfig, query, setup };
}
