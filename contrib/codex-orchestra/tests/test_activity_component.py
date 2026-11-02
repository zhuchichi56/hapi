"""Synthetic SQLite fixtures only; never import or open the production ledger."""

import copy
import json
import sqlite3
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from orchestra.activity import activity_snapshot, attach_activity

NOW = "2026-11-02T00:10:00+08:00"


class SyntheticLedger:
    def __init__(self, path):
        self.path = path
        self.statements = []
        self.connections = []

    def _connect(self):
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        connection.set_trace_callback(self.statements.append)
        self.connections.append(connection)
        return connection


class ActivityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = str(Path(self.temporary.name) / "synthetic.sqlite")
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, thread_id TEXT,
                                execution TEXT, review TEXT, archive TEXT);
            CREATE TABLE operations (op_id TEXT PRIMARY KEY, task_id TEXT,
                kind TEXT, status TEXT, payload TEXT, created_at TEXT, updated_at TEXT);
        """)
        self.db.executemany("INSERT INTO tasks VALUES (?,?,?,?,?,?)", [
            ("task-a", "Synthetic alpha", "thread-a", "running", "pending", "none"),
            ("task-b", "Synthetic beta", "thread-b", "completed", "accepted", "archived"),
            ("task-c", "Synthetic gamma", None, "failed", "rejected", "none"),
        ])
        self.db.commit()
        self.ledger = SyntheticLedger(self.path)

    def op(self, op_id, task="task-a", kind="dispatch_intent", status="reconciled",
           payload=None, created="2026-11-01T10:00:00Z", updated=None):
        self.db.execute("INSERT INTO operations VALUES (?,?,?,?,?,?,?)", (
            op_id, task, kind, status, json.dumps(payload if payload is not None else {"threadId": "thread-a"}),
            created, created if updated is None else updated))
        self.db.commit()

    def snapshot(self, catalog=None, now=NOW):
        return activity_snapshot(self.ledger, catalog=catalog, now=now)

    def day(self, result, date):
        return next(day for day in result["days"] if day["date"] == date)

    def attestation(self, task="task-a", review="review-a", **changes):
        return {"taskId": task, "reviewOpId": review, "goalSatisfied": True,
                "evidence": "Synthetic whole-goal verification", **changes}

    def review(self, op_id="review-a", **kwargs):
        self.op(op_id, kind="review", status="recorded", payload={"result": "accepted"}, **kwargs)

    def test_timezone_midnight_seconds_milliseconds_and_iso(self):
        before = datetime(2026, 11, 1, 15, 59, 59, tzinfo=timezone.utc).timestamp()
        self.op("before", payload={"threadId": "before"}, updated=before)
        self.op("after", payload={"threadId": "after"}, updated=(before + 1) * 1000)
        self.op("iso", payload={"threadId": "iso"}, updated="2026-11-01T16:00:01Z")
        result = self.snapshot()
        self.assertEqual(len(result["days"]), 84)
        self.assertEqual(result["from"], "2026-08-11")
        self.assertEqual(result["today"], "2026-11-02")
        self.assertEqual(len(self.day(result, "2026-11-01")["dispatches"]), 1)
        self.assertEqual(len(self.day(result, "2026-11-02")["dispatches"]), 2)

    def test_duplicate_dispatch_earliest_confirmation_and_bound_thread_only(self):
        self.op("later", updated="2026-11-01T16:01:00Z")
        self.op("earlier", updated="2026-11-01T15:59:00Z")
        self.op("different-thread", payload={"threadId": "thread-other"})
        self.op("different-task", task="task-b")
        result = self.snapshot()
        self.assertEqual(len(self.day(result, "2026-11-01")["dispatches"]), 3)
        self.assertEqual(len(self.day(result, "2026-11-02")["dispatches"]), 0)
        event = self.day(result, "2026-11-01")["dispatches"][0]
        self.assertEqual(set(event), {"taskId", "title", "threadId", "eventId"})
        self.assertNotIn("earlier", json.dumps(result))

    def test_pending_failed_missing_thread_notifications_and_native_states_excluded(self):
        for status in ("pending", "failed", "recorded"):
            self.op(status, status=status)
        self.op("notice", kind="notification")
        self.op("no-thread", payload={})
        self.op("empty-thread", payload={"threadId": " "})
        self.op("non-string-thread", payload={"threadId": 123})
        self.op("future", updated="2026-12-01T00:00:00Z")
        self.op("naive", updated="2026-11-01T20:00:00")
        result = self.snapshot()
        self.assertEqual(sum(len(day["dispatches"]) for day in result["days"]), 0)
        self.assertEqual(sum(len(day["completions"]) for day in result["days"]), 0)

    def test_stage_acceptance_is_not_whole_goal_completion(self):
        self.review()
        self.review("stage-b", task="task-b")
        for catalog in (None, {}, {"goalCompletions": []}):
            result = self.snapshot(catalog)
            self.assertEqual(sum(len(day["completions"]) for day in result["days"]), 0)
            self.assertEqual(result["coverage"]["completion"], "explicit-attestations-only")

    def test_attestation_requires_same_task_accepted_recorded_review_and_evidence(self):
        self.review()
        self.op("rejected", kind="review", status="recorded", payload={"result": "rejected"})
        self.op("pending-review", kind="review", status="pending", payload={"result": "accepted"})
        invalid = [self.attestation(task="task-b"), self.attestation(review="missing"),
                   self.attestation(review="rejected"), self.attestation(review="pending-review"),
                   self.attestation(goalSatisfied=1), self.attestation(goalSatisfied=False),
                   self.attestation(evidence=" "), self.attestation(evidence=[])]
        result = self.snapshot({"goalCompletions": invalid})
        self.assertEqual(sum(len(day["completions"]) for day in result["days"]), 0)
        result = self.snapshot({"goalCompletions": invalid + [self.attestation()]})
        self.assertEqual(sum(len(day["completions"]) for day in result["days"]), 1)

    def test_completion_once_per_task_earliest_attested_review(self):
        self.review("late", created="2026-11-01T16:01:00Z")
        self.review("early", created="2026-11-01T15:59:00Z", updated="2026-11-01T16:05:00Z")
        catalog = {"goalCompletions": [self.attestation(review="late"),
                                      self.attestation(review="early"), self.attestation(review="early")]}
        result = self.snapshot(catalog)
        self.assertEqual(len(self.day(result, "2026-11-01")["completions"]), 1)
        self.assertEqual(len(self.day(result, "2026-11-02")["completions"]), 0)

    def test_deduplicate_before_window_and_preledger_history_unknown(self):
        self.op("old", created="2026-08-01T00:00:00Z")
        self.op("repeat", created="2026-11-01T00:00:00Z")
        self.assertEqual(sum(len(day["dispatches"]) for day in self.snapshot()["days"]), 0)
        self.db.execute("DELETE FROM operations")
        self.db.commit()
        self.assertTrue(all(not day["recorded"] for day in self.snapshot()["days"]))
        self.op("first", kind="notification", status="recorded", created="2026-10-30T16:00:00Z")
        result = self.snapshot()
        self.assertEqual(result["coverage"]["dispatchFrom"], "2026-10-31")
        self.assertFalse(self.day(result, "2026-10-30")["recorded"])
        self.assertTrue(self.day(result, "2026-10-31")["recorded"])

    def test_only_reads_original_snapshot_and_database_unchanged_connections_closed(self):
        self.op("synthetic-bind")
        original = {"tasks": [{"id": "task-a", "execution": "running"}], "other": ["kept"]}
        before = copy.deepcopy(original)
        before_db = list(self.db.iterdump())
        result = attach_activity(original, self.ledger, now=NOW)
        self.assertEqual(original, before)
        self.assertIs(result["tasks"], original["tasks"])
        self.assertEqual(before_db, list(self.db.iterdump()))
        self.assertTrue(all(statement.lstrip().startswith(("SELECT", "BEGIN")) for statement in self.ledger.statements))
        for connection in self.ledger.connections:
            with self.assertRaises(sqlite3.ProgrammingError):
                connection.execute("SELECT 1")

    def test_failure_does_not_hide_original_tasks_or_leak_details(self):
        class BrokenLedger:
            def _connect(self):
                raise OSError("synthetic private detail")
        original = {"tasks": [{"id": "task-a"}]}
        result = attach_activity(original, BrokenLedger(), now=NOW)
        self.assertEqual(result["tasks"], original["tasks"])
        self.assertEqual(result["activity"], {"available": False, "error": "activity_unavailable"})
        self.assertNotIn("private", json.dumps(result))

    def test_select_failure_still_closes_connection(self):
        class BrokenConnection:
            closed = False

            def execute(self, statement):
                raise sqlite3.DatabaseError("synthetic private detail")

            def close(self):
                self.closed = True

        connection = BrokenConnection()
        with patch.object(self.ledger, "_connect", return_value=connection):
            self.assertEqual(self.snapshot(), {"available": False, "error": "activity_unavailable"})
        self.assertTrue(connection.closed)

    def test_wire_cap_is_explicit_error_and_never_silent_truncation(self):
        self.op("bind", payload={"threadId": "thread-a", "evidence": "synthetic secret", "path": "/synthetic/private"})
        self.assertNotIn("synthetic secret", json.dumps(self.snapshot()))
        self.assertNotIn("/synthetic/private", json.dumps(self.snapshot()))
        with patch("orchestra.activity.WIRE_LIMIT", 1):
            self.assertEqual(self.snapshot(), {"available": False, "error": "activity_too_large"})

    def test_invalid_operation_created_time_uses_valid_confirmation_for_coverage(self):
        self.op("bad-created", created="invalid", updated="2026-11-01T16:01:00Z")
        result = self.snapshot()
        self.assertEqual(result["coverage"]["dispatchFrom"], "2026-11-02")
        self.assertTrue(self.day(result, "2026-11-02")["recorded"])
        self.assertEqual(len(self.day(result, "2026-11-02")["dispatches"]), 1)

    def test_exact_window_start_and_future_history(self):
        self.op("start", created="2026-08-10T16:00:00Z")
        self.op("future-operation", payload={"threadId": "future-thread"}, created="2027-01-01T00:00:00Z")
        result = self.snapshot()
        self.assertEqual(len(result["days"][0]["dispatches"]), 1)
        self.assertTrue(result["days"][0]["recorded"])
        self.assertEqual(sum(len(day["dispatches"]) for day in result["days"]), 1)

    def test_corrupt_json_invalid_dates_and_orphans_do_not_fabricate_events(self):
        self.op("corrupt")
        self.db.execute("UPDATE operations SET payload='{' WHERE op_id='corrupt'")
        self.db.commit()
        self.op("orphan", task="missing-task")
        self.op("bad-time", updated="not-a-time")
        self.op("array-json", payload=["thread-a"])
        result = self.snapshot()
        self.assertEqual(sum(len(day["dispatches"]) for day in result["days"]), 0)
        self.assertEqual(self.snapshot(now="invalid"), {"available": False, "error": "activity_invalid_time"})


if __name__ == "__main__":
    unittest.main()
