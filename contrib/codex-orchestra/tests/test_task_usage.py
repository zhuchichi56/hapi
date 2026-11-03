import json
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from orchestra import task_usage as tu  # noqa: E402
from orchestra.phase_metrics import aggregate_phase_with_task_usage  # noqa: E402



def U(i, o, cr=0, cw=0, total="auto"):
    d = {"input_tokens": i, "output_tokens": o, "cached_input_tokens": cr, "cache_write_input_tokens": cw}
    if total == "auto":
        d["total_tokens"] = i + o
    elif total is not None:
        d["total_tokens"] = total
    return d


def L(type_, ts, payload):
    return json.dumps({"type": type_, "timestamp": ts, "payload": payload})


def start(tid, ts="2026-01-01T00:00:00Z"):
    return L("event_msg", ts, {"type": "task_started", "turn_id": tid})


def end(tid, ts, ms=1000):
    return L("event_msg", ts, {"type": "task_complete", "turn_id": tid, "duration_ms": ms})


def rec(tid, rid, usage, ts="2026-01-01T00:00:01Z"):
    return L("token_usage_record", ts, {"turn_id": tid, "response_id": rid, "usage": usage, "turn_token_usage": usage, "thread_token_usage": usage})


def snap(ts, total, last=None):
    return L("event_msg", ts, {"type": "token_count", "info": {"total_token_usage": total, "last_token_usage": last or total}})


def call(ts, cid):
    return L("response_item", ts, {"type": "custom_tool_call", "call_id": cid})


class NativeTests(unittest.TestCase):
    def test_duplicate_responses_not_summed_and_steps_not_tool_calls(self):
        lines = [start("t1"), rec("t1", "r1", U(100, 10, 60, 10)), rec("t1", "r1", U(100, 10, 60, 10)),
                 rec("t1", "r2", U(200, 20, 150, 5)), call("2026-01-01T00:00:02Z", "c1"), call("2026-01-01T00:00:02Z", "c2"),
                 call("2026-01-01T00:00:03Z", "c3"), call("2026-01-01T00:00:03Z", "c3"), end("t1", "2026-01-01T00:00:09Z", 9000)]
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "current_phase")
        self.assertEqual(s["steps"]["completed"], 2)
        self.assertEqual(s["steps"]["duplicateResponseRecordsIgnored"], 1)
        self.assertEqual(s["toolCalls"]["count"], 3)
        self.assertEqual((s["tokens"]["input"], s["tokens"]["output"]), (300, 30))
        self.assertFalse(s["responsePending"]["pending"])
        self.assertEqual(s["nativeTurnWallSeconds"], 9.0)
        self.assertFalse(s["nativeTurnWallIsExecution"])

    def test_cache_not_double_counted(self):
        lines = [start("t1"), rec("t1", "r1", U(100, 10, 60, 10)), end("t1", "2026-01-01T00:00:09Z")]
        t = tu.turn_scope(tu.parse_native(lines), ["t1"], "x")["tokens"]
        self.assertEqual(t["derivedTotal"], 110)
        self.assertEqual(t["cacheRead"], 60)
        self.assertEqual(t["cacheConvention"], "included_in_input")

    def test_cache_exceeding_input_flagged(self):
        lines = [start("t1"), rec("t1", "r1", U(10, 1, 9, 5)), end("t1", "2026-01-01T00:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "x")
        self.assertFalse(s["cacheConsistent"])
        self.assertFalse(s["coverage"]["complete"])

    def test_missing_native_total_keeps_input_output(self):
        lines = [start("t1"), rec("t1", "r1", U(100, 10, total=None)), end("t1", "2026-01-01T00:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "x")
        self.assertIsNone(s["tokens"]["nativeTotal"])
        self.assertEqual(s["tokens"]["derivedTotal"], 110)
        self.assertEqual(s["tokens"]["input"], 100)
        self.assertIn("native_total_absent", s["coverage"]["missing"])

    def test_turn_association_not_session_total(self):
        lines = [start("t1"), rec("t1", "r1", U(1000, 100)), end("t1", "2026-01-01T00:00:09Z"),
                 start("t2", "2026-01-01T01:00:00Z"), rec("t2", "r2", U(50, 5)), end("t2", "2026-01-01T01:00:09Z")]
        p = tu.parse_native(lines)
        self.assertEqual(tu.turn_scope(p, ["t2"], "current_phase")["tokens"]["input"], 50)
        self.assertEqual(tu.turn_scope(p, ["t1", "t2"], "task_cumulative")["tokens"]["input"], 1050)

    def test_cumulative_snapshots_diff_from_baseline_dedup(self):
        a, b, c = U(100, 10), U(250, 30), U(400, 45)
        lines = [start("t1"), snap("2026-01-01T00:00:01Z", a), end("t1", "2026-01-01T00:00:02Z"),
                 start("t2", "2026-01-01T01:00:00Z"), snap("2026-01-01T01:00:01Z", b), snap("2026-01-01T01:00:01Z", b),
                 snap("2026-01-01T01:00:05Z", c), end("t2", "2026-01-01T01:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t2"], "current_phase")
        self.assertEqual((s["tokens"]["input"], s["tokens"]["output"]), (300, 35))  # 400-100, never 250+250+400
        self.assertEqual(s["steps"]["completed"], 2)  # duplicate snapshot is not a step
        self.assertFalse(s["coverage"]["partial"])

    def test_missing_baseline_is_partial_not_zero(self):
        lines = [start("t2"), snap("2026-01-01T01:00:01Z", U(250, 30)), snap("2026-01-01T01:00:05Z", U(400, 45)),
                 end("t2", "2026-01-01T01:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t2"], "current_phase")
        self.assertTrue(s["coverage"]["partial"])
        self.assertIn("baseline_snapshot_missing_before_turn", s["coverage"]["missing"])
        self.assertEqual(s["tokens"]["input"], 150)  # lower bound, exposed
        self.assertEqual(s["steps"]["completed"], 1)

    def test_response_pending_explicit(self):
        lines = [start("t1"), rec("t1", "r1", U(10, 1))]
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "current_turn")
        self.assertTrue(s["responsePending"]["pending"])
        self.assertTrue(s["coverage"]["partial"])
        self.assertEqual(s["steps"]["completed"], 1)

    def test_unknown_turn_is_missing_not_zero(self):
        s = tu.turn_scope(tu.parse_native([]), ["nope"], "x")
        self.assertIsNone(s["steps"]["completed"])
        self.assertIsNone(s["tokens"]["input"])
        self.assertIn("turn_not_found", s["coverage"]["missing"])


class ExecutionTests(unittest.TestCase):
    def rec(self, start, dur, finish):
        return {"round_index": 1, "started_at": start, "duration_seconds": dur, "finished_at": finish, "executor": "codex", "session": "s"}

    def test_union_excludes_gap_and_overlap(self):
        r = [self.rec("2026-01-01T00:00:00Z", 100, "2026-01-01T00:01:40Z"),
             self.rec("2026-01-01T00:01:00Z", 100, "2026-01-01T00:02:40Z"),   # overlaps 40s
             self.rec("2026-01-01T01:00:00Z", 50, "2026-01-01T01:00:50Z")]    # after an idle gap
        e = tu.execution_block(r)
        self.assertEqual(e["seconds"], 210.0)
        self.assertEqual(e["sumOfIntervalSeconds"], 250.0)
        self.assertGreater(e["excludedGapSeconds"], 3000)
        self.assertTrue(e["includesWaitInsideInvocation"])
        self.assertFalse(e["nativeTurnWallIsExecution"])

    def test_no_invocation_is_unknown_with_gap(self):
        e = tu.execution_block([])
        self.assertIsNone(e["seconds"])
        self.assertEqual(e["gap"], "no_explicit_executor_invocation_interval")

    def test_wall_separate_from_execution(self):
        spec = {"taskId": "T", "phaseId": "P", "stage": 1, "executorSessionRef": tu.ref("s"), "phase": {"startedAt": "2026-01-01T00:00:00Z", "endedAt": "2026-01-01T02:00:00Z"}}
        out = tu.build_task_usage(spec, None, [self.rec("2026-01-01T00:10:00Z", 60, "2026-01-01T00:11:00Z")])
        self.assertEqual(out["wall"]["seconds"], 7200.0)
        self.assertEqual(out["execution"]["seconds"], 60.0)

    def test_missing_identity_rejected(self):
        self.assertFalse(tu.build_task_usage({"taskId": "T"}, None, [])["ok"])


class ExecutorScopeTests(unittest.TestCase):
    def test_summary_tokens_exposed_total_missing_steps_unknown(self):
        r = {"finished_at": "2026-01-01T00:00:00Z", "usage": {"tokens": {"input": 100, "output": 10, "cached_read": 80, "cache_write": 5, "reasoning": 3, "total": None}}}
        s = tu.executor_scope([r])
        self.assertIsNone(s["steps"]["completed"])
        self.assertEqual(s["tokens"]["derivedTotal"], 110)
        self.assertIsNone(s["tokens"]["nativeTotal"])
        self.assertIn("steps_unknown_only_turn_summary_available", s["coverage"]["missing"])


class AggregationFixTests(unittest.TestCase):
    TEL = {"round_index": 2, "session": "sess", "started_at": "2026-01-01T00:00:00Z", "finished_at": "2026-01-01T00:01:40Z",
           "duration_seconds": 100, "executor": "codex", "usage": {"tokens": {"input": 100, "output": 10, "cached_read": 80, "cache_write": 5, "total": None}}}

    def spec(self, **kw):
        d = {"taskId": "T", "phaseId": "P", "stage": 2, "executorSessionRef": tu.ref("sess")}
        d.update(kw)
        return d

    def test_missing_turn_ref_is_partial(self):
        lines = [start("t1"), rec("t1", "r1", U(10, 1)), end("t1", "2026-01-01T00:00:09Z")]
        out = tu.build_task_usage(self.spec(phaseTurnRefs=["t1", "ghost"]), lines, [])
        sc = out["scopes"]["plannerTurn"]
        self.assertFalse(sc["coverage"]["complete"])
        self.assertIn("turn_not_found", sc["coverage"]["missing"])
        self.assertEqual(sc["tokens"]["input"], 10)  # present numbers still exposed

    def test_unbound_telemetry_not_attributed(self):
        for kw in ({"stage": None}, {"executorSessionRef": None}):
            out = tu.build_task_usage(self.spec(**kw), None, [self.TEL])
            self.assertIsNone(out["execution"]["seconds"])
            self.assertEqual(out["execution"]["gap"], "executor_binding_required_stage_and_executorSessionRef")
            self.assertNotIn("executorInvocation", out["scopes"])
        wrong = tu.build_task_usage(self.spec(executorSessionRef="0000000000"), None, [self.TEL])
        self.assertIsNone(wrong["execution"]["seconds"])

    def test_duplicate_telemetry_not_doubled(self):
        out = tu.build_task_usage(self.spec(), None, [self.TEL, dict(self.TEL)])
        self.assertEqual(out["execution"]["seconds"], 100.0)
        self.assertEqual(out["execution"]["duplicateInvocationRecordsIgnored"], 1)
        t = out["scopes"]["executorInvocation"]["tokens"]
        self.assertEqual((t["input"], t["output"], t["cacheRead"]), (100, 10, 80))
        self.assertEqual(tu.executor_scope([self.TEL, dict(self.TEL)])["tokens"]["input"], 100)

    def test_execution_scope_labelled_partial(self):
        out = tu.build_task_usage(self.spec(), None, [self.TEL])
        ex = out["execution"]
        self.assertEqual(ex["scope"], "observed_executor_invocations_only")
        self.assertTrue(ex["coverage"].startswith("partial"))
        self.assertIsNotNone(ex["sourceAt"])
        inv = tu.to_investment(out)
        self.assertIsNone(inv["executor"]["steps"]["completed"])
        self.assertEqual(inv["executor"]["tokens"]["input"], 100)
        self.assertIsNone(inv["executor"]["tokens"]["nativeTotal"])
        self.assertEqual(inv["executor"]["tokens"]["derivedTotal"], 110)

    def test_mixed_turns_combine_without_dropping_fallback(self):
        lines = [start("t0"), snap("2026-01-01T00:00:01Z", U(5, 1)), end("t0", "2026-01-01T00:00:02Z"),
                 start("t1", "2026-01-01T01:00:00Z"), rec("t1", "r1", U(100, 10)), end("t1", "2026-01-01T01:00:09Z"),
                 start("t2", "2026-01-01T02:00:00Z"), snap("2026-01-01T02:00:01Z", U(35, 6)), snap("2026-01-01T02:00:02Z", U(65, 9)),
                 end("t2", "2026-01-01T02:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t1", "t2"], "x")
        self.assertEqual(s["steps"]["completed"], 3)  # 1 response + 2 snapshot steps (baseline from t1? no: last snapshot t0)
        self.assertEqual(s["tokens"]["input"], 100 + 60)
        self.assertTrue(s["steps"]["basis"].startswith("mixed"))

    def test_snapshot_equal_baseline_not_step_and_regression_partial(self):
        lines = [start("t0"), snap("2026-01-01T00:00:01Z", U(100, 10)), end("t0", "2026-01-01T00:00:02Z"),
                 start("t1", "2026-01-01T01:00:00Z"), snap("2026-01-01T01:00:01Z", U(100, 10)),
                 snap("2026-01-01T01:00:02Z", U(150, 15)), snap("2026-01-01T01:00:03Z", U(20, 2)),
                 snap("2026-01-01T01:00:04Z", U(70, 5)), end("t1", "2026-01-01T01:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "x")
        self.assertTrue(s["coverage"]["partial"])
        self.assertIn("counter_regression_or_reset", s["coverage"]["missing"])
        self.assertEqual(s["steps"]["completed"], 2)  # 100->150 and (after reset baseline) 20->70; equal-to-baseline ignored
        self.assertEqual(s["tokens"]["input"], 100)  # 50 + 50, regression delta never counted as healthy


class EdgeTests(unittest.TestCase):
    def test_non_adjacent_identical_snapshots_ignored(self):
        lines = [start("t0"), snap("2026-01-01T00:00:01Z", U(100, 10)), end("t0", "2026-01-01T00:00:02Z"), start("t1", "2026-01-01T01:00:00Z")]
        for i, v in enumerate((150, 200, 150, 200)):
            lines.append(snap("2026-01-01T01:00:0%dZ" % (i + 1), U(v, 10 + (v - 100) // 10)))
        lines.append(end("t1", "2026-01-01T01:00:09Z"))
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "x")
        self.assertEqual((s["tokens"]["input"], s["steps"]["completed"]), (100, 2))
        self.assertTrue(s["coverage"]["partial"])
        self.assertIn("counter_regression_or_reset", s["coverage"]["missing"])

    def test_known_turn_plus_empty_turn_keeps_lower_bound(self):
        lines = [start("t1"), rec("t1", "r1", U(100, 10)), rec("t1", "r2", U(50, 5)), end("t1", "2026-01-01T00:00:09Z"),
                 start("t2", "2026-01-01T01:00:00Z"), end("t2", "2026-01-01T01:00:09Z")]
        s = tu.turn_scope(tu.parse_native(lines), ["t1", "t2"], "x")
        self.assertEqual((s["tokens"]["input"], s["tokens"]["output"], s["steps"]["completed"]), (150, 15, 2))
        self.assertTrue(s["coverage"]["partial"])
        self.assertFalse(s["coverage"]["complete"])
        self.assertIn("no_usage_records_in_turn", s["coverage"]["missing"])
        self.assertIsNone(s["tokens"]["nativeTotal"])
        self.assertEqual(s["tokens"]["derivedTotal"], 165)

    def test_duplicated_batch_keeps_first_baseline(self):
        batch = [start("t1", "2026-01-01T01:00:00Z"), snap("2026-01-01T01:00:01Z", U(150, 15)), snap("2026-01-01T01:00:02Z", U(200, 20)),
                 end("t1", "2026-01-01T01:00:09Z")]
        lines = [start("t0"), snap("2026-01-01T00:00:01Z", U(100, 10)), end("t0", "2026-01-01T00:00:02Z")] + batch + batch
        s = tu.turn_scope(tu.parse_native(lines), ["t1"], "x")
        self.assertEqual((s["tokens"]["input"], s["steps"]["completed"]), (100, 2))
        self.assertNotIn("baseline_snapshot_missing_before_turn", s["coverage"]["missing"])


class ResultTests(unittest.TestCase):
    def test_phase_hook_additive_and_no_v1_mirror(self):
        phase = {"taskId": "T", "phaseId": "P", "startedAt": "2026-01-01T00:00:00Z", "threadIds": ["a"],
                 "boundarySource": "explicit_phase", "scopeComplete": False, "endedAt": None}
        lines = [start("t1"), rec("t1", "r1", U(100, 10, 60, 10)), end("t1", "2026-01-01T00:00:09Z")]
        usage = tu.build_task_usage({"taskId": "T", "phaseId": "P", "stage": 2, "executorSessionRef": tu.ref("s"),
                                     "phaseTurnRefs": ["t1"], "primaryScope": "plannerTurn",
                                     "result": {"kind": "before_after", "metric": "m", "unit": "ms", "before": 0.26368208, "after": 0.107675,
                                                "scope": "same input local reader, not host speed", "source": "x"}}, lines,
                                    [{"round_index": 2, "session": "s", "started_at": "2026-01-01T00:00:00Z", "duration_seconds": 30}])
        r = aggregate_phase_with_task_usage(phase, [], usage, "2026-11-03T19:02:00Z")
        self.assertIsNone(r["duration"]["activeExecutionSeconds"])
        self.assertNotIn("phaseMetrics", r["investment"])
        ti = r["investment"]["taskUsage"]
        self.assertEqual(ti["executor"]["executionSeconds"], 30.0)
        self.assertEqual(ti["model"]["steps"]["completed"], 1)
        self.assertEqual(ti["model"]["tokens"]["derivedTotal"], 110)
        self.assertEqual((ti["result"]["before"], ti["result"]["after"], ti["result"]["unit"]), (0.26368208, 0.107675, "ms"))
        self.assertFalse(aggregate_phase_with_task_usage(phase, [], None)["investment"]["taskUsage"]["available"])


if __name__ == "__main__":
    unittest.main()
