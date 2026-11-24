# AGENTS.md

Model profile: private
GitHub account: rifle-donkey

`@rifle-donkey/pi-usage-bar` is a Pi extension that shows Anthropic and OpenAI Codex subscription usage in the input box's top border. User-facing behavior is in [README.md](README.md).

## Layout

- `extensions/usage-bar.ts`: Pi wiring (editor wrapper, refresh timers, fetches).
- `src/usage.ts`: pure parsing and formatting. It has no Pi imports, so tests run on plain Node.
- `tests/usage.test.ts`: unit tests for `src/usage.ts`.

## Commands

- Tests: `npm test`. It needs Node 22.18 or newer and makes no network calls.
- Docs check: `python3 "${PI_PROJECT_DOCS_CHECKER:-$HOME/.pi/agent/npm/node_modules/pi-project-docs/skills/project-docs/scripts/check_docs.py}" . --strict`
- Package check: `npm pack --dry-run --ignore-scripts --json` must list exactly `extensions/usage-bar.ts`, `src/usage.ts`, `README.md`, `CHANGELOG.md`, `LICENSE` and `package.json`.

## What the code doesn't make obvious

- The usage endpoints are undocumented. Validate every field and never log tokens or raw responses.
- Tokens come from Pi's model registry, which refreshes them. Never read `auth.json` directly.
- The extension wraps whatever editor factory is already configured and overrides only its top border.
- No runtime dependencies. Pi provides the host packages, so they are optional peers. Use explicit `.ts` extensions in relative imports.
- The npm `files` whitelist excludes `AGENTS.md`, `tests/` and `docs/`. Published docs must not link to them.

## Documentation map

| File | Reader | Authoritative for | Update when |
|---|---|---|---|
| `README.md` | Users | Install, behavior, replacing the local copy | Behavior or install steps change |
| `AGENTS.md` | Coding agents | Layout, commands, hidden coupling | A convention or command changes |
| `CHANGELOG.md` | Whoever upgrades | Visible change per release | A release is prepared |

## Development rules

- Follow dev-flow. Commit, push, publish and install only as the user authorizes.
- Never write credentials, tokens or provider responses into this repository.
