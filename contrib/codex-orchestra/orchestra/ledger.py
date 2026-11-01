"""Persistent task ledger: tasks, operations, notices, imports and snapshots."""

import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timezone

from .constants import (ARCHIVES, CONTROLLER_THREAD_ID, EXECUTIONS, HOSTS,
                        IMPORT_AUTHORIZATION, IMPORT_SOURCE_OBSERVED_AT,
                        NOTICE_KINDS, POLL_INTERVAL_SECONDS, PROGRESS_LIMIT,
                        REVIEWS, STALE_AFTER_SECONDS, T008_THREAD_ID,
                        TURN_STATUSES, VERSION, WORKER_COUNT)

PROTECTED_T008_THREAD = T008_THREAD_ID
from .db import connect
from .errors import NotFoundError, TransitionError, ValidationError
from .util import (age_seconds, atomic_write, clamp_text, ensure_state_dir,
                   normalize_iso, now_iso, parse_iso)

THREAD_LINK_RE = re.compile(r"codex://threads/([0-9A-Za-z-]+)")
UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)
TASK_ID_RE = re.compile(r"^T\d{3}$")


def _json_list(raw):
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        return []
    if not isinstance(value, list):
        return []
    return [str(item) for item in value]


def _plain(value):
    if isinstance(value, str):
        return value.strip()
    return value


def _require_text(data, key, default=None, allow_empty=False):
    value = data.get(key, default)
    if value is None:
        if allow_empty:
            return ""
        raise ValidationError("%s is required" % key)
    if not isinstance(value, str):
        raise ValidationError("%s must be a string" % key)
    value = value.strip()
    if not value and not allow_empty:
        raise ValidationError("%s must not be empty" % key)
    return value


def _require_list(data, key, default=None):
    value = data.get(key, default if default is not None else [])
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValidationError("%s must be a list of strings" % key)
    return value


def _require_enum(data, key, allowed, default):
    value = data.get(key, default)
    if value not in allowed:
        raise ValidationError("%s must be one of: %s" % (key, ", ".join(allowed)))
    return value


def _row_dict(row):
    data = {key: row[key] for key in row.keys()}
    for key in ("deliverables", "acceptance", "ownership", "evidence"):
        data[key] = _json_list(data.get(key))
    data["external"] = bool(data.get("external"))
    data["read_only"] = bool(data.get("read_only"))
    if data.get("live") is not None:
        data["live"] = bool(data["live"])
    return data


def _public_task(data, now):
    observed_at = data.get("observed_at")
    if data.get("external"):
        stale = True
    elif data.get("last_error"):
        stale = True
    elif observed_at:
        stale = age_seconds(observed_at, now) > STALE_AFTER_SECONDS
    else:
        stale = False
    execution = data["execution"]
    review = data["review"]
    attention = bool(
        review == "awaiting"
        or execution in ("failed", "interrupted", "blocked")
        or (stale and execution in ("running", "unknown"))
    )
    return {
        "id": data["id"],
        "title": data["title"],
        "goal": data["goal"],
        "deliverables": list(data["deliverables"]),
        "acceptance": list(data["acceptance"]),
        "ownership": list(data["ownership"]),
        "authorization": data["authorization"],
        "threadId": data.get("thread_id"),
        "host": data["host"],
        "createdAt": data["created_at"],
        "checkpoint": data["checkpoint"],
        "expectedAt": data.get("expected_at"),
        "execution": execution,
        "review": review,
        "archive": data["archive"],
        "observedAt": observed_at,
        "sourceAt": data.get("source_at"),
        "progress": data["progress"],
        "latestAction": data["latest_action"],
        "evidence": list(data["evidence"]),
        "stale": stale,
        "attention": attention,
        "external": bool(data["external"]),
    }


def _op_public(row):
    try:
        payload = json.loads(row["payload"])
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    return {
        "opId": row["op_id"],
        "taskId": row["task_id"],
        "kind": row["kind"],
        "status": row["status"],
        "payload": payload,
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _md_cell(value):
    text = "" if value is None else str(value)
    text = text.replace("\r", " ").replace("\n", " ").replace("|", "\\|")
    return text.strip()


def _find_thread_id(text):
    match = THREAD_LINK_RE.search(text or "")
    if match:
        return match.group(1)
    match = UUID_RE.search(text or "")
    if match:
        return match.group(0)
    return None


def _strip_md_links(text):
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text or "")
    return text.strip()


def _table_cells(line):
    stripped = line.strip()
    if not stripped.startswith("|"):
        return None
    parts = stripped.split("|")
    if parts and not parts[0].strip():
        parts = parts[1:]
    if parts and not parts[-1].strip():
        parts = parts[:-1]
    return [part.strip() for part in parts]


def _is_separator(cells):
    if not cells:
        return True
    return all(set(cell) <= set("-: ") for cell in cells if cell)


def _import_status(status_text):
    text = status_text or ""
    if "已验收" in text:
        return "reported", "accepted", "archived"
    if "待验收" in text:
        return "reported", "awaiting", "none"
    if "执行中" in text:
        return "running", "pending", "none"
    if "待派发" in text:
        return "queued", "pending", "none"
    if "受阻" in text or "阻塞" in text:
        return "blocked", "pending", "none"
    if "异常中断" in text or "中断" in text:
        return "interrupted", "pending", "none"
    return "unknown", "pending", "none"


def _split_title_deliverables(work_cell):
    if "；交付" in work_cell:
        title, delivered = work_cell.split("；交付", 1)
    elif "；" in work_cell:
        title, delivered = work_cell.split("；", 1)
    else:
        title, delivered = work_cell, ""
    return title.strip(), [delivered.strip()] if delivered.strip() else []


class Ledger:
    """A small, process-safe facade over one SQLite state directory."""

    def __init__(self, state_dir, controller_thread_id=CONTROLLER_THREAD_ID):
        self.state_dir = ensure_state_dir(state_dir)
        self.controller_thread_id = controller_thread_id
        connection = self._connect()
        connection.close()

    def _connect(self):
        return connect(self.state_dir)

    # ------------------------------------------------------------------ reads
    def _meta(self, connection, key, default=None):
        row = connection.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row is not None else default

    def get_meta(self, key, default=None):
        connection = self._connect()
        try:
            return self._meta(connection, key, default)
        finally:
            connection.close()

    def get_task(self, task_id):
        connection = self._connect()
        try:
            row = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            return _row_dict(row) if row is not None else None
        finally:
            connection.close()

    def _require_task(self, connection, task_id, action):
        row = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None:
            external = connection.execute(
                "SELECT 1 FROM external_history WHERE id=?", (task_id,)
            ).fetchone()
            if external is not None:
                raise TransitionError(
                    "task %s is a read-only external historical record" % task_id
                )
            raise NotFoundError("unknown task: %s" % task_id)
        task = _row_dict(row)
        if task["external"] or task["read_only"]:
            raise TransitionError("task %s is read-only (external historical)" % task_id)
        return task

    def _assert_archive_allowed(self, task):
        thread_id = task.get("thread_id")
        if thread_id == CONTROLLER_THREAD_ID:
            raise TransitionError(
                "controller thread %s is permanently archive-protected" % thread_id
            )
        # T008 is protected while it is still the implementation chat or before
        # its parent accepts the delivery.  Once accepted, the parent may archive
        # it through this CLI; there is no permanent hardcoded deny.
        if thread_id == PROTECTED_T008_THREAD and task.get("review") != "accepted":
            raise TransitionError(
                "T008 implementation thread %s is archive-protected until its "
                "parent records an accepted review" % thread_id
            )
        if task["id"] == "T008" and task.get("review") != "accepted":
            raise TransitionError(
                "T008 is archive-protected until its parent records an accepted review"
            )

    def list_tasks(self):
        connection = self._connect()
        try:
            rows = connection.execute("SELECT * FROM tasks ORDER BY id").fetchall()
            return [_row_dict(row) for row in rows]
        finally:
            connection.close()

    def pollable_tasks(self):
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT * FROM tasks
                WHERE thread_id IS NOT NULL
                  AND external=0
                  AND read_only=0
                  AND poll=1
                  AND NOT (review='accepted' AND archive='archived')
                ORDER BY COALESCE(observed_at,'') ASC, id ASC
                """
            ).fetchall()
            return [_row_dict(row) for row in rows]
        finally:
            connection.close()

    def set_meta(self, key, value):
        connection = self._connect()
        try:
            with connection:
                self._set_meta(connection, key, value)
        finally:
            connection.close()

    def _set_meta(self, connection, key, value):
        connection.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, None if value is None else str(value)),
        )

    # --------------------------------------------------------------- register
    def register(self, data):
        if not isinstance(data, dict):
            raise ValidationError("register JSON must be an object")
        task_id = _require_text(data, "id")
        if not re.match(r"^[A-Za-z0-9_.:-]{1,80}$", task_id):
            raise ValidationError("id contains unsupported characters")
        title = _require_text(data, "title")
        host = _require_enum(data, "host", HOSTS, "local")
        thread_id = data.get("threadId")
        if thread_id is not None:
            if not isinstance(thread_id, str) or not thread_id.strip():
                raise ValidationError("threadId must be a non-empty string or null")
            thread_id = thread_id.strip()
            if re.search(r"\s", thread_id):
                raise ValidationError("threadId must not contain whitespace")
        expected_at = data.get("expectedAt")
        if expected_at is not None:
            expected_at = normalize_iso(expected_at, "expectedAt")
        created_at = data.get("createdAt") or now_iso()
        created_at = normalize_iso(created_at, "createdAt")
        execution = _require_enum(data, "execution", EXECUTIONS, "queued")
        review = _require_enum(data, "review", REVIEWS, "pending")
        archive = _require_enum(data, "archive", ARCHIVES, "none")
        external = bool(data.get("external", False))
        read_only = bool(data.get("readOnly", external))
        thread_observed = data.get("observedAt")
        if thread_observed is not None:
            thread_observed = normalize_iso(thread_observed, "observedAt")
        source_at = data.get("sourceAt")
        if source_at is not None:
            source_at = normalize_iso(source_at, "sourceAt")

        connection = self._connect()
        try:
            with connection:
                existing = connection.execute(
                    "SELECT * FROM tasks WHERE id=?", (task_id,)
                ).fetchone()
                if existing is not None:
                    current = _row_dict(existing)
                    if (
                        thread_id
                        and current.get("thread_id")
                        and current["thread_id"] != thread_id
                    ):
                        raise TransitionError(
                            "task %s is already bound to another thread" % task_id
                        )
                    return {"created": False, "task": _public_task(current, datetime.now(timezone.utc))}
                if thread_id:
                    clash = connection.execute(
                        "SELECT id FROM tasks WHERE thread_id=? AND id<>?", (thread_id, task_id)
                    ).fetchone()
                    if clash is not None:
                        raise TransitionError(
                            "thread %s is already registered to task %s"
                            % (thread_id, clash["id"])
                        )
                poll = 1 if thread_id and not external and not read_only else 0
                if review == "accepted" and archive == "archived":
                    poll = 0
                timestamp = now_iso()
                connection.execute(
                    """
                    INSERT INTO tasks (
                        id,title,goal,deliverables,acceptance,ownership,authorization,
                        thread_id,host,created_at,checkpoint,expected_at,execution,
                        review,archive,observed_at,source_at,progress,latest_action,
                        evidence,external,read_only,source_revision,source_turn_id,
                        turn_status,live,last_error,poll,updated_at
                    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """,
                    (
                        task_id,
                        title,
                        _require_text(data, "goal", title, allow_empty=True),
                        json.dumps(_require_list(data, "deliverables")),
                        json.dumps(_require_list(data, "acceptance")),
                        json.dumps(_require_list(data, "ownership")),
                        _require_text(data, "authorization", "registered locally", allow_empty=True),
                        thread_id,
                        host,
                        created_at,
                        _require_text(data, "checkpoint", "", allow_empty=True),
                        expected_at,
                        execution,
                        review,
                        archive,
                        thread_observed,
                        source_at,
                        _require_text(data, "progress", "", allow_empty=True)[:PROGRESS_LIMIT],
                        _require_text(data, "latestAction", "", allow_empty=True),
                        json.dumps(_require_list(data, "evidence")),
                        1 if external else 0,
                        1 if read_only else 0,
                        None,
                        None,
                        None,
                        None,
                        None,
                        poll,
                        timestamp,
                    ),
                )
                row = connection.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
                return {"created": True, "task": _public_task(_row_dict(row), datetime.now(timezone.utc))}
        finally:
            connection.close()

    # ----------------------------------------------------------- contract edit
    def update_contract(self, task_id, data):
        """Amend contract text only; identity/status/thread stay immutable."""
        if not isinstance(data, dict):
            raise ValidationError("contract JSON must be an object")
        forbidden = {
            "id",
            "threadId",
            "thread_id",
            "host",
            "execution",
            "review",
            "archive",
            "observedAt",
            "sourceAt",
            "external",
            "readOnly",
            "createdAt",
        }
        touched_forbidden = sorted(set(data) & forbidden)
        if touched_forbidden:
            raise ValidationError(
                "identity/state fields are not mutable via update-contract: %s"
                % ", ".join(touched_forbidden)
            )
        allowed = {
            "title",
            "goal",
            "deliverables",
            "acceptance",
            "ownership",
            "authorization",
            "checkpoint",
            "expectedAt",
            "evidence",
        }
        unknown = sorted(set(data) - allowed)
        if unknown:
            raise ValidationError(
                "unsupported contract fields: %s" % ", ".join(unknown)
            )
        updates = {}
        if "title" in data:
            updates["title"] = _require_text(data, "title")
        if "goal" in data:
            updates["goal"] = _require_text(data, "goal", allow_empty=True)
        for key in ("deliverables", "acceptance", "ownership", "evidence"):
            if key in data:
                updates[key] = json.dumps(_require_list(data, key))
        if "authorization" in data:
            updates["authorization"] = _require_text(
                data, "authorization", allow_empty=True
            )
        if "checkpoint" in data:
            updates["checkpoint"] = _require_text(data, "checkpoint", allow_empty=True)
        if "expectedAt" in data:
            value = data["expectedAt"]
            updates["expected_at"] = (
                None if value is None else normalize_iso(value, "expectedAt")
            )
        if not updates:
            raise ValidationError("no contract fields supplied")
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "update")
                assignments = ", ".join("%s=?" % key for key in updates)
                values = list(updates.values()) + [now_iso(), task_id]
                connection.execute(
                    "UPDATE tasks SET %s,updated_at=? WHERE id=?" % assignments,
                    values,
                )
                row = connection.execute(
                    "SELECT * FROM tasks WHERE id=?", (task_id,)
                ).fetchone()
                return {
                    "updated": True,
                    "fields": sorted(data.keys()),
                    "task": _public_task(_row_dict(row), datetime.now(timezone.utc)),
                }
        finally:
            connection.close()

    # ----------------------------------------------------------------- import
    def import_markdown(self, path):
        source = os.path.abspath(os.path.expanduser(path))
        try:
            with open(source, "r", encoding="utf-8") as handle:
                text = handle.read()
        except OSError as exc:
            raise ValidationError("cannot read markdown: %s" % exc.__class__.__name__)
        source_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
        # The main table is imported from a mutable working overview, not from
        # the frozen 13:27 external snapshot.  Its provenance timestamp is the
        # source file mtime; T007/T008 therefore stay on Nov 2 instead of being
        # backdated to Nov 1.  It is never presented as a native observation.
        imported_at = now_iso()
        source_at = datetime.fromtimestamp(
            os.stat(source).st_mtime, timezone.utc
        ).isoformat(timespec="microseconds")

        lines = text.splitlines()
        main_rows = []
        external_rows = []
        in_external = False
        for line in lines:
            if line.strip().startswith("## 既有任务跟踪"):
                in_external = True
                continue
            cells = _table_cells(line)
            if cells is None:
                continue
            if not in_external and TASK_ID_RE.match(cells[0] or ""):
                main_rows.append(cells)
            elif in_external:
                if not cells or cells[0] in ("任务",) or _is_separator(cells):
                    continue
                if len(cells) >= 4:
                    external_rows.append(cells)

        if not main_rows:
            raise ValidationError("no T### task rows found in markdown")

        created = 0
        skipped = 0
        connection = self._connect()
        try:
            with connection:
                for cells in main_rows:
                    if len(cells) < 7:
                        continue
                    task_id, work_cell, thread_cell, status_cell = cells[:4]
                    acceptance_cell, checkpoint, evidence_cell = cells[4], cells[5], cells[6]
                    title, deliverables = _split_title_deliverables(work_cell)
                    thread_id = _find_thread_id(thread_cell)
                    execution, review, archive = _import_status(status_cell)
                    exists = connection.execute(
                        "SELECT 1 FROM tasks WHERE id=?", (task_id,)
                    ).fetchone()
                    if exists is not None:
                        skipped += 1
                        continue
                    if thread_id:
                        clash = connection.execute(
                            "SELECT id FROM tasks WHERE thread_id=?", (thread_id,)
                        ).fetchone()
                        if clash is not None:
                            skipped += 1
                            continue
                    acceptance = [part.strip() for part in acceptance_cell.split("；") if part.strip()]
                    evidence = [evidence_cell] if evidence_cell else []
                    poll = 1 if (thread_id and not (review == "accepted" and archive == "archived")) else 0
                    # Only a historical snapshot may carry a snapshot observation
                    # time.  Queued/unbound tasks and a running task await a real
                    # native read, so they must stay observedAt=null.
                    if review in ("accepted", "awaiting") and archive in ("archived", "none"):
                        observed_at = source_at
                    else:
                        observed_at = None
                    connection.execute(
                        """
                        INSERT INTO tasks (
                            id,title,goal,deliverables,acceptance,ownership,authorization,
                            thread_id,host,created_at,checkpoint,expected_at,execution,
                            review,archive,observed_at,source_at,progress,latest_action,
                            evidence,external,read_only,source_revision,source_turn_id,
                            turn_status,live,last_error,poll,updated_at
                        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                        """,
                        (
                            task_id,
                            title or work_cell,
                            work_cell,
                            json.dumps(deliverables),
                            json.dumps(acceptance),
                            json.dumps([]),
                            IMPORT_AUTHORIZATION,
                            thread_id,
                            "local",
                            imported_at,
                            checkpoint,
                            None,
                            execution,
                            review,
                            archive,
                            observed_at,
                            source_at,
                            "导入快照（源文件 mtime %s）：%s" % (source_at, status_cell),
                            "import:historical-snapshot",
                            json.dumps(evidence),
                            0,
                            0,
                            None,
                            None,
                            None,
                            None,
                            None,
                            poll,
                            now_iso(),
                        ),
                    )
                    created += 1

                for index, cells in enumerate(external_rows, start=1):
                    title = _strip_md_links(cells[0])
                    status_text = _strip_md_links(cells[1])
                    detail = _strip_md_links(cells[2])
                    next_step = _strip_md_links(cells[3])
                    thread_id = _find_thread_id(" ".join(cells))
                    ext_id = "EXT%03d" % index
                    connection.execute(
                        """
                        INSERT INTO external_history
                            (id,title,status_text,detail,next_step,thread_id,observed_at,ordinal)
                        VALUES (?,?,?,?,?,?,?,?)
                        ON CONFLICT(id) DO UPDATE SET
                            title=excluded.title,
                            status_text=excluded.status_text,
                            detail=excluded.detail,
                            next_step=excluded.next_step,
                            thread_id=excluded.thread_id,
                            observed_at=excluded.observed_at,
                            ordinal=excluded.ordinal
                        """,
                        (
                            ext_id,
                            title,
                            status_text,
                            detail,
                            next_step,
                            thread_id,
                            IMPORT_SOURCE_OBSERVED_AT,
                            index,
                        ),
                    )

                self._set_meta(connection, "import_source", source)
                self._set_meta(connection, "import_source_at", source_at)
                self._set_meta(connection, "external_source_at", IMPORT_SOURCE_OBSERVED_AT)
                self._set_meta(connection, "import_source_sha256", source_hash)
                self._set_meta(connection, "imported_at", imported_at)
        finally:
            connection.close()
        return {
            "source": source,
            "sourceAt": source_at,
            "importedAt": imported_at,
            "externalSourceAt": IMPORT_SOURCE_OBSERVED_AT,
            "created": created,
            "skipped": skipped,
            "external": len(external_rows),
            "sha256": source_hash,
        }

    # ------------------------------------------------------------- operations
    def _existing_op(self, connection, op_id, task_id, kind):
        row = connection.execute(
            "SELECT * FROM operations WHERE op_id=?", (op_id,)
        ).fetchone()
        if row is None:
            return None
        if row["task_id"] != task_id or row["kind"] != kind:
            raise TransitionError(
                "op-id %s is already used for %s/%s" % (op_id, row["task_id"], row["kind"])
            )
        return row

    def _insert_op(self, connection, op_id, task_id, kind, status, payload):
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        op_id = op_id.strip()
        timestamp = now_iso()
        connection.execute(
            """
            INSERT INTO operations(op_id,task_id,kind,status,payload,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (
                op_id,
                task_id,
                kind,
                status,
                json.dumps(payload, ensure_ascii=False),
                timestamp,
                timestamp,
            ),
        )
        row = connection.execute(
            "SELECT * FROM operations WHERE op_id=?", (op_id,)
        ).fetchone()
        return _op_public(row)

    def dispatch_intent(self, task_id, op_id):
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        op_id = op_id.strip()
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "dispatch")
                existing = self._existing_op(connection, op_id, task_id, "dispatch_intent")
                if existing is not None:
                    return {"reused": True, "operation": _op_public(existing)}
                if task.get("thread_id"):
                    raise TransitionError(
                        "task %s is already bound; duplicate dispatch is refused" % task_id
                    )
                pending = connection.execute(
                    """
                    SELECT * FROM operations
                    WHERE task_id=? AND kind='dispatch_intent' AND status='pending'
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (task_id,),
                ).fetchone()
                if pending is not None:
                    return {"reused": True, "operation": _op_public(pending)}
                operation = self._insert_op(
                    connection,
                    op_id,
                    task_id,
                    "dispatch_intent",
                    "pending",
                    {"threadId": None},
                )
                return {"reused": False, "operation": operation}
        finally:
            connection.close()

    def dispatch_pending(self, task_id, op_id, client_thread_id):
        """Persist a pending create receipt (clientThreadId) on its intent.

        A pending create is evidence that an attempt may exist; it must be
        reconciled by an explicit ``bind`` after restart, never re-created just
        because the operation is still pending.
        """
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        if not isinstance(client_thread_id, str) or not client_thread_id.strip():
            raise ValidationError("--client-thread must be a non-empty string")
        client_thread_id = client_thread_id.strip()
        if re.search(r"\s", client_thread_id):
            raise ValidationError("--client-thread must not contain whitespace")
        op_id = op_id.strip()
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "dispatch")
                if task.get("thread_id"):
                    raise TransitionError(
                        "task %s is already bound; pending create identity is not applicable"
                        % task_id
                    )
                operation = self._existing_op(
                    connection, op_id, task_id, "dispatch_intent"
                )
                if operation is None:
                    raise NotFoundError(
                        "no dispatch intent %s for %s" % (op_id, task_id)
                    )
                if operation["status"] != "pending":
                    raise TransitionError(
                        "dispatch intent %s is %s, not pending"
                        % (op_id, operation["status"])
                    )
                payload = _op_public(operation)["payload"]
                previous = payload.get("clientThreadId")
                if previous and previous != client_thread_id:
                    raise TransitionError(
                        "dispatch intent %s already records a different clientThreadId"
                        % op_id
                    )
                payload["clientThreadId"] = client_thread_id
                timestamp = now_iso()
                connection.execute(
                    "UPDATE operations SET payload=?,updated_at=? WHERE op_id=?",
                    (json.dumps(payload, ensure_ascii=False), timestamp, op_id),
                )
                row = connection.execute(
                    "SELECT * FROM operations WHERE op_id=?", (op_id,)
                ).fetchone()
                return {
                    "reused": bool(previous == client_thread_id),
                    "operation": _op_public(row),
                }
        finally:
            connection.close()

    def bind(self, task_id, op_id, thread_id, host="local"):
        if host not in HOSTS:
            raise ValidationError("host must be local")
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise ValidationError("--thread must be a non-empty string")
        thread_id = thread_id.strip()
        if re.search(r"\s", thread_id):
            raise ValidationError("--thread must not contain whitespace")
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        op_id = op_id.strip()
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "bind")
                operation = self._existing_op(connection, op_id, task_id, "dispatch_intent")
                if operation is None:
                    raise NotFoundError(
                        "no dispatch intent %s for %s; create the intent before binding" % (op_id, task_id)
                    )
                if task.get("thread_id"):
                    if task["thread_id"] != thread_id:
                        raise TransitionError(
                            "task %s is already bound to a different thread; refusing to change it"
                            % task_id
                        )
                    if operation["status"] != "reconciled":
                        connection.execute(
                            "UPDATE operations SET status='reconciled',updated_at=? WHERE op_id=?",
                            (now_iso(), op_id),
                        )
                    return {"reused": True, "task": _public_task(task, datetime.now(timezone.utc))}
                clash = connection.execute(
                    "SELECT id FROM tasks WHERE thread_id=? AND id<>?", (thread_id, task_id)
                ).fetchone()
                if clash is not None:
                    raise TransitionError(
                        "thread %s is already registered to task %s" % (thread_id, clash["id"])
                    )
                new_execution = "unknown" if task["execution"] == "queued" else task["execution"]
                timestamp = now_iso()
                connection.execute(
                    """
                    UPDATE tasks SET thread_id=?,host=?,execution=?,poll=1,updated_at=?
                    WHERE id=?
                    """,
                    (thread_id, host, new_execution, timestamp, task_id),
                )
                bind_payload = _op_public(operation)["payload"]
                bind_payload["threadId"] = thread_id
                connection.execute(
                    "UPDATE operations SET status='reconciled',payload=?,updated_at=? WHERE op_id=?",
                    (json.dumps(bind_payload, ensure_ascii=False), timestamp, op_id),
                )
                task["thread_id"] = thread_id
                task["host"] = host
                task["execution"] = new_execution
                return {"reused": False, "task": _public_task(task, datetime.now(timezone.utc))}
        finally:
            connection.close()

    def review(self, task_id, result, evidence, op_id):
        if result not in ("accepted", "rejected"):
            raise ValidationError("review result must be accepted or rejected")
        if not isinstance(evidence, str) or not evidence.strip():
            raise ValidationError("--evidence must be a non-empty string")
        evidence = evidence.strip()
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        op_id = op_id.strip()
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "review")
                existing = self._existing_op(connection, op_id, task_id, "review")
                if existing is not None:
                    payload = _op_public(existing)["payload"]
                    if payload.get("result") != result:
                        raise TransitionError(
                            "op-id %s already recorded review=%s" % (op_id, payload.get("result"))
                        )
                    return {"reused": True, "operation": _op_public(existing)}
                if task["review"] == "accepted":
                    if result == "accepted":
                        return {"reused": True, "review": "accepted", "operation": None}
                    raise TransitionError("accepted review is terminal and cannot be overwritten")
                if task["review"] == "rejected" and result == "rejected":
                    return {"reused": True, "review": "rejected", "operation": None}
                if result == "accepted" and task["execution"] != "reported":
                    raise TransitionError(
                        "acceptance requires a delivered/reported turn; current execution is %s"
                        % task["execution"]
                    )
                if result == "rejected" and task["execution"] not in (
                    "reported",
                    "failed",
                    "interrupted",
                ):
                    raise TransitionError(
                        "rejection requires a delivery or a terminal failure; current execution is %s"
                        % task["execution"]
                    )
                new_evidence = list(task["evidence"])
                new_evidence.append(
                    "review %s (%s): %s" % (result, op_id, evidence)
                )
                connection.execute(
                    "UPDATE tasks SET review=?,evidence=?,updated_at=? WHERE id=?",
                    (result, json.dumps(new_evidence), now_iso(), task_id),
                )
                operation = self._insert_op(
                    connection,
                    op_id,
                    task_id,
                    "review",
                    "recorded",
                    {"result": result, "evidence": evidence[:500]},
                )
                return {"reused": False, "review": result, "operation": operation}
        finally:
            connection.close()

    def archive_request(self, task_id, op_id):
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        op_id = op_id.strip()
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "archive")
                self._assert_archive_allowed(task)
                if task["review"] != "accepted":
                    raise TransitionError("archive requires an accepted review")
                if not task.get("thread_id"):
                    raise TransitionError("archive requires a known bound thread")
                existing = self._existing_op(connection, op_id, task_id, "archive_request")
                if existing is not None:
                    return {"reused": True, "operation": _op_public(existing)}
                if task["archive"] == "archived":
                    return {
                        "reused": True,
                        "taskId": task_id,
                        "archive": "archived",
                        "operation": None,
                    }
                if task["archive"] == "unknown":
                    raise TransitionError(
                        "archive outcome is unknown; record a receipt before requesting again"
                    )
                if task["archive"] == "pending":
                    pending = connection.execute(
                        """
                        SELECT * FROM operations
                        WHERE task_id=? AND kind='archive_request' AND status='pending'
                        ORDER BY created_at DESC LIMIT 1
                        """,
                        (task_id,),
                    ).fetchone()
                    if pending is not None:
                        return {"reused": True, "operation": _op_public(pending)}
                operation = self._insert_op(
                    connection,
                    op_id,
                    task_id,
                    "archive_request",
                    "pending",
                    {"threadId": task.get("thread_id")},
                )
                connection.execute(
                    "UPDATE tasks SET archive='pending',updated_at=? WHERE id=?",
                    (now_iso(), task_id),
                )
                return {"reused": False, "operation": operation}
        finally:
            connection.close()

    def archive_receipt(self, task_id, op_id, result, evidence):
        if result not in ("confirmed", "failed", "unknown"):
            raise ValidationError("archive receipt result must be confirmed, failed or unknown")
        if not isinstance(evidence, str) or not evidence.strip():
            raise ValidationError("--evidence must be a non-empty string")
        evidence = evidence.strip()
        if not isinstance(op_id, str) or not op_id.strip():
            raise ValidationError("--op-id must be a non-empty string")
        op_id = op_id.strip()
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "archive")
                self._assert_archive_allowed(task)
                existing = self._existing_op(connection, op_id, task_id, "archive_receipt")
                if existing is not None:
                    payload = _op_public(existing)["payload"]
                    if payload.get("result") != result:
                        raise TransitionError(
                            "op-id %s already recorded receipt=%s"
                            % (op_id, payload.get("result"))
                        )
                    return {"reused": True, "operation": _op_public(existing)}
                if task["archive"] not in ("pending", "unknown"):
                    raise TransitionError(
                        "archive receipt requires archive=pending or unknown; current is %s"
                        % task["archive"]
                    )
                archive = {
                    "confirmed": "archived",
                    "failed": "pending",
                    "unknown": "unknown",
                }[result]
                new_evidence = list(task["evidence"])
                new_evidence.append(
                    "archive receipt %s (%s): %s" % (result, op_id, evidence)
                )
                timestamp = now_iso()
                connection.execute(
                    "UPDATE tasks SET archive=?,evidence=?,updated_at=? WHERE id=?",
                    (archive, json.dumps(new_evidence), timestamp, task_id),
                )
                if result == "confirmed":
                    connection.execute(
                        """
                        UPDATE operations SET status='reconciled',updated_at=?
                        WHERE task_id=? AND kind='archive_request' AND status='pending'
                        """,
                        (timestamp, task_id),
                    )
                operation = self._insert_op(
                    connection,
                    op_id,
                    task_id,
                    "archive_receipt",
                    "recorded",
                    {"result": result, "evidence": evidence[:500]},
                )
                return {
                    "reused": False,
                    "archive": archive,
                    "operation": operation,
                }
        finally:
            connection.close()

    def get_operation(self, op_id):
        connection = self._connect()
        try:
            row = connection.execute(
                "SELECT * FROM operations WHERE op_id=?", (op_id,)
            ).fetchone()
            return _op_public(row) if row is not None else None
        finally:
            connection.close()

    def pending_archive_requests(self, limit=20):
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT t.*, o.op_id AS archive_op_id, o.status AS op_status,
                       o.payload AS op_payload
                FROM tasks t
                JOIN operations o ON o.task_id=t.id
                WHERE o.kind='archive_request'
                  AND o.status IN ('pending','retry','attempting')
                  AND t.review='accepted'
                  AND t.archive IN ('pending','unknown')
                ORDER BY o.updated_at ASC
                LIMIT ?
                """,
                (int(limit),),
            ).fetchall()
            result = []
            for row in rows:
                payload = json.loads(row["op_payload"])
                attempts = int(payload.get("attempts") or 0)
                if row["op_status"] == "retry":
                    if attempts >= 3:
                        continue
                    attempted_at = payload.get("lastAttemptAt")
                    if attempted_at and age_seconds(attempted_at) < min(30, 2 ** (attempts + 1)):
                        continue
                task = _row_dict(row)
                result.append(
                    {
                        "task": task,
                        "opId": row["archive_op_id"],
                        "opStatus": row["op_status"],
                    }
                )
            return result
        finally:
            connection.close()

    def begin_archive_attempt(self, task_id, op_id):
        """Atomically persist ``attempting`` before the single native POST."""
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "archive")
                self._assert_archive_allowed(task)
                if task["review"] != "accepted":
                    raise TransitionError("archive-run requires an accepted review")
                if not task.get("thread_id"):
                    raise TransitionError("archive-run requires a known bound thread")
                if task["archive"] == "archived":
                    return {"alreadyArchived": True, "task": task}
                if task["archive"] == "unknown":
                    raise TransitionError(
                        "archive outcome is unknown; only list reconciliation is allowed"
                    )
                if task["archive"] != "pending":
                    raise TransitionError(
                        "archive-run requires archive=pending; current is %s"
                        % task["archive"]
                    )
                operation = self._existing_op(
                    connection, op_id, task_id, "archive_request"
                )
                if operation is None:
                    raise NotFoundError(
                        "no archive request %s for %s" % (op_id, task_id)
                    )
                payload = _op_public(operation)["payload"]
                if operation["status"] == "attempting":
                    return {
                        "uncertainPriorAttempt": True,
                        "task": task,
                        "attempt": int(payload.get("attempts") or 0),
                    }
                if operation["status"] not in ("pending", "retry"):
                    raise TransitionError(
                        "archive request %s is not runnable (status=%s)"
                        % (op_id, operation["status"])
                    )
                attempts = int(payload.get("attempts") or 0)
                last_outcome = payload.get("lastOutcome")
                if attempts >= 3 and last_outcome in ("not-sent", "rejected"):
                    raise TransitionError(
                        "archive attempt limit reached (3); manual reconciliation required"
                    )
                attempt = attempts + 1
                payload.update(
                    {
                        "attempts": attempt,
                        "lastOutcome": None,
                        "lastAttemptAt": now_iso(),
                        "threadId": task["thread_id"],
                    }
                )
                connection.execute(
                    "UPDATE operations SET status='attempting',payload=?,updated_at=? "
                    "WHERE op_id=?",
                    (json.dumps(payload, ensure_ascii=False), now_iso(), op_id),
                )
                return {
                    "uncertainPriorAttempt": False,
                    "attempt": attempt,
                    "task": task,
                }
        finally:
            connection.close()

    def update_operation(self, op_id, status, extra=None):
        connection = self._connect()
        try:
            with connection:
                row = connection.execute(
                    "SELECT * FROM operations WHERE op_id=?", (op_id,)
                ).fetchone()
                if row is None:
                    raise NotFoundError("unknown operation: %s" % op_id)
                payload = _op_public(row)["payload"]
                if extra:
                    payload.update(extra)
                connection.execute(
                    "UPDATE operations SET status=?,payload=?,updated_at=? WHERE op_id=?",
                    (
                        status,
                        json.dumps(payload, ensure_ascii=False),
                        now_iso(),
                        op_id,
                    ),
                )
                return _op_public(
                    connection.execute(
                        "SELECT * FROM operations WHERE op_id=?", (op_id,)
                    ).fetchone()
                )
        finally:
            connection.close()

    # -------------------------------------------------------------- observing
    def apply_observation(self, task_id, observation, observed_at):
        if not isinstance(observation, dict):
            raise ValidationError("observation must be an object")
        observed_at = normalize_iso(observed_at, "observedAt")
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "observe")
                if task.get("observed_at") and parse_iso(observed_at) < parse_iso(
                    task["observed_at"]
                ):
                    return {"applied": False, "reason": "outdated", "taskId": task_id}
                live = observation.get("live") is True
                live_value = 1 if live else 0
                turn_status = observation.get("turnStatus")
                revision = observation.get("revision")
                turn_id = observation.get("turnId")
                latest_action = observation.get("latestAction") or (
                    "turn:%s" % turn_status if turn_status else ""
                )
                progress = task["progress"]
                if observation.get("assistantText"):
                    progress = clamp_text(observation["assistantText"], PROGRESS_LIMIT)
                # Imported file timestamps do not date a later native message.
                source_at = None
                if observation.get("sourceAt"):
                    try:
                        source_at = normalize_iso(observation["sourceAt"], "sourceAt")
                    except ValidationError:
                        source_at = None
                timestamp = now_iso()
                verified_delivery = ("reported",)

                if turn_status not in TURN_STATUSES:
                    # A successful read with no explicit terminal status is not
                    # completion.  Never let it erase an already verified delivery.
                    error = (
                        "latest turn status missing/unrecognized (live=%s); "
                        "last known delivery retained" % ("true" if live else "false")
                    )
                    execution = (
                        task["execution"]
                        if task["execution"] in verified_delivery
                        else "unknown"
                    )
                    connection.execute(
                        """
                        UPDATE tasks SET execution=?,observed_at=?,source_at=?,
                            source_revision=?,source_turn_id=?,turn_status=?,live=?,
                            last_error=?,progress=?,latest_action=?,updated_at=?
                        WHERE id=?
                        """,
                        (
                            execution,
                            observed_at,
                            source_at,
                            revision,
                            turn_id,
                            turn_status,
                            live_value,
                            error,
                            progress,
                            latest_action,
                            timestamp,
                            task_id,
                        ),
                    )
                    return {
                        "applied": False,
                        "reason": "unknown_turn",
                        "taskId": task_id,
                    }

                if turn_status == "inProgress" and not live:
                    # live=false means no current live owner, not a failed read.
                    # An explicitly completed/failed/interrupted last turn stays
                    # valid; an unowned inProgress turn is unknown/stale instead.
                    error = (
                        "no live owner (live=false, source status=%s) and latest "
                        "turn is inProgress; observation treated unknown/stale"
                        % (observation.get("status") or "unknown")
                    )
                    execution = (
                        task["execution"]
                        if task["execution"] in verified_delivery
                        else "unknown"
                    )
                    connection.execute(
                        """
                        UPDATE tasks SET execution=?,observed_at=?,source_at=?,
                            source_revision=?,source_turn_id=?,turn_status=?,live=0,
                            last_error=?,progress=?,latest_action=?,updated_at=?
                        WHERE id=?
                        """,
                        (
                            execution,
                            observed_at,
                            source_at,
                            revision,
                            turn_id,
                            turn_status,
                            error,
                            progress,
                            latest_action,
                            timestamp,
                            task_id,
                        ),
                    )
                    return {
                        "applied": False,
                        "reason": "no_live_owner",
                        "taskId": task_id,
                    }

                if task["review"] == "accepted":
                    execution = task["execution"]
                else:
                    execution = {
                        "completed": "reported",
                        "inProgress": "running",
                        "failed": "failed",
                        "interrupted": "interrupted",
                    }[turn_status]

                review = task["review"]
                if turn_status == "completed" and (
                    review == "pending" or
                    review == "rejected" and turn_id != task.get("source_turn_id")
                ):
                    review = "awaiting"

                connection.execute(
                    """
                    UPDATE tasks SET execution=?,review=?,observed_at=?,source_at=?,
                        source_revision=?,source_turn_id=?,turn_status=?,live=?,
                        last_error=NULL,progress=?,latest_action=?,poll=1,updated_at=?
                    WHERE id=?
                    """,
                    (
                        execution,
                        review,
                        observed_at,
                        source_at,
                        revision,
                        turn_id,
                        turn_status,
                        live_value,
                        progress,
                        latest_action,
                        timestamp,
                        task_id,
                    ),
                )

                if turn_status == "completed" and review != "accepted":
                    self._notice(
                        connection,
                        task_id,
                        "delivery",
                        "%s 最新回合已完成，等待验收" % task_id,
                        # One delivery per native turn.  A revision bump on the
                        # same completed turn must not notify twice.
                        "delivery:%s:%s" % (task_id, turn_id or "turn-without-id"),
                    )
                elif turn_status in ("failed", "interrupted") and review != "accepted":
                    kind = "blocked"
                    self._notice(
                        connection,
                        task_id,
                        kind,
                        "%s 最新回合状态为 %s" % (task_id, turn_status),
                        "blocked:%s:%s:%s"
                        % (task_id, turn_id or "turn-without-id", turn_status),
                    )
                return {
                    "applied": True,
                    "taskId": task_id,
                    "execution": execution,
                    "review": review,
                    "turnStatus": turn_status,
                }
        finally:
            connection.close()

    def record_observation_error(self, task_id, error, observed_at):
        observed_at = normalize_iso(observed_at, "observedAt")
        message = clamp_text(str(error).replace("\n", " "), 300)
        if not message:
            message = "observation failed"
        connection = self._connect()
        try:
            with connection:
                task = self._require_task(connection, task_id, "observe")
                if task.get("observed_at") and parse_iso(observed_at) < parse_iso(
                    task["observed_at"]
                ):
                    return {"applied": False, "reason": "outdated", "taskId": task_id}
                connection.execute(
                    "UPDATE tasks SET live=0,last_error=?,updated_at=? WHERE id=?",
                    (message, now_iso(), task_id),
                )
                return {"applied": True, "reason": "error_recorded", "taskId": task_id}
        finally:
            connection.close()

    def _notice(self, connection, task_id, kind, message, dedup_key):
        if kind not in NOTICE_KINDS:
            raise ValidationError("invalid notice kind")
        connection.execute(
            """
            INSERT OR IGNORE INTO notices
                (id,task_id,kind,message,dedup_key,created_at,acknowledged_at)
            VALUES (?,?,?,?,?,?,NULL)
            """,
            (uuid.uuid4().hex, task_id, kind, message, dedup_key, now_iso()),
        )

    # ---------------------------------------------------------------- notices
    def consume_notices(self):
        connection = self._connect()
        try:
            rows = connection.execute(
                """
                SELECT * FROM notices WHERE acknowledged_at IS NULL
                ORDER BY created_at ASC LIMIT 200
                """
            ).fetchall()
            return [
                {
                    "id": row["id"],
                    "taskId": row["task_id"],
                    "kind": row["kind"],
                    "message": row["message"],
                    "createdAt": row["created_at"],
                }
                for row in rows
            ]
        finally:
            connection.close()

    def ack_notice(self, notice_id):
        if not isinstance(notice_id, str) or not notice_id.strip():
            raise ValidationError("notice id must be a non-empty string")
        connection = self._connect()
        try:
            with connection:
                row = connection.execute(
                    "SELECT * FROM notices WHERE id=?", (notice_id.strip(),)
                ).fetchone()
                if row is None:
                    raise NotFoundError("unknown notice: %s" % notice_id)
                if row["acknowledged_at"] is None:
                    connection.execute(
                        "UPDATE notices SET acknowledged_at=? WHERE id=?",
                        (now_iso(), notice_id.strip()),
                    )
                return {"acknowledged": True, "id": notice_id.strip()}
        finally:
            connection.close()

    # --------------------------------------------------------------- snapshot
    def _collector_view(self, connection, now):
        pid_value = self._meta(connection, "daemon_pid")
        pid = int(pid_value) if pid_value and str(pid_value).isdigit() else None
        running = False
        if pid:
            try:
                os.kill(pid, 0)
                running = True
            except OSError:
                running = False
        try:
            workers = int(self._meta(connection, "worker_count") or WORKER_COUNT)
        except ValueError:
            workers = WORKER_COUNT
        try:
            interval = float(
                self._meta(connection, "poll_interval_seconds") or POLL_INTERVAL_SECONDS
            )
        except ValueError:
            interval = POLL_INTERVAL_SECONDS
        try:
            inflight = int(self._meta(connection, "inflight") or 0)
        except ValueError:
            inflight = 0
        task_errors = {}
        for row in connection.execute(
            "SELECT id,last_error FROM tasks WHERE last_error IS NOT NULL AND last_error<>''"
        ).fetchall():
            task_errors[row["id"]] = row["last_error"]

        last_poll = self._meta(connection, "last_poll_at")
        connected = bool(
            running
            and last_poll
            and age_seconds(last_poll, now) <= STALE_AFTER_SECONDS
        )
        active_stale = False
        active_rows = connection.execute(
            """
            SELECT id,observed_at,last_error FROM tasks
            WHERE thread_id IS NOT NULL AND external=0 AND read_only=0
              AND poll=1 AND NOT (review='accepted' AND archive='archived')
            """
        ).fetchall()
        for row in active_rows:
            if row["last_error"]:
                active_stale = True
            elif not row["observed_at"]:
                active_stale = True
            elif age_seconds(row["observed_at"], now) > STALE_AFTER_SECONDS:
                active_stale = True

        def _max_observed(rows):
            best = None
            for candidate in rows:
                if not candidate:
                    continue
                if best is None or parse_iso(candidate) > parse_iso(best):
                    best = candidate
            return best

        success_rows = connection.execute(
            """
            SELECT observed_at FROM tasks
            WHERE external=0 AND observed_at IS NOT NULL AND last_error IS NULL
              AND NOT (review='accepted' AND archive='archived')
            """
        ).fetchall()
        observed_rows = connection.execute(
            "SELECT observed_at FROM tasks WHERE external=0 AND observed_at IS NOT NULL"
        ).fetchall()
        last_success = _max_observed([row["observed_at"] for row in success_rows])
        last_observed = _max_observed(
            [row["observed_at"] for row in observed_rows]
        ) or last_poll
        return {
            "source": "native-desktop-bridge",
            "pollIntervalSeconds": interval,
            "workerCount": workers,
            "running": running,
            "pid": pid if running else None,
            "connected": connected,
            "stale": bool(not connected or active_stale),
            "startedAt": self._meta(connection, "daemon_started_at"),
            "lastPollAt": last_poll,
            "lastSuccessAt": last_success,
            "lastObservedAt": last_observed,
            "inFlight": inflight,
            "lastError": self._meta(connection, "collector_error"),
            "taskErrors": task_errors,
        }

    def snapshot(self):
        now = datetime.now(timezone.utc)
        connection = self._connect()
        try:
            tasks = [
                _public_task(_row_dict(row), now)
                for row in connection.execute("SELECT * FROM tasks ORDER BY id").fetchall()
            ]
            for row in connection.execute(
                "SELECT * FROM external_history ORDER BY ordinal"
            ).fetchall():
                observed = row["observed_at"]
                progress = "只读历史快照（%s）：%s；%s；下一步：%s" % (
                    observed,
                    row["status_text"],
                    row["detail"],
                    row["next_step"],
                )
                tasks.append(
                    {
                        "id": row["id"],
                        "title": row["title"],
                        "goal": "只读外部历史快照",
                        "deliverables": [],
                        "acceptance": [],
                        "ownership": [],
                        "authorization": "external historical snapshot; read-only",
                        "threadId": row["thread_id"],
                        "host": "local",
                        "createdAt": observed,
                        "checkpoint": "",
                        "expectedAt": None,
                        "execution": "unknown",
                        "review": "pending",
                        "archive": "none",
                        "observedAt": observed,
                        "sourceAt": observed,
                        "progress": progress,
                        "latestAction": "history:read-only",
                        "evidence": [],
                        "stale": True,
                        "attention": False,
                        "external": True,
                    }
                )
            notices = [
                {
                    "id": row["id"],
                    "taskId": row["task_id"],
                    "kind": row["kind"],
                    "message": row["message"],
                    "createdAt": row["created_at"],
                }
                for row in connection.execute(
                    """
                    SELECT * FROM notices WHERE acknowledged_at IS NULL
                    ORDER BY created_at ASC LIMIT 50
                    """
                ).fetchall()
            ]
            operations = [
                _op_public(row)
                for row in connection.execute(
                    "SELECT * FROM operations ORDER BY created_at DESC,rowid DESC LIMIT 50"
                ).fetchall()
            ]
            collector = self._collector_view(connection, now)
        finally:
            connection.close()
        return {
            "version": VERSION,
            "generatedAt": now.isoformat(timespec="microseconds"),
            "controllerThreadId": self.controller_thread_id,
            "collector": collector,
            "tasks": tasks,
            "notices": notices,
            "operations": operations,
        }

    # --------------------------------------------------------------- markdown
    def export_markdown(self, path, force=False):
        target = os.path.abspath(os.path.expanduser(path))
        source = self.get_meta("import_source")
        if source and os.path.realpath(target) == os.path.realpath(source):
            raise TransitionError("refusing to overwrite the imported source markdown")
        if os.path.exists(target) and not force:
            raise TransitionError(
                "output already exists; pass --force to replace an explicit export"
            )
        snapshot = self.snapshot()
        generated = snapshot["generatedAt"]
        lines = [
            "# Codex Orchestra 任务账本（派生）",
            "",
            "> 由 SQLite 唯一事实源生成，生成时间 %s；请勿手工编辑，也勿把本文件当作实时状态。"
            % generated,
            "> 仅含结构化字段和公开 assistant 进展，不含用户/工具/推理原文。",
            "",
            "| 编号 | 任务与交付物 | 工作对话 | 执行 | 验收 | 归档 | 最近进展 | 检查点 | 证据 |",
            "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ]
        for task in snapshot["tasks"]:
            if task["external"]:
                continue
            thread = (
                "[打开](codex://threads/%s)" % task["threadId"]
                if task["threadId"]
                else "未绑定"
            )
            deliverables = "；".join(task["deliverables"])
            title = task["title"]
            if deliverables:
                title = "%s；交付 %s" % (title, deliverables)
            lines.append(
                "| %s |"
                % " | ".join(
                    _md_cell(value)
                    for value in (
                        task["id"],
                        title,
                        thread,
                        task["execution"],
                        task["review"],
                        task["archive"],
                        task["progress"],
                        task["checkpoint"],
                        "；".join(task["evidence"]),
                    )
                )
            )
        external = [task for task in snapshot["tasks"] if task["external"]]
        if external:
            lines.extend(
                [
                    "",
                    "## 只读外部历史快照",
                    "",
                    "> 这些记录只读、不轮询、不会因观察或验收命令改变；来源时间 %s。"
                    % IMPORT_SOURCE_OBSERVED_AT,
                    "",
                    "| 编号 | 任务 | 状态 | 最新进展 | 下一验收点 |",
                    "| --- | --- | --- | --- | --- |",
                ]
            )
            for task in external:
                lines.append(
                    "| %s |"
                    % " | ".join(
                        _md_cell(value)
                        for value in (
                            task["id"],
                            task["title"],
                            _status_from_progress(task["progress"]),
                            task["progress"],
                            "",
                        )
                    )
                )
        lines.append("")
        return atomic_write(target, "\n".join(lines))


def _status_from_progress(progress):
    match = re.search(r"）：([^；]+)", progress or "")
    return match.group(1) if match else "未知"
