# Development log

## 2026-10-04 — Explain the historical Machine spawn warning

- Question: What does the Machine card's October 3 "Existing HAPI session has no Codex thread binding" warning mean?
- Analysis/Root Cause: Machine identifies the Mac host and its HAPI CLI version. The quoted warning records a previous child process exiting before registration; fresh-session versus resume protocol mismatch caused the missing Codex thread binding. It is a historical last-spawn diagnostic, not a model error or machine-offline indicator.
- Solution: Read the live machine API. The named Mac is active, Runner status is running, and lastSpawnError is null after the matching-build deployment and successful default-session verification. Explain the old timestamp and recommend refreshing the page to obtain current state.
- Files Changed: docs/dev.md only.
- Verification: Read-only live API check; no session creation or inference request.
- Commit Hash: Included in this documentation commit.

## 2026-10-04 — Align composer controls to the bottom and create default sessions in one click

- Question: Why is there an empty row below composer controls, can New Session launch GPT-6.1-Sol/Medium directly, and what do recent HAPI versions and Settings provide?
- Analysis/Root Cause: The collapsed composer has a desktop minimum height without flex layout, so short rich-input content leaves unused space below its toolbar. All New Session buttons navigate to the generic multi-agent configuration form. Real creation also exposed a protocol mismatch: the globally installed Runner forwarded fresh reserved rows as existing-session resumes, which Codex rejected because no thread was bound.
- Solution: Make the composer surface a flex column and bottom-align its compact toolbar. Add an opt-in personal quick-launch preset that validates the explicit machine, directory, model, and Medium effort before launching Codex; project-specific creation retains the clicked directory. Keep existing permission preferences and the advanced form for explicit configuration/share flows. Document upstream 0.29–0.30 release highlights and Settings recommendations for this deployment. Point the local Runner LaunchAgent at the same custom build as the Hub; retain its previous plist for rollback and restart the Runner without stopping detached sessions.
- Files Changed: HappyComposer, ComposerButtons, quick-launch hook/tests, router, locales, web/README.md, personal setup guide, and this log. Machine/directory deployment settings remain in ignored web/.env.local.
- Verification: Web typecheck, 38 focused tests, and all 3,297 Web tests passed. Independent review findings on missing project machines, legacy permission preferences, and pending navigation were fixed and covered. Chrome verified rich/legacy inputs, multiline, expanded, mobile, and dark layouts; toolbar bottom gap is 13px throughout, with no page errors or overflow. Production UI actually created a Codex GPT-6.1-Sol/Medium session in /Users/zhuhe; the successful empty verification session was archived, with no inference request sent. Two failed pre-fix verification stubs remain inactive; their archive endpoint returns 409, so they were preserved. Embedded-Web build, Hub health, and matching Runner startup passed. Previous binary and Runner plist are retained for rollback.
- Commit Hash: `695fba82` (implementation); branch `feat/work-style-ui-20261003`.

## 2026-10-04 — Refine composer details and verify Ultra capability

- Question: Can the permission/model controls better match the supplied reference, and does selecting Ultra require a separately implemented HAPI mode?
- Analysis/Root Cause: Codex's local model catalog advertises Ultra for GPT-6-Sol and several other models, but excludes it for Luna models. HAPI forwards the reasoning effort unchanged to the Codex app-server. A restored unsupported effort was previously inserted as a selectable option even when the current model's catalog excluded it.
- Solution: Increase compact control typography and horizontal spacing, provide a blue keyboard focus outline independent of the monochrome link theme, retain unsupported stored efforts as disabled diagnostic rows, and exclude them from slider positions. Keep advertised Ultra available without silently substituting another level.
- Files Changed: ComposerButtons, CompactModelSettings, HappyComposer, codexReasoningEffortOptions, regression tests, index.css, locales, and this log.
- Verification: Web typecheck and 33 focused tests passed. Independent review identified an unknown-versus-unsupported capability distinction, which was corrected and covered by regression tests. Desktop/mobile preview passed with no overflow or page errors. Model discovery was read-only; no Ultra inference request was issued. Live Hub binary replacement and health check passed; Chrome verified production desktop/mobile, blue keyboard focus outline, schedule popup, dark mode, no overflow, and no page errors. The previous binary is retained as `backups/work-ui-20261004/hapi-before-ultra-refinement`.
- Commit Hash: `8d38d22a` (implementation); final focus-color adjustment is included in the completion commit.

## 2026-10-04 — Simplify the composer and remove retired Azure navigation

- Question: Can the composer match the minimal Work reference, and can the retired GCR machine groups stop appearing?
- Analysis/Root Cause: The previous visual shell retained the full upstream toolbar and duplicate metadata/status row. GCR groups come from preserved historical sessions, whose Runner row is no longer in the live machine list.
- Solution: Keep a plus menu, permission chip, combined model/effort selector, and send/stop control in the composer. Move secondary tools into the plus menu and show status only when it matters. Add build-time sidebar exclusions for retired machine IDs; configure the live build to omit the historical Azure machine, preserving direct links and stored history.
- Files Changed: ComposerButtons, HappyComposer, StatusBar, SessionList, sidebarVisibility, locales, index.css, web/README.md, and this log.
- Verification: Web typecheck passed; all 3,280 Web tests passed, followed by 23 affected tests after the final slider fix. Independent reviews found and resolved schedule portal, settings access, context warning, and slider interaction issues; the final focused review reported no findings. Chrome verified the deployed desktop/mobile UI, dark mode, model popup, schedule popup, expand/collapse, no horizontal overflow, and no page errors. Retired GCR groups are absent from navigation.
- Deployment: replaced the embedded-Web Hub binary atomically and restarted the existing LaunchAgent. Health checks passed; previous binary remains in `backups/work-ui-20261004/hapi-before-compact-composer`.
- Commit Hash: `b55d8845` (implementation); branch `feat/work-style-ui-20261003`.

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

## 2026-10-06 — Stabilize pinned projects and restore human-turn timestamps

- Question: Why do WWX/Zhuhe projects keep swapping positions, and why do untouched conversations show “just now”?
- Analysis/Root Cause: Project and pinned-row sorting used mutable activity timestamps/connection state. Public timestamps inherited storage writes for metadata/state, not just user messages. Relative-time labels had no clock-driven refresh.
- Solution: Keep pinned projects first with deterministic name/identity ordering; keep pinned rows stable by identity. Derive public conversation timestamps from the latest human transcript turn (creation time for empty conversations), preserving historical timestamps and ignoring background writes. Refresh relative labels every 30 seconds and when tab visibility changes.
- Files Changed: SessionList, SessionRowSummary, hub message store/session cache/activity predicate/socket handlers, regression tests, and this log.
- Verification: Full typecheck passed after correcting test types; final Hub suite 1,384 passed (3 optional integration tests skipped), Shared 323 passed, Relay 118 passed, focused Web 182 passed, and final search/group/row regressions 101 passed (including two search-specific checks). Web full suite passed 3,298 tests but hit the known Node 26 experimental-WebStorage failure in two unrelated markdown tests; those tests passed with `NODE_OPTIONS=--no-experimental-webstorage`. The full CLI suite passed 2,945 tests but its existing Agy retry-cancellation test failed, including an isolated retry; no CLI source was changed. Isolated compiled-Hub desktop/mobile verification passed. Read-only historical scan found 625 polluted clocks among 776 sessions. First scan took 6.4 seconds in the quiet environment; cached refresh took 72 ms across all sessions.
- Deployment: Embedded-Web Hub binary replaced atomically and existing LaunchAgent restarted. Live API/browser verified 776 sessions, 772 old conversations with zero clock changes during keepalives, stable Zhuhe/WWX headers, historical labels, no mobile overflow, and no page errors. No transcript or database rewrite was performed. Previous binary retained under live HAPI home's `backups/sidebar-clock-20261006/hapi-before-fix`.
- Review: Independent GPT-5.5 xhigh review of the final production diff reported no confirmed correctness bugs. Local review caught and fixed the interaction between deterministic header sorting and search relevance; both search ranking and pin dividers are covered by passing regression tests.
- Commit Hash: `7e4d6071` (implementation); completion verification and review record are in the subsequent documentation commit.

## 2026-10-06 — Diagnose and accelerate new conversation launch

- Question: Why does creating a conversation take 10–20 seconds or never open, and why is HAPI generally slow?
- Analysis/Root Cause: The local runner used the public tunnel URL from personal settings, so local child bootstrap crossed the Internet. A localhost browser launch hit the runner's 15-second webhook deadline and the child was killed. Public list retrieval measured 60,444 ms versus 20 ms locally. After the runner's LaunchAgent was configured for loopback, a complete new conversation opened in 3,184 ms (model preflight 960 ms, spawn 2,135 ms). Human-clock cache fingerprints also forced historical decoding after every agent append; each visible row owned a separate refresh timer.
- Solution: Backed up the local runner LaunchAgent and set an explicit loopback Hub URL, supervised restart, and a 60-second cold-start safety limit. Existing agent processes remain independent of runner shutdown. Configure the personal CLI default for loopback too. Explicit same-Hub URL aliases preserve recognition of live shared Codex owners across the public/loopback transport change, while retaining authentication matching. Prewarm/share the verified model catalog, retain fresh directory checks, and bound launch HTTP waits. Allow 90 seconds for the Hub spawn RPC so the runner safety limit can finish. Scan human clocks row-by-row once, then only newly appended output; explicitly invalidate destructive edits and real invocation changes. Cache positive conversation-content checks against a surviving message witness, so deletion/recreation of a session ID cannot reuse stale content status. Share one visibility-aware relative-time timer across rows. Compress embedded text assets asynchronously once and cache hashed assets for one year; HTML revalidates and service workers retain no-store.
- Files Changed: CLI shared-runtime registry/runner/docs and alias regressions; Hub message store/scanner, spawn RPC gateway, embedded static response/server, Web quick-launch hook/API timeouts/shared relative clock, regression tests, and this log. Local LaunchAgent configuration is outside the repository and contains no committed credentials.
- Verification: Hub 1,392 passed with 3 optional integration tests skipped; focused Web 137 passed using the Node 26 WebStorage workaround; Hub/Web/CLI typechecks passed; CLI runner/registry regressions 129 passed. A final runner-restart launch opened in 2,443 ms. Across 150 related pre-restart processes only the old runner PID exited; all other agent processes remained alive. Cold readonly human-clock scan across 780 sessions fell from 5,526 ms to 2,790 ms, warm scan to 8 ms. A regression proves one appended agent output checks one new message instead of 502 historical messages. Live browser click-to-chat measured 2,600 ms (fresh path check 47 ms, spawn 2,457 ms); model discovery ran before the click. Entry JavaScript transferred 663,955 gzip bytes versus 2,291,562 uncompressed bytes (71% less). Live desktop/mobile checks preserved old clocks through keepalives, stable project headers, no mobile overflow, and no page errors. Disposable launch sessions were archived.
- Deployment: Embedded-Web binary installed atomically; prior binary preserved under live home backups/launch-performance-20261006/hapi-before-fix.
- Remaining Limitation: The public Cloudflare route goes through LAX and remained slow/unstable during final tests: a fresh public page timed out after 45 seconds, public auth later timed out after 20 seconds, CDN asset caching was verified as HIT, and asset transfer delivered only 69 KB in 15 seconds. Compression and immutable caching reduce transferred bytes, but there is no evidence that the underlying Internet/tunnel bottleneck is solved. Local users can avoid it via http://127.0.0.1:3006/sessions.
- Review: Independent GPT-5.5 xhigh static-delivery and runtime-alias reviews found no confirmed issues. Combined/cache diff reviews hit provider reconnection errors and were replaced with a bounded review of the complete cache lookup methods and mutation invariants. Final cache review verification is pending.
- Commit Hash: Pending.
