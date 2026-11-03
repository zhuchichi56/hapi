#!/usr/bin/env python3
"""Metadata-only task usage adapter (stdlib only): execution seconds, model steps, tokens.

Schema ``task_usage/v1``.  Complements ``phase_metrics`` (which keeps
``activeExecutionSeconds`` null and rejects thread totals) without changing it.

Rules
-----
* executionSeconds = UNION of explicit executor invocation intervals.  Gaps between
  invocations are excluded; model/tool/network wait *inside* an invocation is included.
  A native turn wall duration is never execution time.
* Model steps = distinct completed model responses carrying usage (``response_id``), or, when
  only cumulative ``token_count`` snapshots exist, distinct changed cumulative snapshots.
  Tool calls are counted separately and never used as steps.
* Tokens: per-response usage is summed once per response id; cumulative counters are
  differenced against a true baseline (never summed).  Missing baseline => partial lower bound.
  Codex convention: cached/cache-write are subsets of input; derived total = input + output
  (never labelled native).  Present counters stay visible when native total is absent.
* Only allow-listed numeric / id-hash / timestamp fields are read; no message, reasoning or
  tool bodies are retained.  Ids are emitted as short sha256 refs.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

SCHEMA = "task_usage/v1"
TOKEN_KEYS = (("input", "input_tokens"), ("output", "output_tokens"),
              ("cacheRead", "cached_input_tokens"), ("cacheWrite", "cache_write_input_tokens"),
              ("reasoning", "reasoning_output_tokens"))
EXEC_LABEL = "累计执行：执行者调用区间并集（含调用内模型/工具/网络等待，不含调用之间的空档）"


def ref(value: Any) -> Optional[str]:
    if value is None or value == "":
        return None
    if re.fullmatch(r"[0-9a-f]{10}", str(value)):
        return str(value)  # already a ref (sanitized extract)
    return hashlib.sha256(str(value).encode()).hexdigest()[:10]


def _ts(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value) if value >= 0 else None
    try:
        s = str(value).replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return None
        return dt.timestamp()
    except ValueError:
        return None


def iso(epoch: Optional[float]) -> Optional[str]:
    if epoch is None:
        return None
    return datetime.fromtimestamp(epoch, timezone.utc).isoformat().replace("+00:00", "Z")


def _int(v: Any) -> Optional[int]:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _usage(raw: Any) -> Dict[str, Optional[int]]:
    raw = raw if isinstance(raw, dict) else {}
    out = {k: _int(raw.get(n)) for k, n in TOKEN_KEYS}
    out["nativeTotal"] = _int(raw.get("total_tokens"))
    return out


# ---------------------------------------------------------------- native transcript
def parse_native(lines: Iterable[str]) -> Dict[str, Any]:
    """Return per-turn metadata. Turn keys are the transcript's own turn ids (kept in memory only)."""
    turns: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    current: Optional[str] = None
    last_snapshot: Optional[Dict[str, Any]] = None
    invalid = 0

    def turn(tid: str) -> Dict[str, Any]:
        if tid not in turns:
            turns[tid] = {"startedAt": None, "completedAt": None, "durationMs": None, "model": None,
                          "responses": {}, "duplicateResponses": 0, "toolCalls": set(),
                          "snapshots": [], "baselineSnapshot": None, "lastRecordAt": None}
            order.append(tid)
        return turns[tid]

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except ValueError:
            invalid += 1
            continue
        if not isinstance(d, dict):
            continue
        p = d.get("payload") if isinstance(d.get("payload"), dict) else {}
        t, pt, at = d.get("type"), p.get("type"), _ts(d.get("timestamp"))
        if t == "event_msg" and pt == "task_started":
            current = p.get("turn_id")
            if not current:
                continue
            tr = turn(current)
            if tr["startedAt"] is None and tr["baselineSnapshot"] is None and "baselineSet" not in tr:
                # a repeated task_started (duplicated batch) must keep the first baseline
                tr["startedAt"] = _ts(p.get("started_at")) if at is None else at
                tr["baselineSnapshot"] = last_snapshot
                tr["baselineSet"] = True
        elif t == "event_msg" and pt == "task_complete":
            tid = p.get("turn_id") or current
            if tid:
                tr = turn(tid)
                tr["completedAt"] = at
                tr["durationMs"] = _int(p.get("duration_ms"))
            current = None
        elif t == "turn_context" and p.get("turn_id"):
            turn(p["turn_id"])["model"] = p.get("model") if isinstance(p.get("model"), str) else None
        elif t == "token_usage_record":
            tid = p.get("turn_id") or current
            rid = p.get("response_id")
            if not tid or not rid:
                invalid += 1
                continue
            tr = turn(tid)
            if rid in tr["responses"]:
                tr["duplicateResponses"] += 1
                continue
            tr["responses"][rid] = {"at": at, "usage": _usage(p.get("usage")),
                                    "turnCumulative": _usage(p.get("turn_token_usage")),
                                    "threadCumulative": _usage(p.get("thread_token_usage"))}
            tr["lastRecordAt"] = at
        elif t == "event_msg" and pt == "token_count":
            info = p.get("info") if isinstance(p.get("info"), dict) else None
            if not info:
                continue
            snap = {"at": at, "total": _usage(info.get("total_token_usage")),
                    "last": _usage(info.get("last_token_usage"))}
            last_snapshot = snap
            if current:
                turn(current)["snapshots"].append(snap)
                turn(current)["lastRecordAt"] = at
        elif t == "response_item" and pt in ("function_call", "custom_tool_call") and current:
            cid = p.get("call_id") or p.get("id")
            if cid:
                turn(current)["toolCalls"].add(cid)
    return {"turns": turns, "order": order, "invalidLines": invalid}


def find_turn(parsed: Dict[str, Any], r: str) -> Optional[str]:
    for tid in parsed["order"]:
        if tid == r or ref(tid) == r or tid.startswith(r):
            return tid
    return None


def _sum_responses(responses: List[Dict[str, Any]]) -> Dict[str, Optional[int]]:
    out: Dict[str, Optional[int]] = {}
    for k in [k for k, _ in TOKEN_KEYS] + ["nativeTotal"]:
        vals = [r["usage"][k] for r in responses]
        known = [v for v in vals if v is not None]
        out[k] = sum(known) if known else None
        if known and len(known) != len(vals):
            out[k + "_partial"] = True  # type: ignore
    return out


def _derive(tok: Dict[str, Optional[int]]) -> Dict[str, Any]:
    i, o = tok.get("input"), tok.get("output")
    derived = i + o if i is not None and o is not None else None
    return {"input": tok.get("input"), "output": tok.get("output"), "cacheRead": tok.get("cacheRead"),
            "cacheWrite": tok.get("cacheWrite"), "reasoning": tok.get("reasoning"),
            "nativeTotal": tok.get("nativeTotal"), "derivedTotal": derived,
            "derivedTotalBasis": "input+output; cacheRead/cacheWrite are subsets of input (not added again)",
            "cacheConvention": "included_in_input"}


def _cache_ok(tok: Dict[str, Any]) -> bool:
    i = tok.get("input")
    if i is None:
        return True
    return (tok.get("cacheRead") or 0) + (tok.get("cacheWrite") or 0) <= i


def _diff(after: Dict[str, Optional[int]], before: Dict[str, Optional[int]]) -> Dict[str, Optional[int]]:
    out: Dict[str, Optional[int]] = {}
    for k in [k for k, _ in TOKEN_KEYS] + ["nativeTotal"]:
        a, b = after.get(k), before.get(k)
        out[k] = a - b if a is not None and b is not None and a >= b else None
    return out


def _add(a: Optional[int], b: Optional[int]) -> Optional[int]:
    return None if a is None or b is None else a + b


def _one_turn(tr: Dict[str, Any]) -> Dict[str, Any]:
    """Aggregate a single turn once: response records win; else monotonic cumulative snapshots."""
    keys = [k for k, _ in TOKEN_KEYS] + ["nativeTotal"]
    missing: List[str] = []
    partial = False
    if tr["responses"]:
        rs = list(tr["responses"].values())
        tok: Dict[str, Optional[int]] = {}
        for k in keys:
            vals = [r["usage"][k] for r in rs]
            known = [v for v in vals if v is not None]
            tok[k] = sum(known) if known else None
            if known and len(known) != len(vals):
                missing.append("native_total_partial" if k == "nativeTotal" else k + "_partial")
                if k != "nativeTotal":
                    partial = True
        return {"tok": tok, "steps": len(rs), "partial": partial, "missing": missing, "basis": "responses",
                "cross": all(rs[-1]["turnCumulative"].get(k) == tok.get(k) for k in ("input", "output", "cacheRead", "cacheWrite"))}
    if tr["snapshots"]:
        base = tr["baselineSnapshot"]
        prev = base["total"] if base is not None else None
        seq = [s["total"] for s in tr["snapshots"]]
        fp = lambda t: tuple(t.get(k) for k in keys)
        seen = {fp(prev)} if prev is not None else set()
        tok = {k: 0 for k in keys}
        steps = 0
        if prev is None:
            partial = True
            missing.append("baseline_snapshot_missing_before_turn")
            prev, seq = seq[0], seq[1:]  # first snapshot only seeds the counter: lower bound
            seen.add(fp(prev))
        for cur in seq:
            if cur == prev:
                continue  # adjacent duplicate / equal to baseline: not a new step
            if fp(cur) in seen:
                # identical value seen earlier (non-adjacent): never a new step; a step back is a regression
                partial = True
                if "counter_regression_or_reset" not in missing:
                    missing.append("counter_regression_or_reset")
                prev = cur
                continue
            seen.add(fp(cur))
            regress = any(cur.get(k) is not None and prev.get(k) is not None and cur[k] < prev[k] for k in keys)
            if regress:
                partial = True
                if "counter_regression_or_reset" not in missing:
                    missing.append("counter_regression_or_reset")
                prev = cur  # new baseline; the post-reset response is unaccounted
                continue
            d = _diff(cur, prev)
            for k in keys:
                tok[k] = _add(tok[k], d[k])
            steps += 1
            prev = cur
        return {"tok": tok, "steps": steps, "partial": partial, "missing": missing, "basis": "snapshots", "cross": None}
    return {"tok": {}, "steps": None, "partial": True, "missing": ["no_usage_records_in_turn"], "basis": "none", "cross": None}


def turn_scope(parsed: Dict[str, Any], tids: List[Optional[str]], name: str, now: Optional[float] = None,
               unresolved: int = 0) -> Dict[str, Any]:
    """Model steps / tool calls / tokens for the given native turns (never whole-session)."""
    keys = [k for k, _ in TOKEN_KEYS] + ["nativeTotal"]
    found = [t for t in dict.fromkeys(tids) if t and t in parsed["turns"]]
    unresolved += len(tids) - len([t for t in tids if t]) + len([t for t in tids if t and t not in parsed["turns"]])
    turns = [parsed["turns"][t] for t in found]
    missing: List[str] = ["turn_not_found"] if unresolved else []
    partial = bool(unresolved)
    pending = False
    tool_calls, dup = 0, 0
    tok: Dict[str, Optional[int]] = {k: None for k in keys}
    steps: Optional[int] = None
    ntot_ok = True
    ntot = 0
    bases = set()
    cross = None
    for tr in turns:
        tool_calls += len(tr["toolCalls"])
        dup += tr["duplicateResponses"]
        pending = pending or tr["completedAt"] is None
        o = _one_turn(tr)
        bases.add(o["basis"])
        partial = partial or o["partial"]
        missing += o["missing"]
        if o["basis"] == "none":
            # no usage in this turn: keep numbers observed elsewhere as lower bounds, never erase them
            partial = True
            ntot_ok = False  # a native total over a subset would be a silent undercount
            continue
        if o["steps"] is not None:
            steps = o["steps"] if steps is None else steps + o["steps"]
        for k in keys:
            v = o["tok"].get(k)
            if k == "nativeTotal":
                if v is None:
                    ntot_ok = False
                else:
                    ntot += v
            elif v is not None:
                tok[k] = v if tok[k] is None else tok[k] + v
        if len(turns) == 1:
            cross = {"turnCumulativeMatchesResponseSum": o["cross"]} if o["cross"] is not None else None
    tok["nativeTotal"] = ntot if ntot_ok and any(b != "none" for b in bases) else None
    if not turns:
        tok, steps = {}, None
    # a counter that no turn reported stays unknown rather than 0
    if turns and tok.get("nativeTotal") is None and tok.get("input") is not None:
        missing.append("native_total_absent")
    if "responses" in bases and "snapshots" in bases:
        basis = "mixed_response_ids_and_cumulative_snapshots_per_turn"
    elif "snapshots" in bases:
        basis = "distinct_changed_cumulative_token_count_snapshots"
    else:
        basis = "distinct_completed_model_response_ids_with_usage"
    ends = [tr["lastRecordAt"] for tr in turns if tr["lastRecordAt"]]
    walls = [tr["durationMs"] / 1000.0 for tr in turns if tr["durationMs"] is not None]
    starts = [tr["startedAt"] for tr in turns if tr["startedAt"]]
    cache_ok = _cache_ok(tok)
    return {
        "scope": name,
        "turnRefs": [ref(t) for t in found],
        "source": "native_transcript",
        "sourceAt": iso(max(ends)) if ends else None,
        "boundary": {"startedAt": iso(min(starts)) if starts else None,
                     "endedAt": iso(max(tr["completedAt"] for tr in turns)) if turns and all(tr["completedAt"] for tr in turns) else None,
                     "basis": "native_turn_boundaries"},
        "steps": {"completed": steps, "basis": basis, "toolCallsExcluded": True,
                  "coverage": "partial" if partial or pending else "complete_for_completed_responses",
                  "duplicateResponseRecordsIgnored": dup},
        "toolCalls": {"count": tool_calls, "basis": "distinct_call_ids", "separateFromSteps": True},
        "tokens": _derive(tok), "cacheConsistent": cache_ok,
        "coverage": {"complete": not partial and not pending and cache_ok, "missing": sorted(set(missing)),
                     "partial": partial or pending},
        "nativeTurnWallSeconds": round(sum(walls), 3) if len(walls) == len(turns) and walls else None,
        "nativeTurnWallIsExecution": False,
        "responsePending": {"pending": pending,
                            "note": "turn still open; usage of the in-flight model response is not recorded yet and is not included" if pending else None},
        "crossCheck": cross,
    }


# ---------------------------------------------------------------- executor invocations
def merge_intervals(items: List[Tuple[float, float]]) -> List[Tuple[float, float]]:
    out: List[List[float]] = []
    for s, e in sorted(i for i in items if i[1] >= i[0]):
        if out and s <= out[-1][1]:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(a, b) for a, b in out]


def invocation_interval(rec: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    s, f, dur = _ts(rec.get("started_at")), _ts(rec.get("finished_at")), rec.get("duration_seconds")
    if s is None:
        return None
    exact = isinstance(dur, (int, float)) and not isinstance(dur, bool) and dur >= 0
    if exact and (f is None or abs(s + dur - f) <= 2.0):
        e, b = s + dur, "runner_duration_seconds"
    elif f is not None and f >= s:
        e, b = f, "started_at_to_finished_at"
    else:
        return None
    return {"start": s, "end": e, "basis": b}


def dedup_invocations(records: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], int]:
    """One record per (session, round, start, finish): repeated telemetry rows must not double usage."""
    seen, out, dup = set(), [], 0
    for r in records:
        key = (ref(r.get("session")), r.get("round_index"), r.get("started_at"), r.get("finished_at"))
        if key in seen:
            dup += 1
            continue
        seen.add(key)
        out.append(r)
    return out, dup


def execution_block(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    ivs, ignored = [], 0
    for r in records:
        iv = invocation_interval(r)
        if iv is None:
            ignored += 1
            continue
        iv["rec"] = r
        ivs.append(iv)
    merged = merge_intervals([(i["start"], i["end"]) for i in ivs])
    secs = round(sum(e - s for s, e in merged), 6) if ivs else None
    raw = round(sum(i["end"] - i["start"] for i in ivs), 6) if ivs else None
    gaps = round(sum(merged[i + 1][0] - merged[i][1] for i in range(len(merged) - 1)), 6)
    fins = [i["end"] for i in ivs]
    return {"seconds": secs, "basis": "union_explicit_executor_invocation_intervals", "label": EXEC_LABEL,
            "scope": "observed_executor_invocations_only", "sourceAt": iso(max(fins)) if fins else None,
            "coverage": "partial_observed_invocations_not_full_task_execution",
            "invocationCount": len(ivs), "ignoredInvocationRecords": ignored,
            "sumOfIntervalSeconds": raw, "excludedGapSeconds": gaps,
            "includesWaitInsideInvocation": True, "nativeTurnWallIsExecution": False,
            "gap": None if ivs else "no_explicit_executor_invocation_interval",
            "recordGap": None,
            "intervals": [{"startedAt": iso(i["start"]), "endedAt": iso(i["end"]), "seconds": round(i["end"] - i["start"], 6),
                           "intervalBasis": i["basis"], "stage": i["rec"].get("round_index"),
                           "executor": i["rec"].get("executor"), "model": i["rec"].get("model"),
                           "effort": i["rec"].get("effort"), "sessionRef": ref(i["rec"].get("session")),
                           "status": i["rec"].get("status")} for i in ivs]}


def executor_scope(records: List[Dict[str, Any]], name: str = "executor_invocation") -> Dict[str, Any]:
    """Executor-reported cumulative summary usage. Steps stay unknown: a summary proves one summary only."""
    records, _ = dedup_invocations(records)
    tok: Dict[str, Optional[int]] = {k: None for k in ("input", "output", "cacheRead", "cacheWrite", "reasoning", "nativeTotal")}
    ends = []
    seen = 0
    for r in records:
        u = ((r.get("usage") or {}).get("tokens")) or {}
        mapping = {"input": "input", "output": "output", "cacheRead": "cached_read", "cacheWrite": "cache_write",
                   "reasoning": "reasoning", "nativeTotal": "total"}
        if not any(_int(u.get(v)) is not None for v in mapping.values()):
            continue
        seen += 1
        for k, v in mapping.items():
            x = _int(u.get(v))
            if x is not None:
                tok[k] = (tok[k] or 0) + x
        f = _ts(r.get("finished_at"))
        if f:
            ends.append(f)
    missing = ["steps_unknown_only_turn_summary_available"]
    if tok["nativeTotal"] is None and tok["input"] is not None:
        missing.append("native_total_absent")
    return {"scope": name, "turnRefs": [], "source": "executor_telemetry_turn_summary",
            "sourceAt": iso(max(ends)) if ends else None,
            "steps": {"completed": None, "basis": "unknown_summary_only", "toolCallsExcluded": True,
                      "coverage": "unknown", "duplicateResponseRecordsIgnored": 0},
            "toolCalls": {"count": None, "basis": "not_in_summary", "separateFromSteps": True},
            "tokens": _derive(tok), "cacheConsistent": _cache_ok(tok),
            "coverage": {"complete": False, "partial": True, "missing": missing, "summaryRecords": seen},
            "nativeTurnWallSeconds": None, "nativeTurnWallIsExecution": False,
            "responsePending": {"pending": False, "note": None}, "crossCheck": None}


# ---------------------------------------------------------------- top level
def build_task_usage(spec: Dict[str, Any], native_lines: Optional[Iterable[str]],
                     telemetry_records: List[Dict[str, Any]], now: Any = None) -> Dict[str, Any]:
    nowt = _ts(now) if now is not None else None
    if not spec.get("taskId") or not spec.get("phaseId"):
        return {"schema": SCHEMA, "ok": False, "error": "missing_task_or_phase_identity"}
    stage = spec.get("stage")
    sess = spec.get("executorSessionRef")
    bound = stage is not None and sess is not None
    recs: List[Dict[str, Any]] = []
    dups = 0
    if bound:  # explicit stable executor binding is mandatory; unbound telemetry is never attributed
        recs, dups = dedup_invocations([r for r in telemetry_records
                                        if r.get("round_index") == stage and (ref(r.get("session")) == sess)])
    ex = execution_block(recs)
    ex["duplicateInvocationRecordsIgnored"] = dups
    ex["recordGap"] = spec.get("executionGap")
    if not bound:
        ex["gap"] = "executor_binding_required_stage_and_executorSessionRef"
    parsed = parse_native(native_lines) if native_lines is not None else {"turns": {}, "order": [], "invalidLines": 0}
    scopes: Dict[str, Any] = {}
    if spec.get("phaseTurnRefs"):
        pt = [find_turn(parsed, r) for r in spec["phaseTurnRefs"]]
        scopes["plannerTurn"] = turn_scope(parsed, pt, "planner_phase_turn", nowt)
    cur = find_turn(parsed, spec["currentTurnRef"]) if spec.get("currentTurnRef") else None
    if spec.get("currentTurnRef"):
        scopes["currentTurn"] = turn_scope(parsed, [cur], "current_open_turn", nowt)
    if spec.get("taskTurnRefs"):
        task_t = [find_turn(parsed, r) for r in spec["taskTurnRefs"]]
    else:
        task_t = list(parsed["order"]) if spec.get("taskTurnsAll") else []
    if task_t:
        scopes["taskCumulative"] = turn_scope(parsed, task_t, "task_cumulative", nowt)
        allr = [r for t in task_t if t for r in parsed["turns"][t]["responses"].values()]
        if allr and spec.get("taskTurnsAll"):
            tk = scopes["taskCumulative"]["tokens"]
            lastc = allr[-1]["threadCumulative"]
            scopes["taskCumulative"]["crossCheck"] = {"threadCumulativeMatchesResponseSum":
                all(lastc.get(k) == tk.get(k) for k in ("input", "output", "cacheRead", "cacheWrite"))}
    if recs:
        scopes["executorInvocation"] = executor_scope(recs)
    pt_scope = scopes.get("plannerTurn")
    if pt_scope and pt_scope["boundary"]["endedAt"] and pt_scope["boundary"]["startedAt"]:
        ps, pe, wb = _ts(pt_scope["boundary"]["startedAt"]), _ts(pt_scope["boundary"]["endedAt"]), "planner_turn_native_boundaries_includes_approval_and_idle"
    else:
        ps, pe = _ts((spec.get("phase") or {}).get("startedAt")), _ts((spec.get("phase") or {}).get("endedAt"))
        wb = "explicit_phase_boundary_wall_clock_includes_approval_and_idle"
    wall = {"seconds": round(pe - ps, 3) if ps is not None and pe is not None and pe >= ps else None,
            "basis": wb, "scope": "planner_turn" if pt_scope else "phase", "startedAt": iso(ps), "endedAt": iso(pe)}
    primary = scopes.get(spec.get("primaryScope", "taskCumulative")) or next(iter(scopes.values()), None)
    src = [s["sourceAt"] for s in scopes.values() if s.get("sourceAt")]
    src_at = max(src) if src else None
    primary_name = spec.get("primaryScope", "taskCumulative")
    return {"schema": SCHEMA, "ok": True, "error": None, "taskId": spec["taskId"], "phaseId": spec["phaseId"],
            "stage": stage, "executorSessionRef": sess, "sourceAt": src_at,
            "evaluatedAt": iso(nowt), "execution": ex, "wall": wall, "scopes": scopes, "primaryScope": primary_name,
            "result": spec.get("result"), "invalidNativeLines": parsed["invalidLines"],
            "privacy": "metadata_only; ids are sha256 refs; no message/reasoning/tool bodies"}


def _tok(t: Dict[str, Any]) -> Dict[str, Any]:
    return {"input": t["input"], "output": t["output"], "cacheRead": t["cacheRead"], "cacheWrite": t["cacheWrite"],
            "nativeTotal": t["nativeTotal"], "derivedTotal": t["derivedTotal"], "cacheConvention": "included_in_input"}


def to_investment(tu: Dict[str, Any]) -> Dict[str, Any]:
    """Stable ``investment.taskUsage``: model usage (native transcript scope) and executor observation are separate blocks."""
    if not tu or not tu.get("ok"):
        return {"schema": SCHEMA, "available": False}
    scopes = tu.get("scopes") or {}
    ps = scopes.get(tu.get("primaryScope"))
    ex, exs = tu["execution"], scopes.get("executorInvocation")
    out: Dict[str, Any] = {"schema": SCHEMA, "available": True, "taskId": tu["taskId"], "phaseId": tu["phaseId"],
                           "sourceAt": tu["sourceAt"], "model": None, "executor": None,
                           "wall": ({"seconds": tu["wall"]["seconds"], "scope": tu["wall"]["scope"], "basis": tu["wall"]["basis"]}
                            if tu["wall"]["scope"] != "planner_turn" or tu.get("primaryScope") == "plannerTurn" else None),
                           "result": tu.get("result")}
    if ps:
        out["model"] = {"scope": ps["scope"], "boundary": ps["boundary"], "sourceAt": ps["sourceAt"],
                        "steps": {"completed": ps["steps"]["completed"], "basis": ps["steps"]["basis"], "coverage": ps["steps"]["coverage"]},
                        "toolCalls": ps["toolCalls"]["count"], "tokens": _tok(ps["tokens"]),
                        "coverage": "complete" if ps["coverage"]["complete"] else "partial", "missing": ps["coverage"]["missing"],
                        "responsePending": ps["responsePending"]["pending"]}
    out["executor"] = {"scope": ex["scope"], "label": ex["label"], "sourceAt": ex["sourceAt"], "coverage": ex["coverage"],
                       "executionSeconds": ex["seconds"], "invocationCount": ex["invocationCount"],
                       "excludedGapSeconds": ex["excludedGapSeconds"], "gap": ex.get("gap") or ex.get("recordGap"),
                       "steps": {"completed": None, "gap": "turn_summary_only_no_per_request_records"},
                       "tokens": _tok(exs["tokens"]) if exs else None,
                       "tokensSourceAt": exs["sourceAt"] if exs else None,
                       "tokensMissing": exs["coverage"]["missing"] if exs else []}
    return out


def load_jsonl(path: str) -> List[Dict[str, Any]]:
    out = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            try:
                d = json.loads(line)
            except ValueError:
                continue
            if isinstance(d, dict):
                out.append(d)
    return out


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--spec", required=True)
    ap.add_argument("--native", help="native transcript or sanitized extract (jsonl)")
    ap.add_argument("--telemetry", help="executor-telemetry.jsonl")
    ap.add_argument("--now")
    a = ap.parse_args(argv)
    with open(a.spec, encoding="utf-8") as fh:
        spec = json.load(fh)
    recs = load_jsonl(a.telemetry) if a.telemetry else []
    if a.native:
        with open(a.native, encoding="utf-8") as fh:
            out = build_task_usage(spec, fh, recs, a.now)
    else:
        out = build_task_usage(spec, None, recs, a.now)
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if out.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
