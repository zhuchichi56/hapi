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
from orchestra.db import SCHEMA as DB_SCHEMA
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
            lambda: self.ledger.review("EXT001", "accepted", "x", "op-ext-review", actor=self.ledger.controller_thread_id),
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
        self.ledger.review("T100", "rejected", "Missing output", "reject-1", actor=self.ledger.controller_thread_id)
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
            self.ledger.review("T100", "accepted", "not delivered", "review-fail", actor=self.ledger.controller_thread_id)

        self.ledger.apply_observation(
            "T100", observation(turn_id="turn-final", revision="r1"), t()
        )
        self.ledger.review("T100", "accepted", "verified output", "review-ok", actor=self.ledger.controller_thread_id)
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
            self.ledger.review("T100", "rejected", "late", "review-late", actor=self.ledger.controller_thread_id)

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
            restarted.review("T100", "accepted", "x", "dispatch-1", actor=restarted.controller_thread_id)

        restarted.apply_observation(
            "T100", observation(turn_id="turn-1", revision="r1"), t()
        )
        restarted.review("T100", "accepted", "ok", "review-1", actor=restarted.controller_thread_id)
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
        self.ledger.review("T008", "accepted", "parent accepted handoff", "t008-review", actor=self.ledger.controller_thread_id)
        # After the parent accepts, the implementation chat is no longer
        # permanently blocked from archive; only the controller remains so.
        requested = self.ledger.archive_request("T008", "t008-after-accept")
        self.assertEqual(requested["operation"]["status"], "pending")


LEGACY_SCHEMA = """
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    deliverables TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT '[]',
    ownership TEXT NOT NULL DEFAULT '[]',
    authorization TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    host TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    checkpoint TEXT NOT NULL DEFAULT '',
    expected_at TEXT,
    execution TEXT NOT NULL DEFAULT 'queued',
    review TEXT NOT NULL DEFAULT 'pending',
    archive TEXT NOT NULL DEFAULT 'none',
    observed_at TEXT,
    source_at TEXT,
    progress TEXT NOT NULL DEFAULT '',
    latest_action TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    external INTEGER NOT NULL DEFAULT 0,
    read_only INTEGER NOT NULL DEFAULT 0,
    source_revision TEXT,
    source_turn_id TEXT,
    turn_status TEXT,
    live INTEGER,
    last_error TEXT,
    poll INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
"""

FIXTURE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
with open(
    os.path.join(FIXTURE_DIR, "legacy_review_cursor.json"), encoding="utf-8"
) as _fixture_handle:
    LEGACY_FIXTURE = json.load(_fixture_handle)


class MultiTurnLifecycleTests(unittest.TestCase):
    """Stage-2 lifecycle regressions: review binds a turn, not a cursor."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state")
        self.ledger = Ledger(self.state)
        make_task(self.ledger)

    def observe(self, status="completed", turn="turn-1", at=0, revision=None, live=True):
        return self.ledger.apply_observation(
            "T100",
            observation(
                turn_status=status,
                turn_id=turn,
                revision=revision or "rev-%s-%s" % (status, at),
                live=live,
            ),
            t(at),
        )

    def history(self, ledger=None):
        ledger = ledger or self.ledger
        return ledger.task_history("T100", limit=100)

    def test_rejected_same_turn_repeats_but_new_inprogress_then_completed_awaits(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "rejected", "missing output", "reject-1", actor=self.ledger.controller_thread_id)

        self.observe("completed", "turn-1", 1)
        self.assertEqual(self.ledger.get_task("T100")["review"], "rejected")

        self.observe("inProgress", "turn-2", 2)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "running")
        self.assertEqual(task["review"], "pending")
        self.assertEqual(task["rejected_turn_id"], "turn-1")

        self.observe("completed", "turn-2", 3)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["delivery_turn_id"], "turn-2")

    def test_accepted_turn_can_be_superseded_by_authorized_continuation(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "first delivery", "accept-1", actor=self.ledger.controller_thread_id)
        self.assertEqual(self.ledger.get_task("T100")["accepted_turn_id"], "turn-1")

        # A new inProgress turn on the same bound chat is real work, not a
        # frozen completed state.
        self.observe("inProgress", "turn-2", 1)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "running")
        self.assertEqual(task["review"], "pending")
        self.assertEqual(task["accepted_turn_id"], "turn-1")
        self.assertEqual(task["delivery_turn_id"], "turn-1")

        self.observe("completed", "turn-2", 2)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["delivery_turn_id"], "turn-2")
        # The earlier acceptance remains in the readable history.
        self.assertEqual(task["accepted_turn_id"], "turn-1")

        self.ledger.review("T100", "accepted", "second delivery", "accept-2", actor=self.ledger.controller_thread_id)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["accepted_turn_id"], "turn-2")
        accepted = [
            event
            for event in self.history()
            if event["kind"] == "review"
            and event["detail"].get("result") == "accepted"
        ]
        self.assertEqual(
            [event["detail"]["turnId"] for event in accepted], ["turn-1", "turn-2"]
        )
        self.assertEqual(
            [event["detail"]["evidence"] for event in accepted],
            ["first delivery", "second delivery"],
        )

    def test_repeated_read_of_accepted_turn_keeps_accepted(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)
        self.observe("completed", "turn-1", 1, revision="rev-late")
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["accepted_turn_id"], "turn-1")
        self.assertEqual(task["reviewed_turns"], ["turn-1"])
        self.assertEqual(len(self.ledger.consume_notices()), 1)

    def test_acceptance_binds_delivery_turn_not_observation_cursor(self):
        self.observe("completed", "turn-delivery", 0)
        # An unknown/read-only callback advances the observation cursor but must
        # not become the accepted delivery turn.
        self.observe("unknown", "turn-cursor", 1)
        self.assertEqual(self.ledger.get_task("T100")["source_turn_id"], "turn-cursor")
        self.ledger.review("T100", "accepted", "verified delivery", "accept-1", actor=self.ledger.controller_thread_id)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["accepted_turn_id"], "turn-delivery")
        self.assertEqual(task["delivery_turn_id"], "turn-delivery")

    def test_new_turn_expires_acceptance_before_archive_request(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)
        self.observe("inProgress", "turn-2", 1)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "running")
        self.assertEqual(task["review"], "pending")
        with self.assertRaises(TransitionError):
            self.ledger.archive_request("T100", "archive-after-new-turn")

    def test_pending_archive_cannot_run_on_expired_acceptance(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)
        self.ledger.archive_request("T100", "archive-op")
        self.observe("inProgress", "turn-2", 1)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["archive"], "pending")
        self.assertEqual(task["review"], "pending")
        self.assertEqual(task["execution"], "running")
        self.assertEqual(self.ledger.pending_archive_requests(), [])
        with self.assertRaises(TransitionError):
            self.ledger.begin_archive_attempt("T100", "archive-op")

    def test_archived_state_is_terminal_for_callbacks(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)
        self.ledger.archive_request("T100", "archive-op")
        self.ledger.archive_receipt("T100", "receipt-1", "confirmed", "done")
        self.observe("failed", "turn-2", 1)
        self.observe("unknown", "turn-cursor", 2)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["archive"], "archived")
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["accepted_turn_id"], "turn-1")

    def test_callback_for_older_reviewed_turn_cannot_erase_newer_stage(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "first", "accept-1", actor=self.ledger.controller_thread_id)
        self.observe("inProgress", "turn-2", 1)
        self.observe("completed", "turn-2", 2)
        self.ledger.review("T100", "accepted", "second", "accept-2", actor=self.ledger.controller_thread_id)

        # Even with a newer observedAt, a callback for the already-reviewed old
        # turn cannot move the task back to awaiting.
        stale = self.observe("completed", "turn-1", 20)
        self.assertFalse(stale["applied"])
        self.assertEqual(stale["reason"], "stale_turn")
        task = self.ledger.get_task("T100")
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["accepted_turn_id"], "turn-2")
        self.assertEqual(task["delivery_turn_id"], "turn-2")
        self.assertEqual(task["source_turn_id"], "turn-2")

    def test_out_of_order_observation_cannot_erase_new_acceptance(self):
        self.observe("completed", "turn-1", 0)
        self.observe("inProgress", "turn-2", 1)
        self.observe("completed", "turn-2", 10)
        self.ledger.review("T100", "accepted", "turn two", "accept-2", actor=self.ledger.controller_thread_id)
        stale = self.observe("failed", "turn-1", 5)
        self.assertFalse(stale["applied"])
        task = self.ledger.get_task("T100")
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["accepted_turn_id"], "turn-2")
        self.assertEqual(task["source_turn_id"], "turn-2")

    def test_disconnect_and_unknown_keep_verified_delivery_and_acceptance(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)
        self.ledger.record_observation_error("T100", BridgeError("timeout"), t(1))
        self.assertIn("timeout", self.ledger.get_task("T100")["last_error"])
        # An unknown read of the same accepted turn preserves acceptance.
        self.observe("unknown", "turn-1", 2)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["accepted_turn_id"], "turn-1")

    def test_unknown_or_unowned_new_turn_expires_acceptance_for_archive(self):
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)
        self.observe("unknown", "turn-new", 1)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "pending")
        self.assertEqual(task["accepted_turn_id"], "turn-1")
        with self.assertRaises(TransitionError):
            self.ledger.archive_request("T100", "archive-unknown-turn")

        stale = self.observe("completed", "turn-1", 3)
        self.assertFalse(stale["applied"])
        self.assertEqual(stale["reason"], "stale_turn")
        self.assertEqual(self.ledger.get_task("T100")["review"], "pending")
        self.observe("inProgress", "turn-3", 4, live=False)
        task = self.ledger.get_task("T100")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "pending")
        with self.assertRaises(TransitionError):
            self.ledger.archive_request("T100", "archive-unowned-turn")

    def test_contract_and_acceptance_history_survive_restart(self):
        self.ledger.update_contract("T100", {"goal": "goal one", "checkpoint": "c1"})
        self.ledger.update_contract("T100", {"goal": "goal two"})
        self.observe("completed", "turn-1", 0)
        self.ledger.review("T100", "accepted", "verified", "accept-1", actor=self.ledger.controller_thread_id)

        task = self.ledger.get_task("T100")
        self.assertEqual(task["goal"], "goal two")
        contract = [event for event in self.history() if event["kind"] == "contract"]
        self.assertEqual(len(contract), 2)
        self.assertEqual(contract[0]["detail"]["before"]["goal"], "验证账本行为")
        self.assertEqual(contract[0]["detail"]["after"]["goal"], "goal one")
        self.assertEqual(contract[1]["detail"]["before"]["goal"], "goal one")
        self.assertEqual(contract[1]["detail"]["after"]["goal"], "goal two")
        review = [event for event in self.history() if event["kind"] == "review"]
        self.assertEqual(len(review), 1)
        self.assertEqual(review[0]["detail"]["turnId"], "turn-1")
        self.assertEqual(review[0]["detail"]["evidence"], "verified")

        restarted = Ledger(self.state)
        self.assertEqual(restarted.get_task("T100")["accepted_turn_id"], "turn-1")
        kinds = [event["kind"] for event in self.history(restarted)]
        self.assertEqual(kinds.count("contract"), 2)
        self.assertEqual(kinds.count("review"), 1)
        self.assertEqual(kinds.count("delivery"), 1)

    def test_snapshot_history_is_bounded_summary_and_full_history_is_paged(self):
        for index in range(25):
            self.ledger.update_contract(
                "T100", {"goal": "goal-%02d" % index}
            )
            time.sleep(0.002)
        task = next(
            item for item in self.ledger.snapshot()["tasks"] if item["id"] == "T100"
        )
        self.assertEqual(len(task["history"]), 20)
        for event in task["history"]:
            self.assertEqual(set(event), {"id", "kind", "createdAt"})

        full = self.ledger.task_history("T100", limit=100)
        self.assertEqual(len(full), 25)
        self.assertTrue(
            all("before" in event["detail"] and "after" in event["detail"] for event in full)
        )

        page = self.ledger.task_history("T100", limit=5)
        self.assertEqual(len(page), 5)
        self.assertEqual(
            [event["createdAt"] for event in page],
            sorted(event["createdAt"] for event in page),
        )
        older = self.ledger.task_history(
            "T100", limit=5, before=page[0]["createdAt"]
        )
        self.assertEqual(len(older), 5)
        self.assertTrue(
            all(event["createdAt"] < page[0]["createdAt"] for event in older)
        )
        with self.assertRaises(ValidationError):
            self.ledger.task_history("T100", limit=0)
        with self.assertRaises(ValidationError):
            self.ledger.task_history("T100", limit=101)
        with self.assertRaises(NotFoundError):
            self.ledger.task_history("T999")

    def _seed_legacy(self, case):
        state = os.path.join(self.tmp.name, "%s-legacy" % case["task"]["id"])
        os.makedirs(state, mode=0o700)
        connection = sqlite3.connect(os.path.join(state, "orchestra.db"))
        try:
            connection.executescript(LEGACY_SCHEMA)
            connection.executescript(DB_SCHEMA)
            task = case["task"]
            connection.execute(
                """
                INSERT INTO tasks (
                    id,title,goal,thread_id,created_at,execution,review,archive,
                    observed_at,source_turn_id,turn_status,evidence,poll,updated_at
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    task["id"],
                    "legacy %s" % task["id"],
                    "legacy",
                    "cccccccc-cccc-cccc-cccc-cccccccccccc",
                    "2026-11-01T10:00:00+00:00",
                    task["execution"],
                    task["review"],
                    "none",
                    task["observed_at"],
                    task["source_turn_id"],
                    task["turn_status"],
                    json.dumps(["legacy review evidence"]),
                    1,
                    "2026-11-01T10:00:00+00:00",
                ),
            )
            connection.execute(
                """
                INSERT INTO operations (
                    op_id,task_id,kind,status,payload,created_at,updated_at
                ) VALUES (?,?,?,?,?,?,?)
                """,
                (
                    "legacy-review-%s" % task["id"],
                    task["id"],
                    "review",
                    "recorded",
                    json.dumps({"result": task["review"], "evidence": "legacy"}),
                    case["review_at"],
                    case["review_at"],
                ),
            )
            if "delivery_notice_at" in case:
                connection.execute(
                    """
                    INSERT INTO notices (
                        id,task_id,kind,message,dedup_key,created_at,acknowledged_at
                    ) VALUES (?,?,?,?,?,?,NULL)
                    """,
                    (
                        "notice-%s" % task["id"],
                        task["id"],
                        "delivery",
                        "legacy delivery",
                        "delivery:%s:%s" % (task["id"], case["notice_turn"]),
                        case["delivery_notice_at"],
                    ),
                )
            connection.commit()
        finally:
            connection.close()
        return state

    def test_legacy_terminal_cursor_at_review_time_binds_the_turn(self):
        case = LEGACY_FIXTURE["cases"][0]
        self.assertEqual(case["name"], "terminal_cursor_at_review_time")
        legacy = Ledger(self._seed_legacy(case))
        task = legacy.get_task("T200")
        self.assertEqual(task["accepted_turn_id"], "turn-legacy")
        self.assertEqual(task["delivery_turn_id"], "turn-legacy")
        legacy.apply_observation(
            "T200",
            observation(turn_status="completed", turn_id="turn-new"),
            t(5),
        )
        task = legacy.get_task("T200")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["delivery_turn_id"], "turn-new")

    def _legacy_case(self, name):
        return next(case for case in LEGACY_FIXTURE["cases"] if case["name"] == name)

    def test_legacy_repeated_completed_with_prior_delivery_notice_binds(self):
        case = self._legacy_case("repeated_completed_with_prior_delivery_notice")
        legacy = Ledger(self._seed_legacy(case))
        task = legacy.get_task("T009")
        # observed_at moved after review, but the pre-review delivery notice
        # names the same completed turn, so the acceptance is recoverable.
        self.assertEqual(task["accepted_turn_id"], "turn-009")
        self.assertEqual(task["delivery_turn_id"], "turn-009")
        self.assertEqual(task["reviewed_turns"], ["turn-009"])

        legacy.apply_observation(
            "T009",
            observation(turn_status="completed", turn_id="turn-next"),
            t(5),
        )
        task = legacy.get_task("T009")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["delivery_turn_id"], "turn-next")

    def test_legacy_newer_turn_or_late_notice_is_not_bound(self):
        for name in (
            "newer_completed_with_only_old_notice",
            "completed_with_notice_after_review",
        ):
            case = self._legacy_case(name)
            legacy = Ledger(self._seed_legacy(case))
            task = legacy.get_task(case["task"]["id"])
            self.assertEqual(task["review"], "accepted")
            self.assertIsNone(task["accepted_turn_id"], name)
            self.assertIsNone(task["delivery_turn_id"], name)
            self.assertEqual(task["reviewed_turns"], [], name)

    def test_legacy_inprogress_cursor_is_not_bound_as_a_reviewed_turn(self):
        case = LEGACY_FIXTURE["cases"][1]
        self.assertEqual(case["name"], "inprogress_cursor_after_review")
        legacy = Ledger(self._seed_legacy(case))
        task = legacy.get_task("T201")
        # The old review/evidence is retained, but the cursor turn is not
        # invented as the reviewed delivery.
        self.assertEqual(task["review"], "accepted")
        self.assertEqual(task["accepted_turn_id"], None)
        self.assertEqual(task["delivery_turn_id"], None)
        self.assertEqual(task["reviewed_turns"], [])
        self.assertIn("legacy review evidence", task["evidence"])

        legacy.apply_observation(
            "T201",
            observation(
                turn_status="completed",
                turn_id="turn-rework",
                revision="rev-rework",
            ),
            t(5),
        )
        task = legacy.get_task("T201")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["delivery_turn_id"], "turn-rework")
        self.assertEqual(task["accepted_turn_id"], None)
        self.assertIn("legacy review evidence", task["evidence"])


class IdentityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.ledger = Ledger(os.path.join(self.tmp.name, "state"))

    def test_same_chat_cannot_be_reused_for_a_new_task(self):
        make_task(self.ledger, task_id="T100")
        with self.assertRaises(TransitionError):
            make_task(self.ledger, task_id="T101")  # same thread id

        make_task(self.ledger, task_id="T102", thread_id=None)
        self.ledger.dispatch_intent("T102", "dispatch-102")
        with self.assertRaises(TransitionError):
            self.ledger.bind(
                "T102", "dispatch-102", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
            )
        with self.assertRaises(ValidationError):
            self.ledger.update_contract("T100", {"threadId": "new-thread"})
        with self.assertRaises(TransitionError):
            self.ledger.register(
                {
                    "id": "T100",
                    "title": "renamed",
                    "threadId": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                }
            )
        # Re-registering the same task keeps the original identity and does not
        # silently start a second logical task.
        again = self.ledger.register(
            {"id": "T100", "title": "renamed", "threadId": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}
        )
        self.assertFalse(again["created"])
        self.assertEqual(
            self.ledger.get_task("T100")["thread_id"],
            "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        )


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
        self.ledger.review("T100", "accepted", "verified", "review", actor=self.ledger.controller_thread_id)
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


ADOPTION_THREADS = {
    "EXT004": "01a16806-e25b-7860-9484-bc53745180a7",
    "EXT003": "01a18e3a-1751-77a0-a314-e10126357707",
    "EXT005": "01a18af4-5542-78c3-abbd-a526cc3053d4",
}
EXT005_ROLE_THREAD = "01a195c0-d141-7d60-89f7-a58abb5059c7"
EXT005_EVIDENCE_THREAD = "01a181a3-04d9-7a92-a25d-8f180f3e01f6"
AUTHORIZATION_SOURCE = (
    "/Users/zhuhe/Documents/Codex/2026-11-01/new-chat/work/orchestra/"
    "UrbanClaw-supervision-adoption.json"
)


class AdoptionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = os.path.join(self.tmp.name, "state")
        self.ledger = Ledger(self.state)

    def seed_external(self, task_id):
        observed = "2026-11-01T13:27:00+08:00"
        connection = self.ledger._connect()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT INTO external_history
                        (id,title,status_text,detail,next_step,thread_id,observed_at,ordinal)
                    VALUES (?,?,?,?,?,?,?,?)
                    """,
                    (
                        task_id,
                        "原始 %s" % task_id,
                        "执行中",
                        "原始快照 detail %s" % task_id,
                        "原始下一步",
                        ADOPTION_THREADS[task_id],
                        observed,
                        int(task_id[-3:]),
                    ),
                )
        finally:
            connection.close()

    def adopt_data(self, task_id):
        return {
            "title": "接管 %s" % task_id,
            "scope": "scope-%s" % task_id,
            "authorization": "用户明确授权总控接管 %s" % task_id,
            "threadId": ADOPTION_THREADS[task_id],
            "host": "local",
            "requestedAt": "2026-11-01T19:35:32+00:00",
            "expectedAt": "2026-11-01T19:50:32+00:00",
            "authorizationSource": AUTHORIZATION_SOURCE,
            "authorizationSha256": "a" * 64,
            "baselineTurnId": "turn-baseline-%s" % task_id,
        }

    def external_row(self, task_id):
        connection = self.ledger._connect()
        try:
            return dict(
                connection.execute(
                    "SELECT * FROM external_history WHERE id=?", (task_id,)
                ).fetchone()
            )
        finally:
            connection.close()

    def test_adoption_requires_exact_mapping_and_keeps_readonly_protection(self):
        self.seed_external("EXT004")
        with self.assertRaises(TransitionError):
            self.ledger.adopt_external("EXT001", self.adopt_data("EXT004"), "adopt-x")
        wrong = self.adopt_data("EXT004")
        wrong["threadId"] = "01a18e3a-1751-77a0-a314-e10126357707"
        with self.assertRaises(TransitionError):
            self.ledger.adopt_external("EXT004", wrong, "adopt-wrong-thread")
        missing_baseline = self.adopt_data("EXT004")
        missing_baseline["baselineTurnId"] = ""
        with self.assertRaises(ValidationError):
            self.ledger.adopt_external("EXT004", missing_baseline, "adopt-no-baseline")
        # Before adoption the external row remains read-only for normal ops.
        with self.assertRaises(TransitionError):
            self.ledger.review("EXT004", "accepted", "x", "review-ext", actor=self.ledger.controller_thread_id)
        self.assertIsNone(self.ledger.get_task("EXT004"))
        self.assertEqual(self.external_row("EXT004")["title"], "原始 EXT004")

    def test_adopt_copies_managed_task_preserves_snapshot_and_is_idempotent(self):
        before = {}
        for task_id in ("EXT003", "EXT004"):
            self.seed_external(task_id)
            before[task_id] = self.external_row(task_id)
            result = self.ledger.adopt_external(
                task_id, self.adopt_data(task_id), "adopt-%s" % task_id
            )
            self.assertFalse(result["reused"])
            task = self.ledger.get_task(task_id)
            self.assertEqual(task["thread_id"], ADOPTION_THREADS[task_id])
            self.assertEqual(task["execution"], "unknown")
            self.assertEqual(task["review"], "pending")
            self.assertEqual(task["archive"], "none")
            self.assertEqual(task["poll"], 1)
            self.assertEqual(task["authorization"], self.adopt_data(task_id)["authorization"])
            self.assertEqual(
                task["adoption_baseline_turn_id"],
                "turn-baseline-%s" % task_id,
            )
            self.assertIn("已接管", task["progress"])
            self.assertIn("等待本轮交接", task["progress"])
            self.assertEqual(self.external_row(task_id), before[task_id])

        snapshot = self.ledger.snapshot()
        ids = [task["id"] for task in snapshot["tasks"]]
        self.assertEqual(ids.count("EXT003"), 1)
        self.assertEqual(ids.count("EXT004"), 1)
        adopted = next(task for task in snapshot["tasks"] if task["id"] == "EXT004")
        self.assertFalse(adopted["external"])

        history = self.ledger.task_history("EXT004", limit=20)
        adoption = [event for event in history if event["kind"] == "adoption"]
        self.assertEqual(len(adoption), 1)
        detail = adoption[0]["detail"]
        self.assertEqual(detail["external"], before["EXT004"])
        self.assertEqual(detail["scope"], "scope-EXT004")
        self.assertEqual(detail["authorizationSource"], AUTHORIZATION_SOURCE)
        self.assertEqual(detail["authorizationSha256"], "a" * 64)
        self.assertEqual(
            detail["requestedAt"], "2026-11-01T19:35:32.000000+00:00"
        )
        self.assertEqual(detail["baselineTurnId"], "turn-baseline-EXT004")
        self.assertTrue(detail["sourceRowRetained"])

        # Same op + same request is an idempotent receipt; it does not reset
        # progress or duplicate the task.
        connection = self.ledger._connect()
        try:
            with connection:
                connection.execute(
                    "UPDATE tasks SET progress='已接管，等待本轮交接（custom）' "
                    "WHERE id='EXT004'"
                )
        finally:
            connection.close()
        reused = self.ledger.adopt_external(
            "EXT004", self.adopt_data("EXT004"), "adopt-EXT004"
        )
        self.assertTrue(reused["reused"])
        self.assertEqual(
            self.ledger.get_task("EXT004")["progress"],
            "已接管，等待本轮交接（custom）",
        )
        changed = self.adopt_data("EXT004")
        changed["scope"] = "different-scope"
        with self.assertRaises(TransitionError):
            self.ledger.adopt_external("EXT004", changed, "adopt-EXT004")
        with self.assertRaises(TransitionError):
            self.ledger.adopt_external(
                "EXT004", self.adopt_data("EXT004"), "adopt-EXT004-new-op"
            )

    def test_baseline_turn_is_not_a_delivery_and_first_new_turn_is(self):
        self.seed_external("EXT004")
        self.ledger.adopt_external(
            "EXT004", self.adopt_data("EXT004"), "adopt-EXT004"
        )
        baseline = self.ledger.apply_observation(
            "EXT004",
            observation(
                turn_status="completed",
                turn_id="turn-baseline-EXT004",
                revision="rev-baseline",
            ),
            t(),
        )
        self.assertTrue(baseline["applied"])
        self.assertEqual(baseline["reason"], "adoption_baseline")
        task = self.ledger.get_task("EXT004")
        self.assertEqual(task["execution"], "unknown")
        self.assertEqual(task["review"], "pending")
        self.assertIsNone(task["delivery_turn_id"])
        self.assertEqual(task["adoption_baseline_turn_id"], "turn-baseline-EXT004")
        self.assertEqual(self.ledger.consume_notices(), [])

        result = self.ledger.apply_observation(
            "EXT004",
            observation(
                turn_status="completed",
                turn_id="turn-new",
                revision="rev-new",
            ),
            t(1),
        )
        self.assertTrue(result["applied"])
        task = self.ledger.get_task("EXT004")
        self.assertEqual(task["execution"], "reported")
        self.assertEqual(task["review"], "awaiting")
        self.assertEqual(task["delivery_turn_id"], "turn-new")
        self.assertIsNone(task["adoption_baseline_turn_id"])
        cleared = [
            event
            for event in self.ledger.task_history("EXT004", limit=20)
            if event["kind"] == "state"
            and event["detail"].get("event") == "adoption-cleared"
        ]
        self.assertEqual(len(cleared), 1)

        # Restart + same adopt op keeps the new progress/state.
        restarted = Ledger(self.state)
        receipt = restarted.adopt_external(
            "EXT004", self.adopt_data("EXT004"), "adopt-EXT004"
        )
        self.assertTrue(receipt["reused"])
        self.assertEqual(restarted.get_task("EXT004")["review"], "awaiting")
        self.assertEqual(restarted.get_task("EXT004")["delivery_turn_id"], "turn-new")

    def test_import_markdown_does_not_overwrite_adopted_snapshot(self):
        self.seed_external("EXT004")
        original = self.external_row("EXT004")
        self.ledger.adopt_external(
            "EXT004", self.adopt_data("EXT004"), "adopt-EXT004"
        )
        markdown = """# 任务总览

| 编号 | 任务与交付物 | 工作对话 ID / 链接 | 状态 | 负责范围与验收标准 | 预计交付 / 检查点 | 证据、阻碍或下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| T900 | 测试；交付测试 | 待创建 | 待派发 | 范围；验收 | 未启动 | 无 |

## 既有任务跟踪

| 任务 | 核对时状态 | 正在做什么 / 最新交付 | 下一验收点 |
| --- | --- | --- | --- |
| [A](codex://threads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) | 执行中 | A | 下一步 |
| [B](codex://threads/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb) | 执行中 | B | 下一步 |
| [C](codex://threads/cccccccc-cccc-cccc-cccc-cccccccccccc) | 执行中 | C | 下一步 |
| [D](codex://threads/dddddddd-dddd-dddd-dddd-dddddddddddd) | 执行中 | 新标题 | 新下一步 |
"""
        path = os.path.join(self.tmp.name, "overview.md")
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(markdown)
        self.ledger.import_markdown(path)
        self.assertEqual(self.external_row("EXT004"), original)

    def ext005_data(self):
        data = self.adopt_data("EXT005")
        data["sessions"] = [
            {
                "threadId": ADOPTION_THREADS["EXT005"],
                "title": "排查 8H20-1 挂起原因",
                "role": "既有容量诊断与历史证据；保留EXT005原绑定身份",
            },
            {
                "threadId": EXT005_ROLE_THREAD,
                "title": "查看 DeepSWE RSI 最新进展",
                "role": "当前排空、测速及基线恢复交接负责人",
            },
            {
                "threadId": EXT005_EVIDENCE_THREAD,
                "title": "查找 H20 推理 A3B 的对话",
                "role": "A3B原评测来源及长期状态证据；先只读，不重复派单",
            },
        ]
        return data

    def test_ext005_adopts_owner_and_evidence_sessions_with_counters(self):
        self.seed_external("EXT005")
        result = self.ledger.adopt_external(
            "EXT005", self.ext005_data(), "adopt-EXT005"
        )
        self.assertFalse(result["reused"])
        task = self.ledger.get_task("EXT005")
        self.assertEqual(task["thread_id"], ADOPTION_THREADS["EXT005"])
        rows = self.ledger.pollable_sessions()
        self.assertEqual(
            {row["thread_id"] for row in rows},
            {EXT005_ROLE_THREAD, EXT005_EVIDENCE_THREAD},
        )
        snapshot = self.ledger.snapshot()
        sessions = [s for s in snapshot["sessions"] if s["taskId"] == "EXT005"]
        self.assertEqual(len(sessions), 3)  # main + two associated roles
        self.assertEqual(snapshot["runningSessionCount"], 0)
        self.assertGreaterEqual(snapshot["pendingTaskCount"], 1)
        # Unbound T004/T005 contribute queued tasks, never fake sessions.
        make_task(self.ledger, task_id="T004", thread_id=None)
        make_task(self.ledger, task_id="T005", thread_id=None)
        snapshot = self.ledger.snapshot()
        self.assertEqual(snapshot["queuedTaskCount"], 2)
        self.assertFalse(
            [s for s in snapshot["sessions"] if s["taskId"] in ("T004", "T005")]
        )

    def test_session_baseline_delivery_and_same_turn_review_are_independent(self):
        self.seed_external("EXT005")
        self.ledger.adopt_external("EXT005", self.ext005_data(), "adopt-EXT005")
        session_id = EXT005_ROLE_THREAD

        first = self.ledger.apply_session_observation(
            "EXT005", session_id,
            observation(turn_status="completed", turn_id="old-turn"), t(),
        )
        self.assertEqual(first["reason"], "session_baseline")
        self.assertEqual(
            self.ledger.apply_session_observation(
                "EXT005", session_id,
                observation(turn_status="completed", turn_id="old-turn"), t(1),
            )["reason"],
            "session_baseline",
        )
        row = [
            item for item in self.ledger.pollable_sessions()
            if item["session_id"] == session_id
        ][0]
        self.assertNotEqual(row["execution"], "reported")
        self.assertIsNone(row["delivery_turn_id"])

        self.ledger.apply_session_observation(
            "EXT005", session_id,
            observation(turn_status="inProgress", turn_id="new-turn"), t(2),
        )
        row = [
            item for item in self.ledger.pollable_sessions()
            if item["session_id"] == session_id
        ][0]
        self.assertEqual(row["execution"], "running")
        self.ledger.apply_session_observation(
            "EXT005", session_id,
            observation(turn_status="completed", turn_id="new-turn"), t(3),
        )
        self.ledger.review_session(
            "EXT005", session_id, "accepted", "session verified", "sess-review-1", actor=self.ledger.controller_thread_id
        )
        self.ledger.apply_session_observation(
            "EXT005", session_id,
            observation(turn_status="completed", turn_id="new-turn", revision="r2"), t(4),
        )
        row = [
            item for item in self.ledger.pollable_sessions()
            if item["session_id"] == session_id
        ][0]
        self.assertEqual(row["review"], "accepted")
        self.ledger.apply_session_observation(
            "EXT005", session_id,
            observation(turn_status="inProgress", turn_id="next-turn"), t(5),
        )
        row = [
            item for item in self.ledger.pollable_sessions()
            if item["session_id"] == session_id
        ][0]
        self.assertEqual(row["review"], "pending")
        self.assertEqual(row["execution"], "running")
        # A session completing never changes the parent task delivery state.
        self.assertNotEqual(self.ledger.get_task("EXT005")["execution"], "reported")

    def test_open_sessions_block_task_acceptance_and_cross_identity(self):
        self.seed_external("EXT005")
        self.ledger.adopt_external("EXT005", self.ext005_data(), "adopt-EXT005")
        self.ledger.apply_observation(
            "EXT005",
            observation(turn_status="completed", turn_id="turn-main"),
            t(),
        )
        with self.assertRaises(TransitionError):
            self.ledger.review("EXT005", "accepted", "main", "review-main", actor=self.ledger.controller_thread_id)
        for thread_id in (EXT005_ROLE_THREAD, EXT005_EVIDENCE_THREAD):
            self.ledger.end_task_session("EXT005", thread_id, "end-%s" % thread_id)
        self.ledger.review("EXT005", "accepted", "main", "review-main", actor=self.ledger.controller_thread_id)
        self.ledger.archive_request("EXT005", "archive-main")
        with self.assertRaises(TransitionError):
            self.ledger.add_task_session(
                "EXT005",
                {"threadId": ADOPTION_THREADS["EXT005"], "role": "duplicate"},
                "session-main",
            )
        with self.assertRaises(TransitionError):
            make_task(
                self.ledger,
                task_id="T099",
                thread_id=EXT005_EVIDENCE_THREAD,
            )


class SessionCollectorTests(unittest.TestCase):
    def test_collector_observes_main_and_associated_sessions(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ledger = Ledger(os.path.join(tmp.name, "state"))
        connection = ledger._connect()
        try:
            with connection:
                connection.execute(
                    """
                    INSERT INTO external_history
                        (id,title,status_text,detail,next_step,thread_id,observed_at,ordinal)
                    VALUES ('EXT005','x','执行中','x','x',?,?,5)
                    """,
                    (ADOPTION_THREADS["EXT005"], "2026-11-01T13:27:00+08:00"),
                )
        finally:
            connection.close()
        data = {
            "title": "EXT005",
            "scope": "scope",
            "authorization": "authorized",
            "threadId": ADOPTION_THREADS["EXT005"],
            "host": "local",
            "requestedAt": "2026-11-01T19:35:32+00:00",
            "expectedAt": "2026-11-01T19:50:32+00:00",
            "authorizationSource": AUTHORIZATION_SOURCE,
            "authorizationSha256": "a" * 64,
            "baselineTurnId": "turn-main",
            "sessions": [
                {"threadId": EXT005_ROLE_THREAD, "title": "owner", "role": "owner"},
                {"threadId": EXT005_EVIDENCE_THREAD, "title": "eval", "role": "eval"},
            ],
        }
        ledger.adopt_external("EXT005", data, "adopt-EXT005")
        bridge = FakeBridge()
        collector = Collector(ledger, bridge_fn=bridge, interval=0.1, workers=2)
        try:
            result = collector.observe_all()
        finally:
            collector.close()
        self.assertGreaterEqual(result["observed"], 3)
        called = {call[0] for call in bridge.calls}
        self.assertTrue(
            {
                ADOPTION_THREADS["EXT005"],
                EXT005_ROLE_THREAD,
                EXT005_EVIDENCE_THREAD,
            }.issubset(called)
        )


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
