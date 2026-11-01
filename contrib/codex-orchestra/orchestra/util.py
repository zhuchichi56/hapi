"""Small stdlib-only helpers shared by the ledger, daemon, and CLI."""

import json
import os
from datetime import datetime, timezone

from .errors import ValidationError

ISO_FORMAT = "%Y-%m-%dT%H:%M:%S.%f%z"


def now_iso():
    """Return a timezone-aware UTC timestamp with microsecond precision."""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def parse_iso(value, field="timestamp"):
    """Parse an ISO-8601 timestamp, accepting a trailing Z."""
    if not isinstance(value, str) or not value.strip():
        raise ValidationError("%s must be a non-empty ISO-8601 string" % field)
    text = value.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        raise ValidationError("%s is not a valid ISO-8601 timestamp" % field)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_iso(value, field="timestamp"):
    return parse_iso(value, field).isoformat(timespec="microseconds")


def age_seconds(value, now=None):
    """Age of a timestamp in seconds; negative clock skew clamps to zero."""
    if value is None:
        return None
    current = now or datetime.now(timezone.utc)
    return max(0.0, (current - parse_iso(value)).total_seconds())


def clamp_text(value, limit=1200):
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) <= limit:
        return text
    if limit <= 1:
        return text[:limit]
    return text[: limit - 1] + "…"


def ensure_state_dir(path):
    if not isinstance(path, str) or not path.strip():
        raise ValidationError("--state must be a non-empty directory path")
    absolute = os.path.abspath(os.path.expanduser(path))
    os.makedirs(absolute, mode=0o700, exist_ok=True)
    os.chmod(absolute, 0o700)
    return absolute


def chmod_private(path):
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def atomic_write(path, text, mode=0o600):
    """Write an explicit output path atomically, never through a shared source."""
    absolute = os.path.abspath(os.path.expanduser(path))
    parent = os.path.dirname(absolute) or "."
    if not os.path.isdir(parent):
        raise ValidationError("output directory does not exist: %s" % parent)
    tmp = "%s.tmp-%d" % (absolute, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        chmod_private(tmp)
        os.replace(tmp, absolute)
    finally:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
    return absolute


def read_json_file(path):
    try:
        with open(os.path.abspath(os.path.expanduser(path)), "r", encoding="utf-8") as handle:
            return json.load(handle)
    except OSError as exc:
        raise ValidationError("cannot read JSON file %s: %s" % (path, exc.__class__.__name__))
    except ValueError:
        raise ValidationError("file is not valid JSON: %s" % path)
