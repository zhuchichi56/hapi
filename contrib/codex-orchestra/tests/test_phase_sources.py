"""Synthetic-only regression tests for source accounting boundaries."""

import copy
import itertools
import json
import unittest
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from orchestra.phase_sources import (
    aggregate_counter_windows, aggregate_dsh_steps, native_counter_window, normalize_dsh_step,
)


def native_scope(**changes):
    return {"taskId": "task-1", "phaseId": "phase-1", "threadIds": ["thread-1", "thread-2"],
            "startedAt": 10, "endedAt": 100, **changes}


def sample(at, revision=None, thread="thread-1"):
    return {
        "threadId": thread, "phaseId": "phase-1", "observedAt": at,
        "revision": at if revision is None else revision,
        "tokenUsage": {"total": {
            "inputTokens": 1000 + at * 10, "outputTokens": 200 + at * 2,
            "cachedInputTokens": 400 + at, "cacheWriteInputTokens": 100,
            "totalTokens": 1200 + at * 12, "reasoningOutputTokens": 40 + at,
        }, "last": {"inputTokens": 999999, "outputTokens": 999999}},
    }


def window(start=20, end=40, thread="thread-1"):
    return native_counter_window(sample(start, thread=thread), sample(end, thread=thread), native_scope())


def dsh_scope(**changes):
    return {"taskId": "task-1", "phaseId": "phase-1", "executorId": "executor-1",
            "startedAt": 10, "endedAt": 100, **changes}


def event(step=1, **changes):
    return {"type": "status", "phase": "step_end", "turn": 1, "step": step,
            "usage": {"inputTokens": 10, "cacheReadTokens": 5, "outputTokens": 3, "totalTokens": 18},
            **changes}


def dsh(step=1, **changes):
    return normalize_dsh_step(event(step, **changes), dsh_scope(), "source-1")


class NativeTests(unittest.TestCase):
    def test_numeric_delta_and_reasoning_metadata(self):
        record = window()
        self.assertEqual(record["status"], "accepted")
        self.assertEqual(record["observedTokens"], {
            "inputTokens": 200, "outputTokens": 40, "cacheReadInputTokens": 20,
            "cacheWriteInputTokens": 0, "totalTokens": 240,
        })
        self.assertEqual(record["metadata"], {"reasoningOutputTokens": 20})
        self.assertEqual(record["cacheConvention"], "included_in_input")
        self.assertEqual(record["scope"], "observed_counter_window")
        self.assertEqual(record["coverage"], "partial")
        self.assertIsNone(record["inputTokens"])
        self.assertIsNone(record["outputTokens"])
        self.assertFalse(record["phaseTokensComplete"])

    def test_last_ignored_even_if_malformed(self):
        before, after = sample(20), sample(40)
        expected = native_counter_window(before, after, native_scope())
        before["tokenUsage"]["last"] = {"inputTokens": -999, "reasoning": "PRIVATE"}
        after["tokenUsage"]["last"] = "PRIVATE"
        self.assertEqual(expected, native_counter_window(before, after, native_scope()))

    def test_no_baseline_or_lifetime_fallback(self):
        for before in (None, {}, {"threadId": "thread-1"}):
            with self.subTest(before=before):
                record = native_counter_window(before, sample(40), native_scope())
                self.assertEqual(record["status"], "rejected")
                self.assertIsNone(record["inputTokens"])
        before = sample(20)
        before["tokenUsage"]["total"] = {}
        self.assertEqual(native_counter_window(before, sample(40), native_scope())["reason"],
                         "missing_counter_baseline")

    def test_thread_phase_and_registration(self):
        cases = [(sample(20), sample(40, thread="thread-2"), native_scope(), "thread_mismatch"),
                 (sample(20), sample(40), native_scope(threadIds=["thread-2"]), "unregistered_thread"),
                 (sample(20), sample(40), native_scope(phaseId="phase-2"), "phase_mismatch")]
        for before, after, scope, reason in cases:
            with self.subTest(reason=reason):
                self.assertEqual(native_counter_window(before, after, scope)["reason"], reason)

    def test_any_known_counter_decrease_is_reset(self):
        for key in sample(20)["tokenUsage"]["total"]:
            with self.subTest(key=key):
                before, after = sample(20), sample(40)
                after["tokenUsage"]["total"][key] = before["tokenUsage"]["total"][key] - 1
                record = native_counter_window(before, after, native_scope())
                self.assertEqual(record["reason"], "counter_decrease")
                self.assertTrue(record["resetDetected"])

    def test_invalid_known_counter_types(self):
        for value in (True, False, -1, 1.0, float("nan"), float("inf"), "12", [], {}):
            with self.subTest(value=repr(value)):
                after = sample(40)
                after["tokenUsage"]["total"]["inputTokens"] = value
                self.assertEqual(native_counter_window(sample(20), after, native_scope())["reason"],
                                 "invalid_counters")

    def test_repeated_observation_is_not_a_window(self):
        before = sample(20)
        self.assertEqual(native_counter_window(before, before, native_scope())["status"], "duplicate")
        later = copy.deepcopy(before)
        later["observedAt"] = 40
        self.assertEqual(native_counter_window(before, later, native_scope())["status"], "duplicate")
        later = sample(40, revision=20)
        self.assertEqual(native_counter_window(before, later, native_scope())["reason"], "observation_conflict")
        later["observedAt"] = 20
        later["revision"] = 40
        self.assertEqual(native_counter_window(before, later, native_scope())["reason"], "observation_conflict")

    def test_timestamp_and_revision_order(self):
        self.assertEqual(native_counter_window(sample(40), sample(20), native_scope())["reason"],
                         "out_of_order_timestamp")
        self.assertEqual(native_counter_window(sample(20, 40), sample(40, 20), native_scope())["reason"],
                         "out_of_order_revision")
        for revision in (True, -1, 1.2, "2"):
            after = sample(40)
            after["revision"] = revision
            self.assertEqual(native_counter_window(sample(20), after, native_scope())["reason"], "invalid_revision")
        before, after = sample(20), sample(40)
        del before["revision"]
        self.assertEqual(native_counter_window(before, after, native_scope())["reason"], "invalid_revision")
        del after["revision"]
        self.assertEqual(native_counter_window(before, after, native_scope())["status"], "accepted")

    def test_timestamp_bounds_and_future(self):
        for start, end in ((9, 20), (20, 101)):
            self.assertEqual(window(start, end)["reason"], "outside_phase_or_future")
        self.assertEqual(window(10, 100)["status"], "accepted")
        scope = native_scope(endedAt=None, asOf=30)
        self.assertEqual(native_counter_window(sample(20), sample(40), scope)["reason"], "outside_phase_or_future")
        self.assertEqual(native_counter_window(sample(20), sample(30), scope)["status"], "accepted")
        self.assertEqual(native_counter_window(sample(20), sample(40), native_scope(endedAt=None))["reason"], "invalid_scope")
        for scope in (native_scope(endedAt=9), native_scope(asOf=90), native_scope(startedAt=True)):
            self.assertEqual(native_counter_window(sample(20), sample(40), scope)["reason"], "invalid_scope")

    def test_invalid_timestamps(self):
        for at in (True, -1, float("nan"), float("inf"), "2026-01-01", "2026-01-01T00:00:00", 10 ** 400):
            after = sample(40)
            after["observedAt"] = at
            self.assertEqual(native_counter_window(sample(20), after, native_scope())["reason"], "invalid_timestamp")

    def test_stable_id_and_equivalent_clock_encodings(self):
        before, after = sample(20), sample(40)
        original = native_counter_window(before, after, native_scope())
        before["observedAt"] = "1970-01-01T08:00:20+08:00"
        after["observedAt"] = 40.0
        self.assertEqual(native_counter_window(before, after, native_scope())["windowId"], original["windowId"])
        self.assertEqual(len(original["windowId"]), 64)

    def test_missing_metric_is_unknown(self):
        before, after = sample(20), sample(40)
        del before["tokenUsage"]["total"]["cacheWriteInputTokens"]
        record = native_counter_window(before, after, native_scope())
        self.assertEqual(record["observedTokens"]["inputTokens"], 200)
        self.assertIsNone(record["observedTokens"]["cacheWriteInputTokens"])
        self.assertIsNone(record["observedTokens"]["totalTokens"])
        self.assertIsNone(record["cacheConvention"])

    def test_endpoint_and_delta_identity_validation(self):
        after = sample(40)
        after["tokenUsage"]["total"]["totalTokens"] += 1
        self.assertEqual(native_counter_window(sample(20), after, native_scope())["reason"], "inconsistent_native_counters")
        after = sample(40)
        after["tokenUsage"]["total"]["cachedInputTokens"] = 900
        self.assertEqual(native_counter_window(sample(20), after, native_scope())["reason"], "inconsistent_native_delta")
        after["tokenUsage"]["total"]["cachedInputTokens"] = 99999
        self.assertEqual(native_counter_window(sample(20), after, native_scope())["reason"], "inconsistent_native_counters")

    def test_pure_and_private(self):
        before, after, scope = sample(20), sample(40), native_scope()
        for record in (before, after):
            record.update(body="SECRET_BODY", reasoning="SECRET_REASONING", clock="SECRET_CLOCK")
            record["tokenUsage"]["total"]["unknown"] = "SECRET_UNKNOWN"
        saved = copy.deepcopy((before, after, scope))
        result = native_counter_window(before, after, scope)
        self.assertEqual((before, after, scope), saved)
        self.assertNotIn("SECRET_", json.dumps(result))


class NativeAggregationTests(unittest.TestCase):
    def test_deduplication(self):
        record = window()
        result = aggregate_counter_windows([record, copy.deepcopy(record), record])
        self.assertEqual(result["observedTokens"]["totalTokens"], 240)
        self.assertEqual(result["coverageCounts"]["duplicateRecords"], 2)
        self.assertEqual(result["coverageCounts"]["acceptedWindows"], 1)

    def test_repeated_observation_has_no_extra_window_or_rejection(self):
        duplicate = native_counter_window(sample(20), sample(20), native_scope())
        result = aggregate_counter_windows([window(), duplicate])
        self.assertEqual(result["coverageCounts"]["duplicateObservations"], 1)
        self.assertEqual(result["coverageCounts"]["rejectedRecords"], 0)
        self.assertEqual(result["observedTokens"]["totalTokens"], 240)

    def test_adjacent_windows_sum(self):
        result = aggregate_counter_windows([window(40, 60), window(20, 40)])
        self.assertEqual(result["observedTokens"]["totalTokens"], 480)
        self.assertEqual(result["observedElapsedSeconds"], 40)

    def test_overlap_excludes_entire_thread_set(self):
        result = aggregate_counter_windows([window(20, 40), window(30, 50), window(60, 70)])
        self.assertIsNone(result["observedTokens"]["totalTokens"])
        self.assertIsNone(result["observedElapsedSeconds"])
        self.assertEqual(result["coverageCounts"]["excludedAmbiguousWindows"], 3)

    def test_different_threads_sum_spend_union_elapsed(self):
        result = aggregate_counter_windows([window(20, 40), window(30, 50, "thread-2")])
        self.assertEqual(result["observedTokens"]["totalTokens"], 480)
        self.assertEqual(result["observedElapsedSeconds"], 30)
        disjoint = aggregate_counter_windows([window(20, 30), window(40, 50, "thread-2")])
        self.assertEqual(disjoint["observedElapsedSeconds"], 20)

    def test_conflicting_id_and_overlap_leave_other_thread(self):
        first = window()
        conflict = copy.deepcopy(first)
        conflict["observedTokens"]["cacheWriteInputTokens"] = 1
        result = aggregate_counter_windows([first, conflict, window(50, 60), window(20, 40, "thread-2")])
        self.assertEqual(result["coverageCounts"]["conflictingWindowIds"], 1)
        self.assertEqual(result["coverageCounts"]["acceptedWindows"], 1)
        self.assertEqual(result["observedTokens"]["totalTokens"], 240)

    def test_conflict_replays_have_order_independent_counts(self):
        first = window()
        second = copy.deepcopy(first)
        second["observedTokens"]["cacheWriteInputTokens"] = 1
        results = [aggregate_counter_windows(order) for order in itertools.permutations([first, second, second])]
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(results[0]["coverageCounts"]["duplicateRecords"], 1)

    def test_missing_metric_coverage_and_no_invented_zero(self):
        complete, partial = window(), window(40, 60)
        partial["observedTokens"]["cacheWriteInputTokens"] = None
        partial["observedTokens"]["totalTokens"] = None
        result = aggregate_counter_windows([complete, partial])
        self.assertEqual(result["observedTokens"]["inputTokens"], 400)
        self.assertIsNone(result["observedTokens"]["totalTokens"])
        self.assertEqual(result["knownObservedTokens"]["totalTokens"], 240)
        self.assertEqual(result["coverageCounts"]["metricKnownWindows"]["totalTokens"], 1)
        self.assertIsNone(aggregate_counter_windows([])["observedTokens"]["totalTokens"])

    def test_cross_phase_rejected_and_sources_never_merged(self):
        other = window()
        other["phaseId"] = "phase-2"
        self.assertEqual(aggregate_counter_windows([window(), other])["reason"], "mixed_task_or_phase")
        result = aggregate_counter_windows([window(), dsh()])
        self.assertEqual(result["observedTokens"]["totalTokens"], 240)
        self.assertEqual(result["coverageCounts"]["rejectedRecords"], 1)


class DshTests(unittest.TestCase):
    def test_missing_total_cannot_prove_inclusive_input_without_cache_write(self):
        record = dsh(usage={"inputTokens": 10, "cacheReadTokens": 5, "outputTokens": 3})
        self.assertIsNone(record["observedTokens"]["inputTokens"])
        self.assertEqual(record["uncachedInputTokens"], 10)
        self.assertEqual(record["observedTokens"]["cacheReadInputTokens"], 5)
        self.assertIsNone(record["observedTokens"]["cacheWriteInputTokens"])

    def test_included_cache_conversion_no_timing(self):
        record = dsh()
        self.assertEqual(record["observedTokens"], {
            "inputTokens": 15, "outputTokens": 3, "cacheReadInputTokens": 5,
            "cacheWriteInputTokens": None, "totalTokens": 18,
        })
        self.assertEqual(record["uncachedInputTokens"], 10)
        self.assertEqual(record["coverage"], "executor_observed_steps")
        self.assertIsNone(record["clock"])
        self.assertNotIn("windowStart", record)
        self.assertIsNone(record["inputTokens"])
        self.assertFalse(record["phaseTokensComplete"])

    def test_total_requires_original_and_verified_identity(self):
        for usage in ({"inputTokens": 10, "outputTokens": 3, "totalTokens": 18},
                      {"inputTokens": 10, "cacheReadTokens": 5, "outputTokens": 3}):
            record = dsh(usage=usage)
            self.assertIsNone(record["observedTokens"]["totalTokens"])
        record = dsh(usage={"inputTokens": 10, "cacheReadTokens": 5, "outputTokens": 3, "totalTokens": 13})
        self.assertEqual(record["status"], "rejected")
        self.assertEqual(record["reason"], "inconsistent_dsh_total")

    def test_missing_step_usage_and_step_start(self):
        missing = dsh(usage=None)
        empty = dsh(2, usage={})
        start = dsh(3, phase="step_start", usage=None)
        wrong_type = dsh(4, type="message", usage=None)
        result = aggregate_dsh_steps([missing, empty, start, wrong_type])
        counts = result["coverageCounts"]
        self.assertEqual(counts["uniqueStepEnds"], 2)
        self.assertEqual(counts["missingUsageSteps"], 2)
        self.assertEqual(counts["recordsWithoutUsage"], 2)
        self.assertEqual(counts["ignoredRecords"], 2)
        self.assertIsNone(result["knownObservedTokens"]["totalTokens"])

    def test_replay_deduplicates_and_ids_stable(self):
        record = dsh()
        self.assertEqual(record["stepId"], dsh()["stepId"])
        result = aggregate_dsh_steps([record, dsh(), dsh(2)])
        self.assertEqual(result["coverageCounts"]["uniqueStepEnds"], 2)
        self.assertEqual(result["coverageCounts"]["duplicateRecords"], 1)
        self.assertEqual(result["observedTokens"]["totalTokens"], 36)
        self.assertIsNone(result["observedTokens"]["cacheWriteInputTokens"])

    def test_conflicting_duplicate_becomes_missing_in_either_order(self):
        first = dsh()
        conflict = dsh(usage={"inputTokens": 11, "cacheReadTokens": 5, "outputTokens": 3, "totalTokens": 19})
        a = aggregate_dsh_steps([first, conflict, dsh(2)])
        b = aggregate_dsh_steps([conflict, first, dsh(2)])
        self.assertEqual(a, b)
        self.assertEqual(a["coverageCounts"]["conflictingSteps"], 1)
        self.assertEqual(a["coverageCounts"]["uniqueStepEnds"], 2)
        self.assertEqual(a["coverageCounts"]["missingUsageSteps"], 1)
        self.assertIsNone(a["observedTokens"]["totalTokens"])
        self.assertEqual(a["knownObservedTokens"]["totalTokens"], 18)

    def test_conflicting_unverifiable_original_total_not_hidden(self):
        result = aggregate_dsh_steps([dsh(usage={"totalTokens": 10}), dsh(usage={"totalTokens": 20})])
        self.assertEqual(result["coverageCounts"]["conflictingSteps"], 1)
        self.assertEqual(result["coverageCounts"]["missingUsageSteps"], 1)

    def test_conflicting_replay_counts_are_order_independent(self):
        first = dsh()
        second = dsh(usage={"inputTokens": 11, "cacheReadTokens": 5, "outputTokens": 3, "totalTokens": 19})
        results = [aggregate_dsh_steps(order) for order in itertools.permutations([first, second, second])]
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(results[0]["coverageCounts"]["duplicateRecords"], 1)
        self.assertEqual(results[0]["coverageCounts"]["conflictingSteps"], 1)

    def test_missing_then_complete_is_conflict(self):
        result = aggregate_dsh_steps([dsh(usage=None), dsh()])
        self.assertEqual(result["coverageCounts"]["conflictingSteps"], 1)
        self.assertIsNone(result["knownObservedTokens"]["totalTokens"])

    def test_partial_step_preserves_exact_metric_coverage(self):
        result = aggregate_dsh_steps([dsh(), dsh(2, usage={"outputTokens": 7}), dsh(3, usage=None)])
        counts = result["coverageCounts"]
        self.assertEqual(counts["uniqueStepEnds"], 3)
        self.assertEqual(counts["stepsWithUsage"], 2)
        self.assertEqual(counts["missingUsageSteps"], 1)
        self.assertEqual(counts["metricKnownSteps"]["inputTokens"], 1)
        self.assertEqual(counts["metricKnownSteps"]["outputTokens"], 2)
        self.assertIsNone(result["observedTokens"]["outputTokens"])
        self.assertEqual(result["knownObservedTokens"]["outputTokens"], 10)
        self.assertEqual(result["knownUncachedInputTokens"], 10)
        self.assertIsNone(result["observedElapsedSeconds"])

    def test_invalid_values_rejected_not_exposed(self):
        for value in (True, False, -1, 1.0, float("nan"), float("inf"), "SECRET_BAD_COUNTER"):
            usage = event()["usage"]
            usage["cacheReadTokens"] = value
            record = dsh(usage=usage)
            self.assertEqual(record["status"], "rejected")
            self.assertNotIn("SECRET_", json.dumps(record))
            counts = aggregate_dsh_steps([record])["coverageCounts"]
            self.assertEqual(counts["invalidUsageSteps"], 1)
            self.assertEqual(counts["missingUsageSteps"], 1)
        self.assertEqual(dsh(usage="SECRET_BODY")["reason"], "invalid_usage")

    def test_invalid_identity_scope_and_mixed_sources(self):
        for bad in (True, -1, "1", None):
            self.assertEqual(dsh(step=bad)["reason"], "invalid_step_identity")
        for scope in (dsh_scope(executorId=None), dsh_scope(endedAt=9)):
            self.assertEqual(normalize_dsh_step(event(), scope, "source-1")["reason"], "invalid_scope_or_source")
        for change in ({"phaseId": "phase-2"}, {"executorId": "executor-2"}):
            other = normalize_dsh_step(event(), dsh_scope(**change), "source-1")
            self.assertEqual(aggregate_dsh_steps([dsh(), other])["reason"], "mixed_scope_or_source")
        other = normalize_dsh_step(event(), dsh_scope(), "source-2")
        self.assertEqual(aggregate_dsh_steps([dsh(), other])["reason"], "mixed_scope_or_source")
        self.assertEqual(aggregate_dsh_steps([window()])["coverageCounts"]["rejectedRecords"], 1)

    def test_zero_is_known_and_empty_is_unknown(self):
        usage = dict.fromkeys(event()["usage"], 0)
        result = aggregate_dsh_steps([dsh(usage=usage)])
        self.assertEqual(result["observedTokens"]["totalTokens"], 0)
        self.assertIsNone(result["observedTokens"]["cacheWriteInputTokens"])
        self.assertIsNone(aggregate_dsh_steps([])["knownObservedTokens"]["totalTokens"])

    def test_aggregate_rejects_mutated_source_conventions(self):
        for field in ("cacheWriteInputTokens", "inputTokens", "totalTokens"):
            record = dsh()
            record["observedTokens"][field] = 100
            result = aggregate_dsh_steps([record])
            self.assertEqual(result["coverageCounts"]["rejectedRecords"], 1)
            self.assertIsNone(result["observedTokens"][field])

    def test_pure_allowlist_privacy_and_extra_fields_ignored(self):
        raw, scope = event(), dsh_scope()
        raw.update(body="SECRET_BODY", reasoning="SECRET_REASONING", timestamp="SECRET_TIME")
        raw["usage"].update(unknown="SECRET_UNKNOWN", cacheWriteInputTokens=900)
        snapshot = copy.deepcopy((raw, scope))
        normalized = normalize_dsh_step(raw, scope, "source-1")
        self.assertEqual((raw, scope), snapshot)
        self.assertEqual(normalized, dsh())
        normalized["body"] = "SECRET_BODY"
        result = aggregate_dsh_steps([normalized])
        self.assertNotIn("SECRET_", json.dumps(result))
        self.assertIsNone(result["observedTokens"]["cacheWriteInputTokens"])


if __name__ == "__main__":
    unittest.main()
