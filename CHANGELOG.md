# Changelog

## 0.2.0

- **Before upgrading:** Remove the old `pi-copilot-credit` package or its copied `<agent-dir>/extensions/copilot-credits/` directory. Keep `.config/copilot-credits.json` and run `/reload` after updating. See [Upgrade from pi-copilot-credit](README.md#upgrade-from-pi-copilot-credit).
- Added Cursor OAuth usage for the Cursor Models and Other Models pools.
- Moved Copilot Enterprise quota into the input border for Copilot models. It shows the used share and uses the shared refresh schedule. The old status-bar entry is gone; `/copilot-credits` and `/copilot-credits setup` still work with any model.
- If the config file is missing, the automatic Copilot setup prompt now appears the first time a Copilot model is active, not at startup.

## 0.1.0

- First package release, moved from the local `usage-status` extension, published as `@rifle-donkey/pi-usage-bar`. Remove that local directory after installing, or both copies draw the border.
