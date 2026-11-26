# Plan: merge pi-copilot-credit and add Cursor

Status: accepted
Updated: 2026-11-25

Approved 2026-11-25 in conversation: design and D1–D7 (all defaults), D8–D13, round 2
resolutions.

## Goal

One package, `@rifle-donkey/pi-usage-bar`, shows subscription usage in the input box's top
border for `anthropic`, `openai-codex`, `github-copilot` and `cursor`. It replaces
`@rifle-donkey/pi-copilot-credit`.

## Level

Reinforced: T2 (sends Cursor and GitHub credentials to provider endpoints, keeps the
Copilot account check) and T8 (shared per-provider cache and `generation` invalidation).

## Approved user decisions (2026-11-25, conversation)

- Extend `pi-usage-bar`; keep its package name and history.
- Display: top border, only for the active model's provider.
- Copilot shows only while a `github-copilot/*` model is active.
- Cursor: two pools from the "Included in subscription" section of the spending page:
  "Cursor Models" and "Other Models".

## Facts and evidence

- Pi exposes only the Copilot session token through `modelRegistry`; the GitHub OAuth token
  stays in `refresh`. `copilot_internal/user` needs the GitHub token, so Copilot keeps using
  `gh` with the configured account check. (pi-ai 1.6.1 `auth/oauth/github-copilot.js`.)
- `pi-cursor-provider` registers provider `cursor`; an account login is OAuth and
  `toAuth` returns the access token as `apiKey`. An API key login is not OAuth.
- Cursor usage (undocumented, community sources PaceBar docs and oh-my-pi
  `usage/cursor.ts`): `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
  body `{}`, headers `Authorization: Bearer`, `Content-Type: application/json`,
  `Connect-Protocol-Version: 1`. Response `billingCycleEnd` (unix ms as string),
  `planUsage.autoPercentUsed` ("Cursor Models"), `planUsage.apiPercentUsed`
  ("Other Models"). Same host the provider already calls.
- Unverified: that the two fields match the spending page for this account. New "X
  Subscription" plans have one weekly pool only.

## Design

Files:

- `src/usage.ts`: add `parseCursorUsage(data)` and `parseCopilotQuota(data)` (moved
  `parseQuota`, output as a `UsageSnapshot`). Pure, no Pi imports.
- `src/copilot.ts` (new): config location, `readConfig`, `publish`, `askLogin`, the `gh`
  calls and the two account checks, moved from `copilot-credits.ts` without behavior changes
  except those listed below.
- `extensions/usage-bar.ts`: provider table; Cursor fetch; Copilot through `src/copilot.ts`;
  registers `/copilot-credits`.

Behavior:

| Provider | Shown when | Source | Segments |
|---|---|---|---|
| anthropic, openai-codex | unchanged | unchanged | unchanged |
| cursor | model `cursor/*` and `isUsingOAuth` | `GetCurrentPeriodUsage` with the registry token | `cursor 12% (12d 3h) · other 46% (12d 3h)`; either pool may be absent, not both |
| github-copilot | model `github-copilot/*` (any auth) | `gh`, account checked before and after | `enterprise · premium 1% (6d 3h)` (used share; reset at 00:00 UTC of `reset`) |

- Copilot states without a value show one muted segment: `copilot setup needed`,
  `account mismatch`, `usage unavailable`. A failed refresh keeps the old value with `stale`;
  a mismatch or account change clears it.
- Copilot first-start prompt runs the first time a `github-copilot` model is active and the
  config is `missing`, once per instance. Never at startup with another provider.
- `/copilot-credits` and `/copilot-credits setup` keep their behavior. The status-bar entry
  `copilot-credits` is removed.
- Refresh cadence for all providers: turn end and model switch (at most once per 60 s), and
  every 5 minutes while idle. Copilot changes from every 2 minutes.
- Config file `.config/copilot-credits.json` and its rules are unchanged, so existing
  installs keep their account.

Tooling: add `tsconfig.json`, `src/node-types.d.ts` only if needed, and `npm run check`
(typecheck plus tests). Port the Copilot tests to `tests/`.

## Acceptance criteria

1. Anthropic and Codex output is byte-identical to 0.1.0 for the same responses.
2. With a `cursor/*` OAuth model, the border shows both pools and the reset countdown from
   `billingCycleEnd`; with an API key login nothing is shown.
3. A Cursor response with neither percent field, a non-finite value or a non-2xx status
   shows `usage unavailable` (or `stale` with an old value); the token is sent only to
   `api2.cursor.sh` and never logged.
4. With a `github-copilot/*` model and a matching `gh` account, the border shows the used
   share; mismatch clears the value; all Copilot config, prompt and publish guarantees in
   pi-copilot-credit's AGENTS.md hold (ported tests pass).
5. With any other model, no `gh` call and no Copilot prompt happen.
6. `npm run check`, `npm pack --dry-run` (exact file list) and the strict docs checker pass.

## Decisions (approved 2026-11-25, all defaults)

| # | Decision | Default |
|---|---|---|
| D1 | Copilot figure | Used share, like the other providers (was remaining) |
| D2 | Cursor labels | `cursor`, `other` |
| D3 | Copilot prompt timing | First time a Copilot model is active |
| D4 | Copilot cadence | Shared 5-minute idle refresh (was 2 minutes) |
| D5 | Cursor verification | Ship with a KNOWN_ISSUES C entry; you compare with the spending page after install |
| D6 | Version | 0.2.0; changelog says: uninstall `pi-copilot-credit` first, or `/copilot-credits` is registered twice |
| D7 | Old repo and npm package | Out of scope; deprecate or archive later only with your separate authorization |

## Design review round 1 resolutions (D8–D13 approved 2026-11-25, all defaults, in conversation)

Review `copilot-cursor-review` (2026-11-25) raised six blocking and two non-blocking findings.
These changes answer them. They replace any conflicting text above.

### Decisions to approve (D8–D13)

| # | Decision | Default |
|---|---|---|
| D8 | `/copilot-credits` with a non-Copilot model | Explicit commands keep their old behavior with any model (refresh, details, setup prompt). AC5 covers only automatic work. The border still shows Copilot only with a Copilot model. |
| D9 | Cursor credential change | Refresh sends only when `getProviderAuth("cursor")` returns `source: "OAuth"` and a non-empty `apiKey`; otherwise the Cursor value is cleared and nothing is shown. A token different from the one behind the cached value clears that value before the request. |
| D10 | Copilot second account check | Runs after every attempted quota call, also when it failed. A mismatch from either check wins over any other failure. Behavior change from the source. |
| D11 | `stale` at narrow width (Cursor, Copilot) | `stale` is kept; pools are dropped from the end first; if no pool fits, only `stale` shows. Anthropic and Codex unchanged. |
| D12 | Test harness | Tests load the real extension through a test-only resolve hook that stubs the two Pi packages. No test-only exports, no runtime change. |
| D13 | Typecheck scope | `tsc --noEmit` (global `tsc`, as in pi-copilot-credit) covers `src/` only; `extensions/usage-bar.ts` is covered by tests, because Pi types are not installed in a clean checkout. |

Adopted non-blocking findings: the Cursor request sends exactly the headers listed under
Facts; the D5 KNOWN_ISSUES entry also covers endpoint acceptance. The D6 upgrade note tells
users to remove the old npm package or the copied `extensions/copilot-credits/` directory,
keep `.config/copilot-credits.json`, and run `/reload`.

### State and invalidation (T8)

- One cache entry per provider: value (snapshot, plus Copilot `quota` details), `failed`,
  `fetchedAt`, `inFlight` with the generation it started in, Cursor token digest
  (SHA-256, memory only).
- `generation` increments on `session_start`, `session_shutdown`, any change of the active
  provider (including to none), and a successful Copilot setup.
- A refresh is live while `generation` equals its start value and the session is not shut
  down. It checks liveness before every later external step (auth lookup, `fetch`, each `gh`
  call, the automatic prompt) and before writing the cache, `fetchedAt`, or rendering.
  Discarded work writes nothing, so it starts no cooldown.
- A caller joins `inFlight` only when it started in the current generation; otherwise it
  starts a new refresh. After a provider switch and back, the next trigger therefore gets a
  fresh attempt.
- Copilot mismatch, account change by setup, and a Cursor token change clear the value and
  its details together. Anthropic and Codex account changes are out of scope (unchanged).

### Copilot sequence

config → pre-check → quota call → post-check (if live, after any attempted quota call) →
parse. `gh` missing, non-zero exit, timeout (10 s) or unparseable output is a failure, not a
mismatch. Automatic `gh` calls and the first-start prompt run only while the active provider
is `github-copilot`; explicit commands follow D8. The value and `quota` details are stored
and cleared together; the command reports them as before, including the last-success time.

### Cursor request

`fetch("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
{ method: "POST", headers: { Authorization: "Bearer <token>", "Content-Type":
"application/json", "Connect-Protocol-Version": "1" }, body: "{}", redirect: "error",
signal })`. One 10 s deadline covers the request and the body read. Non-2xx, network error,
timeout or a parse error is a failure.

### Interfaces for QA

- `parseCursorUsage(data: unknown): UsageSnapshot` in `src/usage.ts`. Pools:
  `planUsage.autoPercentUsed` → window `cursor`, `planUsage.apiPercentUsed` → window
  `other`. Absent or `null` → pool omitted. A finite number ≥ 0 → used percent (values over
  100 kept). Any other value (string, negative, NaN, object) → throw. Both omitted → throw.
  `billingCycleEnd`: a decimal-digit string or finite number of unix ms → `resetsAt` for
  both pools; absent or invalid → pools without countdown. No plan segment.
- `parseCopilotQuota(data: unknown, nowMs: number): { snapshot: UsageSnapshot; quota:
  Quota }` in `src/usage.ts`. Validation exactly as the source `parseQuota`. Snapshot: plan
  `enterprise`, one window `premium`, `usedPercent = 100 - percent_remaining`, `resetsAt =
  Date.parse(reset + "T00:00:00Z")`. `quota` as the source, with `fetchedAt = nowMs`.
- Formatting reuses `buildSegments` (rounding with `Math.round`). Muted single-segment
  states: Copilot config missing or invalid → `copilot setup needed`; mismatch → `account
  mismatch`; failure without value → `usage unavailable` (both providers).
- Harness: `node --test --import ./tests/pi-stubs.mjs tests/`. The QA-owned stub maps
  `@earendil-works/pi-coding-agent` to `{ CustomEditor }` (class whose `renderTopBorder(width,
  hidden)` returns `"─".repeat(width)`) and `@earendil-works/pi-tui` to `{ visibleWidth }`
  (ANSI stripped, one column per code point).
- Factory: `import usageBar from "../extensions/usage-bar.ts"`; `usageBar(pi)` with fake
  `pi = { on(event, handler), registerCommand(name, { description, handler }), exec(cmd,
  args, opts) }`. Events: `session_start`, `session_shutdown`, `model_select` (`{ model }`),
  `agent_start`, `agent_end`, `resources_discover`.
- Fake `ctx`: `hasUI`, `model` (`{ provider, id }`), `modelRegistry.getProviderAuth(provider)`
  → `{ auth: { apiKey }, source } | undefined`, `modelRegistry.isUsingOAuth(model)`,
  `ui.theme.fg(tone, text)`, `ui.getEditorComponent()`, `ui.setEditorComponent(factory)`,
  `ui.notify(message, level)`, `ui.input(title, placeholder, { signal, timeout })` as in the
  ported tests.
- Observation: call the captured editor factory with a fake `tui = { requestRender }`, then
  `editor.renderTopBorder(width, 0)`. Each refresh that completes while live calls
  `requestRender` once after the cache write; discarded work never calls it. Network through
  a replaced `globalThis.fetch`; `gh` through `pi.exec`; time through `node:test` mock timers
  (`Date`, `setInterval`, `setTimeout`).
- Cadence (unchanged mechanism): a 60 s tick refreshes the active provider when its last
  completed fetch is about 5 minutes old or a known reset has passed; `model_select` and
  `agent_end` refresh at most once per 60 s; `session_start` and explicit commands force a
  refresh. No `isIdle` gate.
- Byte identity (AC1): same responses, fixed `Date.now`, width, and identity theme give the
  same border string as `b4d1538`, including `stale` and `usage unavailable`.
- Package: the archive lists exactly the six files in AGENTS.md plus `src/copilot.ts`.

## Design review round 2 resolutions (approved 2026-11-25 in conversation; no further design round)

Delta review `copilot-cursor-review-2` resolved r1-3, r1-5 and r1-6 and left three blocking
gaps (B1–B3). These rules close them and replace conflicting text above.

- **B1 (Cursor login change, same model).** Pi emits no event when a login changes. The
  Cursor value renders only while `isUsingOAuth(model)` is true at render time. On
  activation of `cursor` and on every 60 s tick while it is active, the extension resolves
  `getProviderAuth("cursor")` (local, no network) and compares the token digest. It hides
  the cached value from activation until that check passes. If the source is not OAuth, it
  clears the value. If the digest differs, it clears the value and forces a refresh outside
  the cooldown. Detection delay for a login change without a model switch: at most one tick
  (60 s).
- **B2 (explicit command and model switch).** Two liveness rules. Automatic work is
  live while neither `generation` nor the Copilot account generation has changed. Explicit
  `/copilot-credits` work is live until shutdown or a Copilot account change only, so a
  model switch does not cancel it. A command never joins automatic in-flight work from an
  older `generation`; it starts its own. Its result may update the Copilot cache while
  another provider is active.
- **B3 (reactivation after discarded work).** When invalidation discards a provider's
  in-flight refresh, its entry is marked `discarded`. The next activation of that provider
  ignores the 60 s cooldown once and clears the mark, also when the discarded promise has
  already settled.
- **Token change while a request is pending** (coordinator clarification of B1/D9, from QA's
  question). A detected digest change discards the old token's pending request like any
  other invalidation (it writes nothing) and starts the request with the new token at once.
- **QA seams.** `getProviderAuth` returns a promise the test controls. The Cursor deadline
  uses `setTimeout` with an `AbortController` (not `AbortSignal.timeout`), so mock timers
  drive it. The `gh` timeout is the `timeout` option passed to `pi.exec`. The ported
  `O_NOFOLLOW` test intercepts the import in `src/copilot.ts`. The 60 s tick never calls
  `gh` when the config is missing or invalid (ports the old "no timer" assertions).

## Implementation review follow-ups (approved 2026-11-25 in conversation)

- **impl-N1.** The Cursor account check compares a SHA-256 digest of the access token's
  JWT `sub` claim (payload decoded, not verified, as `pi-cursor-provider` does). If the
  claim is missing or the token is not a JWT, it compares the token digest as before. A
  token refresh for the same account keeps the value. If `getProviderAuth` throws, the
  value is hidden but not cleared, and no request is sent. This changes B1/D9.
- **impl-N2.** A reset counts as elapsed only if it passed after the last completed fetch.
- **impl-N3.** A successful Copilot setup advances only the Copilot account generation,
  not the shared `generation`. This changes "State and invalidation".
- **impl-N4.** Add the missing tests: B3 for Anthropic, Codex and Copilot; a Copilot refresh
  after a passed reset; a setup with the same account discards Copilot automatic work;
  shutdown before the config read completes.
- **impl-N5.** Changelog notes D3; README notes the Cursor token refresh behavior.
- **impl-N6.** The coordinator reproduces the LSP warnings and triages them. Result
  (2026-11-25): 16 warnings, all in `extensions/usage-bar.ts`, all from missing Pi and Node
  types outside the D13 typecheck scope (unresolved modules, implicit `any`, DOM timer
  type); one was a transient mid-edit signature change. No defect; closed.

## Non-goals

On-demand spend, credit grants, team pools, Cursor API-key accounts, other GitHub hosts,
publishing.

## Workflow

QA writes acceptance tests from this plan; developer implements; coordinator runs offline
checks; cross-family reviewer reviews design before coding (one round, at most one delta) and
the implementation after. Run budget: 8.

## Task state

```yaml
task-state:
  goal: merge pi-copilot-credit into pi-usage-bar and add Cursor two-pool usage
  level: reinforced
  profile: private
  models: /Users/bin.cui/.pi/agent/dev-kit/models.json (user)
  base: main@b4d1538 (+ docs/plans/2026-11-25-copilot-cursor.md untracked)
  approvals: [design + D1-D7 defaults, user in conversation 2026-11-25; D8-D13 defaults, user in conversation 2026-11-25; r2 B1-B3 resolutions and skip further design round, user in conversation 2026-11-25; fix impl-N2/N5 then commit, then fix impl-N1/N3/N4/N6 with recommended options, user in conversation 2026-11-25]
  grants: [none]
  owners: {tests/ (new QA files): qa, tests/usage.test.ts src/ extensions/ package.json tsconfig.json README.md CHANGELOG.md KNOWN_ISSUES.md AGENTS.md: developer, plan: coordinator}
  children: {copilot-cursor-review: reviewer design r1, openai-codex/gpt-6.2-sol high (upgrade: reinforced review), done, copilot-cursor-review-2: reviewer design r2 delta, openai-codex/gpt-6.2-sol high, done, copilot-cursor-test: qa, openai-codex/gpt-6.2-sol medium (upgrade: reinforced), done, copilot-cursor-build: developer, openai-codex/gpt-6.2-sol high (upgrade: high-risk), done, copilot-cursor-review-3: reviewer impl (reviewer-alternate), anthropic/claude-opus-5-5 high, done, copilot-cursor-build-2: developer N2/N5, openai-codex/gpt-6.2-sol high, done}
  runs: 6/8
  handoff: done
  evidence: [QA suite pre-implementation (node --test --import ./tests/pi-stubs.mjs tests/): b4d1538+QA tests, 24 pass / 89 fail as expected, coordinator re-ran exit 1; npm run check: developer tree, 119 pass, exit 0 (coordinator); npm pack --dry-run: 7 files exact (coordinator); git diff --check exit 0; QA test files unmodified since QA handoff (mtimes); strict docs checker 0/0 (coordinator); implementation review: 0 blocking, 6 non-blocking, AC1 oracle verified against b4d1538; after N2/N5: npm run check 122 pass, pack 7 files, docs 0/0, diff --check ok (coordinator)]
  findings: [r1-1..r1-6: blocking, resolved in plan (D8-D13 approved), r1-3/5/6 resolved, r1-1/2/4 partial -> r2 B1-B3: blocking, fixed in plan (approved), verified by QA tests and implementation review, closed, cycles 1/3; impl-N2/N5: fixed (unreviewed until run 8), impl-N6: closed, impl-N1/N3/N4: approved for fix; r1-7, r1-8: non-blocking, adopted]
  next: developer fixes impl-N1/N3/N4 (copilot-cursor-build-3); then cross-family review of impl-N1..N4 (run 8)
```

Source for the Copilot code and tests to port: `~/Workplace/Github/private/pi-copilot-credit`
at `1c21ff7` plus its uncommitted working tree (read-only; do not modify that repository).
