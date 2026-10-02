# Development log

## 2026-10-02: Refresh local Codex model support

- **Question:** Can the local Codex CLI and HAPI select the current GPT-6 models?
- **Analysis/Root Cause:** The installed Codex CLI was `0.156.1`. Its App Server catalog exposed GPT-6 Astra, Sol, and Luna, but omitted GPT-6.1 Sol even though the local Copilot proxy advertised it. HAPI obtains its model choices from that App Server catalog.
- **Solution:** Updated the global Codex CLI to `0.160.0`. A read-only HAPI API check now returns GPT-6.1 Sol, Astra, Sol, and Luna, and an ephemeral Codex request using `gpt-6.1-sol` completed successfully. The custom HAPI Hub and existing model default were left in place.
- **Files Changed:** `docs/dev.md`; global npm installation of `@openai/codex` (outside this repository).
- **Commit Hash:** N/A for the global npm package update; this entry's documentation commit is recorded in Git history.

## 2026-10-01: Show GPT-6.1 Sol from the local Copilot proxy

- **Question:** Why does HAPI not offer `gpt-6.1-sol` although the local Copilot proxy serves it?
- **Analysis/Root Cause:** HAPI reads Codex App Server's `model/list` catalog, which currently omits this model. The configured local Copilot provider advertises and serves it through `/v1/models`.
- **Solution:** Merge the model into HAPI's catalog only when the active Copilot provider advertises it. Keep the App Server catalog authoritative for all other models.
- **Files Changed:** `cli/src/modules/common/codexModels.ts`, `docs/dev.md`.
- **Commit Hash:** `f91e74d4`.
