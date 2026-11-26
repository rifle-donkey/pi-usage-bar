# @rifle-donkey/pi-usage-bar

A Pi extension that shows subscription usage for the active model in the input box's top border.

```text
──────────── plus · 5h 35% (3h 41m) · 7d 9% (2d 12h) · ✦ 2 exp 18d 22h ─
```

## Install

If you use `pi-copilot-credit`, follow [Upgrade from pi-copilot-credit](#upgrade-from-pi-copilot-credit) instead.

1. If you use the local `usage-status` copy, remove `~/.pi/agent/extensions/usage-status/` so both copies do not draw the border.
2. Install the package in Pi:

   ```bash
   pi install npm:@rifle-donkey/pi-usage-bar
   ```

3. Start Pi, or run `/reload` in an open session.

This extension works with Pi only, not Oh My Pi (OMP). It wraps the configured editor and changes only its top border.

## Upgrade from pi-copilot-credit

1. Remove `npm:@rifle-donkey/pi-copilot-credit` from Pi. If you installed it by copying files, remove `<agent-dir>/extensions/copilot-credits/` instead. Remove both copies if you installed both. Otherwise, two extensions register `/copilot-credits`.
2. Keep `.config/copilot-credits.json` in the same agent directory. See [Copilot configuration](#copilot-configuration) for how the extension finds it.
3. Install or update `npm:@rifle-donkey/pi-usage-bar`, then run `/reload`.

## Behavior

| Active model provider | Login required | Visible usage |
|---|---|---|
| `anthropic` | OAuth subscription | `5h` and `7d` windows |
| `openai-codex` | OAuth subscription | Plan, usage windows and available reset credits |
| `cursor` | OAuth subscription, not an API key | `cursor` (Cursor Models) and `other` (Other Models), when reported |
| `github-copilot` | Any Pi login; matching GitHub CLI (`gh`) login required | `enterprise` plan and `premium` interactions used |

The border shows used percentages and known reset countdowns. Copilot counts down to midnight UTC on the reset date. Refreshes run after a turn or model switch, at most once per minute, and every five minutes while idle. A known reset can trigger an earlier refresh.

If a refresh fails, the border marks a previous value `stale` or shows `usage unavailable` if there is no value. When space is tight, Cursor and Copilot keep `stale` even if no usage fits.

A Cursor account change or a Pi token refresh for the Cursor login clears the old value and refreshes usage with the new OAuth token. The extension detects either change within one minute while Cursor is active. A Copilot account change or mismatch also clears the old value.

These usage endpoints are read-only and undocumented. If the displayed usage differs from your provider's settings, use the provider's settings. Other GitHub limits, such as a user budget or shared pool, can block usage before the displayed quota runs out.

## Set the Copilot account

1. Authenticate `gh` for `github.com` as the account that holds the Copilot Enterprise license.
2. Select a `github-copilot` model. If the config file is missing, Pi asks for that account's GitHub login the first time Copilot becomes active. The prompt does not block startup and times out after 60 seconds. If you cancel, answer nothing, or enter three invalid logins, use `/copilot-credits setup` to try again.
3. To change the account or fix an invalid file, run `/copilot-credits setup` and enter the login. Setup refuses to replace a directory or a symbolic link. Remove that path first.

Either prompt saves the config and refreshes without `/reload`. If another session creates the file first, the automatic prompt uses that file instead. The automatic prompt never replaces an existing file.

The extension runs only in sessions with a UI. In RPC mode, the prompt is an `input` dialog request with a 60-second timeout.

## Copilot configuration

The extension reads `.config/copilot-credits.json` in the Pi agent directory. It does not use project config. The agent directory depends on `PI_CODING_AGENT_DIR`:

| Value | Agent directory |
|---|---|
| Unset or empty | `~/.pi/agent` |
| Absolute path | That path |
| Relative path | Relative to where Pi starts; prefer an absolute path |
| Exactly `~` | Your home directory |
| A path starting with `~/` | That path under your home directory |

The extension refuses other values starting with `~` and URL forms such as `file:///…`, even if Pi accepts them. The extension also needs an operating system that supports opening a file without following symbolic links (`O_NOFOLLOW`). On an unsupported path or platform, it does not prompt, read or write the config, or call `gh`.

```json
{"account": "your-github-login"}
```

- `account` is required. Use 1–39 ASCII letters and digits, with single hyphens only between them. The comparison ignores case.
- The file must be regular and at most 4096 bytes. Symbolic links are invalid. Other fields are ignored. Do not put secrets in the file.
- The extension writes the file with mode `0600` and creates a missing `.config` directory with mode `0700`. It keeps existing directory permissions.
- The extension reads the config once per instance. If you edit it by hand, run `/reload` or start a new Pi process.

## Copilot commands

These commands work with any active model. Copilot usage still appears only on a Copilot model's border.

| Command | Action |
|---|---|
| `/copilot-credits` | Refresh now and show the total, remaining and used amounts, the reset date and the time of the last successful refresh. If the config is missing or invalid, show where to fix it. |
| `/copilot-credits setup` | Set the account; see [Set the Copilot account](#set-the-copilot-account). |

## Security

The extension gets OAuth tokens from Pi and sends them to the matching provider. It uses the existing `gh` login for Copilot and checks that it matches the configured account before and after the quota request. It never logs tokens, logins, config content or raw responses.

Only the config file or your answer to the setup prompt sets the expected Copilot account. Keep the Pi agent directory and its `.config` directory owned by you and not writable by other users.

## Troubleshooting

- **`copilot setup needed`:** Run `/copilot-credits setup`, or check [Copilot configuration](#copilot-configuration) and run `/reload`.
- **`account mismatch`:** Run `gh auth switch` to select the configured account, then run `/copilot-credits`.
- **Setup refused:** Remove the directory or symbolic link at the config path, then run `/copilot-credits setup`.
- **`PI_CODING_AGENT_DIR` is not a supported path:** Set a supported path from [Copilot configuration](#copilot-configuration), then restart Pi.
- **`usage unavailable`:** Check your login and usage in the provider's settings.
- **Copilot command registered twice:** Remove the old extension as described in [Upgrade from pi-copilot-credit](#upgrade-from-pi-copilot-credit).
