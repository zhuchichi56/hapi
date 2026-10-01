# Development log

## 2026-10-01: Show GPT-6.1 Sol from the local Copilot proxy

- **Question:** Why does HAPI not offer `gpt-6.1-sol` although the local Copilot proxy serves it?
- **Analysis/Root Cause:** HAPI reads Codex App Server's `model/list` catalog, which currently omits this model. The configured local Copilot provider advertises and serves it through `/v1/models`.
- **Solution:** Merge the model into HAPI's catalog only when the active Copilot provider advertises it. Keep the App Server catalog authoritative for all other models.
- **Files Changed:** `cli/src/modules/common/codexModels.ts`, `docs/dev.md`.
- **Commit Hash:** `f91e74d4`.
