# Controller review commands

Task and associated-session review mutations require the current controller actor:

```sh
codex-orchestra review TASK --result accepted --actor CURRENT_CONTROLLER --evidence 'inspected evidence' --op-id STABLE_OPERATION
codex-orchestra session-review TASK SESSION_ID --result rejected --actor CURRENT_CONTROLLER --evidence 'remaining gap' --op-id STABLE_OPERATION
```

The CLI rejects an omitted or different actor before opening state. Ledger methods also check their current controller instance before any mutation or idempotent return. The actor is a trusted local caller assertion. Review transitions remain unchanged: task acceptance requires a reported delivery and ended associated responsibilities; rejection remains bound to its delivered or terminal-failure turn. Review operations record the actor.

For an existing `file-mtime` item in the state directory's `watchdog-sources.json` that has no tasks row:

```sh
codex-orchestra watch-review TASK --result rejected --actor CURRENT_CONTROLLER --evidence 'specific gap and next action' --evidence-ref /absolute/reviewed-evidence.md --op-id STABLE_STAGE_OPERATION
codex-orchestra watch-review-status TASK
```

`--evidence-ref` is repeatable and requires existing readable evidence files. An existing done marker is required. The decision records the source specification, full reason, evidence references, actor, operation ID and exact stage identity: watched path, done path, marker mtime_ns and size. The operations audit and `watch_reviews` record commit together. The same operation and payload reuse one decision; conflicting reuse fails. A later explicit operation may revise the same stage, preserving history.

The readback separates the current decision from the latest historical decision. Updating the done marker reopens awaiting review; an older decision cannot close that new delivery. Rejection preserves the original goal, gaps and evidence and closes only the reviewed delivery's repeated reminders. No task, native session, receipt or accepted marker is created for the file item.

The separate `patches/watchdog-stage-review.patch` contains the three-line read-only projection hook for the installed T026 watchdog. The source checkout predates that independently maintained module, so only its exact patch is tracked here. Under the controller's explicit hook authorization, the current installed watchdog was checked against its reviewed baseline, the three lines were applied, and the existing daemon was restarted once through its installer. All other installed modules and the shared tunnel were retained. Actual automatic ticks resolved the two old review-waiting events after the controller's recorded T026/T027 rejections. Deployment evidence and reversible file copies are in the phase handoff. Restore the saved watchdog file and reload through the same installer to roll back the hook; do not restore the whole database over later controller decisions.
