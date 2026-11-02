"""Pure, allowlisted source semantics; never produces phase_metrics.turn_total."""

from collections.abc import Mapping
from datetime import datetime
import hashlib
import json
import math
import re


NATIVE_SOURCE = "native_desktop"
DSH_SOURCE = "dsh"
FIELDS = (
    "inputTokens", "outputTokens", "cacheReadInputTokens",
    "cacheWriteInputTokens", "totalTokens",
)
NATIVE_FIELDS = {
    "inputTokens": "inputTokens", "outputTokens": "outputTokens",
    "cacheReadInputTokens": "cachedInputTokens",
    "cacheWriteInputTokens": "cacheWriteInputTokens",
    "totalTokens": "totalTokens", "reasoningOutputTokens": "reasoningOutputTokens",
}
DSH_FIELDS = ("inputTokens", "outputTokens", "totalTokens", "cacheReadTokens")
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}\Z")


def _id(value):
    return isinstance(value, str) and _ID.fullmatch(value) is not None


def _counter(value):
    return type(value) is int and value >= 0


def _time(value):
    if type(value) in (int, float):
        # Reject millisecond epochs rather than silently changing the unit.
        if 0 <= value <= 253402300799 and math.isfinite(value):
            return int(value) if value == int(value) else value
    elif isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if parsed.tzinfo is not None:
                result = parsed.timestamp()
                if math.isfinite(result) and 0 <= result <= 253402300799:
                    return int(result) if result == int(result) else result
        except (ValueError, OverflowError, OSError):
            pass
    return None


def _hash(parts):
    return hashlib.sha256(_canonical(parts).encode("utf-8")).hexdigest()


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _empty_tokens():
    return dict.fromkeys(FIELDS)


def _reject(source, reason, **safe):
    return {
        "source": source, "status": "rejected", "reason": reason,
        "resetDetected": reason == "counter_decrease",
        "phaseTokensComplete": False, "inputTokens": None, "outputTokens": None,
        **safe,
    }


def _scope(scope, native=False):
    if not isinstance(scope, Mapping):
        return None
    if not all(_id(scope.get(key)) for key in ("taskId", "phaseId")):
        return None
    start = _time(scope.get("startedAt"))
    end = _time(scope.get("endedAt")) if scope.get("endedAt") is not None else None
    as_of = _time(scope.get("asOf")) if scope.get("asOf") is not None else None
    if start is None or (scope.get("endedAt") is not None and end is None):
        return None
    if scope.get("asOf") is not None and as_of is None:
        return None
    if (end is not None and end < start) or (as_of is not None and as_of < start):
        return None
    if end is not None and as_of is not None and end > as_of:
        return None
    if native:
        threads = scope.get("threadIds")
        if not isinstance(threads, (list, tuple)) or not threads or not all(map(_id, threads)):
            return None
        if end is None and as_of is None:
            return None
    elif not _id(scope.get("executorId")):
        return None
    return start, end if end is not None else as_of


def _native_counts(sample):
    usage = sample.get("tokenUsage")
    if not isinstance(usage, Mapping) or not isinstance(usage.get("total"), Mapping):
        return None
    total = usage["total"]
    result = {}
    for dest, key in NATIVE_FIELDS.items():
        value = total.get(key)
        if value is not None and not _counter(value):
            return None
        result[dest] = value
    return result


def _consistent(counts):
    i, o, t = (counts[k] for k in ("inputTokens", "outputTokens", "totalTokens"))
    read, write = counts["cacheReadInputTokens"], counts["cacheWriteInputTokens"]
    if None not in (i, o, t) and i + o != t:
        return False
    if i is not None and sum(v for v in (read, write) if v is not None) > i:
        return False
    return True


def native_counter_window(before, after, scope):
    """Difference two lifetime snapshots inside one explicitly bounded phase.

    Open phases require scope.asOf, a caller-captured wall-clock upper bound.
    `last` and unknown fields are never read or emitted.
    """
    bounds = _scope(scope, native=True)
    if bounds is None:
        return _reject(NATIVE_SOURCE, "invalid_scope")
    if not isinstance(before, Mapping) or not isinstance(after, Mapping):
        return _reject(NATIVE_SOURCE, "missing_baseline_or_sample")
    thread = before.get("threadId")
    if not _id(thread) or thread != after.get("threadId"):
        return _reject(NATIVE_SOURCE, "thread_mismatch")
    if thread not in scope["threadIds"]:
        return _reject(NATIVE_SOURCE, "unregistered_thread")
    if before.get("phaseId") != scope["phaseId"] or after.get("phaseId") != scope["phaseId"]:
        return _reject(NATIVE_SOURCE, "phase_mismatch")
    start, end = _time(before.get("observedAt")), _time(after.get("observedAt"))
    if start is None or end is None:
        return _reject(NATIVE_SOURCE, "invalid_timestamp")
    if end < start:
        return _reject(NATIVE_SOURCE, "out_of_order_timestamp")
    if start < bounds[0] or end > bounds[1]:
        return _reject(NATIVE_SOURCE, "outside_phase_or_future")
    revisions = (before.get("revision"), after.get("revision"))
    if revisions != (None, None):
        if not all(_counter(v) for v in revisions):
            return _reject(NATIVE_SOURCE, "invalid_revision")
        if revisions[1] < revisions[0]:
            return _reject(NATIVE_SOURCE, "out_of_order_revision")
    left, right = _native_counts(before), _native_counts(after)
    if left is None or right is None:
        return _reject(NATIVE_SOURCE, "invalid_counters")
    for key in NATIVE_FIELDS:
        if left[key] is not None and right[key] is not None and right[key] < left[key]:
            return _reject(NATIVE_SOURCE, "counter_decrease")
    if not _consistent(left) or not _consistent(right):
        return _reject(NATIVE_SOURCE, "inconsistent_native_counters")
    if start == end or (revisions[0] is not None and revisions[0] == revisions[1]):
        if left != right:
            return _reject(NATIVE_SOURCE, "observation_conflict")
        return {
            "source": NATIVE_SOURCE, "status": "duplicate", "reason": "repeated_observation",
            "phaseTokensComplete": False, "inputTokens": None, "outputTokens": None,
        }
    delta = {key: right[key] - left[key] if None not in (left[key], right[key]) else None
             for key in NATIVE_FIELDS}
    if not any(delta[key] is not None for key in FIELDS):
        return _reject(NATIVE_SOURCE, "missing_counter_baseline")
    # Full endpoint identities plus delta identities prove inclusion. Reasoning
    # is a subset/metadata, never an additional term in totalTokens.
    proven = all(counts[key] is not None for counts in (left, right) for key in FIELDS)
    if not _consistent(delta):
        return _reject(NATIVE_SOURCE, "inconsistent_native_delta")
    if not proven:
        delta["totalTokens"] = None
    return {
        "source": NATIVE_SOURCE, "sourceId": NATIVE_SOURCE,
        "status": "accepted", "taskId": scope["taskId"], "phaseId": scope["phaseId"],
        "threadId": thread,
        "windowId": _hash([NATIVE_SOURCE, thread, scope["phaseId"], [start, revisions[0]], [end, revisions[1]]]),
        "windowStart": start, "windowEnd": end,
        "beforeRevision": revisions[0], "afterRevision": revisions[1],
        "clock": "observation_wall", "timestampUnit": "epoch_seconds",
        "scope": "observed_counter_window", "coverage": "partial",
        "phaseTokensComplete": False, "inputTokens": None, "outputTokens": None,
        "cacheConvention": "included_in_input" if proven else None,
        "observedTokens": {key: delta[key] for key in FIELDS},
        "metadata": {"reasoningOutputTokens": delta["reasoningOutputTokens"]},
    }


def _sum_metrics(records, denominator):
    known, complete, counts = {}, {}, {}
    for key in FIELDS:
        values = [r["observedTokens"][key] for r in records if r["observedTokens"][key] is not None]
        counts[key] = len(values)
        known[key] = sum(values) if values else None
        complete[key] = known[key] if len(values) == denominator and denominator > 0 else None
    return known, complete, counts


def _union_seconds(records):
    intervals = sorted((r["windowStart"], r["windowEnd"]) for r in records)
    if not intervals:
        return None
    start, end = intervals[0]
    total = 0
    for left, right in intervals[1:]:
        if left <= end:
            end = max(end, right)
        else:
            total += end - start
            start, end = left, right
    return total + end - start


def _valid_tokens(value):
    return isinstance(value, Mapping) and all(
        key in value and (value[key] is None or _counter(value[key])) for key in FIELDS)


def _safe_window(record):
    if not isinstance(record, Mapping) or record.get("source") != NATIVE_SOURCE or record.get("status") != "accepted":
        return None
    if not all(_id(record.get(k)) for k in ("taskId", "phaseId", "threadId", "windowId")):
        return None
    start, end = _time(record.get("windowStart")), _time(record.get("windowEnd"))
    if start is None or end is None or end <= start or not _valid_tokens(record.get("observedTokens")):
        return None
    if record.get("scope") != "observed_counter_window" or record.get("phaseTokensComplete") is not False:
        return None
    tokens = {k: record["observedTokens"][k] for k in FIELDS}
    if not _consistent(tokens):
        return None
    if tokens["totalTokens"] is not None and (
        record.get("cacheConvention") != "included_in_input" or
        tokens["inputTokens"] is None or tokens["outputTokens"] is None or
        tokens["inputTokens"] + tokens["outputTokens"] != tokens["totalTokens"]
    ):
        return None
    return {"taskId": record["taskId"], "phaseId": record["phaseId"], "threadId": record["threadId"],
            "windowId": record["windowId"], "windowStart": start, "windowEnd": end,
            "observedTokens": tokens}


def aggregate_counter_windows(windows):
    """Deduplicate; exclude a thread's entire set on any positive overlap."""
    unique, conflicts, identities = {}, set(), set()
    variants = {}
    conflict_threads = set()
    received = duplicates = duplicate_observations = rejected = 0
    for record in windows:
        received += 1
        if isinstance(record, Mapping) and record.get("source") == NATIVE_SOURCE and record.get("status") == "duplicate":
            duplicate_observations += 1
            continue
        safe = _safe_window(record)
        if safe is None:
            rejected += 1
            continue
        identities.add((safe["taskId"], safe["phaseId"]))
        key = safe["windowId"]
        if key in unique:
            if safe in variants[key]:
                duplicates += 1
            else:
                variants[key].append(safe)
                conflicts.add(key)
                conflict_threads.update((safe["threadId"], unique[key]["threadId"]))
        else:
            unique[key] = safe
            variants[key] = [safe]
    if len(identities) > 1:
        return _reject(NATIVE_SOURCE, "mixed_task_or_phase")
    # A conflict poisons its thread, including all other windows on that thread.
    bad_threads = conflict_threads
    by_thread = {}
    for record in unique.values():
        by_thread.setdefault(record["threadId"], []).append(record)
    for thread, records in by_thread.items():
        records.sort(key=lambda r: (r["windowStart"], r["windowEnd"], r["windowId"]))
        if any(a["windowEnd"] > b["windowStart"] for a, b in zip(records, records[1:])):
            bad_threads.add(thread)
    accepted = [r for r in unique.values() if r["threadId"] not in bad_threads]
    known, complete, metric_counts = _sum_metrics(accepted, len(accepted))
    identity = next(iter(identities), (None, None))
    return {
        "source": NATIVE_SOURCE, "status": "accepted", "taskId": identity[0], "phaseId": identity[1],
        "scope": "observed_counter_windows", "coverage": "partial",
        "phaseTokensComplete": False, "inputTokens": None, "outputTokens": None,
        "observedTokens": complete, "knownObservedTokens": known,
        "observedElapsedSeconds": _union_seconds(accepted),
        "clock": "observation_wall", "timestampUnit": "epoch_seconds",
        "coverageCounts": {
            "receivedRecords": received, "uniqueWindows": len(unique),
            "acceptedWindows": len(accepted), "duplicateRecords": duplicates,
            "duplicateObservations": duplicate_observations,
            "rejectedRecords": rejected, "conflictingWindowIds": len(conflicts),
            "excludedAmbiguousWindows": len(unique) - len(accepted),
            "metricKnownWindows": metric_counts,
        },
    }


def normalize_dsh_step(event, scope, source_id):
    """Normalize only explicit status/step_end under an exclusive executor map."""
    if _scope(scope) is None or not _id(source_id):
        return _reject(DSH_SOURCE, "invalid_scope_or_source")
    if not isinstance(event, Mapping) or event.get("type") != "status" or event.get("phase") != "step_end":
        return {"source": DSH_SOURCE, "status": "ignored", "reason": "not_step_end"}
    turn, step = event.get("turn"), event.get("step")
    if not _counter(turn) or not _counter(step):
        return _reject(DSH_SOURCE, "invalid_step_identity")
    base = {
        "source": DSH_SOURCE, "sourceId": source_id,
        "taskId": scope["taskId"], "phaseId": scope["phaseId"], "executorId": scope["executorId"],
        "turn": turn, "step": step, "stepId": _hash([DSH_SOURCE, source_id, turn, step]),
        "scope": "executor_step", "coverage": "executor_observed_steps",
        "phaseTokensComplete": False, "inputTokens": None, "outputTokens": None,
        "cacheConvention": "included_in_input", "uncachedInputTokens": None,
        "observedTokens": _empty_tokens(), "clock": None,
        "reportedUsage": None,
    }
    usage = event.get("usage")
    if usage is None:
        return {**base, "status": "missing", "reason": "missing_usage"}
    if not isinstance(usage, Mapping) or any(
        usage.get(k) is not None and not _counter(usage[k]) for k in DSH_FIELDS
    ):
        return {**base, "status": "rejected", "reason": "invalid_usage"}
    base["reportedUsage"] = {key: usage.get(key) for key in DSH_FIELDS}
    uncached, read, output, total = (usage.get(k) for k in
                                    ("inputTokens", "cacheReadTokens", "outputTokens", "totalTokens"))
    inclusive = uncached + read if None not in (uncached, read) else None
    if None not in (inclusive, output, total) and inclusive + output != total:
        return {**base, "status": "rejected", "reason": "inconsistent_dsh_total"}
    verified_prompt = inclusive if None not in (inclusive, output, total) else None
    tokens = {
        # Without a verified total, an unreported cache-write bucket may exist.
        # Keep uncached/read evidence separately; do not call their sum full input.
        "inputTokens": verified_prompt, "outputTokens": output, "cacheReadInputTokens": read,
        "cacheWriteInputTokens": None,
        "totalTokens": total if None not in (inclusive, output, total) else None,
    }
    return {**base, "status": "accepted" if any(v is not None for v in (uncached, read, output, total)) else "missing",
            "reason": None if any(v is not None for v in (uncached, read, output, total)) else "missing_usage",
            "uncachedInputTokens": uncached, "observedTokens": tokens}


def _safe_step(record):
    if not isinstance(record, Mapping) or record.get("source") != DSH_SOURCE:
        return None
    status = record.get("status")
    if status not in ("accepted", "missing", "rejected"):
        return None
    if not all(_id(record.get(k)) for k in ("taskId", "phaseId", "executorId", "sourceId", "stepId")):
        return None
    if not all(_counter(record.get(k)) for k in ("turn", "step")):
        return None
    if record["stepId"] != _hash([DSH_SOURCE, record["sourceId"], record["turn"], record["step"]]):
        return None
    if not _valid_tokens(record.get("observedTokens")):
        return None
    if record.get("scope") != "executor_step" or record.get("phaseTokensComplete") is not False:
        return None
    if record["observedTokens"]["cacheWriteInputTokens"] is not None:
        return None
    uncached = record.get("uncachedInputTokens")
    if uncached is not None and not _counter(uncached):
        return None
    reported = record.get("reportedUsage")
    if reported is not None and (not isinstance(reported, Mapping) or any(
        reported.get(key) is not None and not _counter(reported[key]) for key in DSH_FIELDS
    )):
        return None
    if status == "accepted":
        if reported is None:
            return None
        # Reconstruct from the safe source counters, so a mutated normalized
        # record cannot introduce inclusive-cache or total inconsistencies.
        expected = normalize_dsh_step(
            {"type": "status", "phase": "step_end", "turn": record["turn"],
             "step": record["step"], "usage": reported},
            {"taskId": record["taskId"], "phaseId": record["phaseId"],
             "executorId": record["executorId"], "startedAt": 0}, record["sourceId"],
        )
        if expected["status"] != status or expected["observedTokens"] != record["observedTokens"] or expected["uncachedInputTokens"] != uncached:
            return None
    elif any(value is not None for value in record["observedTokens"].values()) or uncached is not None:
        return None
    # Keep only safe normalized fields. Invalid usage values never escape.
    return {k: record[k] for k in (
        "taskId", "phaseId", "executorId", "sourceId", "stepId", "turn", "step", "status",
    )} | {"observedTokens": {k: record["observedTokens"][k] for k in FIELDS},
         "uncachedInputTokens": uncached,
         "reportedUsage": {k: reported.get(k) for k in DSH_FIELDS} if reported is not None else None}


def aggregate_dsh_steps(steps):
    """Conflicting replays poison the unique step; missing usage stays missing."""
    unique, conflicts, identities = {}, set(), set()
    variants = {}
    received = duplicates = ignored = rejected = 0
    for record in steps:
        received += 1
        if isinstance(record, Mapping) and record.get("source") == DSH_SOURCE and record.get("status") == "ignored":
            ignored += 1
            continue
        safe = _safe_step(record)
        if safe is None:
            rejected += 1
            continue
        identities.add((safe["taskId"], safe["phaseId"], safe["executorId"], safe["sourceId"]))
        key = safe["stepId"]
        if key in unique:
            if safe in variants[key]:
                duplicates += 1
            else:
                variants[key].append(safe)
                conflicts.add(key)
        else:
            unique[key] = safe
            variants[key] = [safe]
    if len(identities) > 1:
        return _reject(DSH_SOURCE, "mixed_scope_or_source")
    accepted = [r for key, r in unique.items() if key not in conflicts and r["status"] == "accepted"]
    known, complete, metric_counts = _sum_metrics(accepted, len(unique))
    identity = next(iter(identities), (None, None, None, None))
    uncached = [r["uncachedInputTokens"] for r in accepted if r["uncachedInputTokens"] is not None]
    return {
        "source": DSH_SOURCE, "status": "accepted", "taskId": identity[0], "phaseId": identity[1],
        "executorId": identity[2], "sourceId": identity[3],
        "scope": "executor_steps", "coverage": "executor_observed_steps",
        "phaseTokensComplete": False, "inputTokens": None, "outputTokens": None,
        "observedTokens": complete, "knownObservedTokens": known,
        "knownUncachedInputTokens": sum(uncached) if uncached else None,
        "clock": None, "observedElapsedSeconds": None,
        "coverageCounts": {
            "receivedRecords": received, "uniqueStepEnds": len(unique),
            "stepsWithUsage": len(accepted), "missingUsageSteps": len(unique) - len(accepted),
            "recordsWithoutUsage": sum(r["status"] == "missing" for k, r in unique.items() if k not in conflicts),
            "invalidUsageSteps": sum(r["status"] == "rejected" for k, r in unique.items() if k not in conflicts),
            "conflictingSteps": len(conflicts), "duplicateRecords": duplicates,
            "ignoredRecords": ignored, "rejectedRecords": rejected,
            "metricKnownSteps": metric_counts, "uncachedInputKnownSteps": len(uncached),
        },
    }
