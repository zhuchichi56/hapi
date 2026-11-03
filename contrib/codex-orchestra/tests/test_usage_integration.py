"""Focused synthetic contract tests; no real sessions or sample fallback."""
import copy
import json
import os
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from orchestra import task_usage as usage
from orchestra import usage_integration as integration


def event(kind, at, **payload):
    return {"type": kind, "timestamp": at, "payload": payload}


def tokens(i, o, cached=0, written=0):
    return {"input_tokens": i, "output_tokens": o, "cached_input_tokens": cached,
            "cache_write_input_tokens": written, "total_tokens": i + o}


def turn(tid="turn-one", rid="response-one", i=100, o=10, at="2026-01-01T00:00:01Z",
         start="2026-01-01T00:00:00Z", end="2026-01-01T00:00:10Z"):
    return [event("event_msg", start, type="task_started", turn_id=tid),
            event("turn_context", start, turn_id=tid, model="model", secret="discard-context"),
            event("token_usage_record", at, turn_id=tid, response_id=rid,
                  usage=tokens(i, o, 60 if i >= 60 else 0, 10 if i >= 60 else 0), secret="discard-usage"),
            event("response_item", at, type="function_call", call_id="call-" + tid,
                  arguments="discard-arguments", text="discard-tool-body"),
            event("event_msg", end, type="task_complete", turn_id=tid, duration_ms=10000)]


class Ledger:
    def __init__(self, state_dir):
        self.state_dir = state_dir
        self.thread = "native-thread"

    def get_task(self, task_id):
        return {"id": task_id, "thread_id": self.thread} if task_id == "T001" else None


class IntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.getcwd())
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.native = self.root / "original-rollout.jsonl"
        self.telemetry = self.root / "executor-telemetry.jsonl"
        self.ledger = Ledger(self.root)
        self.payload = {"revision": 9, "tasks": [{"id": "T001", "threadId": "native-thread",
                        "investment": {"existing": 27, "result": "preserve"}}]}
        self.binding = {"threadId": "native-thread", "nativePath": str(self.native),
                        "taskTurnsAll": True, "phaseId": "P1", "executorBindings": []}
        integration._SOURCES.clear()
        integration._RESULTS.clear()
        self.write_rows(self.native, turn())
        self.bind()

    def write_rows(self, path, rows, mode="w"):
        with path.open(mode, encoding="utf-8") as fh:
            for row in rows:
                fh.write(json.dumps(row) + "\n")

    def bind(self):
        (self.root / "task-usage-bindings.json").write_text(json.dumps({"version": 1, "tasks": {"T001": self.binding}}))

    def result(self):
        return integration.attach_task_usage(self.payload, self.ledger)["tasks"][0]["investment"]["taskUsage"]

    def test_response_dedup_cache_subset_and_existing_keys(self):
        rows = turn()
        rows.insert(3, rows[2])
        self.write_rows(self.native, rows)
        original = copy.deepcopy(self.payload)
        result = integration.attach_task_usage(self.payload, self.ledger)
        investment = result["tasks"][0]["investment"]
        model = investment["taskUsage"]["model"]
        self.assertEqual(model["steps"]["completed"], 1)
        self.assertEqual(model["tokens"]["derivedTotal"], 110)
        self.assertEqual(model["tokens"]["cacheRead"], 60)
        self.assertEqual(model["tokens"]["cacheWrite"], 10)
        self.assertEqual(model["toolCalls"], 1)
        self.assertEqual(investment["existing"], 27)
        self.assertEqual(investment["result"], "preserve")
        self.assertEqual(self.payload, original)

    def test_explicit_task_and_thread_match_required(self):
        self.binding["threadId"] = "wrong-thread"
        self.bind()
        with patch.object(integration, "_source", side_effect=AssertionError("must not read")):
            self.assertFalse(self.result()["available"])
        self.binding["threadId"] = "native-thread"
        self.bind()
        self.ledger.thread = "different-ledger-thread"
        self.assertFalse(self.result()["available"])

    def test_unbound_task_has_no_sample_fallback(self):
        (self.root / "task-usage-bindings.json").unlink()
        with patch.object(integration, "_source", side_effect=AssertionError("must not read")):
            value = self.result()
        self.assertFalse(value["available"])
        self.assertIsNone(value["sourceAt"])
        self.assertIsNone(value["model"])

    def test_bound_native_append_updates_source_timestamp_and_tokens(self):
        first = self.result()
        self.write_rows(self.native, turn("turn-two", "response-two", 250, 20,
                        at="2026-01-01T01:00:01Z", start="2026-01-01T01:00:00Z",
                        end="2026-01-01T01:00:10Z"), "a")
        second = self.result()
        self.assertNotEqual(first["sourceAt"], second["sourceAt"])
        self.assertEqual(second["sourceAt"], "2026-01-01T01:00:01Z")
        self.assertEqual(second["model"]["tokens"]["input"], 350)
        self.assertEqual(second["model"]["steps"]["completed"], 2)
        self.assertFalse(second["stale"])

    def test_missing_and_rotated_source_preserve_stale_timestamp(self):
        first = self.result()
        self.native.unlink()
        missing = self.result()
        self.assertTrue(missing["stale"])
        self.assertEqual(missing["sourceAt"], first["sourceAt"])
        self.assertEqual(missing["model"]["tokens"], first["model"]["tokens"])
        self.native.write_text("")
        rotated = self.result()
        self.assertTrue(rotated["stale"])
        self.assertEqual(rotated["sourceAt"], first["sourceAt"])
        self.write_rows(self.native, [event("event_msg", "2026-01-02T00:00:00Z", type="task_started", turn_id="rotated-open")])
        opened_replacement = self.result()
        self.assertTrue(opened_replacement["stale"])
        self.assertEqual(opened_replacement["sourceAt"], first["sourceAt"])
        replacement_path = self.root / "replacement.jsonl"
        self.write_rows(replacement_path, turn("new-turn", "new-response", 22, 3, at="2026-01-02T00:00:01Z"))
        replacement_path.replace(self.native)
        replacement = self.result()
        self.assertFalse(replacement["stale"])
        self.assertEqual(replacement["model"]["tokens"]["input"], 22)
        self.assertEqual(replacement["sourceAt"], "2026-01-02T00:00:01Z")

    def test_truncation_and_same_size_rewrite_invalidate(self):
        first = self.result()
        self.native.write_text("\n")
        self.assertTrue(self.result()["stale"])
        self.write_rows(self.native, turn(i=200))
        self.assertEqual(self.result()["model"]["tokens"]["input"], 200)
        before = self.native.stat().st_size
        self.native.write_text(self.native.read_text().replace('200', '300'))
        self.assertEqual(self.native.stat().st_size, before)
        self.assertEqual(self.result()["model"]["tokens"]["input"], 300)
        self.assertEqual(first["model"]["tokens"]["input"], 100)

    def test_exact_native_turn_refs_and_scope_consistent_wall(self):
        self.write_rows(self.native, turn() + turn("turn-two", "response-two", 20, 2,
                        at="2026-01-01T01:00:01Z", start="2026-01-01T01:00:00Z", end="2026-01-01T01:00:10Z"))
        self.binding.update(taskTurnsAll=False, phaseTurnRefs=[usage.ref("turn-two")])
        self.bind()
        result = self.result()
        self.assertEqual(result["model"]["scope"], "planner_phase_turn")
        self.assertEqual(result["model"]["tokens"]["input"], 20)
        self.assertEqual(result["wall"]["seconds"], 10)
        self.binding["taskTurnsAll"] = True
        self.bind()
        cumulative = self.result()
        self.assertEqual(cumulative["wall"]["scope"], "task_cumulative")
        self.assertEqual(cumulative["wall"]["seconds"], 3610)
        self.binding.update(taskTurnsAll=False, phaseTurnRefs=["turn-tw"])
        self.bind()
        self.assertIsNone(self.result()["model"]["tokens"]["input"])

    def test_explicit_boolean_whole_task_required(self):
        self.binding["taskTurnsAll"] = "true"
        self.bind()
        self.assertFalse(self.result()["available"])
        self.binding.update(taskTurnsAll=False)
        self.bind()
        self.assertFalse(self.result()["available"])

    def test_exact_ref_cannot_select_an_earlier_longer_native_id(self):
        self.write_rows(self.native, turn("turn-one-longer", "long-response", 900, 90) + turn())
        self.binding.update(taskTurnsAll=False, phaseTurnRefs=["turn-one"])
        self.bind()
        self.assertEqual(self.result()["model"]["tokens"]["input"], 100)
        self.binding.update(phaseTurnRefs=[], currentTurnRef="turn-one")
        self.bind()
        current = self.result()["model"]
        self.assertEqual(current["scope"], "current_open_turn")
        self.assertEqual(current["tokens"]["input"], 100)

    def telemetry_row(self, index, start, end, session="executor-session", i=10):
        return {"session": session, "round_index": index, "started_at": start, "finished_at": end,
                "executor": "codex", "model": "model", "usage": {"tokens": {"input": i, "output": 2,
                "cached_read": 4, "total": i + 2}}, "tool_arguments": "discard-telemetry-body"}

    def test_executor_three_rounds_union_dedup_and_unknown_steps(self):
        rows = [self.telemetry_row(1, "2026-01-01T00:00:00Z", "2026-01-01T00:01:40Z"),
                self.telemetry_row(2, "2026-01-01T00:01:00Z", "2026-01-01T00:02:40Z"),
                self.telemetry_row(3, "2026-01-01T00:03:00Z", "2026-01-01T00:03:50Z")]
        rows += [rows[0], self.telemetry_row(4, "2026-01-01T00:04:00Z", "2026-01-01T00:05:00Z", i=900),
                 self.telemetry_row(1, "2026-01-01T00:05:00Z", "2026-01-01T00:06:00Z", session="other-session", i=999)]
        self.write_rows(self.telemetry, rows)
        self.binding["executorBindings"] = [{"telemetryPath": str(self.telemetry),
                    "sessionRef": usage.ref("executor-session"), "roundIndexes": [1, 2, 3]}]
        self.bind()
        value = self.result()
        ex = value["executor"]
        self.assertEqual(ex["executionSeconds"], 210)
        self.assertEqual(ex["excludedGapSeconds"], 20)
        self.assertEqual(ex["invocationCount"], 3)
        self.assertEqual(ex["duplicateInvocationRecordsIgnored"], 1)
        self.assertEqual(ex["tokens"]["input"], 30)
        self.assertEqual(ex["tokens"]["derivedTotal"], 36)
        self.assertIsNone(ex["steps"]["completed"])
        self.assertEqual(ex["tokensSourceAt"], "2026-01-01T00:03:50Z")
        self.assertIn("partial", ex["coverage"])
        self.assertEqual(value["model"]["tokens"]["input"], 100)

    def claude_rows(self):
        rows = [self.telemetry_row(n, "2026-01-01T00:0%d:00Z" % n,
                                   "2026-01-01T00:0%d:30Z" % n) for n in (1, 2, 3)]
        for r in rows:
            r["executor"] = "claude"
            r["usage"]["tokens"] = {"input": 1, "output": 8, "cached_read": 498,
                                       "cache_write": 14, "total": None}
        return rows

    def bind_claude(self):
        self.binding["executorBindings"] = [{"telemetryPath": str(self.telemetry),
                    "sessionRef": usage.ref("executor-session"), "roundIndexes": [1, 2, 3]}]
        self.bind()

    def test_claude_cache_exclusive_input_normalized_once_after_dedup(self):
        rows = self.claude_rows()
        self.write_rows(self.telemetry, rows[:2] + [rows[0]])
        self.bind_claude()
        before = self.result()
        self.assertEqual(before["executor"]["tokens"]["input"], 1026)
        self.write_rows(self.telemetry, rows[2:], "a")
        value = self.result()
        ex = value["executor"]
        self.assertEqual(ex["tokens"]["input"], 1539)
        self.assertEqual(ex["tokens"]["output"], 24)
        self.assertEqual(ex["tokens"]["derivedTotal"], 1563)
        self.assertEqual(ex["tokens"]["cacheRead"], 1494)
        self.assertEqual(ex["tokens"]["cacheWrite"], 42)
        self.assertIsNone(ex["tokens"]["nativeTotal"])
        self.assertEqual(ex["tokens"]["cacheConvention"], "included_in_input")
        self.assertEqual(ex["tokens"]["sourceCacheConvention"], "excluded_from_input")
        self.assertEqual(ex["tokens"]["inputUncached"], 3)
        self.assertEqual(ex["tokenProvenance"]["claude"]["summaryRecords"], 3)
        self.assertEqual(ex["duplicateInvocationRecordsIgnored"], 1)
        self.assertEqual(self.result(), value)
        self.assertEqual(value["model"]["tokens"]["input"], 100)
        self.assertEqual(value["model"]["tokens"]["derivedTotal"], 110)

    def test_claude_unknown_cache_category_is_not_zero_or_partial_total(self):
        rows = self.claude_rows()
        del rows[1]["usage"]["tokens"]["cache_write"]
        self.write_rows(self.telemetry, rows)
        self.bind_claude()
        ex = self.result()["executor"]
        self.assertIsNone(ex["tokens"]["input"])
        self.assertIsNone(ex["tokens"]["cacheWrite"])
        self.assertIsNone(ex["tokens"]["derivedTotal"])
        self.assertIsNone(ex["tokens"]["nativeTotal"])
        self.assertEqual(ex["tokens"]["output"], 24)
        self.assertEqual(ex["tokens"]["cacheRead"], 1494)
        self.assertEqual(ex["tokens"]["inputUncached"], 3)
        self.assertIn("claude_inclusive_input_requires_uncached_input_cache_read_and_cache_write", ex["tokensMissing"])

    def test_claude_explicit_zero_cache_is_known(self):
        rows = self.claude_rows()
        for row in rows:
            row["usage"]["tokens"].update(cached_read=0, cache_write=0)
        self.write_rows(self.telemetry, rows)
        self.bind_claude()
        tokens = self.result()["executor"]["tokens"]
        self.assertEqual(tokens["input"], 3)
        self.assertEqual(tokens["cacheRead"], 0)
        self.assertEqual(tokens["cacheWrite"], 0)
        self.assertEqual(tokens["derivedTotal"], 27)

    def test_open_native_cumulative_scope_has_null_wall(self):
        self.write_rows(self.native, turn()[:-1])
        value = self.result()
        self.assertEqual(value["model"]["scope"], "task_cumulative")
        self.assertEqual(value["model"]["tokens"]["input"], 100)
        self.assertTrue(value["model"]["responsePending"])
        self.assertIsNone(value["wall"])

    def test_cache_retains_metadata_only_and_reuses_computation(self):
        self.write_rows(self.native, [event("response_item", "2026-01-01T00:00:00Z", type="message", text="discard-user-body")] + turn())
        first = self.result()
        cached = repr(integration._SOURCES)
        for secret in ("discard-context", "discard-usage", "discard-arguments", "discard-tool-body", "discard-user-body"):
            self.assertNotIn(secret, cached)
        with patch.object(usage, "build_task_usage", side_effect=AssertionError("recomputed")):
            second = self.result()
        self.assertEqual(first, second)
        second["model"]["tokens"]["input"] = 9999
        self.assertEqual(self.result()["model"]["tokens"]["input"], 100)

    def test_incomplete_json_append_is_not_retained_and_is_retried(self):
        first = self.result()
        row = json.dumps(event("token_usage_record", "2026-01-01T00:00:08Z", turn_id="turn-one", response_id="late", usage=tokens(5, 1)))
        with self.native.open("a") as fh:
            fh.write(row[:30])
        self.assertEqual(self.result()["model"]["tokens"], first["model"]["tokens"])
        with self.native.open("a") as fh:
            fh.write(row[30:] + "\n")
        self.assertEqual(self.result()["model"]["tokens"]["input"], 105)

    def test_concurrent_reads_are_consistent(self):
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.result(), range(24)))
        self.assertTrue(all(r == results[0] for r in results))

    def test_metadata_limit_fails_stale_without_killing_snapshot(self):
        first = self.result()
        self.write_rows(self.native, turn("turn-two", "response-two"), "a")
        with patch.object(integration, "_MAX_METADATA_BYTES", 1):
            stale = self.result()
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["sourceAt"], first["sourceAt"])

    def test_missing_native_first_read_keeps_bound_executor_usage(self):
        self.native.unlink()
        self.write_rows(self.telemetry, [self.telemetry_row(1, "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")])
        self.binding["executorBindings"] = [{"telemetryPath": str(self.telemetry),
                    "sessionRef": usage.ref("executor-session"), "roundIndexes": [1]}]
        self.bind()
        value = self.result()
        self.assertTrue(value["available"])
        self.assertIsNone(value["model"])
        self.assertEqual(value["executor"]["tokens"]["input"], 10)
        self.assertIn("native_source_unavailable_or_changed", value["missing"])

    def test_initial_partial_coverage_is_cached_and_native_can_advance(self):
        self.binding["executorBindings"] = [{"telemetryPath": str(self.telemetry),
                    "sessionRef": usage.ref("executor-session"), "roundIndexes": [1]}]
        self.bind()
        first = self.result()
        self.assertEqual(first["model"]["tokens"]["input"], 100)
        with patch.object(usage, "build_task_usage", side_effect=AssertionError("recomputed")):
            self.assertEqual(self.result(), first)
        self.write_rows(self.native, turn("turn-two", "response-two", i=25), "a")
        advanced = self.result()
        self.assertEqual(advanced["model"]["tokens"]["input"], 125)
        self.native.unlink()
        stale = self.result()
        self.assertTrue(stale["stale"])
        self.assertEqual(stale["model"]["tokens"]["input"], 125)

    def test_binding_for_a_different_task_is_never_matched_by_thread(self):
        (self.root / "task-usage-bindings.json").write_text(json.dumps({"version": 1, "tasks": {"T999": self.binding}}))
        with patch.object(integration, "_source", side_effect=AssertionError("must not read")):
            self.assertFalse(self.result()["available"])

    def test_native_counter_baseline_and_duplicates_survive_metadata_filter(self):
        def snapshot(i, o, at):
            return event("event_msg", at, type="token_count", info={
                "total_token_usage": tokens(i, o, i // 2),
                "last_token_usage": tokens(50, 5), "text": "discard-counter-body"})
        rows = [snapshot(100, 10, "2026-01-01T00:00:00Z"),
                event("event_msg", "2026-01-01T00:00:01Z", type="task_started", turn_id="target"),
                snapshot(150, 15, "2026-01-01T00:00:02Z"),
                snapshot(150, 15, "2026-01-01T00:00:02Z"),
                snapshot(200, 20, "2026-01-01T00:00:03Z"),
                event("event_msg", "2026-01-01T00:00:04Z", type="task_complete", turn_id="target", duration_ms=3000)]
        self.write_rows(self.native, rows)
        self.binding.update(taskTurnsAll=False, phaseTurnRefs=["target"])
        self.bind()
        model = self.result()["model"]
        self.assertEqual(model["steps"]["completed"], 2)
        self.assertEqual(model["tokens"]["input"], 100)
        self.assertEqual(model["tokens"]["output"], 10)
        self.assertEqual(model["tokens"]["derivedTotal"], 110)
        self.assertEqual(model["tokens"]["cacheRead"], 50)
        self.assertEqual(model["sourceAt"], "2026-01-01T00:00:03Z")
        self.assertNotIn("discard-counter-body", repr(integration._SOURCES))


def benchmark():
    """Measure the same synthetic snapshot cold, cached and after one append."""
    fixture = IntegrationTests()
    fixture.setUp()
    try:
        rows = []
        for n in range(1000):
            rows.extend(turn("turn-%d" % n, "response-%d" % n))
            rows.append(event("response_item", "2026-01-01T00:00:01Z", type="message", text="x" * 20000))
        fixture.write_rows(fixture.native, rows)
        start = time.perf_counter()
        first = fixture.result()
        cold = time.perf_counter() - start
        timings = []
        for _ in range(100):
            start = time.perf_counter()
            cached = fixture.result()
            timings.append(time.perf_counter() - start)
            if cached != first:
                raise AssertionError("cached result differs")
        fixture.write_rows(fixture.native, turn("turn-appended", "response-appended"), "a")
        start = time.perf_counter()
        appended = fixture.result()
        append_seconds = time.perf_counter() - start
        if appended["model"]["tokens"]["input"] != 100100:
            raise AssertionError("append usage did not advance")
        return {"input": "synthetic metadata plus discarded message bodies; not live performance",
                "nativeBytesAfterAppend": fixture.native.stat().st_size, "turnsInitially": 1000,
                "coldReadSeconds": cold, "cachedReadCount": len(timings),
                "cachedReadMeanSeconds": sum(timings) / len(timings),
                "cachedReadMinSeconds": min(timings), "cachedReadMaxSeconds": max(timings),
                "appendReadSeconds": append_seconds,
                "initialInputTokens": first["model"]["tokens"]["input"],
                "appendedInputTokens": appended["model"]["tokens"]["input"]}
    finally:
        fixture.doCleanups()


if __name__ == "__main__":
    import sys
    if sys.argv[1:] == ["--benchmark"]:
        print(json.dumps(benchmark(), indent=2))
    else:
        unittest.main()
