# @rifle-donkey/pi-usage-bar

A Pi extension that shows your subscription usage in the top border of the input box.

```text
──────────── plus · 5h 35% (3h 41m) · 7d 9% (2d 12h) · ✦ 2 exp 18d 22h ─
```

## Install

```bash
pi install npm:@rifle-donkey/pi-usage-bar
```

## Behavior

- Shows only while the active model is `anthropic/*` or `openai-codex/*` and signed in with OAuth (a subscription).
- Reads usage from undocumented, read-only provider endpoints, so it can break without notice. When a request fails, it hides the bar.
- Uses the access tokens that Pi already holds. It never logs tokens or responses. It sends them only to the matching provider.
- Works with Pi only. It wraps the configured editor and replaces only its top border.
- Refreshes after a turn, after a model switch and every five minutes while idle.

## Replace the local extension

If you ran the earlier local copy, remove `~/.pi/agent/extensions/usage-status/` after installing the package. Two copies draw the same border.

Development rules: [AGENTS.md](AGENTS.md).
