"""Attach the precomputed T021 executor daily artifact to a snapshot payload.

Read-only: one bounded JSON read of the canonical file per call, no raw-log
parsing, no arithmetic, no writes, no fallback sample. The source path and
file body are never disclosed in error output.
"""

import json
import math
import os
from datetime import datetime, timezone

CANONICAL_DAILY_PATH = (
    "/Users/zhuhe/Documents/Codex/2026-11-02/orchestra-system-metrics/"
    "outputs/executor-metrics/daily.json"
)
SCHEMA_VERSION = "1.0"
MAX_BYTES = 2 * 1024 * 1024
SNAPSHOT_LIMIT = 512 * 1024  # HAPI hub SNAPSHOT_LIMIT; same utf-8 JSON measure as server._send_json
UNAVAILABLE = {"available": False, "data": None, "error": "executor_daily_unavailable"}
TOO_LARGE = {"available": False, "data": None, "error": "executor_daily_too_large"}


def _reject(_name):
    raise ValueError("nonfinite")


def _finite(text):
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("nonfinite")
    return value


def _time(value):
    if not isinstance(value, str):
        raise ValueError("time")
    parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("time zone")


def _check(data):
    if (not isinstance(data, dict) or data.get("schemaVersion") != SCHEMA_VERSION
            or data.get("timezone") != "Asia/Shanghai"):
        raise ValueError("invalid daily")
    if not isinstance(data.get("coverage"), dict) or not isinstance(data.get("current"), dict):
        raise ValueError("coverage/current")
    _time(data.get("generatedAt"))
    _time(data["current"].get("asOf"))
    days = data.get("days")
    if not isinstance(days, list):
        raise ValueError("days")
    for day in days:
        if not isinstance(day, dict) or not isinstance(day.get("date"), str) \
                or not isinstance(day.get("groups"), list) \
                or not all(isinstance(g, dict) for g in day["groups"]):
            raise ValueError("day")


def read_executor_daily(path=CANONICAL_DAILY_PATH):
    """Return (daily dict, mtime); raises on any problem. Read is bounded."""
    with open(path, "rb") as handle:
        raw = handle.read(MAX_BYTES + 1)
        mtime = os.fstat(handle.fileno()).st_mtime
    if len(raw) > MAX_BYTES:
        raise ValueError("too large")
    data = json.loads(raw.decode("utf-8"), parse_constant=_reject, parse_float=_finite)
    _check(data)
    return data, mtime


def executor_daily_block(path=CANONICAL_DAILY_PATH):
    try:
        data, mtime = read_executor_daily(path)
    except Exception:
        return dict(UNAVAILABLE)
    modified = datetime.fromtimestamp(mtime, timezone.utc).isoformat().replace("+00:00", "Z")
    # data is the producer object verbatim (generatedAt/asOf/stuck untouched).
    # fileModifiedAt is informational only and implies no stuck/failed state.
    return {"available": True, "data": data, "error": None, "fileModifiedAt": modified}


def attach_executor_daily(payload, path=CANONICAL_DAILY_PATH):
    """Return a shallow copy with a new top-level executorDaily key only.

    If embedding would push the snapshot past the host limit, only executorDaily
    degrades; all existing keys are kept.
    """
    block = executor_daily_block(path)
    out = {**payload, "executorDaily": block}
    if block["available"]:
        try:
            size = len(json.dumps(out, ensure_ascii=False).encode("utf-8"))
        except Exception:
            size = SNAPSHOT_LIMIT + 1
        if size > SNAPSHOT_LIMIT:
            out["executorDaily"] = dict(TOO_LARGE)
    return out
