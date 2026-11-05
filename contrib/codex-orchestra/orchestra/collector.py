"""Bounded, non-blocking observation collector for registered chats."""

import hashlib
import json
import sys
import threading
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, as_completed, wait

from .bridge import observe_thread, read_thread, sanitize_read_response
from .constants import (BRIDGE_SOCKET, BRIDGE_TIMEOUT_SECONDS, POLL_INTERVAL_SECONDS,
                        WORKER_COUNT)
from .errors import OrchestraError
from .util import now_iso


def native_progress_key(task_id, session_id=None):
    identity = json.dumps([task_id, session_id], separators=(",", ":"))
    return "native_progress_v1:" + hashlib.sha256(identity.encode()).hexdigest()


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def _observe_progress(thread_id, socket_path, timeout):
    """Use the collector's single read; discard raw text after hashing it.

    Native revision covers the entire view, including duration/metadata. Only
    current-turn item identities, states and text extent/content date activity.
    No native event timestamps exist in this response shape.
    """
    payload = read_thread(thread_id, socket_path, timeout)
    observation = sanitize_read_response(payload, thread_id)
    observation["_activityCursor"] = None
    turns = payload["result"].get("turns")
    latest = turns[-1] if isinstance(turns, list) and turns else None
    if isinstance(latest, dict) and isinstance(latest.get("items"), list):
        items = []
        for item in latest["items"]:
            if not isinstance(item, dict):
                continue
            text = item.get("text")
            text = text.strip() if isinstance(text, str) else ""
            items.append([item.get("id"), item.get("role"), item.get("status"),
                          item.get("phase"), item.get("outputLength"), len(text), _digest(text)])
        observation["_activityCursor"] = _digest([latest.get("status"), items])
    return observation


class Collector:
    """Polls each task independently with a bounded per-task worker pool.

    A slow native read occupies one worker only; completed futures are applied
    immediately and CLI writes continue in their own short SQLite transactions.
    """

    def __init__(
        self,
        ledger,
        bridge_fn=observe_thread,
        socket_path=BRIDGE_SOCKET,
        interval=POLL_INTERVAL_SECONDS,
        workers=WORKER_COUNT,
        timeout=BRIDGE_TIMEOUT_SECONDS,
    ):
        self.ledger = ledger
        # Preserve injected observers and their call contract; no second read.
        self.bridge_fn = _observe_progress if bridge_fn is observe_thread else bridge_fn
        self.socket_path = socket_path
        self.interval = max(0.05, float(interval))
        self.workers = max(1, int(workers))
        self.timeout = timeout
        self._executor = ThreadPoolExecutor(
            max_workers=self.workers, thread_name_prefix="orchestra-observer"
        )
        self._inflight = {}
        self._inflight_ids = set()
        self._due = {}
        self._next_scan = 0.0
        self._last_inflight = -1
        self._closed = False

    @staticmethod
    def _item_key(task):
        return "%s|%s" % (task["id"], task.get("session_id", ""))

    def _run_one(self, task):
        # Capture observation start before the read. If two reads race, the one
        # that started later wins; an earlier slow callback is rejected.
        started_at = now_iso()
        try:
            observation = self.bridge_fn(
                task["thread_id"], self.socket_path, self.timeout
            )
            return {
                "taskId": task["id"],
                "sessionId": task.get("session_id"),
                "startedAt": started_at,
                "observation": observation,
                "error": None,
            }
        except Exception as exc:  # bridge errors are recorded, not raised
            return {
                "taskId": task["id"],
                "sessionId": task.get("session_id"),
                "startedAt": started_at,
                "observation": None,
                "error": "%s: %s" % (exc.__class__.__name__, exc),
            }

    def _apply(self, result):
        try:
            if result["error"] is not None:
                if result.get("sessionId") is not None:
                    return {"applied": False, "reason": "session_error"}
                return self.ledger.record_observation_error(
                    result["taskId"], result["error"], result["startedAt"]
                )
            if result.get("sessionId") is not None:
                outcome = self.ledger.apply_session_observation(
                    result["taskId"],
                    result["sessionId"],
                    result["observation"],
                    result["startedAt"],
                )
            else:
                outcome = self.ledger.apply_observation(
                    result["taskId"], result["observation"], result["startedAt"]
                )
            if outcome.get("applied"):
                self._record_progress(result)
            return outcome
        except Exception as exc:  # a single bad task must not kill the daemon
            self.ledger.set_meta(
                "collector_error",
                "apply failed for %s: %s" % (result["taskId"], exc.__class__.__name__),
            )
            print(
                "orchestra: apply failed for %s: %s"
                % (result["taskId"], exc.__class__.__name__),
                file=sys.stderr,
            )
            return {"applied": False, "reason": "apply_error"}

    def _record_progress(self, result):
        """First sight is UNKNOWN; only a same-turn semantic delta dates progress.

        One bounded record per task/session survives restarts. The ledger has
        already rejected outdated callbacks before this runs. Raw native text,
        polling timestamps and view revisions are never stored here.
        """
        observation = result["observation"]
        thread_id = observation.get("threadId")
        turn_id = observation.get("turnId")
        if not isinstance(thread_id, str) or not isinstance(turn_id, str):
            thread_id = turn_id = None
        elif not (0 < len(thread_id) <= 128 and 0 < len(turn_id) <= 128):
            thread_id = turn_id = None
        cursor_kind = "items-v1" if "_activityCursor" in observation else "sanitized-v1"
        cursor = observation.get("_activityCursor")
        if not (isinstance(cursor, str) and len(cursor) == 64
                and all(c in "0123456789abcdef" for c in cursor)):
            # Older/injected sanitized observers can still report real content
            # or generic tool/status changes, but revision alone cannot help.
            semantic = [observation.get(k) for k in
                        ("assistantText", "assistantPhase", "latestAction", "turnStatus")]
            cursor = (_digest(semantic)
                      if cursor_kind == "sanitized-v1" and any(semantic) else None)
        key = native_progress_key(result["taskId"], result.get("sessionId"))
        try:
            previous = json.loads(self.ledger.get_meta(key) or "null")
        except (ValueError, TypeError):
            previous = None
        previous = previous if isinstance(previous, dict) and previous.get("version") == 1 else {}
        same_turn = (thread_id is not None and turn_id is not None
                     and previous.get("threadId") == thread_id
                     and previous.get("turnId") == turn_id)
        progress_at = None
        previous_cursor = previous.get("cursor")
        if (same_turn and cursor_kind == previous.get("cursorKind")
                and cursor and isinstance(previous_cursor, str)
                and len(previous_cursor) == 64
                and all(c in "0123456789abcdef" for c in previous_cursor)):
            progress_at = (now_iso() if cursor != previous_cursor
                           else previous.get("progressAt"))
        record = dict(version=1, threadId=thread_id, turnId=turn_id,
                      cursor=cursor, cursorKind=cursor_kind, progressAt=progress_at)
        if record != previous:
            self.ledger.set_meta(key, json.dumps(record, separators=(",", ":")))

    def _submit_available(self):
        try:
            tasks = self.ledger.pollable_items()
        except Exception as exc:
            self.ledger.set_meta("collector_error", "poll query failed: %s" % exc.__class__.__name__)
            return 0
        submitted = 0
        monotonic_now = time.monotonic()
        for task in tasks:
            if len(self._inflight) >= self.workers:
                break
            key = self._item_key(task)
            if key in self._inflight_ids:
                continue
            if self._due.get(key, 0.0) > monotonic_now:
                continue
            future = self._executor.submit(self._run_one, task)
            self._inflight[future] = task
            self._inflight_ids.add(key)
            # Keep a submission-to-submission cadence. In-flight identity
            # tracking prevents overlapping reads even if a read runs late.
            self._due[key] = monotonic_now + self.interval
            submitted += 1
        self.ledger.set_meta("inflight", len(self._inflight))
        self._last_inflight = len(self._inflight)
        # Discover new items on the existing scan cadence, but do not sleep
        # past an already-known item's due time when a worker is available.
        scan_deadline = monotonic_now + max(0.25, self.interval / 5.0)
        next_due = min(
            (self._due.get(self._item_key(task), monotonic_now)
             for task in tasks if self._item_key(task) not in self._inflight_ids),
            default=scan_deadline,
        )
        self._next_scan = min(scan_deadline, next_due)
        return submitted

    def _drain(self, timeout):
        if not self._inflight:
            return 0
        done, _ = wait(
            list(self._inflight.keys()),
            timeout=timeout,
            return_when=FIRST_COMPLETED,
        )
        applied = 0
        for future in done:
            task = self._inflight.pop(future)
            key = self._item_key(task)
            self._inflight_ids.discard(key)
            try:
                result = future.result()
            except Exception as exc:
                result = {
                    "taskId": task["id"],
                    "sessionId": task.get("session_id"),
                    "startedAt": now_iso(),
                    "observation": None,
                    "error": "future failed: %s" % exc.__class__.__name__,
                }
            self._apply(result)
            self._next_scan = 0.0
            applied += 1
        if applied and len(self._inflight) != self._last_inflight:
            self.ledger.set_meta("inflight", len(self._inflight))
            self._last_inflight = len(self._inflight)
        return applied

    def tick(self):
        """Run one scheduling slice; returns number of finished observations."""
        self._submit_available()
        return self._drain(0.0)

    def run(self, stop_event=None):
        stop_event = stop_event or threading.Event()
        started_at = now_iso()
        pid = __import__("os").getpid()
        self.ledger.set_meta("daemon_pid", pid)
        self.ledger.set_meta("daemon_started_at", started_at)
        self.ledger.set_meta("worker_count", self.workers)
        self.ledger.set_meta("poll_interval_seconds", self.interval)
        self.ledger.set_meta("bridge_socket", self.socket_path)
        self.ledger.set_meta("collector_error", "")
        next_heartbeat = 0.0
        try:
            while not stop_event.is_set():
                monotonic_now = time.monotonic()
                if len(self._inflight) < self.workers and monotonic_now >= self._next_scan:
                    self._submit_available()
                if monotonic_now >= next_heartbeat:
                    self.ledger.set_meta("last_poll_at", now_iso())
                    next_heartbeat = monotonic_now + self.interval
                # Free worker slots are filled on the next short slice, so more
                # than `workers` tasks are not starved until the 5s tick.
                if self._inflight:
                    self._drain(0.2)
                else:
                    stop_event.wait(0.2)
        finally:
            self._closed = True
            self._inflight.clear()
            self._inflight_ids.clear()
            self._executor.shutdown(wait=False, cancel_futures=True)
            self.ledger.set_meta("daemon_pid", "")
            self.ledger.set_meta("inflight", 0)

    def observe_all(self):
        """One bounded parallel pass over all pollable tasks."""
        try:
            tasks = self.ledger.pollable_items()
        except OrchestraError:
            raise
        if not tasks:
            self.ledger.set_meta("last_poll_at", now_iso())
            return {"observed": 0, "applied": 0, "errors": 0}
        observed = applied = errors = 0
        with ThreadPoolExecutor(max_workers=self.workers) as executor:
            futures = [executor.submit(self._run_one, task) for task in tasks]
            for future in as_completed(futures):
                result = future.result()
                outcome = self._apply(result)
                observed += 1
                if result["error"] is not None:
                    errors += 1
                if outcome.get("applied"):
                    applied += 1
        self.ledger.set_meta("last_poll_at", now_iso())
        return {"observed": observed, "applied": applied, "errors": errors}

    def close(self):
        if not self._closed:
            self._closed = True
            self._executor.shutdown(wait=False, cancel_futures=True)
