# Development log

## 2026-10-04 — Simplify the composer and remove retired Azure navigation

- Question: Can the composer match the minimal Work reference, and can the retired GCR machine groups stop appearing?
- Analysis/Root Cause: The previous visual shell retained the full upstream toolbar and duplicate metadata/status row. GCR groups come from preserved historical sessions, whose Runner row is no longer in the live machine list.
- Solution: Keep a plus menu, permission chip, combined model/effort selector, and send/stop control in the composer. Move secondary tools into the plus menu and show status only when it matters. Add build-time sidebar exclusions for retired machine IDs; configure the live build to omit the historical Azure machine, preserving direct links and stored history.
- Files Changed: ComposerButtons, HappyComposer, StatusBar, SessionList, sidebarVisibility, locales, index.css, web/README.md, and this log.
- Verification: Web typecheck passed; all 3,280 Web tests passed, followed by 23 affected tests after the final slider fix. Independent reviews found and resolved schedule portal, settings access, context warning, and slider interaction issues; the final focused review reported no findings. Chrome verified the deployed desktop/mobile UI, dark mode, model popup, schedule popup, expand/collapse, no horizontal overflow, and no page errors. Retired GCR groups are absent from navigation.
- Deployment: replaced the embedded-Web Hub binary atomically and restarted the existing LaunchAgent. Health checks passed; previous binary remains in `backups/work-ui-20261004/hapi-before-compact-composer`.
- Commit Hash: recorded in the completion entry; branch `feat/work-style-ui-20261003`.

## 2026-10-03 — Resolve the review-skill dependency and complete the upgrade

- Question: Can the missing pre-push-review skill be retrieved from A100 to finish the pending commit and push?
- Analysis/Root Cause: No matching skill exists in the searched local skill directories or dotfiles archive. The three configured A100 routes are currently unavailable. The upstream merge replaced the previous skill-specific policy with local review and impact-based verification.
- Solution: Follow the current project policy, reuse the passing full checks and independent review, inspect staged changes, and commit the verified upgrade on the feature branch.
- Files Changed: `docs/dev.md`; the upgrade and Work-style UI are recorded in implementation commit `4af9de13`.
- Commit Hash: `4af9de13` (upgrade and UI implementation).
- Verification: staged whitespace check passed; no unstaged or untracked changes preceded the documentation update. Push destination is explicitly `refs/heads/feat/work-style-ui-20261003`.

## 2026-10-03 — Upgrade the live Mac Hub and align the web shell with ChatGPT Work

- Question: Can HAPI be updated and visually aligned with the supplied ChatGPT Work screenshot?
- Analysis/Root Cause: The live service uses this customized 0.29.0 checkout, rather than the older ~/hapi development checkout. Upstream is now 0.30.7. Local patches include media rendering, reasoning activity, queued-message indexes, and optional single-project grouping.
- Solution: Merge upstream while preserving these patches; introduce a pale-blue navigation sidebar, dedicated new-chat navigation and settings footer, narrower centered conversation, full-width header, and elevated rounded composer. Preserve responsive layouts and dark/OLED themes.
- Files Changed: upstream merge plus web shell, SessionList, SessionHeader, HappyThread, HappyComposer, sidebar sizing, index.css, and merge adaptations; locale labels and SessionRowSummary style hooks.
- Verification: full typecheck and full suite passed (8,041 tests passed, 14 skipped); independent GPT-5.5 xhigh review reported no findings. Verified desktop/mobile, dark/OLED, mobile expand/collapse, isolated Hub startup, and post-deploy health/auth/session/machine access.
- Deployment: live custom Hub upgraded from 0.29.0 to 0.30.7; global CLI upgraded from 0.27.3 to 0.30.7, runner restarted with SIGTERM. Previous binary and a consistent SQLite backup are retained in the live HAPI home under `backups/work-ui-20261003/`.
- Review policy: The merged upstream AGENTS.md requires local diff review and relevant verification, and no longer references pre-push-review. Local skill directories and the dotfiles archive contain no matching skill; read-only retrieval attempts through the three configured A100 aliases failed (two SSH timeouts, one unavailable key/hostname). Existing full checks and independent review remain valid; staged diff review and whitespace checks passed.
- Commit Hash: recorded in the completion entry below; implementation is on `feat/work-style-ui-20261003` and deployed locally.


## 2026-09-30 — Configure one project group for a personal Hub

- Question: How can sessions started in different working directories appear under one named project on the current machine?
- Analysis/Root Cause: The sidebar groups by machine ID and worktree base path or session path. A new repository directory therefore creates another project heading even when the Hub has only one machine.
- Solution: Add optional build-time configuration for one machine ID, its project label, and the directory used by project-header actions. Only that machine's visual grouping changes; each session keeps its real path. The visible label is searchable. Keep standard grouping when configuration is incomplete.
- Files Changed: `web/src/components/SessionList.tsx`, `web/src/components/SessionList.test.ts`, `web/README.md`, and this log.
- Commit Hash: `e2dc7cc`.
- Verification: targeted grouping tests, full typecheck, configured Web build, and the full test suite pass with Node 26 experimental WebStorage disabled. The unmodified Node 26 default caused an unrelated jsdom `StorageEvent.storageArea` failure.
- Review: independent Codex review found that the new label was missing from sidebar search and that Windows absolute paths were rejected. Both cases were fixed and covered by targeted tests before the final full suite.
- Status: feature branch only; the running Hub binary and production database are unchanged.
