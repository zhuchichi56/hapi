"""Safe archive runner for explicitly requested archive operations.

Archive is never triggered by a normal observation.  A planner must first
record ``archive-request``; only then may ``archive-run`` (or the daemon when
explicitly enabled with ``--enable-archive-run``) execute one native archive
mutation.

Safety rules:
* list archived chats first and reconcile an existing archived identity;
* persist ``attempting`` before the single POST;
* an unknown/timeout outcome is never repeated -- later runs only reconcile;
* explicit not-sent/rejected outcomes may retry at most three times;
* controller is always protected; T008 only after an accepted parent review.
"""

import hashlib

from .bridge import post_command
from .constants import BRIDGE_SOCKET, BRIDGE_TIMEOUT_SECONDS
from .errors import BridgeError, ValidationError


class NativeArchiveClient:
    def __init__(self, socket_path=BRIDGE_SOCKET, timeout=BRIDGE_TIMEOUT_SECONDS, max_pages=50):
        self.socket_path = socket_path
        self.timeout = timeout
        self.max_pages = max(1, int(max_pages))

    def is_archived(self, thread_id):
        cursor = None
        pages = 0
        while True:
            command = {"app": "codex", "op": "list", "archived": True}
            if cursor:
                command["cursor"] = cursor
            try:
                status, payload = post_command(
                    command, self.socket_path, self.timeout
                )
            except BridgeError as exc:
                raise BridgeError(
                    "archive list failed: %s" % exc, delivery=exc.delivery
                )
            if status != 200 or payload.get("ok") is not True:
                raise BridgeError(
                    "archive list returned HTTP %s / ok=%s"
                    % (status, payload.get("ok")),
                    delivery=payload.get("delivery"),
                )
            result = payload.get("result")
            if not isinstance(result, dict):
                raise BridgeError("archive list result is not an object", delivery="unknown")
            threads = result.get("threads")
            if isinstance(threads, list):
                for thread in threads:
                    if isinstance(thread, dict) and thread.get("id") == thread_id:
                        return True
            cursor = result.get("nextCursor")
            pages += 1
            if not cursor:
                return False
            if pages >= self.max_pages:
                raise BridgeError(
                    "archive list pagination cap reached; refusing mutation",
                    delivery="unknown",
                )

    def archive(self, thread_id, action_id):
        try:
            status, payload = post_command(
                {
                    "app": "codex",
                    "op": "archive",
                    "id": thread_id,
                    "archived": True,
                    "actionId": action_id,
                },
                self.socket_path,
                self.timeout,
            )
        except BridgeError as exc:
            outcome = "not-sent" if exc.delivery == "not-sent" else "unknown"
            return {"outcome": outcome, "detail": str(exc)}
        if status == 200 and payload.get("ok") is True:
            result = payload.get("result")
            if isinstance(result, dict) and result.get("archived") is True:
                return {"outcome": "confirmed", "detail": "native archived=true"}
            return {
                "outcome": "unknown",
                "detail": "ok response without archived=true",
            }
        delivery = payload.get("delivery")
        if delivery == "not-sent":
            return {"outcome": "not-sent", "detail": "bridge classified not-sent"}
        if delivery in (None, "rejected"):
            return {
                "outcome": "rejected",
                "detail": "native rejected before mutation",
            }
        return {"outcome": "unknown", "detail": "native outcome uncertain"}


def _action_id(op_id, attempt):
    # Lossy punctuation replacement can collide across distinct operations.
    digest = hashlib.sha256(op_id.encode("utf-8")).hexdigest()[:32]
    return "orchestra-%s-a%d" % (digest, attempt)


def _confirm(ledger, task_id, op_id, attempt, evidence):
    receipt_id = "%s:reconcile" % op_id
    return ledger.archive_receipt(task_id, receipt_id, "confirmed", evidence)


def run_archive(ledger, task_id, op_id, client=None, max_pages=50):
    """Execute or reconcile one explicitly requested archive operation."""
    client = client or NativeArchiveClient(max_pages=max_pages)
    task = ledger.get_task(task_id)
    if task is None:
        raise ValidationError("unknown task: %s" % task_id)
    ledger._assert_archive_allowed(task)
    if task["external"] or task["read_only"]:
        raise ValidationError("external historical records are read-only")
    operation = ledger.get_operation(op_id)
    if operation is None:
        raise ValidationError("unknown archive op: %s" % op_id)
    if operation["taskId"] != task_id or operation["kind"] != "archive_request":
        raise ValidationError("op %s is not an archive request for %s" % (op_id, task_id))
    if task["review"] != "accepted":
        raise ValidationError("archive-run requires an accepted review")
    if not task.get("thread_id"):
        raise ValidationError("archive-run requires a known bound thread")
    if task["archive"] == "archived":
        return {
            "outcome": "already-archived",
            "writePerformed": False,
            "taskId": task_id,
        }

    thread_id = task["thread_id"]
    op_status = operation["status"]
    # A previous attempt may have reached the native side.  Reconcile only.
    if task["archive"] == "unknown" or op_status == "attempting":
        archived = client.is_archived(thread_id)
        attempts = int(operation["payload"].get("attempts") or 0)
        if archived:
            _confirm(
                ledger,
                task_id,
                op_id,
                attempts,
                "archive-run reconcile: thread already in archived list; no write",
            )
            ledger.update_operation(
                op_id, "reconciled", {"lastOutcome": "confirmed-reconciled"}
            )
            return {
                "outcome": "confirmed-reconciled",
                "writePerformed": False,
                "taskId": task_id,
            }
        if op_status == "attempting":
            ledger.archive_receipt(
                task_id,
                "%s:uncertain" % op_id,
                "unknown",
                "archive-run found a prior attempting record with no archived "
                "identity; no second mutation was sent",
            )
            ledger.update_operation(op_id, "uncertain", {"lastOutcome": "unknown"})
        return {
            "outcome": "unknown",
            "writePerformed": False,
            "taskId": task_id,
            "note": "unknown outcome; later runs reconcile only",
        }

    if task["archive"] != "pending":
        raise ValidationError(
            "archive-run requires archive=pending or unknown; current is %s"
            % task["archive"]
        )
    if op_status not in ("pending", "retry"):
        raise ValidationError(
            "archive request %s is not runnable (status=%s)" % (op_id, op_status)
        )

    # Reconcile existing archived identity before any mutation.
    if client.is_archived(thread_id):
        _confirm(
            ledger,
            task_id,
            op_id,
            0,
            "archive-run preflight: thread already archived; no write",
        )
        ledger.update_operation(
            op_id, "reconciled", {"lastOutcome": "confirmed-reconciled"}
        )
        return {
            "outcome": "confirmed-reconciled",
            "writePerformed": False,
            "taskId": task_id,
        }

    begun = ledger.begin_archive_attempt(task_id, op_id)
    if begun.get("alreadyArchived"):
        return {
            "outcome": "already-archived",
            "writePerformed": False,
            "taskId": task_id,
        }
    if begun.get("uncertainPriorAttempt"):
        # A crash left the operation in attempting.  The list check above did
        # not find it archived, so the safe outcome is unknown, not a retry.
        ledger.archive_receipt(
            task_id,
            "%s:uncertain" % op_id,
            "unknown",
            "archive-run resumed an attempting operation; no second mutation sent",
        )
        ledger.update_operation(op_id, "uncertain", {"lastOutcome": "unknown"})
        return {
            "outcome": "unknown",
            "writePerformed": False,
            "taskId": task_id,
        }

    attempt = begun["attempt"]
    result = client.archive(thread_id, _action_id(op_id, attempt))
    outcome = result["outcome"]
    receipt_id = "%s:receipt:%d" % (op_id, attempt)
    if outcome == "confirmed":
        ledger.archive_receipt(
            task_id,
            receipt_id,
            "confirmed",
            "archive-run attempt %d: %s" % (attempt, result.get("detail")),
        )
        ledger.update_operation(
            op_id,
            "reconciled",
            {"attempts": attempt, "lastOutcome": "confirmed"},
        )
        return {
            "outcome": "confirmed",
            "writePerformed": True,
            "attempt": attempt,
            "taskId": task_id,
        }
    if outcome in ("not-sent", "rejected"):
        ledger.archive_receipt(
            task_id,
            receipt_id,
            "failed",
            "archive-run attempt %d retryable %s: %s"
            % (attempt, outcome, result.get("detail")),
        )
        ledger.update_operation(
            op_id,
            "retry",
            {"attempts": attempt, "lastOutcome": outcome},
        )
        return {
            "outcome": outcome,
            "writePerformed": True,
            "attempt": attempt,
            "retryable": True,
            "taskId": task_id,
        }
    ledger.archive_receipt(
        task_id,
        receipt_id,
        "unknown",
        "archive-run attempt %d unknown: %s" % (attempt, result.get("detail")),
    )
    ledger.update_operation(
        op_id,
        "uncertain",
        {"attempts": attempt, "lastOutcome": "unknown"},
    )
    return {
        "outcome": "unknown",
        "writePerformed": True,
        "attempt": attempt,
        "taskId": task_id,
        "note": "unknown outcome; later runs reconcile only",
    }
