"""Explicit, metadata-only usage bindings for the existing snapshot process.

No discovery, timers, ledger writes or sample fallback. The sidecar is owned by
the operator; task_usage remains the authority for token and interval arithmetic.
"""
from __future__ import annotations

import copy
import json
import os
import threading
from collections import OrderedDict
from pathlib import Path

from . import task_usage as usage

_LOCK = threading.RLock()
_SOURCES = OrderedDict()
_RESULTS = OrderedDict()
_MAX_SOURCES = 16
_MAX_RESULTS = 128
_MAX_METADATA_BYTES = 8 * 1024 * 1024  # per source; overflow fails closed
_MAX_LINE_BYTES = 16 * 1024 * 1024
_TOKEN_FIELDS = {name for _, name in usage.TOKEN_KEYS} | {"total_tokens"}


def _tokens(value):
    return {k: v for k, v in (value.items() if isinstance(value, dict) else [])
            if k in _TOKEN_FIELDS and type(v) is int and v >= 0}


def _native(record):
    """Discard all bodies before retaining anything in the source cache."""
    p = record.get("payload")
    if not isinstance(p, dict):
        return None
    kind, sub = record.get("type"), p.get("type")
    out = {}
    if kind == "event_msg" and sub in ("task_started", "task_complete"):
        out = {k: p[k] for k in ("type", "turn_id", "started_at", "duration_ms") if k in p}
    elif kind == "event_msg" and sub == "token_count":
        info = p.get("info")
        if not isinstance(info, dict):
            return None
        out = {"type": sub, "info": {k: _tokens(info.get(k)) for k in
                                     ("total_token_usage", "last_token_usage")}}
    elif kind == "turn_context":
        out = {k: p[k] for k in ("turn_id", "model") if k in p}
    elif kind == "token_usage_record":
        out = {k: p[k] for k in ("turn_id", "response_id") if k in p}
        out.update({k: _tokens(p.get(k)) for k in ("usage", "turn_token_usage", "thread_token_usage")})
    elif kind == "response_item" and sub in ("function_call", "custom_tool_call"):
        out = {k: p[k] for k in ("type", "call_id", "id") if k in p}
    else:
        return None
    # Identity and timestamp fields are scalars, never arbitrary nested objects.
    out = {k: v for k, v in out.items() if isinstance(v, (str, int, float, type(None)))
           or k in ("info", "usage", "turn_token_usage", "thread_token_usage")}
    at = record.get("timestamp")
    return {"type": kind, "timestamp": at if isinstance(at, (str, int, float)) else None, "payload": out}


def _telemetry(record):
    out = {k: record[k] for k in ("session", "round_index", "started_at", "finished_at",
                                "duration_seconds", "executor", "model", "effort", "status")
           if k in record and isinstance(record[k], (str, int, float, type(None)))}
    u = record.get("usage")
    tokens = u.get("tokens") if isinstance(u, dict) else None
    out["usage"] = {"tokens": {k: v for k, v in (tokens.items() if isinstance(tokens, dict) else [])
                                if k in ("input", "output", "cached_read", "cache_write", "reasoning", "total")
                                and type(v) is int and v >= 0}}
    return out


def _signature(st):
    return st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns


def _trim(cache, limit):
    while len(cache) > limit:
        cache.popitem(last=False)


def _source(path, kind):
    """Read append-only JSONL incrementally; incomplete final lines are retried.

    Cache entries contain only serialized allow-listed metadata. A changed inode,
    shrink or same-size rewrite starts a new parse; stale bytes are never reused.
    """
    key = (str(path), kind)
    try:
        st = os.stat(path)
        sig = _signature(st)
        old = _SOURCES.get(key)
        if old and old["sig"] == sig:
            _SOURCES.move_to_end(key)
            return old
        append = bool(old and old["sig"][:2] == sig[:2] and sig[2] > old["sig"][2])
        with open(path, "rb") as fh:
            if _signature(os.fstat(fh.fileno())) != sig:
                raise ValueError("source_changed_during_open")
            rows = list(old["rows"]) if append else []
            size = old["bytes"] if append else 0
            offset = old["offset"] if append else 0
            fh.seek(offset)
            while True:
                line = fh.readline(_MAX_LINE_BYTES + 1)
                if not line:
                    break
                if len(line) > _MAX_LINE_BYTES:
                    # Discard an oversized body without retaining it. It cannot
                    # be trusted as metadata; reject rather than undercount.
                    raise ValueError("source_line_exceeds_limit")
                if not line.endswith(b"\n"):
                    break  # active writer: retain no partial body in memory
                offset = fh.tell()
                try:
                    raw = json.loads(line)
                except (ValueError, UnicodeError):
                    raise ValueError("invalid_source_json") from None
                if not isinstance(raw, dict):
                    continue
                record = _native(raw) if kind == "native" else _telemetry(raw)
                if record is None:
                    continue
                encoded = json.dumps(record, separators=(",", ":"), ensure_ascii=True)
                size += len(encoded)
                if size > _MAX_METADATA_BYTES:
                    raise ValueError("source_metadata_exceeds_limit")
                rows.append(encoded if kind == "native" else record)
            if _signature(os.fstat(fh.fileno())) != sig:
                raise ValueError("source_changed_during_read")
        entry = {"sig": sig, "rows": rows, "bytes": size, "offset": offset}
        _SOURCES[key] = entry
        _SOURCES.move_to_end(key)
        _trim(_SOURCES, _MAX_SOURCES)
        return entry
    except Exception:
        _SOURCES.pop(key, None)
        raise


def _unavailable(reason):
    return {"schema": usage.SCHEMA, "available": False, "sourceAt": None,
            "model": None, "executor": None, "wall": None,
            "coverage": "unavailable", "missing": [reason]}


def _warn(result, warnings, stale=False):
    result = copy.deepcopy(result)
    result["stale"] = stale
    result["coverage"] = "partial" if result.get("available") else "unavailable"
    result["missing"] = sorted(set(result.get("missing", []) + warnings))
    if result.get("model"):
        result["model"]["coverage"] = "partial"
        result["model"]["missing"] = sorted(set(result["model"].get("missing", []) + warnings))
    if result.get("executor"):
        result["executor"]["warnings"] = warnings
    return result


def _validate(binding, task, ledger_task):
    if not isinstance(binding, dict):
        raise ValueError("task_usage_binding_missing")
    tid = binding.get("threadId")
    if not isinstance(tid, str) or not tid or tid != task.get("threadId"):
        raise ValueError("task_usage_thread_binding_mismatch")
    if not ledger_task or tid != ledger_task.get("thread_id", ledger_task.get("threadId")):
        raise ValueError("task_usage_ledger_binding_mismatch")
    if not isinstance(binding.get("phaseId"), str) or not binding["phaseId"]:
        raise ValueError("task_usage_phase_binding_required")
    path = binding.get("nativePath")
    if not isinstance(path, str) or not os.path.isabs(path):
        raise ValueError("task_usage_explicit_native_path_required")
    if type(binding.get("taskTurnsAll")) is not bool:
        raise ValueError("task_usage_explicit_task_scope_required")
    for key in ("phaseTurnRefs",):
        if key in binding and (not isinstance(binding[key], list) or
                               any(not isinstance(r, str) or not r for r in binding[key])):
            raise ValueError("task_usage_invalid_turn_refs")
    if "currentTurnRef" in binding and (not isinstance(binding["currentTurnRef"], str) or not binding["currentTurnRef"]):
        raise ValueError("task_usage_invalid_turn_ref")
    executors = binding.get("executorBindings", [])
    if not isinstance(executors, list):
        raise ValueError("task_usage_invalid_executor_bindings")
    for ex in executors:
        if (not isinstance(ex, dict) or not isinstance(ex.get("telemetryPath"), str)
                or not os.path.isabs(ex["telemetryPath"]) or not isinstance(ex.get("sessionRef"), str)
                or not ex["sessionRef"] or not isinstance(ex.get("roundIndexes"), list)
                or not ex["roundIndexes"] or any(type(r) is not int or r < 0 for r in ex["roundIndexes"])):
            raise ValueError("task_usage_invalid_executor_binding")


def _executor_usage(records):
    """Normalize explicitly identified Claude summaries exactly once.

    Cached telemetry stays raw. Anthropic input excludes read/write caches;
    Codex input is already inclusive. Unknown categories remain unknown.
    """
    normalized = copy.deepcopy(records)
    claude = [r for r in records if r.get("executor") == "claude"]
    missing = []
    for r in normalized:
        if r.get("executor") != "claude":
            continue
        t = r["usage"]["tokens"]
        values = [t.get(k) for k in ("input", "cached_read", "cache_write")]
        if all(type(v) is int and v >= 0 for v in values):
            t["input"] = sum(values)
        else:
            t["input"] = None
            missing.append("claude_inclusive_input_requires_uncached_input_cache_read_and_cache_write")
    scope = usage.executor_scope(normalized)
    if claude:
        # A known value in one summary cannot establish an unknown category in
        # another. In particular, missing cache creation is never assumed zero.
        mapping = {"input": "input", "output": "output", "cacheRead": "cached_read",
                   "cacheWrite": "cache_write", "reasoning": "reasoning", "nativeTotal": "total"}
        for field, raw in mapping.items():
            if any(type(r["usage"]["tokens"].get(raw)) is not int for r in normalized):
                scope["tokens"][field] = None
                missing.append("executor_" + field + "_incomplete")
        i, o = scope["tokens"]["input"], scope["tokens"]["output"]
        scope["tokens"]["derivedTotal"] = i + o if i is not None and o is not None else None
        scope["coverage"]["missing"] = sorted(set(scope["coverage"]["missing"] + missing))
    uncached = [r["usage"]["tokens"].get("input") for r in claude]
    provenance = ({"sourceCacheConvention": "excluded_from_input", "summaryRecords": len(claude),
                   "inputUncached": sum(uncached) if all(type(v) is int for v in uncached) else None,
                   "normalization": "claude_input+cached_read+cache_write_once"} if claude else None)
    return scope, provenance


def _build(task_id, binding, native, records):
    # task_usage also accepts prefixes for CLI convenience. Live integration
    # accepts only exact native ids or their exact stable hash refs.
    parsed = usage.parse_native(native or [])
    def exact(value):
        for tid in parsed["order"]:
            if value == tid or value == usage.ref(tid):
                return tid
        return None
    spec = {"taskId": task_id, "phaseId": binding["phaseId"], "taskTurnsAll": binding["taskTurnsAll"]}
    primary = ("taskCumulative" if binding["taskTurnsAll"] else
               "plannerTurn" if binding.get("phaseTurnRefs") else "currentTurn")
    spec["primaryScope"] = primary
    tu = usage.build_task_usage(spec, native, [])
    # Resolve exact refs here instead of invoking the producer's CLI prefix
    # matcher (even a full id could be a prefix of a different native turn).
    if binding.get("phaseTurnRefs"):
        tu["scopes"]["plannerTurn"] = usage.turn_scope(
            parsed, [exact(r) for r in binding["phaseTurnRefs"]], "planner_phase_turn")
    if binding.get("currentTurnRef"):
        tu["scopes"]["currentTurn"] = usage.turn_scope(
            parsed, [exact(binding["currentTurnRef"])], "current_open_turn")
    recs, duplicates = usage.dedup_invocations(records)
    tu["execution"] = usage.execution_block(recs)
    tu["execution"]["duplicateInvocationRecordsIgnored"] = duplicates
    if not binding.get("executorBindings"):
        tu["execution"]["gap"] = "executor_binding_required"
    provenance = None
    if recs:
        tu["scopes"]["executorInvocation"], provenance = _executor_usage(recs)
    timestamps = [s["sourceAt"] for s in tu["scopes"].values() if s.get("sourceAt")]
    tu["sourceAt"] = max(timestamps) if timestamps else None
    out = usage.to_investment(tu)
    # Always derive wall from the selected native scope, including cumulative
    # scope; never attach a single planner turn's duration to task totals.
    scope = tu["scopes"].get(primary)
    out["wall"] = None
    if scope:
        boundary = scope["boundary"]
        start, end = usage._ts(boundary["startedAt"]), usage._ts(boundary["endedAt"])
        if start is not None and end is not None and end >= start:
            out["wall"] = {"seconds": round(end - start, 3), "scope": scope["scope"],
                           "basis": "selected_native_scope_boundaries_includes_approval_and_idle"}
        if not scope["turnRefs"]:
            out["model"]["toolCalls"] = None
    out["executor"]["duplicateInvocationRecordsIgnored"] = duplicates
    out["executor"]["tokensSourceAt"] = tu["scopes"].get("executorInvocation", {}).get("sourceAt")
    if provenance:
        out["executor"]["tokenProvenance"] = {"claude": provenance}
        out["executor"]["tokens"]["sourceCacheConvention"] = (
            "excluded_from_input" if provenance["summaryRecords"] == len(recs) else "mixed")
        out["executor"]["tokens"]["inputUncached"] = (
            provenance["inputUncached"] if provenance["summaryRecords"] == len(recs) else None)
    out["stale"] = False
    if not scope and not recs:
        return _unavailable("explicit_native_turn_scope_or_usage_required")
    return out


def attach_task_usage(payload, ledger, state_dir=None):
    """Return a snapshot copy with investment.taskUsage, preserving other keys.

    Sidecar: {"version": 1, "tasks": {taskId: {threadId, nativePath,
    taskTurnsAll: bool, phaseId, phaseTurnRefs?, currentTurnRef?,
    executorBindings?: [{telemetryPath, sessionRef, roundIndexes: [int]}]}}}.
    Errors are represented on the affected task; no source path is published.
    """
    with _LOCK:
        out = dict(payload)
        out["tasks"] = [dict(t) for t in payload.get("tasks", [])]
        root = state_dir if state_dir is not None else getattr(ledger, "state_dir", None)
        bindings, binding_error = {}, None
        try:
            if root is None:
                raise ValueError("state_dir_required")
            with open(Path(root) / "task-usage-bindings.json", encoding="utf-8") as fh:
                sidecar = json.load(fh)
            if type(sidecar.get("version")) is not int or sidecar["version"] != 1 or not isinstance(sidecar.get("tasks"), dict):
                raise ValueError("invalid_binding_schema")
            bindings = sidecar["tasks"]
        except Exception:
            binding_error = "task_usage_bindings_unavailable"
        for task in out["tasks"]:
            investment = dict(task["investment"]) if isinstance(task.get("investment"), dict) else {}
            task["investment"] = investment
            task_id = task.get("id")
            binding = bindings.get(task_id)
            try:
                if binding_error:
                    raise ValueError(binding_error)
                if not isinstance(binding, dict):
                    raise ValueError("task_usage_binding_missing")
                try:
                    ledger_task = ledger.get_task(task_id)
                except Exception:
                    raise ValueError("task_usage_ledger_unavailable") from None
                _validate(binding, task, ledger_task)
            except Exception as exc:
                # Identity failures must never resurrect another binding's usage.
                reason = str(exc) if isinstance(exc, ValueError) else "task_usage_ledger_unavailable"
                investment["taskUsage"] = _unavailable(reason)
                continue
            canonical_binding = json.dumps(binding, sort_keys=True, separators=(",", ":"))
            key = (str(root), task_id, canonical_binding)
            old = _RESULTS.get(key)
            warnings, signatures, records, native = [], [], [], None
            try:
                entry = _source(binding["nativePath"], "native")
                native = entry["rows"]
                signatures.append(entry["sig"])
                if not native:
                    warnings.append("native_source_has_no_metadata")
            except Exception:
                warnings.append("native_source_unavailable_or_changed")
            for ex in binding.get("executorBindings", []):
                try:
                    entry = _source(ex["telemetryPath"], "telemetry")
                    signatures.append(entry["sig"])
                    matched = [r for r in entry["rows"] if
                               (r.get("session") == ex["sessionRef"] or usage.ref(r.get("session")) == ex["sessionRef"])
                               and type(r.get("round_index")) is int and r["round_index"] in ex["roundIndexes"]]
                    records.extend(matched)
                    seen = {r.get("round_index") for r in matched}
                    if seen != set(ex["roundIndexes"]):
                        warnings.append("bound_executor_rounds_missing")
                except Exception:
                    warnings.append("executor_source_unavailable_or_changed")
            warnings = sorted(set(warnings))
            try:
                if warnings and old and warnings != old["warnings"]:
                    value = _warn(old["value"], warnings, stale=True)
                elif old and old["sig"] == signatures and warnings == old["warnings"]:
                    value = copy.deepcopy(old["value"])
                    _RESULTS.move_to_end(key)
                else:
                    value = _build(task_id, binding, native, records)
                    previous_model = (old["value"].get("model") or {}) if old else {}
                    current_model = value.get("model") or {}
                    if previous_model.get("sourceAt") and not current_model.get("sourceAt"):
                        value = _warn(old["value"], warnings + ["native_source_usage_unavailable"], stale=True)
                    elif warnings:
                        value = _warn(value, warnings)
                    if not value.get("stale"):
                        _RESULTS[key] = {"sig": signatures, "warnings": warnings, "value": copy.deepcopy(value)}
                        _RESULTS.move_to_end(key)
                        _trim(_RESULTS, _MAX_RESULTS)
                investment["taskUsage"] = value
            except Exception:
                investment["taskUsage"] = (_warn(old["value"], ["usage_calculation_failed"], stale=True)
                                           if old else _unavailable("usage_calculation_failed"))
        return out
