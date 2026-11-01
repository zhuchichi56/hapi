"""Meaningful unittest coverage for the local Codex Orchestra backend.

Run: python3 -m unittest -v test_orchestra.py
All state lives in temporary directories; no native chats are created.
"""

import json
import os
import socket
import sqlite3
import stat
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta, timezone

from orchestra.archive import run_archive, _action_id
from orchestra.bridge import sanitize_read_response
from orchestra.collector import Collector
from orchestra.constants import (CONTROLLER_THREAD_ID, T008_THREAD_ID,
                                 IMPORT_SOURCE_OBSERVED_AT)
from orchestra.errors import BridgeError, NotFoundError, TransitionError, ValidationError
from orchestra.ledger import Ledger
from orchestra.server import start_snapshot_server, stop_snapshot_server
from orchestra.bridge import UnixHTTPConnection
from orchestra.util import now_iso, parse_iso

FIXTURE = """# 任务总览

| 编号 | 任务与交付物 | 工作对话 ID / 链接 | 状态 | 负责范围与验收标准 | 预计交付 / 检查点 | 证据、阻碍或下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| T001 | 实现 A；交付 [A 文件](a.md) | [工作对话](codex://threads/11111111-1111-1111-1111-111111111111)（`11111111-1111-1111-1111-111111111111`） | 已验收、已归档 | 范围 A；验收 A | 30 分钟 | 证据 A |
| T002 | 实现 B；交付 B 文件 | [工作对话](codex://threads/22222222-2222-2222-2222-222222222222) | 已验收、已归档 | 范围 B；验收 B | 30 分钟 | 证据 B |
| T003 | 实现 C；交付 C 文件 | [工作对话](codex://threads/33333333-3333-3333-3333-333333333333) | 已验收、已归档 | 范围 C；验收 C | 30 分钟 | 证据 C |
| T004 | 待派发 D | 待创建 | 待派发 | 范围 D；验收 D | 未启动 | 尚未创建，不能算执行中 |
| T005 | 待派发 E | 待创建 | 待派发 | 范围 E；验收 E | 未启动 | 尚未创建，不能算执行中 |
| T006 | 实现 F；交付 F 文件 | [工作对话](codex://threads/66666666-6666-6666-6666-666666666666) | 已验收、已归档 | 范围 F；验收 F | 30 分钟 | 证据 F |
| T007 | 实现 G；交付 G 文件 | [工作对话](codex://threads/77777777-7777-7777-7777-777777777777) | 已验收、已归档 | 范围 G；验收 G | 30 分钟 | 证据 G |
| T008 | 实现 H | [工作对话](codex://threads/88888888-8888-8888-8888-888888888888) | 执行中 | 范围 H；验收 H | 02:54 | 证据 H |

状态：待澄清 → 待派发 → 执行中 → 待验收 → 已验收。

## 既有任务跟踪

| 任务 | 核对时状态 | 正在做什么 / 最新交付 | 下一验收点 |
| --- | --- | --- | --- |
| [外部任务一](codex://threads/99999999-9999-9999-9999-999999999999) | 执行中 | 公开进度一 | 验收点一 |
| 外部任务二 | 当前轮次已结束 | 公开进度二 | 验收点二 |
"""


def make_task(ledger, task_id="T100", thread_id="aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", **overrides):
    payload = {
        "id": task_id,
        "title": "测试任务 %s" % task_id,
        "goal": "验证账本行为",
        "deliverables": ["out.txt"],
        "acceptance": ["测试通过"],
        "ownership": ["本任务文件"],
        "authorization": "unit test",
        "threadId": thread_id,
        "host": "local",
        "createdAt": now_iso(),
        "checkpoint": "checkpoint",
        "expectedAt": None,
        "execution": "queued",
        "review": "pending",
        "archive": "none",
    }
    payload.update(overrides)
    return ledger.register(payload)


def observation(
    turn_status="completed",
    turn_id="turn-1",
    revision="rev-1",
    live=True,
    status="active",
    assistant="公开进展",
    latest_action="assistant:final",
):
    return {
        "threadId": "x",
        "live": live,
        "status": status,
        "revision": revision,
        "turnId": turn_id,
        "turnStatus": turn_status,
        "assistantText": assistant,
        "assistantPhase": "final",
        "latestAction": latest_action,
    }


def t(seconds=0):
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat(
        timespec="microseconds"
    )


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.source = os.path.join(self.tmp.name, "任务总览.md")
        with open(self.source, "w", encoding="utf-8") as handle:
            handle.write(FIXTURE)
        self.mtime = datetime(2026, 11, 2, 0, 53, tzinfo=timezone.utc).timestamp()
        os.utime(self.source, (self.mtime, self.mtime))
        self.ledger = Ledger(os.path.join(self.tmp.name, "state"))

    def test_import_semantics_timestamps_and_readonly_external(self):
        with open(self.source, "rb") as handle:
            before = handle.read()
        result = self.ledger.import_markdown(self.source)
        with open(self.source, "rb") as handle:
            after = handle.read()
        self.assertEqual(before, after, "import must not edit the source markdown")
        self.assertEqual(result["created"], 8)
        self.assertEqual(result["external"], 2)

        tasks = {task["id"]: task for task in self.ledger.list_tasks()}
        for task_id in ("T001", "T002", "T003", "T006", "T007"):
            self.assertEqual(tasks[task_id]["execution"], "reported")
            self.assertEqual(tasks[task_id]["review"], "accepted")
            self.assertEqual(tasks[task_id]["archive"], "archived")
        for task_id in ("T004", "T005"):
            self.assertEqual(tasks[task_id]["execution"], "queued")
            self.assertEqual(tasks[task_id]["thread_id"], None)
            self.assertEqual(tasks[task_id]["poll"], 0)
        self.assertEqual(tasks["T008"]["execution"], "running")
        self.assertEqual(
            tasks["T008"]["thread_id"], "88888888-8888-8888-8888-888888888888"
        )

        # Main-table provenance is source file mtime, never the frozen 13:27
        # external-history snapshot; queued/running rows have no observation.
        expected_mtime = parse_iso(
            datetime.fromtimestamp(self.mtime, timezone.utc).isoformat()
        )
        for task_id, task in tasks.items():
            self.assertEqual(parse_iso(task["source_at"]), expected_mtime)
        for task_id in ("T004", "T005", "T008"):
            self.assertIsNone(tasks[task_id]["observed_at"])
        for task_id in ("T001", "T002", "T003", "T006", "T007"):
            self.assertEqual(tasks[task_id]["observed_at"], tasks[task_id]["source_at"])
            self.assertNotEqual(
                tasks[task_id]["source_at"], "2026-11-01T13:27:00+08:00"
            )

        snapshot = self.ledger.snapshot()
        external = [task for task in snapshot["tasks"] if task["external"]]
        self.assertEqual(len(external), 2)
        self.assertTrue(all(task["stale"] for task in external))
        self.assertEqual(external[0]["observedAt"], IMPORT_SOURCE_OBSERVED_AT)
        # accepted+archived imports and queued unbound tasks are not polled
        pollable = {task["id"] for task in self.ledger.pollable_tasks()}
        self.assertEqual(pollable, {"T008"})

        # Re-import is idempotent for task rows and refreshes read-only external data.
        second = self.ledger.import_markdown(self.source)
        self.assertEqual(second["created"], 0)
        self.assertEqual(second["skipped"], 8)
        self.assertEqual(len(self.ledger.list_tasks()), 8)
        self.assertEqual(self.ledger.get_task("T001")["review"], "accepted")

        for action in (
            lambda: self.ledger.review("EXT001", "accepted", "x", "op-ext-review"),
            lambda: self.ledger.archive_request("EXT001", "op-ext-archive"),
            lambda: self.ledger.dispatch_intent("EXT001", "op-ext-dispatch"),
        ):
            with self.assertRaises(TransitionError):
                action()

    def test_export_md_never_overwrites_source(self):
        self.ledger.import_markdown(self.source)
        with self.assertRaises(TransitionError):
            self.ledger.export_markdown(self.source, force=True)
        output = os.path.join(self.tmp.name, "derived.md")
        self.assertTrue(self.ledger.export_markdown(output))
        with open(output, encoding="utf-8") as handle:
            text = handle.read()
        self.assertIn("T008", text)
        self.assertIn("只读外部历史快照", text)
        with self.assertRaises(TransitionError):
            self.ledger.export_markdown(output)  # explicit no-clobber default
        self.assertTrue(self.ledger.export_markdown(output, force=True))


class ObservationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Ledger(os.path.join(self.tmp.name, "state"))
        make_task(self.ledger)

    def test_returned_work_enters_review_only_for_a_new_completed_turn(self):
        self.ledger.apply_observation("T100", observation(turn_id="old"), t())
        self.ledger.review("T100", "rejected", "Missing output", "reject-1")
        self.ledger.apply_observation("T100", observation(turn_id="old", revision="changed"), t(1))
        self.assertEqual(self.ledger.get_task("T100")["review"], "rejected")
        self.ledger.apply_observation("T100", observation(turn_id="new"), t(2))
        self.assertEqual(self.ledger.get_task("T100")["review"], "awaiting")

    def test_archive_action_ids_do_not_collapse_punctuation(self):
        self.assertNotEqual(_action_id("a:b", 1), _action_id("a-b", 1))
        self.assertRegex(_action_id("a:b", 1), r"^[A-Za-z0-9_-]{1,128}$")

    def test_native_observation_does_not_inherit_import_file_time(self):
        # A native turn without a source timestamp must leave it unknown.
        connection = self.ledger._connect()
        with connection:
            connection.execute("UPDATE tasks SET source_at=? WHERE id='T100'", (t(-500),))
        connection.close()
        self.ledger.apply_observation("T100", observation(), t())
        self.assertIsNone(self.ledger.get_task("T100")["source_at"])

    def test_native_final_answer_phase_is_public_delivery_text(self):
        safe = sanitize_read_response({"ok": True, "result": {"id": "x", "live": False, "turns": [{"id": "turn-x", "status": "completed", "items": [{"role": "assistant", "phase": "final_answer", "text": "Real final result"}]}]}}, "x")
        self.assertEqual(safe["assistantText"], "Real final result")
        self.assertEqual(safe["assistantPhase"], "final")

    def test_completed_live_false_goes_to_awaiting_not_accepted(self):
        # Real archived chats return live=false/status=notLoaded but an explicit
        # completed latest turn. That is a valid delivery, not a broken read.
        result = self.ledger.apply_observation(
            "T100",
            observation(
                turn_status="completed",
                live=False,
                status="notLoaded",
                revision="rev-complete",
                turn_id="turn-complete",
            ),
            t(),
        )
        self.assertTrue(result["applied"])
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["archive"], "none")
        self.assertIsNone(task["last_error"])
        self.assertEqual(len(self.ledger.consume_notices()), 1)

    def test_failure_idle_and_unowned_inprogress_never_complete(self):
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="inProgress", turn_id="turn-run"),
            t(),
        )
        self.assertEqual(self.ledger.get_task("T100")["execution"], "running")

        self.ledger.apply_observation(
            "T100",
            observation(turn_status="failed", turn_id="turn-fail", revision="r-fail"),
            t(1),
        )
        failed = self.ledger.get_task("T100")
        self.assertEqual(failed["execution"], "failed")
        self.assertEqual(failed["review"], "pending")
        self.assertNotEqual(failed["execution"], "reported")
        self.assertEqual(
            [notice["kind"] for notice in self.ledger.consume_notices()], ["blocked"]
        )

        self.ledger.apply_observation(
            "T100",
            observation(
                turn_status="inProgress",
                live=False,
                status="idle",
                turn_id="turn-idle",
                revision="r-idle",
            ),
            t(2),
        )
        idle = self.ledger.get_task("T100")
        self.assertEqual(idle["execution"], "unknown")
        self.assertIn("no live owner", idle["last_error"])
        self.assertNotEqual(idle["execution"], "reported")
        self.assertTrue(self.ledger.snapshot()["tasks"][0]["stale"])

    def test_disconnect_retains_state_and_marks_stale(self):
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-done", revision="r1"),
            t(),
        )
        before = self.ledger.get_task("T100")
        self.ledger.record_observation_error("T100", BridgeError("timeout"), t(1))
        after = self.ledger.get_task("T100")
        self.assertEqual(after["execution"], "reported")
        self.assertEqual(after["observed_at"], before["observed_at"])
        self.assertIn("timeout", after["last_error"])
        snapshot = self.ledger.snapshot()
        self.assertTrue(snapshot["tasks"][0]["stale"])
        self.assertIn("T100", snapshot["collector"]["taskErrors"])

    def test_out_of_order_callback_is_ignored(self):
        newer = t(10)
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-new", revision="r-new"),
            newer,
        )
        outcome = self.ledger.apply_observation(
            "T100",
            observation(turn_status="failed", turn_id="turn-old", revision="r-old"),
            t(5),
        )
        self.assertFalse(outcome["applied"])
        self.assertEqual(outcome["reason"], "outdated")
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["source_revision"], "r-new")
        self.assertEqual(task["source_turn_id"], "turn-new")

    def test_unknown_never_overwrites_verified_delivery(self):
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-done", revision="r1"),
            t(),
        )
        self.ledger.apply_observation(
            "T100",
            observation(turn_status=None, turn_id=None, revision="r2"),
            t(1),
        )
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertIn("last known delivery retained", task["last_error"])

    def test_collector_view_connected_stale_and_last_success(self):
        observed = t()
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-view", revision="r1"),
            observed,
        )
        self.ledger.set_meta("daemon_pid", os.getpid())
        self.ledger.set_meta("last_poll_at", now_iso())
        collector = self.ledger.snapshot()["collector"]
        for key in (
            "source",
            "connected",
            "stale",
            "lastSuccessAt",
            "lastObservedAt",
            "running",
            "lastPollAt",
            "taskErrors",
        ):
            self.assertIn(key, collector)
        self.assertNotIn("bridgeSocket", collector)
        self.assertEqual(collector["source"], "native-desktop-bridge")
        self.assertTrue(collector["connected"])
        self.assertFalse(collector["stale"])
        self.assertEqual(collector["lastSuccessAt"], observed)
        self.assertEqual(collector["lastObservedAt"], observed)

        old = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat(
            timespec="microseconds"
        )
        self.ledger.set_meta("last_poll_at", old)
        expired = self.ledger.snapshot()["collector"]
        self.assertFalse(expired["connected"])
        self.assertTrue(expired["stale"])

    def test_notice_dedup_is_per_turn_and_survives_restart(self):
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-one", revision="r1"),
            t(),
        )
        # Same completed turn, newer revision -> still exactly one delivery.
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-one", revision="r2"),
            t(1),
        )
        self.assertEqual(len(self.ledger.consume_notices()), 1)

        restarted = Ledger(os.path.join(self.tmp.name, "state"))
        restarted.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-one", revision="r3"),
            t(2),
        )
        self.assertEqual(len(restarted.consume_notices()), 1)
        self.assertEqual(restarted.get_task("T100")["source_revision"], "r3")

        restarted.apply_observation(
            "T100",
            observation(turn_status="completed", turn_id="turn-two", revision="r4"),
            t(3),
        )
        notices = restarted.consume_notices()
        self.assertEqual(len(notices), 2)
        restarted.ack_notice(notices[0]["id"])
        self.assertEqual(len(restarted.consume_notices()), 1)
        third = Ledger(os.path.join(self.tmp.name, "state"))
        self.assertEqual(len(third.consume_notices()), 1)
        self.assertEqual(
            third.get_task("T100")["source_revision"], "r4"
        )

    def test_private_snapshot_has_no_user_tool_or_reasoning_text(self):
        raw = {
            "ok": True,
            "result": {
                "id": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                "status": "active",
                "live": True,
                "revision": "rev-private",
                "turns": [
                    {
                        "id": "turn-private",
                        "status": "completed",
                        "items": [
                            {"role": "user", "text": "USER_SECRET_ABC"},
                            {
                                "role": "tool",
                                "text": "TOOL_SECRET_DEF --token FAKE_TOKEN_XYZ",
                                "status": "completed",
                            },
                            {
                                "role": "assistant",
                                "phase": "commentary",
                                "text": "ASSISTANT_VISIBLE_PROGRESS",
                            },
                        ],
                    }
                ],
            },
        }
        safe = sanitize_read_response(
            raw, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
        )
        self.ledger.apply_observation("T100", safe, t())
        snapshot_text = json.dumps(self.ledger.snapshot(), ensure_ascii=False)
        self.assertNotIn("USER_SECRET_ABC", snapshot_text)
        self.assertNotIn("TOOL_SECRET_DEF", snapshot_text)
        self.assertNotIn("FAKE_TOKEN_XYZ", snapshot_text)
        self.assertNotIn("reasoning", snapshot_text.lower())
        self.assertIn("ASSISTANT_VISIBLE_PROGRESS", snapshot_text)
        self.assertIn("assistant:commentary", snapshot_text)
        # Also ensure raw secrets never reached the database.
        db = sqlite3.connect(os.path.join(self.tmp.name, "state", "orchestra.db"))
        try:
            dump = "\n".join(
                str(row)
                for table in ("tasks", "operations", "notices", "external_history")
                for row in db.execute("SELECT * FROM %s" % table)
            )
        finally:
            db.close()
        self.assertNotIn("USER_SECRET_ABC", dump)
        self.assertNotIn("TOOL_SECRET_DEF", dump)
        self.assertNotIn("FAKE_TOKEN_XYZ", dump)


class TransitionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Ledger(os.path.join(self.tmp.name, "state"))

    def test_review_requires_delivery_and_then_archive_receipt_survives(self):
        make_task(self.ledger, thread_id="bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
        with self.assertRaises(TransitionError):
            self.ledger.review("T100", "accepted", "not delivered", "review-fail")

        self.ledger.apply_observation(
            "T100", observation(turn_id="turn-final", revision="r1"), t()
        )
        self.ledger.review("T100", "accepted", "verified output", "review-ok")
        self.ledger.archive_request("T100", "archive-request-1")
        self.ledger.archive_receipt(
            "T100", "archive-receipt-1", "confirmed", "native archive confirmed"
        )
        task = self.ledger.get_task("T100")
        self.assertEqual(task["archive"], "archived")
        self.assertEqual(task["review"], "accepted")

        # A later observation cannot overwrite accepted/archived state.
        self.ledger.apply_observation(
            "T100",
            observation(turn_status="failed", turn_id="turn-later", revision="r2"),
            t(1),
        )
        task = self.ledger.get_task("T100")
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["archive"], "archived")
        repeated = self.ledger.archive_request("T100", "archive-request-2")
        self.assertTrue(repeated["reused"])
        self.assertEqual(repeated["archive"], "archived")
        with self.assertRaises(TransitionError):
            self.ledger.review("T100", "rejected", "late", "review-late")

    def test_duplicate_op_id_cannot_perform_twice(self):
        make_task(self.ledger, thread_id=None)
        first = self.ledger.dispatch_intent("T100", "dispatch-1")
        self.assertFalse(first["reused"])
        again = self.ledger.dispatch_intent("T100", "dispatch-1")
        self.assertTrue(again["reused"])
        second_identity = self.ledger.dispatch_intent("T100", "dispatch-2")
        self.assertTrue(second_identity["reused"])
        self.assertEqual(second_identity["operation"]["opId"], "dispatch-1")
        self.assertEqual(len(self.ledger.snapshot()["operations"]), 1)

        self.ledger.dispatch_pending(
            "T100", "dispatch-1", "client-thread-0001"
        )
        restarted = Ledger(os.path.join(self.tmp.name, "state"))
        pending = restarted.get_operation("dispatch-1")
        self.assertEqual(pending["payload"]["clientThreadId"], "client-thread-0001")
        # Pending is not permission to create again: same intent is returned.
        retry = restarted.dispatch_intent("T100", "dispatch-3")
        self.assertTrue(retry["reused"])
        self.assertEqual(retry["operation"]["opId"], "dispatch-1")
        self.assertEqual(len(restarted.snapshot()["operations"]), 1)

        restarted.bind("T100", "dispatch-1", "dddddddd-dddd-dddd-dddd-dddddddddddd")
        with self.assertRaises(TransitionError):
            restarted.bind("T100", "dispatch-1", "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")
        with self.assertRaises(TransitionError):
            restarted.review("T100", "accepted", "x", "dispatch-1")

        restarted.apply_observation(
            "T100", observation(turn_id="turn-1", revision="r1"), t()
        )
        restarted.review("T100", "accepted", "ok", "review-1")
        restarted.archive_request("T100", "archive-1")
        restarted.archive_receipt("T100", "receipt-1", "confirmed", "ok")
        with self.assertRaises(TransitionError):
            restarted.archive_receipt("T100", "receipt-1", "failed", "different")
        self.assertEqual(restarted.get_task("T100")["archive"], "archived")

    def test_contract_update_cannot_mutate_identity_or_state(self):
        make_task(self.ledger, thread_id="ffffffff-ffff-ffff-ffff-ffffffffffff")
        result = self.ledger.update_contract(
            "T100",
            {
                "goal": "new goal",
                "checkpoint": "02:54",
                "expectedAt": "2026-11-02T02:54:00+08:00",
                "deliverables": ["a", "b"],
                "evidence": ["explicit note"],
            },
        )
        self.assertTrue(result["updated"])
        task = self.ledger.get_task("T100")
        self.assertEqual(task["goal"], "new goal")
        self.assertEqual(task["deliverables"], ["a", "b"])
        self.assertEqual(task["thread_id"], "ffffffff-ffff-ffff-ffff-ffffffffffff")
        with self.assertRaises(ValidationError):
            self.ledger.update_contract("T100", {"threadId": "new"})
        with self.assertRaises(ValidationError):
            self.ledger.update_contract("T100", {"execution": "reported"})

    def test_controller_and_t008_archive_protection(self):
        self.ledger.register(
            {
                "id": "CTRL",
                "title": "controller",
                "threadId": CONTROLLER_THREAD_ID,
                "execution": "reported",
                "review": "accepted",
            }
        )
        with self.assertRaises(TransitionError):
            self.ledger.archive_request("CTRL", "ctrl-archive")

        self.ledger.register(
            {
                "id": "T008",
                "title": "implementation",
                "threadId": T008_THREAD_ID,
                "execution": "running",
            }
        )
        with self.assertRaises(TransitionError):
            self.ledger.archive_request("T008", "t008-early")
        self.ledger.apply_observation(
            "T008",
            observation(turn_status="completed", live=False, status="notLoaded"),
            t(),
        )
        self.ledger.review("T008", "accepted", "parent accepted handoff", "t008-review")
        # After the parent accepts, the implementation chat is no longer
        # permanently blocked from archive; only the controller remains so.
        requested = self.ledger.archive_request("T008", "t008-after-accept")
        self.assertEqual(requested["operation"]["status"], "pending")


class FakeArchiveClient:
    def __init__(self, outcome="confirmed", archived=False):
        self.outcome = outcome
        self.archived = archived
        self.writes = []
        self.list_calls = 0

    def is_archived(self, thread_id):
        self.list_calls += 1
        return self.archived

    def archive(self, thread_id, action_id):
        self.writes.append((thread_id, action_id))
        return {"outcome": self.outcome, "detail": "fake injected client"}


class ArchiveRunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Ledger(os.path.join(self.tmp.name, "state"))
        make_task(self.ledger, thread_id="abababab-abab-abab-abab-abababababab")
        self.ledger.apply_observation(
            "T100", observation(turn_id="turn-final", revision="r1"), t()
        )
        self.ledger.review("T100", "accepted", "verified", "review")
        self.ledger.archive_request("T100", "archive-op")

    def test_confirmed_write_once_and_list_preflight(self):
        client = FakeArchiveClient("confirmed")
        result = run_archive(self.ledger, "T100", "archive-op", client=client)
        self.assertEqual(result["outcome"], "confirmed")
        self.assertEqual(len(client.writes), 1)
        self.assertEqual(client.list_calls, 1)
        self.assertEqual(self.ledger.get_task("T100")["archive"], "archived")
        # Re-run after archived performs no second write.
        rerun = run_archive(self.ledger, "T100", "archive-op", client=client)
        self.assertEqual(rerun["outcome"], "already-archived")
        self.assertEqual(len(client.writes), 1)

    def test_existing_archived_identity_reconciled_without_write(self):
        client = FakeArchiveClient("confirmed", archived=True)
        result = run_archive(self.ledger, "T100", "archive-op", client=client)
        self.assertEqual(result["outcome"], "confirmed-reconciled")
        self.assertFalse(result["writePerformed"])
        self.assertEqual(len(client.writes), 0)
        self.assertEqual(self.ledger.get_task("T100")["archive"], "archived")

    def test_unknown_outcome_is_reconciled_never_repeated(self):
        first = FakeArchiveClient("unknown")
        result = run_archive(self.ledger, "T100", "archive-op", client=first)
        self.assertEqual(result["outcome"], "unknown")
        self.assertEqual(len(first.writes), 1)
        self.assertEqual(self.ledger.get_task("T100")["archive"], "unknown")

        second = FakeArchiveClient("confirmed")
        rerun = run_archive(self.ledger, "T100", "archive-op", client=second)
        self.assertEqual(rerun["outcome"], "unknown")
        self.assertFalse(rerun["writePerformed"])
        self.assertEqual(len(second.writes), 0)
        self.assertEqual(self.ledger.get_task("T100")["archive"], "unknown")

    def test_not_sent_retry_is_capped_at_three(self):
        for attempt in range(3):
            client = FakeArchiveClient("not-sent")
            result = run_archive(self.ledger, "T100", "archive-op", client=client)
            self.assertEqual(result["outcome"], "not-sent")
            self.assertEqual(len(client.writes), 1)
        self.assertEqual(self.ledger.get_task("T100")["archive"], "pending")
        self.assertEqual(self.ledger.pending_archive_requests(), [])
        with self.assertRaises(TransitionError):
            run_archive(
                self.ledger,
                "T100",
                "archive-op",
                client=FakeArchiveClient("not-sent"),
            )


class FakeBridge:
    def __init__(self):
        self.calls = []
        self.lock = threading.Lock()
        self.slow_thread = None

    def __call__(self, thread_id, socket_path, timeout):
        with self.lock:
            self.calls.append((thread_id, now_iso()))
        if thread_id == self.slow_thread:
            time.sleep(1.5)
        return observation(
            turn_status="inProgress",
            turn_id="turn-%s" % thread_id,
            revision="rev-%s" % thread_id,
            assistant="progress %s" % thread_id,
            latest_action="tool:inProgress",
        )


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Ledger(os.path.join(self.tmp.name, "state"))

    def test_slow_worker_does_not_block_others_or_concurrent_register(self):
        threads = {
            "T101": "00000000-0000-0000-0000-000000000101",
            "T102": "00000000-0000-0000-0000-000000000102",
            "T103": "00000000-0000-0000-0000-000000000103",
            "T104": "00000000-0000-0000-0000-000000000104",
            "T105": "00000000-0000-0000-0000-000000000105",
            "T106": "00000000-0000-0000-0000-000000000106",
        }
        for task_id, thread_id in threads.items():
            make_task(self.ledger, task_id=task_id, thread_id=thread_id)
        bridge = FakeBridge()
        bridge.slow_thread = threads["T101"]
        collector = Collector(
            self.ledger,
            bridge_fn=bridge,
            interval=0.2,
            workers=4,
            timeout=3.0,
        )
        stop = threading.Event()
        runner = threading.Thread(target=collector.run, args=(stop,), daemon=True)
        runner.start()
        try:
            deadline = time.time() + 4.0
            while time.time() < deadline:
                if set(threads.values()).issubset({call[0] for call in bridge.calls}):
                    break
                time.sleep(0.05)
            called = {call[0] for call in bridge.calls}
            self.assertTrue(
                set(threads.values()).issubset(called),
                "all >workers tasks must eventually be observed: %s" % called,
            )
            # Slow T101 is still in flight, but the other tasks have applied.
            self.assertEqual(self.ledger.get_task("T102")["execution"], "running")

            start = time.time()
            make_task(
                self.ledger,
                task_id="T107",
                thread_id="00000000-0000-0000-0000-000000000107",
            )
            elapsed = time.time() - start
            self.assertLess(elapsed, 0.5, "concurrent register must not block")
        finally:
            stop.set()
            runner.join(timeout=5)
            collector.close()


class SnapshotServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state")
        self.ledger = Ledger(self.state)
        make_task(self.ledger)
        self.socket = os.path.join(self.state, "orchestra.sock")

    def _get(self, method, path):
        connection = UnixHTTPConnection(self.socket, timeout=3.0)
        try:
            connection.request(method, path)
            response = connection.getresponse()
            return response.status, response.read()
        finally:
            connection.close()

    def test_unix_snapshot_is_private_read_only_and_no_tcp(self):
        server = start_snapshot_server(self.state, self.socket)
        try:
            self.assertEqual(
                stat.S_IMODE(os.stat(self.socket).st_mode), 0o600
            )
            self.assertEqual(
                stat.S_IMODE(os.stat(self.state).st_mode), 0o700
            )
            self.assertIsInstance(server.server_address, str)
            status, body = self._get("GET", "/snapshot")
            self.assertEqual(status, 200)
            payload = json.loads(body)
            self.assertEqual(payload["version"], 1)
            self.assertEqual(payload["controllerThreadId"], CONTROLLER_THREAD_ID)
            self.assertEqual(payload["tasks"][0]["id"], "T100")
            self.assertEqual(self._get("POST", "/snapshot")[0], 405)
            self.assertEqual(self._get("PUT", "/snapshot")[0], 405)
            self.assertEqual(self._get("GET", "/nope")[0], 404)
        finally:
            stop_snapshot_server(server)
        self.assertFalse(os.path.exists(self.socket))


if __name__ == "__main__":
    unittest.main(verbosity=2)
