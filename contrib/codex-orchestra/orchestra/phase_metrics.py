#!/usr/bin/env python3
"""Task phase duration + token aggregation contract (stdlib only).

Public API
----------
``aggregate_phase(phase, observations, now=None) -> dict`` returns a safe,
JSON-serialisable dict.  ``now`` is an ISO-8601 timestamp with an offset or
numeric epoch seconds; when omitted the wall clock is used only for future
validation and sample age, never as a duration horizon.

CLI
---
``python3 phase_metrics.py --phase FILE --observations FILE [--now ISO]``

The module deliberately emits only metadata, bounded enums/identifiers and
computed numbers.  Unknown input keys are ignored, not echoed.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

SCHEMA = "phase_metrics/v1"
STALE_AFTER_SECONDS = 30
MAX_ID_LENGTH = 128

_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,%d}$" % (MAX_ID_LENGTH - 1))
_NUMERIC_RE = re.compile(r"^[0-9]+(?:\.[0-9]+)?$")

TOKEN_FIELDS = (
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheWriteInputTokens",
)
TOTAL_FIELD = "totalTokens"
ALL_METRICS = TOKEN_FIELDS + (TOTAL_FIELD,)

CACHE_CONVENTIONS = ("included_in_input", "separate_from_input", "unknown")
CACHE_CONVENTION_PHASE = CACHE_CONVENTIONS + ("mixed",)

# Only these bounded values are ever echoed.  Anything else becomes "unknown".
STATUS_VALUES = {
    "in_progress": "in_progress",
    "inprogress": "in_progress",
    "in-progress": "in_progress",
    "running": "in_progress",
    "active": "in_progress",
    "started": "in_progress",
    "pending": "pending",
    "queued": "pending",
    "completed": "completed",
    "complete": "completed",
    "succeeded": "completed",
    "success": "completed",
    "done": "completed",
    "failed": "failed",
    "error": "failed",
    "errored": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "aborted": "cancelled",
    "interrupted": "cancelled",
    "unknown": "unknown",
}
BOUNDARY_SOURCES = {
    "explicit_task": "explicit_task",
    "explicit_phase": "explicit_phase",
    "explicit_boundary": "explicit_boundary",
    "manual": "manual",
    "task_record": "task_record",
    "operator": "operator",
    # Canonical native-desktop binding: the turn's startedAt is the phase start
    # and an explicit task/turn binding authorized the phase.
    "native_turn_startedat_with_explicit_task_turn_binding": (
        "native_turn_startedAt_with_explicit_task_turn_binding"
    ),
    "unknown": "unknown",
}

INTERVAL_STATES = ("observed", "clipped", "ongoing", "outside_phase")
USAGE_STATES = ("accepted", "missing", "invalid", "excluded")


# ---------------------------------------------------------------------------
# Small safe-value helpers
# ---------------------------------------------------------------------------


def _safe_id(value: Any) -> Optional[str]:
    """Return a bounded identifier or None.  Arbitrary text is never echoed."""
    if not isinstance(value, str):
        return None
    if not _ID_RE.match(value):
        return None
    return value


def _safe_enum(value: Any, allowed: Dict[str, str]) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return allowed.get(value.strip().lower())


def _round_secs(value: float) -> float:
    result = round(float(value), 3)
    return 0.0 if result == 0 else result


def _iso(epoch: Optional[float]) -> Optional[str]:
    if epoch is None:
        return None
    dt = datetime.fromtimestamp(epoch, timezone.utc)
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _parse_time(value: Any) -> float:
    """Parse ISO-8601 with UTC/offset or epoch seconds.

    Booleans, non-finite numbers, negative epoch values, naive datetimes and
    malformed text are rejected with ValueError.
    """
    if isinstance(value, bool):
        raise ValueError("bool is not a timestamp")
    if isinstance(value, datetime):
        if value.tzinfo is None:
            raise ValueError("datetime lacks UTC/offset")
        return _parse_time(float(value.timestamp()))
    if isinstance(value, (int, float)):
        number = float(value)
        if not math.isfinite(number) or not 0 <= number <= 253402300799:
            raise ValueError("invalid epoch")
        return number
    if isinstance(value, str):
        text = value.strip()
        if not text:
            raise ValueError("empty timestamp")
        if _NUMERIC_RE.match(text):
            number = float(text)
            if not math.isfinite(number) or not 0 <= number <= 253402300799:
                raise ValueError("invalid epoch")
            return number
        if text.endswith("Z") or text.endswith("z"):
            text = text[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(text)
        except (TypeError, ValueError):
            raise ValueError("invalid ISO timestamp")
        if parsed.tzinfo is None:
            raise ValueError("timestamp lacks UTC/offset")
        try:
            return _parse_time(float(parsed.timestamp()))
        except (OverflowError, OSError, ValueError):
            raise ValueError("timestamp out of range")
    raise ValueError("unsupported timestamp type")


def _resolve_now(now: Any) -> Tuple[float, str]:
    if now is None:
        return float(time.time()), "wall_clock"
    return _parse_time(now), "argument"


def _counts() -> Dict[str, int]:
    return {name: 0 for name in ALL_METRICS}


def _empty_usage() -> Dict[str, Any]:
    zero = _counts()
    return {
        "basis": "turn_total",
        "source": None,
        "cacheConvention": None,
        "scope": "whole_turn_in_phase",
        "scopeComplete": None,
        "eligibleTurnCount": 0,
        "excludedTurnCount": 0,
        "knownTurnCounts": dict(zero),
        "unknownTurnCounts": dict(zero),
        "coverage": {
            "eligible": 0,
            "known": dict(zero),
            "unknown": dict(zero),
            "complete": {name: False for name in ALL_METRICS},
        },
        "observedInputTokens": None,
        "observedOutputTokens": None,
        "observedCacheReadInputTokens": None,
        "observedCacheWriteInputTokens": None,
        "observedTotalTokens": None,
        "inputTokens": None,
        "outputTokens": None,
        "cacheReadInputTokens": None,
        "cacheWriteInputTokens": None,
        "totalTokens": None,
        "missingReasons": [],
        "rejectionReasons": {},
        "usageSnapshotCount": 0,
        "rejectedUsageCount": 0,
        "sourceHistoryComplete": False,
    }


def _empty_duration() -> Dict[str, Any]:
    return {
        "phaseElapsedSeconds": None,
        "activeExecutionSeconds": None,
        "activeExecutionReason": "absent_event_intervals",
        "observedTurnWallSeconds": None,
        "sumTurnWallSeconds": None,
        "observedTurnCount": 0,
        "clippedTurnCount": 0,
        "ongoingTurnCount": 0,
        "outsidePhaseTurnCount": 0,
        "duplicateObservationCount": 0,
        "ignoredThreadObservationCount": 0,
        "sourceHistoryComplete": False,
        "clockBasis": "utc_wall_clock",
        "rejectionReasons": {},
        "missingReasons": [],
    }


def _empty_result() -> Dict[str, Any]:
    duration = _empty_duration()
    usage = _empty_usage()
    return {
        "schema": SCHEMA,
        "ok": False,
        "error": None,
        "missing": [],
        "phase": {
            "taskId": None,
            "phaseId": None,
            "threadIds": [],
            "boundarySource": "unknown",
            "scopeComplete": None,
            "startedAt": None,
            "endedAt": None,
            "endBasis": None,
            "elapsedSeconds": None,
            "elapsedBasis": None,
            "durationSource": None,
            "sampleAgeSeconds": None,
            "stale": None,
            "staleAfterSeconds": STALE_AFTER_SECONDS,
            "clockBasis": "utc_wall_clock",
            "evaluatedAt": None,
            "nowSource": None,
        },
        "duration": duration,
        "usage": usage,
        "turns": [],
        # Flattened aliases for consumers that prefer a small surface.
        "phaseElapsedSeconds": None,
        "activeExecutionSeconds": None,
        "activeExecutionReason": "absent_event_intervals",
        "observedTurnWallSeconds": None,
        "sumTurnWallSeconds": None,
        "inputTokens": None,
        "outputTokens": None,
        "cacheReadInputTokens": None,
        "cacheWriteInputTokens": None,
        "totalTokens": None,
        "observedInputTokens": None,
        "observedOutputTokens": None,
        "observedCacheReadInputTokens": None,
        "observedCacheWriteInputTokens": None,
        "observedTotalTokens": None,
        "coverage": usage["coverage"],
        "sourceHistoryComplete": False,
    }


def _fail(result: Dict[str, Any], error: str, missing: List[str]) -> Dict[str, Any]:
    result["ok"] = False
    result["error"] = error
    result["missing"] = list(missing)
    return result


# ---------------------------------------------------------------------------
# Observation validation
# ---------------------------------------------------------------------------


def _validate_usage(raw: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """Validate one cumulative per-turn usage snapshot.

    Returns ``(snapshot, None)`` or ``(None, bounded_reason)``.
    """
    if not isinstance(raw, dict):
        return None, "usage_not_object"

    basis = raw.get("basis")
    if basis == "thread_total":
        return None, "thread_total_unsupported"
    if basis != "turn_total":
        return None, "usage_basis_invalid"

    if raw.get("source") != "native_turn_usage":
        return None, "usage_source_invalid"

    convention = raw.get("cacheConvention", "unknown")
    if convention is None:
        convention = "unknown"
    if convention not in CACHE_CONVENTIONS:
        return None, "cache_convention_invalid"

    values: Dict[str, Optional[int]] = {}
    for name in TOKEN_FIELDS:
        if name not in raw or raw[name] is None:
            values[name] = None
            continue
        value = raw[name]
        if isinstance(value, bool) or not isinstance(value, int):
            return None, "%s_invalid" % _snake(name)
        if value < 0:
            return None, "%s_negative" % _snake(name)
        values[name] = value

    if convention == "included_in_input" and values["inputTokens"] is not None:
        cap = values["inputTokens"]
        reads = values["cacheReadInputTokens"]
        writes = values["cacheWriteInputTokens"]
        if reads is not None and reads > cap:
            return None, "cache_exceeds_input"
        if writes is not None and writes > cap:
            return None, "cache_exceeds_input"
        if reads is not None and writes is not None and reads + writes > cap:
            return None, "cache_exceeds_input"

    snapshot = {
        "basis": "turn_total",
        "source": "native_turn_usage",
        "cacheConvention": convention,
    }
    snapshot.update(values)
    return snapshot, None


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)([A-Z])", r"_\1", name).lower()


def _turn_total(snapshot: Dict[str, Any]) -> Tuple[Optional[int], Optional[str]]:
    convention = snapshot.get("cacheConvention")
    if convention == "included_in_input":
        if snapshot.get("inputTokens") is None:
            return None, "input_tokens_unknown"
        if snapshot.get("outputTokens") is None:
            return None, "output_tokens_unknown"
        return snapshot["inputTokens"] + snapshot["outputTokens"], None
    if convention == "separate_from_input":
        for name in TOKEN_FIELDS:
            if snapshot.get(name) is None:
                return None, "%s_unknown" % _snake(name)
        return (
            snapshot["inputTokens"]
            + snapshot["cacheReadInputTokens"]
            + snapshot["cacheWriteInputTokens"]
            + snapshot["outputTokens"],
            None,
        )
    return None, "cache_convention_unknown"


def _canonical(payload: Any) -> str:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)


def _validate_observation(
    raw: Any,
    thread_ids: List[str],
    now_epoch: float,
    rejection_counts: Dict[str, int],
) -> Tuple[Optional[Dict[str, Any]], bool]:
    """Validate one metadata record.

    Returns ``(record, in_phase)``.  ``record`` is None when rejected; the
    boolean says whether an otherwise shaped record belongs to another thread
    (ignored, not rejected).
    """

    def reject(reason: str) -> Tuple[None, bool]:
        rejection_counts[reason] = rejection_counts.get(reason, 0) + 1
        return None, False

    if not isinstance(raw, dict):
        return reject("observation_not_object")

    thread_id = _safe_id(raw.get("threadId"))
    if thread_id is None:
        return reject("thread_id_invalid")
    turn_id = _safe_id(raw.get("turnId"))
    if turn_id is None:
        return reject("turn_id_invalid")

    if thread_id not in thread_ids:
        return None, True

    try:
        observed_at = _parse_time(raw.get("observedAt"))
    except ValueError:
        return reject("observed_at_invalid")
    try:
        started_at = _parse_time(raw.get("startedAt"))
    except ValueError:
        return reject("started_at_invalid")

    completed_raw = raw.get("completedAt")
    completed_at: Optional[float] = None
    if completed_raw is not None:
        try:
            completed_at = _parse_time(completed_raw)
        except ValueError:
            return reject("completed_at_invalid")

    if observed_at > now_epoch:
        return reject("observed_at_future")
    if started_at > now_epoch:
        return reject("started_at_future")
    if completed_at is not None and completed_at > now_epoch:
        return reject("completed_at_future")
    if observed_at < started_at:
        return reject("observed_before_started")
    if completed_at is not None and completed_at < started_at:
        return reject("reversed_turn_interval")
    if completed_at is not None and completed_at > observed_at:
        return reject("completed_after_observed")

    duration_ms: Optional[int] = raw.get("durationMs")
    if isinstance(duration_ms, bool) or not isinstance(duration_ms, int) or duration_ms < 0:
        duration_ms = None

    status = _safe_enum(raw.get("status"), STATUS_VALUES) or "unknown"
    record = {
        "threadId": thread_id,
        "turnId": turn_id,
        "observedAt": observed_at,
        "startedAt": started_at,
        "completedAt": completed_at,
        "status": status,
        "durationMs": duration_ms,
        "usageRaw": raw.get("usage") if raw.get("usage") is not None else None,
    }
    record["sig"] = _canonical(
        {
            "observedAt": observed_at,
            "startedAt": started_at,
            "completedAt": completed_at,
            "status": status,
            "durationMs": duration_ms,
        }
    )
    return record, False


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------


def aggregate_phase(
    phase: Any,
    observations: Any,
    now: Any = None,
) -> Dict[str, Any]:
    """Aggregate one explicitly bounded task phase.

    ``phase`` must provide ``startedAt``; ``endedAt`` may be null.  Missing or
    invalid boundaries return a mostly-null result with ``ok: false`` instead
    of guessing a lifetime.  ``observations`` is a list of safe metadata
    records; anything outside the declared thread ids is ignored.
    """

    result = _empty_result()
    try:
        now_epoch, now_source = _resolve_now(now)
    except ValueError:
        return _fail(result, "invalid_now", ["now"])
    result["phase"]["evaluatedAt"] = _iso(now_epoch)
    result["phase"]["nowSource"] = now_source

    if not isinstance(phase, dict):
        return _fail(result, "missing_phase_boundary", ["phase"])

    task_id = _safe_id(phase.get("taskId"))
    phase_id = _safe_id(phase.get("phaseId"))
    result["phase"]["taskId"] = task_id
    result["phase"]["phaseId"] = phase_id
    result["phase"]["boundarySource"] = _safe_enum(
        phase.get("boundarySource"), BOUNDARY_SOURCES
    ) or "unknown"

    thread_ids: List[str] = []
    raw_threads = phase.get("threadIds")
    if isinstance(raw_threads, list):
        for item in raw_threads:
            safe = _safe_id(item)
            if safe is not None and safe not in thread_ids:
                thread_ids.append(safe)
    result["phase"]["threadIds"] = list(thread_ids)

    missing: List[str] = []
    raw_started = phase.get("startedAt")
    if raw_started is None:
        missing.append("phase.startedAt")
        return _fail(result, "missing_phase_boundary", missing)
    try:
        started_at = _parse_time(raw_started)
    except ValueError:
        missing.append("phase.startedAt")
        return _fail(result, "invalid_phase_boundary", missing)
    if started_at > now_epoch:
        missing.append("phase.startedAt")
        return _fail(result, "phase_start_in_future", missing)
    result["phase"]["startedAt"] = _iso(started_at)
    result["phase"]["elapsedBasis"] = None
    result["phase"]["durationSource"] = None

    identity_missing: List[str] = []
    if task_id is None:
        identity_missing.append("phase.taskId")
    if phase_id is None:
        identity_missing.append("phase.phaseId")
    if identity_missing:
        return _fail(result, "missing_phase_identity", identity_missing)

    explicit_end: Optional[float] = None
    raw_ended = phase.get("endedAt")
    if raw_ended is not None:
        try:
            explicit_end = _parse_time(raw_ended)
        except ValueError:
            missing.append("phase.endedAt")
            return _fail(result, "invalid_phase_boundary", missing)
        if explicit_end < started_at:
            missing.append("phase.endedAt")
            return _fail(result, "phase_end_before_start", missing)
        if explicit_end > now_epoch:
            missing.append("phase.endedAt")
            return _fail(result, "phase_end_in_future", missing)
        result["phase"]["endedAt"] = _iso(explicit_end)
        result["phase"]["endBasis"] = "explicit"
    else:
        result["phase"]["endedAt"] = None
        result["phase"]["endBasis"] = "open"

    scope_raw = phase.get("scopeComplete")
    if isinstance(scope_raw, bool):
        scope_complete: Optional[bool] = scope_raw
    else:
        scope_complete = None
        missing.append("phase.scopeComplete")
    if not isinstance(raw_threads, list):
        missing.append("phase.threadIds")
    result["phase"]["scopeComplete"] = scope_complete

    # ---- validate observations -------------------------------------------------
    if isinstance(observations, (list, tuple)):
        rows = list(observations)
    elif isinstance(observations, dict) and isinstance(
        observations.get("observations"), (list, tuple)
    ):
        rows = list(observations["observations"])
    elif observations is None:
        rows = []
    else:
        rows = []

    rejection_counts: Dict[str, int] = {}
    in_scope_rejected = 0
    ignored_thread = 0
    valid_records: List[Dict[str, Any]] = []

    for raw in rows:
        record, ignored = _validate_observation(
            raw, thread_ids, now_epoch, rejection_counts
        )
        if ignored:
            ignored_thread += 1
        elif record is None:
            in_scope_rejected += 1
        else:
            valid_records.append(record)

    latest_observed: Optional[float] = None
    for record in valid_records:
        observed = record["observedAt"]
        if latest_observed is None or observed > latest_observed:
            latest_observed = observed

    # Phase elapsed: explicit end wins; otherwise the successful observation
    # horizon.  `now` is deliberately not used as a horizon.
    phase_elapsed: Optional[float] = None
    if explicit_end is not None:
        phase_elapsed = _round_secs(explicit_end - started_at)
        result["phase"]["elapsedBasis"] = "boundary_to_end"
        result["phase"]["durationSource"] = "phase_boundary"
    elif latest_observed is not None and latest_observed >= started_at:
        phase_elapsed = _round_secs(latest_observed - started_at)
        result["phase"]["elapsedBasis"] = "boundary_to_observation_horizon"
        result["phase"]["durationSource"] = "observations"

    horizon = explicit_end if explicit_end is not None else latest_observed

    # ---- select latest metadata and latest usage snapshot per turn -------------
    by_turn: Dict[Tuple[str, str], Dict[str, Any]] = {}
    usage_by_key: Dict[Tuple[str, str], Dict[str, Any]] = {}
    observation_count: Dict[Tuple[str, str], int] = {}
    duplicate_count = 0

    for record in valid_records:
        key = (record["threadId"], record["turnId"])
        observation_count[key] = observation_count.get(key, 0) + 1
        if key in by_turn:
            duplicate_count += 1
        current = by_turn.get(key)
        if current is None or (record["observedAt"], record["sig"]) > (
            current["observedAt"],
            current["sig"],
        ):
            by_turn[key] = record

        if record["usageRaw"] is not None:
            snapshot, error = _validate_usage(record["usageRaw"])
            event = {
                "observedAt": record["observedAt"],
                "rank": _canonical(
                    {
                        "record": record["sig"],
                        "usage": snapshot if snapshot is not None else error,
                    }
                ),
                "snapshot": snapshot,
                "error": error,
            }
            previous = usage_by_key.get(key)
            if previous is None or (event["observedAt"], event["rank"]) > (
                previous["observedAt"],
                previous["rank"],
            ):
                usage_by_key[key] = event

    # ---- build per-turn results ------------------------------------------------
    turns: List[Dict[str, Any]] = []
    intervals: List[Tuple[float, float]] = []
    clipped_count = 0
    ongoing_count = 0
    outside_count = 0
    rejected_usage_count = 0
    usage_rejection_counts: Dict[str, int] = {}

    for key in sorted(by_turn, key=lambda k: (by_turn[k]["startedAt"], k[0], k[1])):
        record = by_turn[key]
        started = record["startedAt"]
        completed = record["completedAt"]
        # An ongoing turn ends at its OWN latest successful observation, never
        # at a fresher observation from another thread.  The global horizon is
        # only used for phase elapsed.
        raw_end = completed if completed is not None else record["observedAt"]

        clip_start = max(started, started_at)
        clip_end = raw_end
        if horizon is not None:
            clip_end = min(raw_end, horizon)

        # Strict comparisons keep a known zero-length interval at the boundary
        # as numeric 0 instead of turning it into "missing".
        outside = raw_end < started_at or (
            horizon is not None and started > horizon
        )

        clipped_seconds = 0.0
        if not outside:
            intervals.append((clip_start, clip_end))
            if clip_end > clip_start:
                clipped_seconds = _round_secs(clip_end - clip_start)

        clipped = bool(started < started_at or (horizon is not None and raw_end > horizon))
        if outside:
            interval_state = "outside_phase"
            outside_count += 1
            clipped = True
        elif completed is None:
            interval_state = "ongoing"
            ongoing_count += 1
        elif clipped:
            interval_state = "clipped"
        else:
            interval_state = "observed"
        if clipped:
            clipped_count += 1

        whole_turn = True
        exclusion_reason: Optional[str] = None
        if completed is None:
            whole_turn = False
            exclusion_reason = "completed_at_unknown"
        elif started < started_at:
            whole_turn = False
            exclusion_reason = "starts_before_phase_boundary"
        elif horizon is not None and completed > horizon:
            whole_turn = False
            exclusion_reason = "ends_after_phase_boundary"

        usage_event = usage_by_key.get(key)
        usage_state = "missing"
        usage_reason: Optional[str] = None
        snapshot: Optional[Dict[str, Any]] = None
        if usage_event is not None:
            if usage_event["error"] is not None:
                usage_state = "invalid"
                usage_reason = usage_event["error"]
                rejected_usage_count += 1
                usage_rejection_counts[usage_reason] = (
                    usage_rejection_counts.get(usage_reason, 0) + 1
                )
            else:
                snapshot = usage_event["snapshot"]
                if whole_turn:
                    usage_state = "accepted"
                else:
                    usage_state = "excluded"
                    usage_reason = exclusion_reason

        public_usage = {
            "state": usage_state,
            "reason": usage_reason,
            "basis": None,
            "source": None,
            "inputTokens": None,
            "outputTokens": None,
            "cacheReadInputTokens": None,
            "cacheWriteInputTokens": None,
            "cacheConvention": None,
            "totalTokens": None,
            "wholeTurnEligible": whole_turn,
        }
        if usage_state in ("accepted", "excluded") and snapshot is not None:
            total, total_reason = _turn_total(snapshot)
            public_usage.update(
                {
                    "basis": snapshot["basis"],
                    "source": snapshot["source"],
                    "inputTokens": snapshot["inputTokens"],
                    "outputTokens": snapshot["outputTokens"],
                    "cacheReadInputTokens": snapshot["cacheReadInputTokens"],
                    "cacheWriteInputTokens": snapshot["cacheWriteInputTokens"],
                    "cacheConvention": snapshot["cacheConvention"],
                    "totalTokens": total,
                }
            )
            if total_reason is not None and usage_state == "accepted":
                public_usage["reason"] = total_reason

        turns.append(
            {
                "threadId": key[0],
                "turnId": key[1],
                "startedAt": _iso(started),
                "completedAt": _iso(completed),
                "observedAt": _iso(record["observedAt"]),
                "observationCount": observation_count[key],
                "observationAgeSeconds": _round_secs(
                    max(0.0, now_epoch - record["observedAt"])
                ),
                "stale": (now_epoch - record["observedAt"]) > STALE_AFTER_SECONDS,
                "status": record["status"],
                "nativeDurationMs": record["durationMs"],
                "interval": {
                    "clippedStart": _iso(clip_start) if not outside else None,
                    "clippedEnd": _iso(clip_end) if not outside else None,
                    "clippedSeconds": clipped_seconds if not outside else 0.0,
                    "state": interval_state,
                    "clipped": clipped,
                    "outsidePhase": outside,
                },
                "wholeTurnInPhase": whole_turn,
                "tokenExclusionReason": exclusion_reason,
                "usage": public_usage,
                "_snapshot": snapshot,
            }
        )

    # ---- duration aggregation ---------------------------------------------------
    union_seconds: Optional[float] = None
    sum_seconds: Optional[float] = None
    if intervals:
        ordered = sorted(intervals, key=lambda item: (item[0], item[1]))
        merged: List[List[float]] = []
        for start, end in ordered:
            if not merged or start > merged[-1][1]:
                merged.append([start, end])
            elif end > merged[-1][1]:
                merged[-1][1] = end
        union_seconds = _round_secs(sum(end - start for start, end in merged))
        sum_seconds = _round_secs(sum(end - start for start, end in intervals))
    elif by_turn:
        # Valid observations exist but none overlaps the phase: the known clipped
        # wall time is exactly 0, not missing.
        union_seconds = 0.0
        sum_seconds = 0.0

    sample_age: Optional[float] = None
    stale: Optional[bool] = None
    if latest_observed is not None:
        sample_age = _round_secs(max(0.0, now_epoch - latest_observed))
        stale = sample_age > STALE_AFTER_SECONDS

    source_history_complete = bool(
        scope_complete is True and in_scope_rejected == 0 and rejected_usage_count == 0
    )

    duration_reasons: List[str] = []
    if phase_elapsed is None:
        duration_reasons.append("phase_elapsed_unavailable")
    if not turns:
        duration_reasons.append("no_observed_turns")
    if scope_complete is not True:
        duration_reasons.append(
            "scope_complete_missing" if scope_complete is None else "scope_complete_false"
        )
    if in_scope_rejected:
        duration_reasons.append("rejected_in_scope_observations")
    if clipped_count:
        duration_reasons.append("intervals_clipped_to_phase")
    if ongoing_count:
        duration_reasons.append("ongoing_turn_uses_own_observation_horizon")
    duration_reasons.append("active_execution_absent_event_intervals")

    duration = _empty_duration()
    duration.update(
        {
            "phaseElapsedSeconds": phase_elapsed,
            "activeExecutionSeconds": None,
            "activeExecutionReason": "absent_event_intervals",
            "observedTurnWallSeconds": union_seconds,
            "sumTurnWallSeconds": sum_seconds,
            "observedTurnCount": len(by_turn),
            "clippedTurnCount": clipped_count,
            "ongoingTurnCount": ongoing_count,
            "outsidePhaseTurnCount": outside_count,
            "duplicateObservationCount": duplicate_count,
            "ignoredThreadObservationCount": ignored_thread,
            "sourceHistoryComplete": source_history_complete,
            "rejectionReasons": dict(sorted(rejection_counts.items())),
            "missingReasons": duration_reasons,
        }
    )

    # ---- token aggregation ------------------------------------------------------
    usage = _build_usage(
        turns=turns,
        scope_complete=scope_complete,
        source_history_complete=source_history_complete,
        rejected_usage_count=rejected_usage_count,
    )
    usage["rejectionReasons"] = dict(sorted(usage_rejection_counts.items()))

    # ---- result -----------------------------------------------------------------
    result["ok"] = True
    result["error"] = None
    result["missing"] = missing
    result["phase"]["elapsedSeconds"] = phase_elapsed
    result["phase"]["sampleAgeSeconds"] = sample_age
    result["phase"]["stale"] = stale
    result["duration"] = duration
    result["usage"] = usage
    result["turns"] = [_public_turn(turn) for turn in turns]

    result["phaseElapsedSeconds"] = phase_elapsed
    result["activeExecutionSeconds"] = None
    result["activeExecutionReason"] = "absent_event_intervals"
    result["observedTurnWallSeconds"] = union_seconds
    result["sumTurnWallSeconds"] = sum_seconds
    for name in ALL_METRICS:
        result[name] = usage[name]
    for name in TOKEN_FIELDS:
        observed_name = "observed" + name[0].upper() + name[1:]
        result[observed_name] = usage[observed_name]
    result["observedTotalTokens"] = usage["observedTotalTokens"]
    result["coverage"] = usage["coverage"]
    result["sourceHistoryComplete"] = source_history_complete
    return result


def _build_usage(
    turns: List[Dict[str, Any]],
    scope_complete: Optional[bool],
    source_history_complete: bool,
    rejected_usage_count: int,
) -> Dict[str, Any]:
    usage = _empty_usage()
    usage["scopeComplete"] = scope_complete
    usage["sourceHistoryComplete"] = source_history_complete
    usage["rejectedUsageCount"] = rejected_usage_count

    eligible = [turn for turn in turns if turn["wholeTurnInPhase"]]
    excluded = len(turns) - len(eligible)
    usage["eligibleTurnCount"] = len(eligible)
    usage["excludedTurnCount"] = excluded

    known = _counts()
    observed = {name: None for name in ALL_METRICS}
    conventions = set()
    accepted_snapshots = 0
    invalid_or_missing = 0

    for turn in eligible:
        snapshot = turn["_snapshot"]
        if turn["usage"]["state"] != "accepted" or snapshot is None:
            invalid_or_missing += 1
            per_turn = {name: None for name in TOKEN_FIELDS}
            per_turn[TOTAL_FIELD] = None
        else:
            accepted_snapshots += 1
            conventions.add(snapshot["cacheConvention"])
            per_turn = {name: snapshot[name] for name in TOKEN_FIELDS}
            total, _reason = _turn_total(snapshot)
            per_turn[TOTAL_FIELD] = total

        for name in ALL_METRICS:
            value = per_turn[name]
            if value is None:
                continue
            known[name] += 1
            observed[name] = value if observed[name] is None else observed[name] + value

    for name in ALL_METRICS:
        usage["knownTurnCounts"][name] = known[name]
        usage["unknownTurnCounts"][name] = len(eligible) - known[name]
        usage["coverage"]["known"][name] = known[name]
        usage["coverage"]["unknown"][name] = len(eligible) - known[name]

    if len(conventions) == 1:
        usage["cacheConvention"] = next(iter(conventions))
    elif len(conventions) > 1:
        usage["cacheConvention"] = "mixed"

    if accepted_snapshots or any(
        turn["usage"]["state"] == "excluded" for turn in turns
    ):
        usage["source"] = "native_turn_usage"
        usage["basis"] = "turn_total"
    usage["usageSnapshotCount"] = sum(
        1 for turn in turns if turn["usage"]["state"] in ("accepted", "excluded")
    )

    for name in TOKEN_FIELDS:
        observed_name = "observed" + name[0].upper() + name[1:]
        usage[observed_name] = observed[name]
    usage["observedTotalTokens"] = observed[TOTAL_FIELD]

    base_complete = (
        scope_complete is True
        and source_history_complete
        and len(eligible) > 0
        and excluded == 0
    )
    per_metric_complete: Dict[str, bool] = {}
    for name in ALL_METRICS:
        complete = base_complete and known[name] == len(eligible)
        if name == TOTAL_FIELD and usage["cacheConvention"] not in (
            "included_in_input",
            "separate_from_input",
        ):
            complete = False
        per_metric_complete[name] = complete
        usage["coverage"]["complete"][name] = complete
        usage[name] = observed[name] if complete else None

    usage["coverage"]["eligible"] = len(eligible)

    reasons: List[str] = []
    if len(eligible) == 0:
        reasons.append("no_eligible_turns")
    if excluded:
        reasons.append("turns_excluded_from_whole_turn_scope")
    if scope_complete is not True:
        reasons.append(
            "scope_complete_missing" if scope_complete is None else "scope_complete_false"
        )
    if not source_history_complete:
        reasons.append("source_history_incomplete")
    if accepted_snapshots == 0 and len(eligible) > 0:
        reasons.append("usage_missing")
    if invalid_or_missing:
        reasons.append("usage_incomplete")
    if rejected_usage_count:
        reasons.append("usage_rejected")
    if usage["cacheConvention"] in (None, "mixed"):
        reasons.append("cache_convention_unknown")
    for name in ALL_METRICS:
        if not per_metric_complete[name] and len(eligible) > 0:
            if name == TOTAL_FIELD:
                if usage["cacheConvention"] == "mixed":
                    reasons.append("cache_convention_mixed")
                elif usage["cacheConvention"] == "unknown":
                    reasons.append("cache_convention_unknown")
                elif known[name] != len(eligible):
                    reasons.append("total_tokens_incomplete")
            else:
                reasons.append("%s_incomplete" % _snake(name))

    # Stable, de-duplicated, bounded reasons.
    seen = set()
    ordered: List[str] = []
    for reason in reasons:
        if reason not in seen:
            seen.add(reason)
            ordered.append(reason)
    usage["missingReasons"] = ordered
    return usage


def _public_turn(turn: Dict[str, Any]) -> Dict[str, Any]:
    public = dict(turn)
    public.pop("_snapshot", None)
    return public


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _load_json(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Aggregate one explicitly bounded task phase."
    )
    parser.add_argument("--phase", required=True, help="phase JSON file")
    parser.add_argument("--observations", required=True, help="observations JSON file")
    parser.add_argument("--now", default=None, help="ISO-8601 UTC/offset timestamp")
    args = parser.parse_args(argv)

    try:
        phase = _load_json(args.phase)
        observations = _load_json(args.observations)
    except (OSError, ValueError) as exc:
        print("phase_metrics: cannot read JSON input: %s" % exc.__class__.__name__, file=sys.stderr)
        return 2

    if isinstance(observations, dict):
        observations = observations.get("observations", [])
    result = aggregate_phase(phase, observations, now=args.now)
    json.dump(result, sys.stdout, indent=2, sort_keys=True, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
