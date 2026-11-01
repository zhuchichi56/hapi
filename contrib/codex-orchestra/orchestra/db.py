"""SQLite schema and connection factory (WAL, short transactions)."""

import os
import sqlite3

from .util import chmod_private, ensure_state_dir

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
    poll INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_tasks_review ON tasks(review);
CREATE INDEX IF NOT EXISTS idx_tasks_archive ON tasks(archive);

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

CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def connect(state_dir):
    """Open a private WAL connection. Callers keep transactions short."""
    directory = ensure_state_dir(state_dir)
    path = os.path.join(directory, "orchestra.db")
    connection = sqlite3.connect(path, timeout=5.0)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    connection.execute("PRAGMA synchronous=NORMAL")
    connection.executescript(SCHEMA)
    for suffix in ("", "-wal", "-shm"):
        candidate = path + suffix
        if os.path.exists(candidate):
            chmod_private(candidate)
    return connection
