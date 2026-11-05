# Current native turn progress

Run the 61 isolated regressions against the installed watchdog with the current-turn patch applied:

```bash
uv run --offline --no-project python contrib/codex-orchestra/fixtures/current-turn-progress/run.py
```

`--package /absolute/path/to/orchestra` selects another package. The runner copies it into a temporary directory, substitutes this checkout's collector and the two fixture modules, and runs with temporary ledgers, a fake wake client and mocked native reads. It neither writes production state nor reads real native conversations.

The watchdog is maintained separately from this checkout. `patches/watchdog-current-turn-progress.patch` is its exact change from the deployed stage-review version; apply it to that version under `orchestra/`. Keep its existing file-watch, stage review, receipt, deadline, handoff and wake behavior.

The fixture reproduces the T015 14066-minute false stall and verifies history resolution, first-observation UNKNOWN, thread/turn identity, semantic changes including tool output extent, unchanged polling, restart persistence, rejected stale callbacks, real cessation at 1201 seconds, delivery deduplication and stage-review closure.
