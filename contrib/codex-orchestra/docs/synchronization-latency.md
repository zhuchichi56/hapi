# Snapshot synchronization

The existing collector defaults to a two-second observation cadence and four workers. Each task/session key has at most one read in flight. Its next due time is calculated at submission; a slow read does not add another full interval after completion. When a worker is available, the next scan respects the earliest known due item while retaining periodic discovery of newly registered items. Receipt recovery and silent dispatch continue on the same executor and cadence.

The private Unix HTTP `GET /snapshot` contract is unchanged. `collector.pollIntervalSeconds` reports the running configuration. `generatedAt` is snapshot generation time, `observedAt` is native read start, and `briefAsOf` dates the explicit brief. Missing source event timestamps remain unknown; a successful snapshot read does not establish source freshness or controller acceptance.

The bounded 23-item workload (16 main tasks, seven sessions; four workers; synthetic 30 ms fast and 1.6 s slow reads; real temporary SQLite ledgers) was measured three times per condition. Slow-read start-gap means of per-repeat medians were 7.140 s with the original five-second scheduling, 5.085 s with the current scheduling at five seconds, 3.901 s with the original scheduling at two seconds, and 2.025 s with the current scheduling at two seconds. These are isolated scheduling measurements, not native bridge or DOM latency.

The live read-only baseline separately measured bridge, apply, snapshot generation and transfer. Snapshot response time was tens of milliseconds; collector cadence dominated observed synchronization waiting. Three live 30-second repeats at the same 23-item/four-worker load reduced the mean of per-repeat median observation gaps from 5.963 ± 0.087 s to 2.190 ± 0.028 s (sample standard deviation). The lower interval increases bridge read frequency while preserving the worker bound. The existing `serve --interval SECONDS` option remains available for explicitly chosen operating conditions.

Focused regression command, from `contrib/codex-orchestra`:

```sh
uv run --offline --no-project python -m unittest -q \
  test_collector_cadence test_orchestra.CollectorTests \
  test_orchestra.SessionCollectorTests test_orchestra.ObservationTests \
  orchestra.test_silent_receipts orchestra.test_silent_dispatch
```

Production measurements, installation readback and source-to-page acceptance are recorded separately by the task owner and controller. No additional service, port, wake mechanism or scheduler is required.
