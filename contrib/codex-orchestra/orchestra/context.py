"""Task-scoped recall packet; no model calls or native context mutations."""

import re
import hashlib
import json

from .brief import read_brief
from .errors import NotFoundError, ValidationError


def _short(value, limit):
    value = str(value or "")
    value = re.sub(r"::[a-z][a-z0-9-]*\{[^}]*\}", "", value, flags=re.I)
    value = re.sub(r"```[\s\S]*?```", "", value)
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= limit else value[:limit] + "…"


def context_packet(ledger, task_id, full=False, reference=None, revision=None):
    """Inline bounded facts and stable IDs; spill full fields to explicit recall.

    This is a deterministic projection of recorded public facts. It cannot
    establish that a task is on track, summarize hidden history, send a message,
    or trigger native Codex context compression.
    """
    task = ledger.get_task(task_id)
    if task is None:
        raise NotFoundError("unknown task: %s" % task_id)
    contract = {key: task.get(key) for key in (
        "id", "title", "goal", "deliverables", "acceptance", "ownership",
        "authorization", "checkpoint", "expected_at", "evidence",
    )}
    version = hashlib.sha256(json.dumps(contract, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:20]
    if revision is not None and revision != version:
        raise ValidationError("recorded contract changed; refresh context before recalling a reference")
    if reference is not None:
        match = re.fullmatch(r"(deliverables|evidence):(\d+)", reference)
        if not match or int(match[2]) >= len(task[match[1]]):
            raise ValidationError("unknown reference; use an ID returned by context")
        return {"taskId": task["id"], "threadId": task.get("thread_id"),
                "revision": version, "referenceId": reference,
                "value": task[match[1]][int(match[2])], "contentRead": False}

    def refs(kind, tail=False):
        items = list(enumerate(task[kind]))
        items = items[-5:] if tail else items[:5]
        return [{"id": "%s:%d" % (kind, index), "preview": _short(item, 180),
                 "recall": ["codex-orchestra", "context", task["id"], "--ref", "%s:%d" % (kind, index), "--revision", version]}
                for index, item in items]

    thread_id = task.get("thread_id")
    archived = task.get("archive") == "archived"
    result = {
        "taskId": task["id"],
        "revision": version,
        "threadId": thread_id,
        "host": task["host"],
        "title": _short(task["title"], 160),
        "goal": _short(task["goal"], 400),
        "constraints": {
            "authorization": _short(task.get("authorization"), 500),
            "acceptance": [_short(item, 180) for item in task["acceptance"][:5]],
            "ownership": [_short(item, 160) for item in task["ownership"][:4]],
        },
        "controllerBrief": read_brief(ledger, task_id),
        "recordedConclusion": _short(task.get("progress"), 400),
        "observation": {
            "execution": task["execution"],
            "review": task["review"],
            "archive": task["archive"],
            "observedAt": task.get("observed_at"),
            "sourceAt": task.get("source_at"),
            "observedAtIsReadTime": True,
            "error": _short(task.get("last_error"), 200) or None,
            "meaning": "Recorded state only; assess goal alignment, recent verifiable progress, blockers/drift and delivery evidence separately.",
        },
        "nextCheckpoint": _short(task.get("checkpoint"), 400),
        "expectedAt": task.get("expected_at"),
        "references": {
            "deliverables": refs("deliverables"),
            "evidence": refs("evidence", tail=True),
            "fullContractRecall": ["codex-orchestra", "context", task["id"], "--full"],
            "historyRecall": ["codex-orchestra", "history", task["id"], "--limit", "20"],
        },
        "routing": {
            "mode": "archived-requires-explicit-reopen" if archived else (
                "continue-original-thread" if thread_id else "unbound-reconcile-before-create"
            ),
            "originalThreadId": thread_id,
            "createsOrSends": False,
        },
        "limits": {
            "automaticModelWakeup": False,
            "nativeContextCompressionTriggered": False,
            "qualityAssessed": False,
            "summarySource": "bounded projection of recorded task facts, not a model-written history summary",
            "referencesRead": False,
        },
    }
    if full:
        result["fullContract"] = contract
    return result
