# Task Phase Metrics Contract (v1)

Status: implementation contract for T015/T021 consumers. Stdlib-only, no UI, no shared-file
edits. Canonical schema id: `phase_metrics/v1`.

This module computes **task-phase** duration and token aggregates from explicit boundaries and
safe turn metadata. It never derives a task lifetime from chat creation, never derives task spend
from lifetime chat totals, and never invents `usage = 0`.

## Files

| File | Purpose |
| --- | --- |
| `phase_metrics.py` | `aggregate_phase`, validation, CLI |
| `test_phase_metrics.py` | 52 synthetic unittest regressions |
| `fixtures/phase_metrics/phase.json` | synthetic phase boundary |
| `fixtures/phase_metrics/observations.json` | synthetic per-turn observations (two chats, overlap, explicit zeros) |
| `fixtures/phase_metrics/output.json` | output of the CLI for the example |

Run from this directory:

```sh
python3 -m unittest discover -s tests -p 'test_phase*.py'
python3 -m orchestra.phase_metrics \
  --phase fixtures/phase_metrics/phase.json \
  --observations fixtures/phase_metrics/observations.json \
  --now 2026-11-02T10:22:00Z
```

The CLI prints indented JSON to stdout, exits `0` when `ok` is true and `1` when the phase is
rejected (for example a missing boundary). Unreadable JSON exits `2`.

## API

```python
aggregate_phase(phase, observations, now=None) -> dict
```

- `phase`: object described below.
- `observations`: list of safe observation objects (or `{"observations": [...]}`).
- `now`: ISO-8601 with UTC/offset, numeric epoch seconds, or an aware `datetime`. When omitted
  the wall clock is used only to reject future timestamps and to compute sample age. `now` is
  **never** used as a duration horizon.
- The return value is JSON-serialisable, deterministic for identical inputs and a fixed `now`,
  and contains only metadata, bounded enums/identifiers and computed numbers.

### Phase object

Required fields:

| Field | Meaning |
| --- | --- |
| `taskId` | non-empty bounded identifier; missing/invalid rejects the phase |
| `phaseId` | non-empty bounded identifier; missing/invalid rejects the phase |
| `startedAt` | explicit phase start, ISO-8601 with UTC/offset or epoch seconds |
| `threadIds` | array of thread ids that share this explicit phase; a replacement chat is listed alongside the original |
| `boundarySource` | provenance enum (see below) |
| `scopeComplete` | boolean assertion that observation history covers the whole phase |
| `endedAt` | explicit phase end, or `null` for an open phase |

`boundarySource` is bounded. Unknown text becomes `unknown`; it is never echoed. Accepted
values include `explicit_task`, `explicit_phase`, `explicit_boundary`, `manual`, `task_record`,
`operator`, `unknown`, and the canonical native-desktop binding
`native_turn_startedAt_with_explicit_task_turn_binding` (input is matched case-insensitively,
output uses this exact spelling).

Identity is mandatory: after a valid phase start, a missing or unsafe `taskId`/`phaseId` returns
`ok: false`, `error: "missing_phase_identity"` and the missing field list. No duration or token
aggregate is produced without identity.

### Observation object

| Field | Meaning |
| --- | --- |
| `threadId` | must be one of the phase `threadIds`; foreign chats are ignored, not counted |
| `turnId` | turn identity within the thread |
| `observedAt` | poll/snapshot time; drives latest-wins ordering and sample age |
| `startedAt` | native turn start |
| `completedAt` | native turn completion, or `null` while ongoing |
| `durationMs` | native full wall duration; copied as metadata, **never** used as active compute time |
| `status` | bounded status; native `inProgress` maps to `in_progress` |
| `usage` | optional cumulative per-turn snapshot (see below) |

Unknown observation keys are ignored and never echoed. A record with an unsafe `threadId` or
`turnId` cannot enter the output. A record for another declared thread is ignored. A malformed
in-scope record is rejected and makes source-history completeness false.

## Time rules

Accepted: ISO-8601 with an explicit UTC/offset (`Z` or `+08:00`) and numeric epoch seconds.
Rejected: booleans, `NaN`/`inf`, negative epoch, naive ISO datetimes, unparseable strings, nulls,
times later than `now`, turns whose observation precedes their start, and intervals whose
`completedAt` is before `startedAt` or after `observedAt`.

`now` is an ISO timestamp in the CLI. Passing it makes the result deterministic; omitting it uses
the wall clock only for future rejection, `sampleAgeSeconds`, and `stale`.

## Duration semantics

- `phase.elapsedSeconds` is `endedAt - startedAt` when an explicit end exists, otherwise
  `latest successful observedAt - startedAt` (the observation horizon). It is `null` when an open
  phase has no observations or only observations before the boundary. It never uses `now`.
- `activeExecutionSeconds` is always `null` with
  `activeExecutionReason: "absent_event_intervals"`. Native turn wall duration is not active
  compute time.
- Each turn interval is clipped to `[phase.startedAt, endedAt]` (or to the global observation
  horizon for an open phase).
- A **completed** turn ends at its `completedAt`; a later poll does not extend it.
- An **ongoing** turn ends at its **own latest successful `observedAt`**. A fresh observation
  from another thread never extends a stale ongoing turn.
- `observedTurnWallSeconds` is the union of clipped turn intervals, so parallel/replacement chats
  are not double-counted. `sumTurnWallSeconds` is the sum of the same intervals and therefore
  includes parallelism explicitly.
- Both union and sum are `null` when no interval is observed. A known zero-length interval
  (start == completed) is retained as numeric `0.0`, not `null` or "missing".
- A turn entirely outside the boundary contributes 0 and is marked `outside_phase`. Crossing
  turns are clipped for wall time and excluded from token attribution.
- `sampleAgeSeconds` is `now - latest observedAt` (`null` without observations).
  `stale` is `sampleAgeSeconds > 30`. Each turn also exposes `observationAgeSeconds` and `stale`
  using the same 30-second threshold (matching existing orchestra behavior).
- Reported coverage: `observedTurnCount`, `clippedTurnCount`, `ongoingTurnCount`,
  `outsidePhaseTurnCount`, `duplicateObservationCount`, `ignoredThreadObservationCount`, and
  `sourceHistoryComplete`.

## Usage semantics

Only explicit **per-turn cumulative snapshots** are accepted:

```json
{
  "basis": "turn_total",
  "source": "native_turn_usage",
  "inputTokens": 1200,
  "outputTokens": 300,
  "cacheReadInputTokens": 800,
  "cacheWriteInputTokens": 100,
  "cacheConvention": "included_in_input"
}
```

- `basis` must be `turn_total`; `thread_total` is rejected as `thread_total_unsupported`
  (no validated phase baseline is supported).
- `source` must be exactly `native_turn_usage`; any other source is rejected and cannot
  manufacture evidence.
- `cacheConvention` is exactly one of:
  - `included_in_input` — cache tokens are already a subset of `inputTokens`;
  - `separate_from_input` — cache tokens are additional to `inputTokens`;
  - `unknown` — cache accounting is unknown, so `totalTokens` is unknown.
  A missing convention is treated as `unknown`; any other value is rejected.
- Token values are integers `>= 0` or `null`. Booleans, floats, negative values and non-integers
  are rejected. Explicit `0` is valid and distinct from unknown (`null`).
- For `included_in_input`, a known cache read/write value greater than `inputTokens`, or
  `cacheRead + cacheWrite > inputTokens`, rejects that usage snapshot
  (`cache_exceeds_input`).
- Per turn, the latest usage-bearing observation by `observedAt` wins; repeated polls of the same
  total replace, never sum. An observation without `usage` does not erase a prior snapshot. An
  invalid latest snapshot is not silently replaced by an older good one.
- Only turns **wholly inside** the phase boundary are eligible for whole-turn token attribution.
  Ongoing turns, turns starting before the boundary, and turns ending after it are marked
  `excluded` and are never prorated.
- Per metric, the module reports `knownTurnCounts`, `unknownTurnCounts` and
  `coverage.{eligible,known,unknown,complete}`.
- `observedInputTokens`, `observedOutputTokens`, `observedCacheReadInputTokens`,
  `observedCacheWriteInputTokens` and `observedTotalTokens` are partial evidence over known
  eligible turns. They are `null` when no eligible turn has that known metric (never `0`).
- Final phase metrics (`inputTokens`, `outputTokens`, `cacheReadInputTokens`,
  `cacheWriteInputTokens`, `totalTokens`) are numeric only when:
  `scopeComplete is true`, no in-scope observation or current usage snapshot was rejected, at
  least one turn is eligible, no observed turn was excluded from whole-turn scope, and every
  eligible turn has that metric known.
- `totalTokens` per turn:
  - `included_in_input`: `inputTokens + outputTokens` (cache is not added again);
  - `separate_from_input`: `inputTokens + cacheReadInputTokens + cacheWriteInputTokens +
    outputTokens`, only when all four are known;
  - `unknown` or mixed conventions: `null`.
  A phase with mixed conventions keeps per-field evidence but sets phase `totalTokens` to `null`.
- Any rejected in-scope observation, invalid current usage, `scopeComplete = false`, or missing
  `scopeComplete` forces partial phase totals while preserving observed partial sums.

Rejection reasons are bounded identifiers (for example `observed_at_invalid`,
`reversed_turn_interval`, `cache_exceeds_input`, `usage_source_invalid`). Arbitrary status,
source or free text is never echoed.

## Output shape

Top-level keys:

- `schema`, `ok`, `error`, `missing`
- `phase`: `taskId`, `phaseId`, `threadIds`, `boundarySource`, `scopeComplete`, `startedAt`,
  `endedAt`, `endBasis`, `elapsedSeconds`, `elapsedBasis`, `durationSource`,
  `sampleAgeSeconds`, `stale`, `staleAfterSeconds`, `clockBasis` (`utc_wall_clock`),
  `evaluatedAt`, `nowSource`
- `duration`: `phaseElapsedSeconds`, `activeExecutionSeconds`, `activeExecutionReason`,
  `observedTurnWallSeconds`, `sumTurnWallSeconds`, `observedTurnCount`, `clippedTurnCount`,
  `ongoingTurnCount`, `outsidePhaseTurnCount`, `duplicateObservationCount`,
  `ignoredThreadObservationCount`, `sourceHistoryComplete`, `rejectionReasons`, `missingReasons`
- `usage`: `basis`, `source`, `cacheConvention`, `scope`, `scopeComplete`,
  `eligibleTurnCount`, `excludedTurnCount`, `knownTurnCounts`, `unknownTurnCounts`, `coverage`,
  observed totals, final phase metrics, `missingReasons`, `rejectionReasons`,
  `usageSnapshotCount`, `rejectedUsageCount`, `sourceHistoryComplete`
- `turns`: per-turn metadata, clipped interval, `wholeTurnInPhase`, `tokenExclusionReason`,
  `observationAgeSeconds`, `stale`, and bounded `usage`
- Flattened aliases for consumers: `phaseElapsedSeconds`, `activeExecutionSeconds`,
  `activeExecutionReason`, `observedTurnWallSeconds`, `sumTurnWallSeconds`, all five phase token
  metrics, all observed partial token totals, `coverage`, `sourceHistoryComplete`.

When the phase boundary or identity is invalid, `ok` is false and numeric fields are `null`;
no lifetime or spend is guessed. `error` is a bounded reason such as `missing_phase_boundary`,
`invalid_phase_boundary`, `phase_start_in_future`, `phase_end_before_start`,
`phase_end_in_future`, `missing_phase_identity`, or `invalid_now`.

## Privacy and determinism

- Output allowlist only: bounded identifiers, enums, timestamps, counts and computed numbers.
- Unknown input keys, unknown statuses/sources and unsafe text are dropped; unknown enum text
  becomes `unknown` or a rejection reason.
- Invalid rows never replace good metadata. Duplicate polling is deduplicated by
  `(threadId, turnId)`, latest `observedAt` wins, and ties are resolved by a stable canonical
  rank so reordered input produces the same result.
- Synthetic fixtures only; no credentials, reasoning, message bodies or tool payloads are read or
  emitted.

## Native adapter mapping (read-only observation, contract only)

Current native desktop adapters retain per-turn `startedAt`, `completedAt` and `durationMs`; the
orchestra bridge sanitizer (`orchestra/bridge.py::sanitize_read_response`) currently discards
these fields and receives no usage. Mapping for a future minimal integration:

1. Extend the sanitizer allowlist with `turns[]` entries containing only:
   `threadId`, `turnId` (`id`), `startedAt`, `completedAt`, `durationMs`, bounded status, and
   the explicit cumulative `usage` snapshot when the native endpoint provides it.
2. Keep the existing safe scalar fields (`live`, `status`, `revision`, `turnId`, `turnStatus`);
   do not forward item text, tool bodies or arbitrary status strings.
3. Add an explicit phase boundary record `{taskId, phaseId, startedAt, endedAt, threadIds,
   boundarySource, scopeComplete}`. `threadIds` must include the replacement chat when a phase
   spans chats.
4. Persist observations with their `observedAt` poll time; do not overwrite the previous
   snapshot. Pass the record list to `aggregate_phase`.
5. Preserve `cacheConvention` exactly as supplied by the native usage source; if unknown, pass
   `"unknown"` rather than assuming cache inclusion.

Suggested shared-file touch points (not edited by this task):

- `orchestra/bridge.py`: allowlist the fields above in `sanitize_read_response`; no behavior
  change to native mutations.
- Native adapter/collector: emit per-turn `usage` with `basis: "turn_total"` and
  `source: "native_turn_usage"`.
- Ledger/T015: store the observation list plus phase boundary; call `aggregate_phase` at read
  time (idempotent) rather than persisting derived numbers as source of truth.
- T021: consume the flattened aliases and `coverage.complete` flags; render `null` as unknown,
  never as zero. Keep `activeExecutionSeconds = null` explicit.

## Assumptions / limits

- Python 3.9+ stdlib only.
- Poll history is scoped to the declared threads and the explicit phase. If history is
  truncated, callers must set `scopeComplete: false`; exact phase totals then stay `null`.
- Token attribution is whole-turn only. No baseline subtraction for `thread_total`, no prorating,
  no inference of missing usage.
- `durationMs` is retained as native metadata only; event intervals for active compute time are
  absent, so active execution remains unknown.
- Stale threshold is 30 seconds, matching existing orchestra behavior.
