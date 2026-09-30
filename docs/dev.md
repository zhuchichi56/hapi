# Development log

## 2026-09-30 — Configure one project group for a personal Hub

- Question: How can sessions started in different working directories appear under one named project on the current machine?
- Analysis/Root Cause: The sidebar groups by machine ID and worktree base path or session path. A new repository directory therefore creates another project heading even when the Hub has only one machine.
- Solution: Add optional build-time configuration for one machine ID, its project label, and the directory used by project-header actions. Only that machine's visual grouping changes; each session keeps its real path. The visible label is searchable. Keep standard grouping when configuration is incomplete.
- Files Changed: `web/src/components/SessionList.tsx`, `web/src/components/SessionList.test.ts`, `web/README.md`, and this log.
- Commit Hash: `e2dc7cc`.
- Verification: targeted grouping tests, full typecheck, configured Web build, and the full test suite pass with Node 26 experimental WebStorage disabled. The unmodified Node 26 default caused an unrelated jsdom `StorageEvent.storageArea` failure.
- Review: independent Codex review found that the new label was missing from sidebar search and that Windows absolute paths were rejected. Both cases were fixed and covered by targeted tests before the final full suite.
- Status: feature branch only; the running Hub binary and production database are unchanged.
