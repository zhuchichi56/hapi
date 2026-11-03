"""Focused scheduling regressions; no native I/O or production state."""
import unittest
from concurrent.futures import Future
from unittest.mock import patch

from orchestra.collector import Collector
from orchestra.receipt_recovery import ReceiptRecoveryCollector


class MemoryLedger:
    def __init__(self, tasks):
        self.tasks = tasks
        self.applied = []

    def pollable_items(self):
        return list(self.tasks)

    def set_meta(self, *args):
        pass

    def apply_observation(self, task_id, observation, started_at):
        self.applied.append((task_id, None, observation, started_at))
        return {"applied": True}

    def apply_session_observation(self, task_id, session_id, observation, started_at):
        self.applied.append((task_id, session_id, observation, started_at))
        return {"applied": True}


class ControlledExecutor:
    def __init__(self):
        self.jobs = []

    def submit(self, fn, task=None):
        future = Future()
        self.jobs.append((future, fn, task))
        return future

    def finish(self, index):
        future, fn, task = self.jobs[index]
        future.set_result(fn(task) if task is not None else fn())

    def shutdown(self, **kwargs):
        pass


class CollectorCadenceTests(unittest.TestCase):
    def setUp(self):
        self.clock = 10.0
        self.patch = patch("orchestra.collector.time.monotonic", side_effect=lambda: self.clock)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def collector(self, tasks=None, workers=4):
        ledger = MemoryLedger(tasks or [{"id": "T100", "thread_id": "main"}])
        collector = Collector(ledger, interval=5, workers=workers,
                              bridge_fn=lambda *args: {"sourceAt": "2026-11-01T00:00:00+00:00"})
        collector._executor.shutdown(wait=True)
        collector._executor = ControlledExecutor()
        self.addCleanup(collector.close)
        return collector, ledger

    def test_slow_completion_does_not_add_bridge_duration_to_interval(self):
        collector, _ = self.collector()
        self.assertEqual(collector._submit_available(), 1)
        self.clock = 11.6
        collector._executor.finish(0)
        self.assertEqual(collector._drain(0), 1)
        self.clock = 14.99
        self.assertEqual(collector._submit_available(), 0)
        self.clock = 15.0
        self.assertEqual(collector._submit_available(), 1)

    def test_idle_scan_does_not_skip_known_due_time(self):
        collector, _ = self.collector()
        collector._submit_available()
        self.clock = 10.03
        collector._executor.finish(0)
        collector._drain(0)
        self.clock = 14.2
        self.assertEqual(collector._submit_available(), 0)
        self.assertLessEqual(collector._next_scan, 15.0)

    def test_overdue_slow_task_never_overlaps_and_other_item_gets_slot(self):
        tasks = [{"id": "T100", "thread_id": "slow"}, {"id": "T101", "thread_id": "fast"}]
        collector, _ = self.collector(tasks, workers=2)
        self.assertEqual(collector._submit_available(), 2)
        self.clock = 10.1
        collector._executor.finish(1)
        collector._drain(0)
        self.clock = 15.1
        self.assertEqual(collector._submit_available(), 1)
        self.assertEqual([task["id"] for _, _, task in collector._executor.jobs], ["T100", "T101", "T101"])
        self.assertEqual(len(collector._inflight), 2)
        self.clock = 18.0
        collector._executor.finish(0)
        collector._drain(0)
        self.assertEqual(collector._submit_available(), 1)
        self.assertEqual(len(collector._inflight), 2)

    def test_removed_item_does_not_force_busy_scan(self):
        collector, ledger = self.collector()
        collector._submit_available()
        self.clock = 11
        collector._executor.finish(0)
        collector._drain(0)
        ledger.tasks.clear()
        self.clock = 20
        collector._submit_available()
        self.assertEqual(collector._next_scan, 21)

    def test_main_and_session_keep_independent_due_and_original_timestamps(self):
        tasks = [{"id": "T100", "thread_id": "main"},
                 {"id": "T100", "thread_id": "session", "session_id": "worker"}]
        collector, ledger = self.collector(tasks)
        collector._submit_available()
        self.clock = 10.1
        collector._executor.finish(0)
        collector._executor.finish(1)
        collector._drain(0)
        self.assertEqual({row[1] for row in ledger.applied}, {None, "worker"})
        for _, _, observation, started_at in ledger.applied:
            self.assertEqual(observation["sourceAt"], "2026-11-01T00:00:00+00:00")
            self.assertNotEqual(started_at, observation["sourceAt"])
        self.assertEqual(set(collector._due), {"T100|", "T100|worker"})

    def test_receipt_recovery_keeps_shared_executor_and_independent_cadence(self):
        class RecoveryProbe(ReceiptRecoveryCollector):
            def _recover_receipts(self):
                return "recovered"

        ledger = MemoryLedger([{"id": "T100", "thread_id": "main"}])
        collector = RecoveryProbe(ledger, interval=5, workers=4,
                                  recovery_adapter=object(), bridge_fn=lambda *args: {})
        collector._executor.shutdown(wait=True)
        collector._executor = ControlledExecutor()
        self.addCleanup(collector.close)
        collector._submit_available()
        executor = collector._executor
        first_recovery = collector._receipt_recovery_future
        self.assertIs(first_recovery, executor.jobs[0][0])
        self.assertEqual(len(executor.jobs), 2)
        self.clock = 11.6
        executor.finish(1)
        collector._drain(0)
        self.clock = 15
        # A pending recovery is not duplicated; native observation still runs.
        self.assertEqual(collector._submit_available(), 1)
        self.assertEqual(len(executor.jobs), 3)
        self.assertIs(collector._receipt_recovery_future, first_recovery)
        executor.finish(0)
        collector._drain(0)
        self.assertIs(collector._executor, executor)
        self.assertEqual(len(executor.jobs), 4)
        self.assertIs(collector._receipt_recovery_future, executor.jobs[3][0])
        self.assertEqual(collector._receipt_recovery_due, 20)


if __name__ == "__main__":
    unittest.main()
