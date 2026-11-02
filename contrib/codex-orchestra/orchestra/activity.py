"""Read-only activity projection. No native calls, persistence or status inference."""

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

SHANGHAI = ZoneInfo("Asia/Shanghai")
WIRE_LIMIT = 128 * 1024


def _time(value):
    """Accept epoch seconds/milliseconds or timezone-aware ISO; reject ambiguity."""
    try:
        if isinstance(value, bool):
            return None
        if isinstance(value, datetime):
            parsed = value
        else:
            if isinstance(value, str):
                value = value.strip()
                try:
                    value = float(value)
                except ValueError:
                    pass
            if isinstance(value, (int, float)):
                if not math.isfinite(value):
                    return None
                seconds = value / 1000 if abs(value) >= 100_000_000_000 else value
                parsed = datetime.fromtimestamp(seconds, timezone.utc)
            elif isinstance(value, str):
                parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            else:
                return None
        if parsed.tzinfo is None or parsed.utcoffset() is None:
            return None
        return parsed.astimezone(SHANGHAI)
    except (ValueError, TypeError, OverflowError, OSError):
        return None


def _text(value, limit):
    return value.strip() if isinstance(value, str) and 0 < len(value.strip()) <= limit else None


def _payload(raw):
    try:
        value = json.loads(raw)
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def _event(kind, task_id, title, thread_id):
    # Stable, opaque IDs avoid exposing operation IDs or raw evidence on the wire.
    identity = [kind, task_id, thread_id] if kind == "dispatch" else [kind, task_id]
    digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False).encode()).hexdigest()[:24]
    return {"taskId": task_id, "title": (title if isinstance(title, str) else "")[:160],
            "threadId": thread_id, "eventId": kind + ":" + digest}


def activity_snapshot(ledger, catalog=None, now=None):
    """Project 84 Beijing calendar days using the backend's existing connection.

    Only SELECTs occur here; the existing ledger connection factory remains owned
    by the backend. Call after its normal initialization, with no live DB probing.
    Completion coverage is always partial: an attestation proves a positive only.
    """
    current = _time(datetime.now(timezone.utc) if now is None else now)
    if current is None:
        return {"available": False, "error": "activity_invalid_time"}
    today = current.date()
    start = today - timedelta(days=83)
    connection = None
    read_failed = False
    try:
        connection = ledger._connect()
        connection.execute("BEGIN")  # consistent short, deferred read transaction
        operation_dates = connection.execute("SELECT created_at, updated_at FROM operations").fetchall()
        rows = connection.execute("""
            SELECT o.op_id, o.task_id, o.kind, o.status, o.payload,
                   o.created_at, o.updated_at, t.title, t.thread_id
            FROM operations AS o LEFT JOIN tasks AS t ON t.id=o.task_id
            WHERE (o.kind='dispatch_intent' AND o.status='reconciled')
               OR (o.kind='review' AND o.status='recorded')
        """).fetchall()
    except Exception:
        # Never surface exception strings: they may contain private paths/data.
        read_failed = True
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                read_failed = True
    if read_failed:
        return {"available": False, "error": "activity_unavailable"}

    valid_dates = [stamp.date() for row in operation_dates for raw in row
                   for stamp in [_time(raw)] if stamp is not None and stamp <= current]
    dispatch_from = min(valid_dates) if valid_dates else None
    days = [{"date": (start + timedelta(days=index)).isoformat(),
             "recorded": dispatch_from is not None and start + timedelta(days=index) >= dispatch_from,
             "dispatches": [], "completions": []} for index in range(84)]
    by_date = {day["date"]: day for day in days}
    attestations = set()
    raw_attestations = catalog.get("goalCompletions", []) if isinstance(catalog, dict) else []
    if isinstance(raw_attestations, list):
        for item in raw_attestations:
            if not isinstance(item, dict) or item.get("goalSatisfied") is not True:
                continue
            task_id = _text(item.get("taskId"), 128)
            review_id = _text(item.get("reviewOpId"), 256)
            evidence = item.get("evidence")
            # Use the same nonempty textual evidence convention as ledger.review.
            if task_id and review_id and isinstance(evidence, str) and evidence.strip():
                attestations.add((task_id, review_id))

    dispatches, completions = {}, {}
    for row in rows:
        task_id = _text(row["task_id"], 128)
        if task_id is None or row["title"] is None:
            continue  # orphan operations cannot identify an existing task
        payload = _payload(row["payload"])
        is_dispatch = row["kind"] == "dispatch_intent"
        stamp = _time(row["updated_at"] if is_dispatch else row["created_at"])
        if stamp is None or stamp > current:
            continue
        if is_dispatch:
            thread_id = _text(payload.get("threadId"), 256)
            if thread_id is None:
                continue
            key, target, kind = (task_id, thread_id), dispatches, "dispatch"
        else:
            if payload.get("result") != "accepted" or (task_id, row["op_id"]) not in attestations:
                continue
            thread_id = _text(row["thread_id"], 256)
            key, target, kind = task_id, completions, "completion"
        candidate = {"at": stamp, "event": _event(kind, task_id, row["title"], thread_id),
                     "sourceOpIds": [row["op_id"]]}
        previous = target.get(key)
        if previous is None:
            target[key] = candidate
        elif stamp < previous["at"]:
            candidate["sourceOpIds"] += previous["sourceOpIds"]
            target[key] = candidate
        else:
            previous["sourceOpIds"].append(row["op_id"])

    # Deduplicate across ALL history before filtering the visible window.
    for target, field in ((dispatches, "dispatches"), (completions, "completions")):
        for candidate in sorted(target.values(), key=lambda c: (c["at"], c["event"]["eventId"])):
            date = candidate["at"].date().isoformat()
            if date in by_date:
                by_date[date][field].append(candidate["event"])
    result = {"asOf": current.isoformat(timespec="seconds"), "today": today.isoformat(),
              "from": start.isoformat(), "to": today.isoformat(),
              "coverage": {"dispatchFrom": dispatch_from.isoformat() if dispatch_from else None,
                           "completion": "explicit-attestations-only"}, "days": days}
    if len(json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()) > WIRE_LIMIT:
        return {"available": False, "error": "activity_too_large"}
    return result


def attach_activity(snapshot, ledger, catalog=None, now=None):
    """Optional owner-only snapshot composition; leaves original tasks untouched."""
    return {**snapshot, "activity": activity_snapshot(ledger, catalog=catalog, now=now)}
