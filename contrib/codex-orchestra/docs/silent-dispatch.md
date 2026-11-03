# Silent external CLI dispatch

Submit one compact package through the installed command:

```sh
codex-orchestra dispatch-submit --json compact.json
```

The response contains only `opId`, `taskId`, `status`, and `reused`. The existing collector generates the full task brief, starts the original Codex CLI, monitors its files and process exit, then enqueues a candidate receipt through the existing outbox. The submit command performs no model or launcher call. No additional service, port, timer, thread pool, or sidebar chat is created.

The package has eight required fields:

```json
{
  "taskId": "T022",
  "requestId": "increment_001",
  "goal": "Implement the authorized local change and save a candidate patch",
  "deliverables": ["candidate.patch", "NOTES.md"],
  "acceptance": ["Relevant checks pass with recorded evidence"],
  "ownership": ["Executor WORKDIR only; preserve other workers' changes"],
  "authorization": "Local candidate implementation; planner integrates the patch",
  "deadline": "2026-11-03T15:00:00Z"
}
```

Replace the example deadline with the authorized absolute UTC deadline, within the next two hours. Reusing an identical request returns the existing operation, including after its deadline; changing its payload under the same request ID fails. The ID accepts letters, digits, underscores and hyphens, beginning with a letter or digit, up to 64 characters. The complete package is limited to 32 KiB. Tasks must already be registered, unarchived, and have a bound worker identity or one active unarchived role session. Explicit authorization in the new package permits an increment even when the previous native turn has ended or its observation is stale.

Private inspection is explicit:

```sh
codex-orchestra dispatch-status silent_dispatch:increment_001
codex-orchestra dispatch-list --limit 20
```

Internal dispatch operations are excluded from the general snapshot operation list. Durable task packages, generated briefs, executor files, and detailed timing remain available through private inspection and `STATE/silent-dispatch/requestId`.

The collector uses the existing operations table and FULL-sync transactions. Up to 100 outstanding jobs are admitted; at most two jobs in this ledger may be launching, running or awaiting reconciliation. Each collector recovery pass claims at most one new job. It persists intent before the non-waiting process launch. An uncertain launch is monitored at its original work directory and never automatically relaunched. An expired job with an unknown live process keeps its capacity reservation until exit evidence is available.

Execution remains Codex CLI / `gpt-6.1-sol` / `high` / `http://127.0.0.1:4150/v1` / strict Copilot, using the original `dsh-delegate` entry point. The subprocess PATH includes the installed `/opt/homebrew/bin` and `/Users/zhuhe/.local/bin` tools; launcher diagnostics are saved in private `launcher.log`. The first work directory deadline is set to the authorized absolute cutoff; subsequent observations never extend it. Candidate files are written inside that work directory for planner integration. Resource tasks still require the launcher's mandatory skills; this entry does not grant MCP, native UI or resource permissions.

Success requires the expected launcher manifest, `running=false`, `failed=false`, `done=true`, exit code zero, and actual runner exit. `DONE` alone does not establish completion. A terminal receipt fixes its identity, timestamp and payload before outbox enqueue, so recovery retries the same event. Its checklist remains `unverified`; it records no controller review, decision or acceptance.

Timing distinguishes submission, claim, launch intent, observed launcher return, first event observation, terminal observation, outbox enqueue and durable receipt. Missing event timestamps remain unknown. `thread.started` is a session event; it is not model first-token latency. The existing five-second collector cadence adds queue and observation delay. Cold/repeated collector calls do not establish provider cache state.

Native wake remains governed by the existing persistent OFF policy. ACKs and internal process records stay in the background. The App still displays its own tool invocation card. Native internal Sub Agents can only be invoked through the real parent tool; this backend launches external CLI processes.

User-facing result tables put project first, group each project's rows together, and show its name only on the first row. ACKs and internal processing do not appear in those tables. Candidate self-checks are separate from parent acceptance.

Focused verification from `contrib/codex-orchestra`:

```sh
uv run --offline --no-project python -m unittest orchestra.test_silent_dispatch orchestra.test_silent_receipts
```
