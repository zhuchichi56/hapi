#!/usr/bin/env python3
"""Focused tests for the phase metrics contract (stdlib unittest, synthetic data)."""

import contextlib
import io
import json
import math
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from orchestra import phase_metrics  # noqa: E402

NOW = "2026-11-02T12:00:00Z"
START = "2026-11-02T10:00:00Z"


def make_phase(**overrides):
    phase = {
        "taskId": "T016",
        "phaseId": "phase-1",
        "startedAt": START,
        "endedAt": None,
        "threadIds": ["th-a"],
        "boundarySource": "explicit_phase",
        "scopeComplete": True,
    }
    phase.update(overrides)
    return phase


def make_obs(
    thread="th-a",
    turn="turn-1",
    observed="2026-11-02T10:05:00Z",
    started=START,
    completed=None,
    status="completed",
    usage=None,
    **extra
):
    record = {
        "threadId": thread,
        "turnId": turn,
        "observedAt": observed,
        "startedAt": started,
        "completedAt": completed,
        "durationMs": None,
        "status": status,
    }
    if usage is not None:
        record["usage"] = usage
    record.update(extra)
    return record


def make_usage(**overrides):
    usage = {
        "basis": "turn_total",
        "source": "native_turn_usage",
        "inputTokens": 100,
        "outputTokens": 10,
        "cacheReadInputTokens": 20,
        "cacheWriteInputTokens": 5,
        "cacheConvention": "included_in_input",
    }
    usage.update(overrides)
    return usage


class BoundaryTests(unittest.TestCase):
    def test_missing_started_returns_missing_fields_and_no_guessing(self):
        result = phase_metrics.aggregate_phase(
            {"phaseId": "p", "threadIds": ["th-a"]},
            [make_obs(completed="2026-11-02T10:04:00Z", usage=make_usage())],
            now=NOW,
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "missing_phase_boundary")
        self.assertIn("phase.startedAt", result["missing"])
        self.assertIsNone(result["phaseElapsedSeconds"])
        self.assertIsNone(result["activeExecutionSeconds"])
        self.assertIsNone(result["inputTokens"])
        self.assertEqual(result["turns"], [])

    def test_reversed_phase_boundary_rejected(self):
        result = phase_metrics.aggregate_phase(
            make_phase(endedAt="2026-11-02T09:00:00Z"), [], now=NOW
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "phase_end_before_start")
        self.assertIsNone(result["phaseElapsedSeconds"])

    def test_future_phase_start_rejected(self):
        result = phase_metrics.aggregate_phase(
            make_phase(startedAt="2026-11-02T13:00:00Z"), [], now=NOW
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "phase_start_in_future")

    def test_invalid_naive_iso_rejected(self):
        result = phase_metrics.aggregate_phase(
            make_phase(startedAt="2026-11-02T10:00:00"), [], now=NOW
        )
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid_phase_boundary")

    def test_open_phase_without_observations_has_null_elapsed(self):
        result = phase_metrics.aggregate_phase(make_phase(), [], now=NOW)
        self.assertTrue(result["ok"])
        self.assertIsNone(result["phaseElapsedSeconds"])
        self.assertIn("phase_elapsed_unavailable", result["duration"]["missingReasons"])

    def test_explicit_end_defines_elapsed_without_observations(self):
        result = phase_metrics.aggregate_phase(
            make_phase(endedAt="2026-11-02T10:10:00Z"), [], now=NOW
        )
        self.assertEqual(result["phaseElapsedSeconds"], 600.0)
        self.assertEqual(result["phase"]["elapsedBasis"], "boundary_to_end")
        self.assertEqual(result["phase"]["durationSource"], "phase_boundary")

    def test_open_phase_uses_observation_horizon_not_now(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    observed="2026-11-02T10:05:00Z",
                    started="2026-11-02T09:58:00Z",
                    completed="2026-11-02T10:05:00Z",
                )
            ],
            now=NOW,
        )
        self.assertEqual(result["phaseElapsedSeconds"], 300.0)
        self.assertEqual(
            result["phase"]["elapsedBasis"], "boundary_to_observation_horizon"
        )
        self.assertEqual(result["phase"]["sampleAgeSeconds"], 6900.0)
        self.assertTrue(result["phase"]["stale"])

    def test_invalid_now(self):
        result = phase_metrics.aggregate_phase(make_phase(), [], now="not-a-time")
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "invalid_now")


class DurationTests(unittest.TestCase):
    def test_disjoint_intervals_union_equals_sum(self):
        observations = [
            make_obs(
                turn="u1",
                started="2026-11-02T10:00:00Z",
                completed="2026-11-02T10:02:00Z",
                observed="2026-11-02T10:03:00Z",
            ),
            make_obs(
                turn="u2",
                started="2026-11-02T10:05:00Z",
                completed="2026-11-02T10:07:00Z",
                observed="2026-11-02T10:08:00Z",
            ),
        ]
        result = phase_metrics.aggregate_phase(make_phase(), observations, now=NOW)
        self.assertEqual(result["observedTurnWallSeconds"], 240.0)
        self.assertEqual(result["sumTurnWallSeconds"], 240.0)
        self.assertEqual(result["duration"]["observedTurnCount"], 2)

    def test_overlapping_parallel_turns_union_not_double_counted(self):
        observations = [
            make_obs(
                turn="u1",
                started="2026-11-02T10:00:00Z",
                completed="2026-11-02T10:10:00Z",
                observed="2026-11-02T10:10:00Z",
            ),
            make_obs(
                turn="u2",
                started="2026-11-02T10:05:00Z",
                completed="2026-11-02T10:15:00Z",
                observed="2026-11-02T10:16:00Z",
            ),
        ]
        result = phase_metrics.aggregate_phase(make_phase(), observations, now=NOW)
        self.assertEqual(result["observedTurnWallSeconds"], 900.0)
        self.assertEqual(result["sumTurnWallSeconds"], 1200.0)
        self.assertLess(
            result["observedTurnWallSeconds"], result["sumTurnWallSeconds"]
        )

    def test_turn_intervals_clip_to_phase(self):
        observations = [
            make_obs(
                turn="u1",
                started="2026-11-02T09:58:00Z",
                completed="2026-11-02T10:02:00Z",
                observed="2026-11-02T10:03:00Z",
            ),
            make_obs(
                turn="u2",
                started="2026-11-02T10:08:00Z",
                completed="2026-11-02T10:12:00Z",
                observed="2026-11-02T10:13:00Z",
            ),
        ]
        result = phase_metrics.aggregate_phase(
            make_phase(endedAt="2026-11-02T10:10:00Z"), observations, now=NOW
        )
        self.assertEqual(result["observedTurnWallSeconds"], 240.0)
        self.assertEqual(result["duration"]["clippedTurnCount"], 2)
        self.assertEqual(result["turns"][0]["interval"]["clippedSeconds"], 120.0)
        self.assertEqual(result["turns"][1]["interval"]["clippedSeconds"], 120.0)
        self.assertFalse(result["turns"][0]["wholeTurnInPhase"])
        self.assertEqual(result["usage"]["eligibleTurnCount"], 0)

    def test_ongoing_turn_uses_horizon_and_stale_sample(self):
        observations = [
            make_obs(
                turn="u1",
                started="2026-11-02T09:50:00Z",
                completed=None,
                observed="2026-11-02T10:05:00Z",
            )
        ]
        result = phase_metrics.aggregate_phase(make_phase(), observations, now=NOW)
        self.assertEqual(result["phaseElapsedSeconds"], 300.0)
        self.assertEqual(result["turns"][0]["interval"]["clippedSeconds"], 300.0)
        self.assertEqual(result["turns"][0]["interval"]["state"], "ongoing")
        self.assertEqual(result["duration"]["ongoingTurnCount"], 1)
        self.assertTrue(result["phase"]["stale"])
        self.assertFalse(result["turns"][0]["wholeTurnInPhase"])

    def test_completed_at_freezes_turn_time(self):
        observations = [
            make_obs(
                turn="u1",
                started="2026-11-02T10:00:00Z",
                completed="2026-11-02T10:03:00Z",
                observed="2026-11-02T10:20:00Z",
            ),
            make_obs(
                turn="u1",
                started="2026-11-02T10:00:00Z",
                completed="2026-11-02T10:03:00Z",
                observed="2026-11-02T10:25:00Z",
            ),
        ]
        result = phase_metrics.aggregate_phase(make_phase(), observations, now=NOW)
        self.assertEqual(result["turns"][0]["interval"]["clippedSeconds"], 180.0)
        self.assertEqual(result["duration"]["observedTurnCount"], 1)
        self.assertEqual(result["duration"]["duplicateObservationCount"], 1)

    def test_same_turn_polling_dedupes_and_latest_wins(self):
        early = make_obs(
            turn="u1",
            completed=None,
            observed="2026-11-02T10:05:00Z",
            usage=make_usage(inputTokens=10, outputTokens=1, cacheReadInputTokens=2, cacheWriteInputTokens=1),
        )
        late = make_obs(
            turn="u1",
            completed="2026-11-02T10:07:00Z",
            observed="2026-11-02T10:08:00Z",
            usage=make_usage(inputTokens=20, outputTokens=2, cacheReadInputTokens=4, cacheWriteInputTokens=2),
        )
        result = phase_metrics.aggregate_phase(make_phase(), [early, late], now=NOW)
        self.assertEqual(result["duration"]["observedTurnCount"], 1)
        self.assertEqual(result["duration"]["duplicateObservationCount"], 1)
        self.assertEqual(result["turns"][0]["interval"]["clippedSeconds"], 420.0)
        self.assertEqual(result["inputTokens"], 20)
        self.assertEqual(result["outputTokens"], 2)
        self.assertNotEqual(result["inputTokens"], 30)

    def test_out_of_order_polling_is_deterministic(self):
        early = make_obs(
            turn="u1",
            completed=None,
            observed="2026-11-02T10:05:00Z",
            usage=make_usage(inputTokens=10, cacheReadInputTokens=2, cacheWriteInputTokens=1),
        )
        late = make_obs(
            turn="u1",
            completed="2026-11-02T10:07:00Z",
            observed="2026-11-02T10:08:00Z",
            usage=make_usage(inputTokens=20, cacheReadInputTokens=4, cacheWriteInputTokens=2),
        )
        first = phase_metrics.aggregate_phase(make_phase(), [early, late], now=NOW)
        second = phase_metrics.aggregate_phase(make_phase(), [late, early], now=NOW)
        self.assertEqual(first, second)

    def test_invalid_later_row_cannot_replace_good_metadata(self):
        good = make_obs(
            turn="u1",
            started="2026-11-02T10:00:00Z",
            completed="2026-11-02T10:04:00Z",
            observed="2026-11-02T10:05:00Z",
        )
        bad = make_obs(
            turn="u1",
            started="2026-11-02T10:00:00Z",
            completed="2026-11-02T09:59:00Z",
            observed="2026-11-02T10:06:00Z",
        )
        result = phase_metrics.aggregate_phase(make_phase(), [good, bad], now=NOW)
        self.assertEqual(result["turns"][0]["completedAt"], "2026-11-02T10:04:00.000Z")
        self.assertEqual(result["duration"]["rejectionReasons"]["reversed_turn_interval"], 1)

    def test_future_and_invalid_times_rejected(self):
        values = [
            ("2026-11-02T13:00:00Z", "observed_at_future"),
            (True, "observed_at_invalid"),
            (float("nan"), "observed_at_invalid"),
            (float("inf"), "observed_at_invalid"),
            (None, "observed_at_invalid"),
        ]
        for value, reason in values:
            with self.subTest(value=value):
                result = phase_metrics.aggregate_phase(
                    make_phase(), [make_obs(observed=value)], now=NOW
                )
                self.assertEqual(result["turns"], [])
                self.assertEqual(
                    result["duration"]["rejectionReasons"].get(reason), 1
                )

    def test_foreign_thread_observations_are_ignored(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(thread="other-chat", turn="x1"),
                make_obs(thread="th-a", turn="u1", completed="2026-11-02T10:04:00Z"),
            ],
            now=NOW,
        )
        self.assertEqual(result["duration"]["observedTurnCount"], 1)
        self.assertEqual(result["duration"]["ignoredThreadObservationCount"], 1)

    def test_active_execution_is_null_not_native_wall_time(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    turn="u1",
                    completed="2026-11-02T10:04:00Z",
                    durationMs=240000,
                )
            ],
            now=NOW,
        )
        self.assertIsNone(result["activeExecutionSeconds"])
        self.assertEqual(
            result["activeExecutionReason"], "absent_event_intervals"
        )
        self.assertEqual(result["turns"][0]["nativeDurationMs"], 240000)

    def test_epoch_and_offset_times_accepted(self):
        start_epoch = int(
            datetime(2026, 11, 2, 10, 0, 0, tzinfo=timezone.utc).timestamp()
        )
        result = phase_metrics.aggregate_phase(
            make_phase(startedAt=start_epoch),
            [
                make_obs(
                    turn="u1",
                    started="2026-11-02T18:00:00+08:00",
                    completed="2026-11-02T18:03:00+08:00",
                    observed="2026-11-02T10:05:00Z",
                )
            ],
            now=NOW,
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["phase"]["startedAt"], "2026-11-02T10:00:00.000Z")
        self.assertEqual(result["observedTurnWallSeconds"], 180.0)


class CorrectionTests(unittest.TestCase):
    def test_task_and_phase_identity_required(self):
        missing_task = phase_metrics.aggregate_phase(
            make_phase(taskId=None), [], now=NOW
        )
        self.assertFalse(missing_task["ok"])
        self.assertEqual(missing_task["error"], "missing_phase_identity")
        self.assertEqual(missing_task["missing"], ["phase.taskId"])
        self.assertIsNone(missing_task["phaseElapsedSeconds"])

        missing_phase = phase_metrics.aggregate_phase(
            make_phase(phaseId="bad phase id"), [], now=NOW
        )
        self.assertFalse(missing_phase["ok"])
        self.assertEqual(missing_phase["error"], "missing_phase_identity")
        self.assertEqual(missing_phase["missing"], ["phase.phaseId"])

    def test_native_in_progress_status_spelling(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    turn="u1",
                    completed=None,
                    observed="2026-11-02T10:05:00Z",
                    status="inProgress",
                )
            ],
            now=NOW,
        )
        self.assertEqual(result["turns"][0]["status"], "in_progress")

    def test_canonical_native_boundary_source(self):
        canonical = "native_turn_startedAt_with_explicit_task_turn_binding"
        result = phase_metrics.aggregate_phase(
            make_phase(boundarySource=canonical), [], now=NOW
        )
        self.assertTrue(result["ok"])
        self.assertEqual(result["phase"]["boundarySource"], canonical)

    def test_known_zero_length_interval_is_numeric_zero(self):
        usage = make_usage(
            inputTokens=0,
            outputTokens=0,
            cacheReadInputTokens=0,
            cacheWriteInputTokens=0,
        )
        for start, observed in [
            ("2026-11-02T10:00:00Z", "2026-11-02T10:01:00Z"),
            ("2026-11-02T10:02:00Z", "2026-11-02T10:03:00Z"),
        ]:
            with self.subTest(start=start):
                result = phase_metrics.aggregate_phase(
                    make_phase(endedAt="2026-11-02T10:10:00Z"),
                    [
                        make_obs(
                            turn="u1",
                            started=start,
                            completed=start,
                            observed=observed,
                            usage=usage,
                        )
                    ],
                    now=NOW,
                )
                turn = result["turns"][0]
                self.assertFalse(turn["interval"]["outsidePhase"])
                self.assertEqual(turn["interval"]["clippedSeconds"], 0.0)
                self.assertIsNotNone(turn["interval"]["clippedStart"])
                self.assertIsNotNone(turn["interval"]["clippedEnd"])
                self.assertEqual(result["observedTurnWallSeconds"], 0.0)
                self.assertEqual(result["sumTurnWallSeconds"], 0.0)
                self.assertEqual(result["inputTokens"], 0)

    def test_ongoing_turn_ends_at_its_own_last_observation(self):
        # A is stale (last observed 10:05); B is fresh (last observed 11:59:50).
        # A's wall interval must stop at 10:05, never extend to B's horizon.
        result = phase_metrics.aggregate_phase(
            make_phase(threadIds=["th-a", "th-b"]),
            [
                make_obs(
                    thread="th-a",
                    turn="a1",
                    started="2026-11-02T10:00:00Z",
                    completed=None,
                    observed="2026-11-02T10:05:00Z",
                ),
                make_obs(
                    thread="th-b",
                    turn="b1",
                    started="2026-11-02T11:59:00Z",
                    completed="2026-11-02T11:59:50Z",
                    observed="2026-11-02T11:59:50Z",
                ),
            ],
            now=NOW,
        )
        turns = {turn["turnId"]: turn for turn in result["turns"]}
        self.assertEqual(turns["a1"]["interval"]["clippedSeconds"], 300.0)
        self.assertEqual(turns["b1"]["interval"]["clippedSeconds"], 50.0)
        self.assertTrue(turns["a1"]["stale"])
        self.assertFalse(turns["b1"]["stale"])
        self.assertEqual(result["phaseElapsedSeconds"], 7190.0)
        self.assertEqual(result["observedTurnWallSeconds"], 350.0)

    def test_stale_threshold_is_30_seconds(self):
        self.assertEqual(phase_metrics.STALE_AFTER_SECONDS, 30)
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    turn="u1",
                    started="2026-11-02T10:00:00Z",
                    completed="2026-11-02T10:00:00Z",
                    observed="2026-11-02T10:00:00Z",
                )
            ],
            now="2026-11-02T10:00:31Z",
        )
        self.assertTrue(result["phase"]["stale"])
        self.assertTrue(result["turns"][0]["stale"])
        fresh = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    turn="u1",
                    started="2026-11-02T10:00:00Z",
                    completed="2026-11-02T10:00:00Z",
                    observed="2026-11-02T10:00:00Z",
                )
            ],
            now="2026-11-02T10:00:30Z",
        )
        self.assertFalse(fresh["phase"]["stale"])
        self.assertFalse(fresh["turns"][0]["stale"])


class UsageTests(unittest.TestCase):
    def test_missing_usage_is_null_not_zero(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:04:00Z")],
            now=NOW,
        )
        self.assertIsNone(result["inputTokens"])
        self.assertIsNone(result["observedInputTokens"])
        self.assertEqual(result["usage"]["knownTurnCounts"]["inputTokens"], 0)
        self.assertEqual(result["usage"]["unknownTurnCounts"]["inputTokens"], 1)
        self.assertEqual(result["turns"][0]["usage"]["state"], "missing")

    def test_explicit_zero_usage_is_valid(self):
        usage = make_usage(
            inputTokens=0,
            outputTokens=0,
            cacheReadInputTokens=0,
            cacheWriteInputTokens=0,
        )
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["inputTokens"], 0)
        self.assertEqual(result["totalTokens"], 0)
        self.assertEqual(result["observedInputTokens"], 0)
        self.assertTrue(result["usage"]["coverage"]["complete"]["inputTokens"])
        self.assertIsNotNone(result["inputTokens"])

    def test_included_cache_is_not_added_twice(self):
        usage = make_usage(
            inputTokens=100,
            outputTokens=20,
            cacheReadInputTokens=40,
            cacheWriteInputTokens=10,
        )
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["totalTokens"], 120)
        self.assertEqual(result["observedTotalTokens"], 120)
        self.assertEqual(result["usage"]["cacheConvention"], "included_in_input")

    def test_separate_cache_is_added_once(self):
        usage = make_usage(
            inputTokens=100,
            outputTokens=20,
            cacheReadInputTokens=40,
            cacheWriteInputTokens=10,
            cacheConvention="separate_from_input",
        )
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["totalTokens"], 170)
        self.assertEqual(result["usage"]["cacheConvention"], "separate_from_input")

    def test_unknown_cache_convention_leaves_total_null(self):
        usage = make_usage(cacheConvention="unknown")
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["inputTokens"], 100)
        self.assertIsNone(result["totalTokens"])
        self.assertEqual(result["usage"]["knownTurnCounts"]["totalTokens"], 0)
        self.assertIn(
            "cache_convention_unknown", result["usage"]["missingReasons"]
        )

    def test_partial_metric_coverage(self):
        first = make_obs(
            turn="u1",
            started="2026-11-02T10:00:00Z",
            completed="2026-11-02T10:01:00Z",
            observed="2026-11-02T10:02:00Z",
            usage=make_usage(inputTokens=100, outputTokens=10, cacheWriteInputTokens=5),
        )
        second = make_obs(
            turn="u2",
            started="2026-11-02T10:03:00Z",
            completed="2026-11-02T10:04:00Z",
            observed="2026-11-02T10:05:00Z",
            usage=make_usage(
                inputTokens=50,
                outputTokens=5,
                cacheWriteInputTokens=None,
            ),
        )
        result = phase_metrics.aggregate_phase(make_phase(), [first, second], now=NOW)
        self.assertEqual(result["inputTokens"], 150)
        self.assertIsNone(result["cacheWriteInputTokens"])
        self.assertEqual(result["usage"]["knownTurnCounts"]["inputTokens"], 2)
        self.assertEqual(result["usage"]["knownTurnCounts"]["cacheWriteInputTokens"], 1)
        self.assertEqual(result["usage"]["unknownTurnCounts"]["cacheWriteInputTokens"], 1)
        self.assertEqual(result["observedCacheWriteInputTokens"], 5)

    def test_mixed_cache_conventions_leave_total_null(self):
        included = make_obs(
            turn="u1",
            started="2026-11-02T10:00:00Z",
            completed="2026-11-02T10:01:00Z",
            observed="2026-11-02T10:02:00Z",
            usage=make_usage(inputTokens=100, outputTokens=10),
        )
        separate = make_obs(
            turn="u2",
            started="2026-11-02T10:03:00Z",
            completed="2026-11-02T10:04:00Z",
            observed="2026-11-02T10:05:00Z",
            usage=make_usage(
                inputTokens=50,
                outputTokens=5,
                cacheConvention="separate_from_input",
            ),
        )
        result = phase_metrics.aggregate_phase(make_phase(), [included, separate], now=NOW)
        self.assertEqual(result["usage"]["cacheConvention"], "mixed")
        self.assertIsNone(result["totalTokens"])
        self.assertEqual(result["inputTokens"], 150)

    def test_thread_total_basis_rejected_without_baseline(self):
        usage = make_usage(basis="thread_total")
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["turns"][0]["usage"]["state"], "invalid")
        self.assertEqual(
            result["turns"][0]["usage"]["reason"], "thread_total_unsupported"
        )
        self.assertIsNone(result["inputTokens"])
        self.assertIsNone(result["observedInputTokens"])
        self.assertEqual(result["usage"]["rejectedUsageCount"], 1)
        self.assertFalse(result["sourceHistoryComplete"])

    def test_unknown_usage_source_rejected(self):
        usage = make_usage(source="mystery_source")
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["turns"][0]["usage"]["reason"], "usage_source_invalid")
        self.assertIsNone(result["observedInputTokens"])

    def test_negative_bool_and_float_token_counts_rejected(self):
        cases = [
            (-1, "input_tokens_negative"),
            (True, "input_tokens_invalid"),
            (1.5, "input_tokens_invalid"),
            (1.0, "input_tokens_invalid"),
        ]
        for value, reason in cases:
            with self.subTest(value=value):
                usage = make_usage(inputTokens=value)
                result = phase_metrics.aggregate_phase(
                    make_phase(),
                    [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
                    now=NOW,
                )
                self.assertEqual(result["turns"][0]["usage"]["state"], "invalid")
                self.assertEqual(result["turns"][0]["usage"]["reason"], reason)
                self.assertIsNone(result["inputTokens"])

    def test_cache_larger_than_input_rejected_when_included(self):
        cases = [
            make_usage(inputTokens=100, cacheReadInputTokens=120, cacheWriteInputTokens=0),
            make_usage(inputTokens=100, cacheReadInputTokens=60, cacheWriteInputTokens=50),
        ]
        for usage in cases:
            with self.subTest(usage=usage):
                result = phase_metrics.aggregate_phase(
                    make_phase(),
                    [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
                    now=NOW,
                )
                self.assertEqual(
                    result["turns"][0]["usage"]["reason"], "cache_exceeds_input"
                )
                self.assertIsNone(result["observedInputTokens"])

    def test_crossing_boundary_turn_excluded_not_prorated(self):
        usage = make_usage(inputTokens=999, outputTokens=99)
        result = phase_metrics.aggregate_phase(
            make_phase(endedAt="2026-11-02T10:10:00Z"),
            [
                make_obs(
                    turn="u1",
                    started="2026-11-02T09:55:00Z",
                    completed="2026-11-02T10:05:00Z",
                    observed="2026-11-02T10:06:00Z",
                    usage=usage,
                )
            ],
            now=NOW,
        )
        self.assertEqual(result["observedTurnWallSeconds"], 300.0)
        self.assertEqual(result["turns"][0]["usage"]["state"], "excluded")
        self.assertEqual(
            result["turns"][0]["tokenExclusionReason"], "starts_before_phase_boundary"
        )
        self.assertEqual(result["usage"]["eligibleTurnCount"], 0)
        self.assertEqual(result["usage"]["excludedTurnCount"], 1)
        self.assertIsNone(result["inputTokens"])
        self.assertIsNone(result["observedInputTokens"])

    def test_turn_ending_after_phase_end_excluded(self):
        result = phase_metrics.aggregate_phase(
            make_phase(endedAt="2026-11-02T10:10:00Z"),
            [
                make_obs(
                    turn="u1",
                    started="2026-11-02T10:05:00Z",
                    completed="2026-11-02T10:15:00Z",
                    observed="2026-11-02T10:16:00Z",
                    usage=make_usage(inputTokens=50),
                )
            ],
            now=NOW,
        )
        self.assertEqual(result["turns"][0]["interval"]["clippedSeconds"], 300.0)
        self.assertEqual(
            result["turns"][0]["tokenExclusionReason"], "ends_after_phase_boundary"
        )
        self.assertIsNone(result["observedInputTokens"])

    def test_ongoing_turn_usage_excluded(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    turn="u1",
                    started="2026-11-02T10:00:00Z",
                    completed=None,
                    observed="2026-11-02T10:05:00Z",
                    usage=make_usage(inputTokens=50),
                )
            ],
            now=NOW,
        )
        self.assertEqual(result["turns"][0]["usage"]["state"], "excluded")
        self.assertEqual(
            result["turns"][0]["tokenExclusionReason"], "completed_at_unknown"
        )
        self.assertIsNone(result["inputTokens"])

    def test_replacement_chat_threads_both_aggregate(self):
        result = phase_metrics.aggregate_phase(
            make_phase(threadIds=["th-a", "th-b"]),
            [
                make_obs(
                    thread="th-a",
                    turn="u1",
                    started="2026-11-02T10:00:00Z",
                    completed="2026-11-02T10:04:00Z",
                    observed="2026-11-02T10:05:00Z",
                    usage=make_usage(inputTokens=100, outputTokens=10),
                ),
                make_obs(
                    thread="th-b",
                    turn="v1",
                    started="2026-11-02T10:02:00Z",
                    completed="2026-11-02T10:06:00Z",
                    observed="2026-11-02T10:07:00Z",
                    usage=make_usage(inputTokens=50, outputTokens=5),
                ),
            ],
            now=NOW,
        )
        self.assertEqual(result["duration"]["observedTurnCount"], 2)
        self.assertEqual(result["observedTurnWallSeconds"], 360.0)
        self.assertEqual(result["sumTurnWallSeconds"], 480.0)
        self.assertEqual(result["inputTokens"], 150)
        self.assertEqual(result["outputTokens"], 15)
        self.assertEqual(result["totalTokens"], 165)
        self.assertEqual(result["phase"]["threadIds"], ["th-a", "th-b"])

    def test_scope_complete_false_forces_partial_totals(self):
        result = phase_metrics.aggregate_phase(
            make_phase(scopeComplete=False),
            [
                make_obs(
                    turn="u1",
                    completed="2026-11-02T10:01:00Z",
                    usage=make_usage(inputTokens=100, outputTokens=10),
                )
            ],
            now=NOW,
        )
        self.assertIsNone(result["inputTokens"])
        self.assertEqual(result["observedInputTokens"], 100)
        self.assertFalse(result["usage"]["coverage"]["complete"]["inputTokens"])
        self.assertIn("scope_complete_false", result["usage"]["missingReasons"])

    def test_rejected_observation_forces_partial_totals(self):
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [
                make_obs(
                    turn="u1",
                    completed="2026-11-02T10:01:00Z",
                    usage=make_usage(inputTokens=100),
                ),
                make_obs(turn="u2", observed="not-a-time"),
            ],
            now=NOW,
        )
        self.assertEqual(result["duration"]["rejectionReasons"]["observed_at_invalid"], 1)
        self.assertFalse(result["sourceHistoryComplete"])
        self.assertIsNone(result["inputTokens"])
        self.assertEqual(result["observedInputTokens"], 100)


class PrivacyTests(unittest.TestCase):
    def test_unknown_text_is_stripped_to_bounded_enums(self):
        observation = make_obs(
            turn="u1",
            completed="2026-11-02T10:01:00Z",
            status="SECRET-STATUS <script>",
            usage=make_usage(),
            secret="SECRET-EXTRA",
        )
        result = phase_metrics.aggregate_phase(
            make_phase(boundarySource="SECRET-SOURCE", taskId="T016-safe"),
            [observation],
            now=NOW,
        )
        self.assertEqual(result["phase"]["boundarySource"], "unknown")
        self.assertEqual(result["turns"][0]["status"], "unknown")
        rendered = json.dumps(result)
        self.assertNotIn("SECRET", rendered)
        self.assertNotIn("<script>", rendered)

    def test_invalid_identifiers_are_not_echoed(self):
        result = phase_metrics.aggregate_phase(
            make_phase(
                taskId="bad\nid",
                phaseId="bad phase id",
                threadIds=["th-a", "bad thread"],
            ),
            [make_obs(thread="th-a", turn="bad\nturn")],
            now=NOW,
        )
        self.assertIsNone(result["phase"]["taskId"])
        self.assertIsNone(result["phase"]["phaseId"])
        self.assertEqual(result["phase"]["threadIds"], ["th-a"])
        self.assertEqual(result["turns"], [])
        self.assertNotIn("bad\n", json.dumps(result))

    def test_unknown_usage_keys_ignored(self):
        usage = make_usage(secret="SECRET-TOKEN", totalTokens=999999)
        result = phase_metrics.aggregate_phase(
            make_phase(),
            [make_obs(turn="u1", completed="2026-11-02T10:01:00Z", usage=usage)],
            now=NOW,
        )
        self.assertEqual(result["totalTokens"], 110)
        self.assertNotIn("SECRET", json.dumps(result))

    def test_result_is_json_serialisable_and_idempotent(self):
        observations = [
            make_obs(
                turn="u1",
                completed="2026-11-02T10:03:00Z",
                observed="2026-11-02T10:04:00Z",
                usage=make_usage(),
            )
        ]
        first = phase_metrics.aggregate_phase(make_phase(), observations, now=NOW)
        second = phase_metrics.aggregate_phase(make_phase(), observations, now=NOW)
        self.assertEqual(first, second)
        json.dumps(first)


class CliTests(unittest.TestCase):
    def test_cli_prints_json(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            phase_path = os.path.join(tmp, "phase.json")
            obs_path = os.path.join(tmp, "observations.json")
            with open(phase_path, "w", encoding="utf-8") as handle:
                json.dump(make_phase(), handle)
            with open(obs_path, "w", encoding="utf-8") as handle:
                json.dump(
                    {
                        "observations": [
                            make_obs(
                                turn="u1",
                                completed="2026-11-02T10:03:00Z",
                                usage=make_usage(),
                            )
                        ]
                    },
                    handle,
                )
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                code = phase_metrics.main(
                    [
                        "--phase",
                        phase_path,
                        "--observations",
                        obs_path,
                        "--now",
                        NOW,
                    ]
                )
            self.assertEqual(code, 0)
            payload = json.loads(stream.getvalue())
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["phaseElapsedSeconds"], 300.0)
            self.assertEqual(payload["inputTokens"], 100)

    def test_cli_missing_boundary_exit_nonzero(self):
        with tempfile.TemporaryDirectory(dir=HERE) as tmp:
            phase_path = os.path.join(tmp, "phase.json")
            obs_path = os.path.join(tmp, "observations.json")
            with open(phase_path, "w", encoding="utf-8") as handle:
                json.dump({"phaseId": "p"}, handle)
            with open(obs_path, "w", encoding="utf-8") as handle:
                json.dump([], handle)
            stream = io.StringIO()
            with contextlib.redirect_stdout(stream):
                code = phase_metrics.main(
                    ["--phase", phase_path, "--observations", obs_path]
                )
            self.assertEqual(code, 1)
            payload = json.loads(stream.getvalue())
            self.assertFalse(payload["ok"])
            self.assertEqual(payload["error"], "missing_phase_boundary")


class PlannerTemporalBoundaryTests(unittest.TestCase):
    def test_large_finite_now_is_rejected_without_overflow(self):
        result = phase_metrics.aggregate_phase(make_phase(), [], now=1e100)
        self.assertEqual(result["error"], "invalid_now")

    def test_negative_iso_and_aware_datetime_are_rejected(self):
        for value in ("1969-12-31T23:59:59Z", datetime(1969, 12, 31, tzinfo=timezone.utc)):
            with self.subTest(value=value):
                result = phase_metrics.aggregate_phase(make_phase(startedAt=value), [], now=NOW)
                self.assertEqual(result["error"], "invalid_phase_boundary")

    def test_finite_out_of_datetime_range_is_rejected(self):
        result = phase_metrics.aggregate_phase(make_phase(startedAt=1e100), [], now=NOW)
        self.assertEqual(result["error"], "invalid_phase_boundary")


if __name__ == "__main__":
    unittest.main()
