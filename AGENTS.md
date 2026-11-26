# AGENTS.md

Model profile: private
GitHub account: rifle-donkey

`@rifle-donkey/pi-usage-bar` shows usage for the active model in Pi's input border. Supported providers, setup and commands are in [README.md](README.md).

## Layout

- `extensions/`: Pi wiring, editor wrapper and per-provider refresh state.
- `src/`: pure parsing and formatting, Copilot quota and config I/O, and type-check-only Node declarations.
- `tests/`: offline tests with fake Pi packages, a temporary home, fake `gh` and stubbed HTTP.

## Commands

- Run `npm run check`: global `tsc` checks `src/` only; `npm test` tests the extension through Pi stubs. Use Node 22.18 or newer. Tests make no network calls.
- Docs check: `python3 "${PI_PROJECT_DOCS_CHECKER:-$HOME/.pi/agent/npm/node_modules/pi-project-docs/skills/project-docs/scripts/check_docs.py}" . --strict`
- Package check: `npm pack --dry-run --ignore-scripts --json` must list exactly `extensions/usage-bar.ts`, `src/usage.ts`, `src/copilot.ts`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.

## What the code doesn't make obvious

- The usage endpoints are undocumented. Validate fields in `src/usage.ts`. Never log or display config content, tokens, logins, raw responses or command errors.
- OAuth tokens come from Pi's model registry; never read `auth.json` directly. Send Cursor only a verified OAuth token and refuse redirects. Keep only a SHA-256 digest of the JWT subject (or whole token as fallback) in the usage cache. Never use the subject to authorize a request.
- Invalidate automatic work on session or provider changes. Copilot setup invalidates only Copilot work, including explicit requests. Explicit Copilot work survives provider switches, not shutdown or account changes. Invalidated work never moves the cooldown or renders.
- The expected Copilot account comes only from `.config/copilot-credits.json` or the user's setup answer. Share one config load per instance. `configLocation` is the only resolver; fail closed on unsupported paths and without `O_NOFOLLOW`.
- Reads distinguish missing from invalid config and reject final-path symlinks. Publish an exclusive, complete `0600` file in the same directory. Link on first activation, rename over regular files for explicit setup, and clean up on failure.
- Allow one Copilot prompt at a time. Automatically prompt only once, on Copilot activation with missing config. Fence setup after each await; abort input on shutdown and automatic input on provider switches.
- Check the configured Copilot account before and after every attempted quota call, including failures. Mismatch clears both cached usage and command details; ordinary failures keep both stale. A failed refresh never substitutes zero.
- Wrap the configured editor and override only its top border. Keep Anthropic and Codex border formatting byte-identical for the same responses.
- No runtime dependencies. Pi supplies optional peers. Use erasable TypeScript and explicit `.ts` relative imports. The npm archive excludes `AGENTS.md`, `KNOWN_ISSUES.md`, `docs/`, tests and type-check files. Published docs must not link to them.

## Documentation map

| File | Reader | Authoritative for | Update when |
|---|---|---|---|
| `README.md` | Users | Install, behavior, replacing the local copy | Behavior or install steps change |
| `AGENTS.md` | Coding agents | Layout, commands, hidden coupling | A convention or command changes |
| `CHANGELOG.md` | Whoever upgrades | Visible change and required upgrade action | A release is prepared |
| `KNOWN_ISSUES.md` | Maintainers | Open issues and unverified external assumptions | An item is added, verified or fixed |
| `docs/plans/<feature>.md` | Development team | Approved designs and acceptance criteria | A plan is approved, revised or closed |

## Development rules

- Follow dev-flow. Commit, push, publish and install only as the user authorizes.
- Never write credentials, tokens or provider responses into this repository.
