# Executor daily snapshot

The existing read-only `/snapshot` response adds `executorDaily` after all existing snapshot projections. The authenticated HAPI endpoint forwards the same object through its owner-only snapshot route and shared refresh chain. No new service, route or scheduler is required.

The producer is the existing T021 canonical `outputs/executor-metrics/daily.json`. `executorDaily` returns `available`, unchanged `data`, `error` and informational `fileModifiedAt`. Producer timestamps, coverage, dimensions, nulls and current stuck values remain unchanged; file age does not change task state. One bounded read consumes at most 2 MiB plus one overflow byte. Missing, invalid or nonfinite data degrades only the new block. If the full response including artifacts would exceed 512 KiB, the block becomes `executor_daily_too_large` and existing fields remain available.

Reports reuse registered and prepared artifact indices. Preserve the existing index0 task-card report; look up the old daily report's actual index from current deliverables rather than overwriting contracts. The deployed phase uses index1 and verifies complete content through both private and authenticated interfaces.

The live installed server retains separately maintained activity, project catalog and prepared-artifact projections absent from this checkout. Only the import and final daily attachment are merged into each server; do not replace the live server with the older checkout wholesale. The accepted T021 module is identical in both. Phase evidence records exact installation identities, one existing-daemon reload and rollback copies. Restore only affected code and reload through the existing installer to roll back; do not overwrite the concurrent ledger.

Backend data availability and actual page rendering are separate. The formal page currently shows its existing ledger flow view; daily executor group rendering is a remaining frontend integration item. Preserve producer generatedAt/asOf when connecting that view.
