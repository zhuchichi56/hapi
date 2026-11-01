"""Read-only client for the existing native-desktop Unix HTTP bridge.

The bridge is the only external input used by this backend. It is read with
``POST /command {app:codex, op:read, id:threadId, limit:2}``. Nothing from the
native response is persisted except a bounded assistant progress line, generic
turn/tool states, the turn id, revision and observation time. User, tool,
output and reasoning text are deliberately discarded before storage.
"""

import http.client
import json
import socket

from .constants import (BRIDGE_READ_LIMIT, BRIDGE_SOCKET, BRIDGE_TIMEOUT_SECONDS,
                        PROGRESS_LIMIT)
from .errors import BridgeError
from .util import clamp_text


class UnixHTTPConnection(http.client.HTTPConnection):
    def __init__(self, socket_path, timeout=BRIDGE_TIMEOUT_SECONDS):
        super().__init__("localhost", timeout=timeout)
        self.socket_path = socket_path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self.socket_path)
        except Exception:
            sock.close()
            raise
        self.sock = sock


def _short(value, limit=80):
    if value is None:
        return None
    return clamp_text(value, limit)


def post_command(command, socket_path=BRIDGE_SOCKET, timeout=BRIDGE_TIMEOUT_SECONDS):
    """POST one command and return its HTTP status plus decoded JSON.

    Unlike :func:`read_thread`, an HTTP 502 body is returned so the archive
    caller can inspect the bridge's ``delivery`` classification. Transport
    failures are tagged: connect failures are ``not-sent`` (safe to retry),
    anything after dispatch is ``unknown`` (never blindly repeat).
    """
    connection = UnixHTTPConnection(socket_path, timeout=timeout)
    try:
        try:
            connection.connect()
        except OSError as exc:
            raise BridgeError(
                "bridge connect failed: %s" % exc.__class__.__name__,
                delivery="not-sent",
            )
        body = json.dumps(command).encode("utf-8")
        try:
            connection.request(
                "POST",
                "/command",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                },
            )
            response = connection.getresponse()
            raw = response.read(2 * 1024 * 1024)
        except (OSError, socket.timeout, http.client.HTTPException) as exc:
            raise BridgeError(
                "bridge request outcome unknown: %s" % exc.__class__.__name__,
                delivery="unknown",
            )
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise BridgeError("bridge returned non-JSON content", delivery="unknown")
        if not isinstance(payload, dict):
            raise BridgeError("bridge returned a non-object payload", delivery="unknown")
        return response.status, payload
    finally:
        connection.close()


def read_thread(thread_id, socket_path=BRIDGE_SOCKET, timeout=BRIDGE_TIMEOUT_SECONDS):
    """Fetch the last two turns for one registered native chat (read only)."""
    if not isinstance(thread_id, str) or not thread_id.strip():
        raise BridgeError("thread id is required")
    connection = UnixHTTPConnection(socket_path, timeout=timeout)
    body = json.dumps(
        {
            "app": "codex",
            "op": "read",
            "id": thread_id,
            "limit": BRIDGE_READ_LIMIT,
        }
    ).encode("utf-8")
    try:
        connection.request(
            "POST",
            "/command",
            body=body,
            headers={"Content-Type": "application/json", "Accept": "application/json"},
        )
        response = connection.getresponse()
        raw = response.read(2 * 1024 * 1024)
        if response.status != 200:
            raise BridgeError("bridge returned HTTP %s" % response.status)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise BridgeError("bridge returned non-JSON content")
        return payload
    except BridgeError:
        raise
    except (OSError, socket.timeout, http.client.HTTPException) as exc:
        raise BridgeError("bridge transport failed: %s" % exc.__class__.__name__)
    finally:
        connection.close()


def sanitize_read_response(payload, thread_id):
    """Reduce a raw bridge payload to a safe observation record.

    The returned dict is the only shape the ledger ever persists. It has no
    item text other than the latest assistant commentary/final line.
    """
    if not isinstance(payload, dict) or payload.get("ok") is not True:
        raise BridgeError("bridge response ok!=true")
    result = payload.get("result")
    if not isinstance(result, dict):
        raise BridgeError("bridge response has no result object")
    if result.get("id") != thread_id:
        raise BridgeError("bridge response thread id mismatch")

    turns = result.get("turns")
    latest = None
    if isinstance(turns, list) and turns and isinstance(turns[-1], dict):
        latest = turns[-1]

    turn_id = None
    turn_status = None
    assistant_text = ""
    assistant_phase = None
    latest_action = None

    if latest is not None:
        turn_id = _short(latest.get("id"), 80)
        turn_status = _short(latest.get("status"), 40)
        items = latest.get("items")
        if isinstance(items, list):
            for item in reversed(items):
                if not isinstance(item, dict):
                    continue
                role = item.get("role")
                phase = item.get("phase")
                # The installed native App labels its final messages this way.
                if phase == "final_answer":
                    phase = "final"
                if (
                    role == "assistant"
                    and phase in ("commentary", "final")
                    and not assistant_text
                ):
                    text = item.get("text")
                    if isinstance(text, str) and text.strip():
                        assistant_text = clamp_text(text.strip(), PROGRESS_LIMIT)
                        assistant_phase = phase
                if latest_action is None:
                    if role == "tool":
                        # Generic status only; tool text may contain secrets.
                        status = _short(item.get("status"), 40) or "unknown"
                        latest_action = "tool:%s" % status
                    elif role == "assistant" and phase in ("commentary", "final"):
                        latest_action = "assistant:%s" % phase

    return {
        "threadId": thread_id,
        "live": result.get("live") is True,
        "status": _short(result.get("status"), 40),
        "revision": _short(result.get("revision"), 120),
        "turnId": turn_id,
        "turnStatus": turn_status,
        "assistantText": assistant_text,
        "assistantPhase": assistant_phase,
        "latestAction": latest_action,
    }


def observe_thread(thread_id, socket_path=BRIDGE_SOCKET, timeout=BRIDGE_TIMEOUT_SECONDS):
    """Read + sanitize one chat. Returns only the safe observation dict."""
    return sanitize_read_response(read_thread(thread_id, socket_path, timeout), thread_id)
