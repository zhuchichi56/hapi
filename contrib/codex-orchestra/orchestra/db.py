"""SQLite schema and connection factory (WAL, short transactions)."""

import json
import os
import sqlite3

from .util import chmod_private, ensure_state_dir, parse_iso
from .receipt_schema import SCHEMA as RECEIPT_SCHEMA
from .review_schema import SCHEMA as REVIEW_SCHEMA
from .review_schema import migrate as migrate_review

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    goal TEXT NOT NULL DEFAULT '',
    deliverables TEXT NOT NULL DEFAULT '[]',
    acceptance TEXT NOT NULL DEFAULT '[]',
    ownership TEXT NOT NULL DEFAULT '[]',
    authorization TEXT NOT NULL DEFAULT '',
    thread_id TEXT,
    host TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL,
    checkpoint TEXT NOT NULL DEFAULT '',
    expected_at TEXT,
    execution TEXT NOT NULL DEFAULT 'queued',
    review TEXT NOT NULL DEFAULT 'pending',
    archive TEXT NOT NULL DEFAULT 'none',
    observed_at TEXT,
    source_at TEXT,
    progress TEXT NOT NULL DEFAULT '',
    latest_action TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    external INTEGER NOT NULL DEFAULT 0,
    read_only INTEGER NOT NULL DEFAULT 0,
    source_revision TEXT,
    source_turn_id TEXT,
    turn_status TEXT,
    live INTEGER,
    last_error TEXT,
    delivery_turn_id TEXT,
    accepted_turn_id TEXT,
    rejected_turn_id TEXT,
    reviewed_turns TEXT NOT NULL DEFAULT '[]',
    adoption_baseline_turn_id TEXT,
    poll INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_review ON tasks(review);
CREATE INDEX IF NOT EXISTS idx_tasks_archive ON tasks(archive);

CREATE TABLE IF NOT EXISTS task_sessions (
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '',
    responsibility_status TEXT NOT NULL DEFAULT 'active',
    host TEXT NOT NULL DEFAULT 'local',
    execution TEXT NOT NULL DEFAULT 'unknown',
    review TEXT NOT NULL DEFAULT 'pending',
    archive TEXT NOT NULL DEFAULT 'none',
    observed_at TEXT,
    source_revision TEXT,
    source_turn_id TEXT,
    turn_status TEXT,
    live INTEGER,
    delivery_turn_id TEXT,
    accepted_turn_id TEXT,
    baseline_turn_id TEXT,
    baseline_pending INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, session_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_thread ON task_sessions(thread_id);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON task_sessions(task_id);

CREATE TABLE IF NOT EXISTS operations (
    op_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    payload TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operations_task ON operations(task_id);

CREATE TABLE IF NOT EXISTS notices (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    dedup_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    acknowledged_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_notices_ack ON notices(acknowledged_at);

CREATE TABLE IF NOT EXISTS external_history (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status_text TEXT NOT NULL,
    detail TEXT NOT NULL,
    next_step TEXT NOT NULL,
    thread_id TEXT,
    observed_at TEXT NOT NULL,
    ordinal INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_history (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id, created_at);

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

# Columns added after the first deployed schema.  They are added in place so a
# restarted collector can keep using an existing private state directory.
LIFECYCLE_COLUMNS = (
    ("delivery_turn_id", "TEXT"),
    ("accepted_turn_id", "TEXT"),
    ("rejected_turn_id", "TEXT"),
    ("reviewed_turns", "TEXT NOT NULL DEFAULT '[]'"),
)

# Adopted external tasks carry the old native turn that must not be reported as
# a new delivery.  Kept separate from LIFECYCLE_COLUMNS so a v2 ledger only adds
# this column and never re-runs the legacy review backfill.
ADOPTION_COLUMNS = (("adoption_baseline_turn_id", "TEXT"),)


def _migrate(connection):
    """Add lifecycle columns and bind legacy rows only on explicit evidence.

    Older rows only stored the observation cursor (``source_turn_id``), and the
    old collector advanced that cursor on ``inProgress``.  A cursor that moved
    after the last recorded review therefore does not identify the reviewed
    turn.  Migration binds a turn only when:

    * the cursor's terminal status agrees with the review (completed for
      accept, completed/failed/interrupted for reject), and
    * the cursor observation is not newer than the recorded review operation.

    Otherwise the old review/evidence is retained but no turn is invented; the
    next completed turn then enters ``awaiting`` normally.
    """
    existing = {
        row[1] for row in connection.execute("PRAGMA table_info(tasks)").fetchall()
    }
    lifecycle_missing = [
        item for item in LIFECYCLE_COLUMNS if item[0] not in existing
    ]
    adoption_missing = [
        item for item in ADOPTION_COLUMNS if item[0] not in existing
    ]
    if not lifecycle_missing and not adoption_missing:
        return
    with connection:
        connection.execute("BEGIN IMMEDIATE")
        # Recheck after the writer lock: another CLI may have migrated while
        # this connection waited. Keep the migration atomic across both groups.
        existing = {row[1] for row in connection.execute("PRAGMA table_info(tasks)")}
        lifecycle_missing = [item for item in LIFECYCLE_COLUMNS if item[0] not in existing]
        adoption_missing = [item for item in ADOPTION_COLUMNS if item[0] not in existing]
        for name, affinity in adoption_missing:
            connection.execute("ALTER TABLE tasks ADD COLUMN %s %s" % (name, affinity))
        if not lifecycle_missing:
            return
        for name, affinity in lifecycle_missing:
            connection.execute("ALTER TABLE tasks ADD COLUMN %s %s" % (name, affinity))
        review_times = {}
        for row in connection.execute(
            """
            SELECT task_id,MAX(created_at) AS created_at FROM operations
            WHERE kind='review' GROUP BY task_id
            """
        ).fetchall():
            review_times[row["task_id"]] = row["created_at"]

        for row in connection.execute(
            """
            SELECT id,review,execution,turn_status,source_turn_id,observed_at,
                   accepted_turn_id,rejected_turn_id,delivery_turn_id,
                   reviewed_turns FROM tasks
            """
        ).fetchall():
            turn = row["source_turn_id"]
            status = row["turn_status"]
            review = row["review"]
            reviewed_at = review_times.get(row["id"])
            corresponds = False
            if turn and row["observed_at"] and reviewed_at:
                try:
                    corresponds = parse_iso(row["observed_at"]) <= parse_iso(
                        reviewed_at
                    )
                except Exception:
                    corresponds = False
            # A repeated collection may advance observed_at past the review even
            # though the reviewed completed turn is unchanged.  The delivery
            # notice written for that turn, before the review, is persistent
            # evidence tying the cursor to the accepted delivery.  Only a
            # completed cursor equal to that notice's turn qualifies; a newer
            # turn or an inProgress cursor never does.
            notice_turn = None
            if (
                reviewed_at
                and turn
                and row["review"] == "accepted"
                and status == "completed"
            ):
                notice = connection.execute(
                    """
                    SELECT dedup_key FROM notices
                    WHERE task_id=? AND kind='delivery' AND created_at<?
                    ORDER BY created_at DESC, rowid DESC LIMIT 1
                    """,
                    (row["id"], reviewed_at),
                ).fetchone()
                prefix = "delivery:%s:" % row["id"]
                if notice is not None and notice["dedup_key"].startswith(prefix):
                    notice_turn = notice["dedup_key"][len(prefix):]
            notice_corresponds = bool(turn and notice_turn == turn)
            accepted = row["accepted_turn_id"]
            rejected = row["rejected_turn_id"]
            delivery = row["delivery_turn_id"]
            if turn and (corresponds or notice_corresponds):
                if accepted is None and review == "accepted" and status == "completed":
                    accepted = turn
                if (
                    rejected is None
                    and review == "rejected"
                    and status in ("completed", "failed", "interrupted")
                ):
                    rejected = turn
                if delivery is None and status == "completed":
                    delivery = turn
            elif (
                delivery is None
                and status == "completed"
                and review in ("pending", "awaiting")
            ):
                delivery = turn

            try:
                original = json.loads(row["reviewed_turns"] or "[]")
            except (TypeError, ValueError):
                original = []
            if not isinstance(original, list):
                original = []
            reviewed = [str(item) for item in original]
            for candidate in (accepted, rejected):
                if candidate and candidate not in reviewed:
                    reviewed.append(candidate)
            if (
                accepted != row["accepted_turn_id"]
                or rejected != row["rejected_turn_id"]
                or delivery != row["delivery_turn_id"]
                or reviewed != original
            ):
                connection.execute(
                    """
                    UPDATE tasks SET accepted_turn_id=?,rejected_turn_id=?,
                        delivery_turn_id=?,reviewed_turns=? WHERE id=?
                    """,
                    (
                        accepted,
                        rejected,
                        delivery,
                        json.dumps(reviewed),
                        row["id"],
                    ),
                )
        connection.execute(
            "INSERT INTO meta(key,value) VALUES('lifecycle_migration','v2') "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
        )


def connect(state_dir):
    """Open a private WAL connection. Callers keep transactions short."""
    directory = ensure_state_dir(state_dir)
    path = os.path.join(directory, "orchestra.db")
    connection = sqlite3.connect(path, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(SCHEMA + RECEIPT_SCHEMA + REVIEW_SCHEMA)
    migrate_review(connection)
    _migrate(connection)
    for suffix in ("", "-wal", "-shm"):
        candidate = path + suffix
        if os.path.exists(candidate):
            chmod_private(candidate)
    return connection
