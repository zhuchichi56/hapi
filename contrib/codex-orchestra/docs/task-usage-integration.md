# Real task usage in snapshots

The existing Unix `/snapshot` response adds `tasks[].investment.taskUsage` using `task_usage/v1`. Other investment fields remain intact. Unbound tasks carry an explicit unavailable value.

The collector state directory contains operator-owned `task-usage-bindings.json` (mode 0600):

```json
{
  "version": 1,
  "tasks": {
    "T021": {
      "threadId": "exact-ledger-thread-id",
      "phaseId": "task-card-phase",
      "nativePath": "/absolute/path/to/native-session.jsonl",
      "taskTurnsAll": true,
      "executorBindings": [{
        "telemetryPath": "/absolute/path/to/executor-telemetry.jsonl",
        "sessionRef": "exact-session-or-producer-ref",
        "roundIndexes": [1, 2, 3]
      }]
    }
  }
}
```

The snapshot and ledger thread identities must match the binding. `taskTurnsAll: true` declares the complete native conversation as task cumulative. For a smaller scope, set it to false and use exact `phaseTurnRefs` or `currentTurnRef`. No session discovery or sample fallback runs.

Native input includes cache read/write subsets. Explicit Claude executor summaries report uncached input; the adapter adds read/write caches once and retains the original convention and uncached input in provenance. Missing categories remain unknown. Summary-only executor steps remain null. Native model work, observed executor invocation interval union, and wall time remain separate. Wall boundaries use the same selected native scope as model totals. `sourceAt` comes from source usage observations.

The adapter reads append-only JSONL incrementally, discards message/tool bodies before caching, and keeps a bounded in-process metadata cache. File replacement, truncation and same-size edits invalidate it. Concurrent readers share a lock. A failed source read retains the previous valid result as stale where available; identity mismatch is unavailable. The supported source protocol does not rewrite existing bytes while growing the same file.

Verification:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=contrib/codex-orchestra uv run --offline --no-project python -m unittest discover -s contrib/codex-orchestra/tests -v
```

The production installation adds three modules and a two-line hook to the latest installed server, preserving its separately owned catalog, activity and artifact handlers. Reload through the existing `~/.local/lib/codex-orchestra/install.py restart` entry point. The installation evidence records exact modules and the preserved collector cadence; deployment adds no service, port or scheduler.
