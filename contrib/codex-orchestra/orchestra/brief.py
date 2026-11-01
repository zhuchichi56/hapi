"""Explicit controller-written brief, separate from native observation."""

import json
from datetime import datetime

from .errors import NotFoundError, ValidationError
from .util import now_iso, parse_iso


def write_brief(ledger, task_id, brief, as_of=None):
    if ledger.get_task(task_id) is None:
        raise NotFoundError("unknown task: %s" % task_id)
    if not isinstance(brief, str) or not brief.strip() or len(brief.strip()) > 500:
        raise ValidationError("brief must contain 1 to 500 characters")
    if len(brief.strip().splitlines()) > 2:
        raise ValidationError("brief must use at most two lines")
    timestamp = as_of or now_iso()
    if not isinstance(timestamp, str):
        raise ValidationError("asOf must be an ISO timestamp with timezone")
    try:
        explicit = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except ValueError:
        raise ValidationError("asOf must be an ISO timestamp with timezone")
    if explicit.tzinfo is None:
        raise ValidationError("asOf must include timezone")
    parsed = parse_iso(timestamp)
    if parsed is None or parsed.tzinfo is None:
        raise ValidationError("asOf must be an ISO timestamp with timezone")
    value = {"brief": brief.strip(), "asOf": timestamp,
             "source": "controller-written", "updatedAt": now_iso()}
    ledger.set_meta("task_brief:" + task_id, json.dumps(value, ensure_ascii=False))
    return {"taskId": task_id, **value, "nativeProgressChanged": False}


def read_brief(ledger, task_id):
    raw = ledger.get_meta("task_brief:" + task_id)
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(value, dict) or not isinstance(value.get("brief"), str) or not isinstance(value.get("asOf"), str):
        return None
    return value
