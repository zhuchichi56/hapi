"""Additive v1 receipt/decision schema; installed through the existing factory."""

SCHEMA = """
CREATE TABLE IF NOT EXISTS receipts (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('delivery','blocked','failed','need-input')),
    payload TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    is_test INTEGER NOT NULL CHECK(is_test IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_receipts_task ON receipts(task_id, received_at);
CREATE TABLE IF NOT EXISTS receipt_reviews (
    review_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES receipts(event_id),
    payload TEXT NOT NULL,
    reviewed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_receipt_reviews ON receipt_reviews(event_id, reviewed_at);
CREATE TABLE IF NOT EXISTS receipt_outbox (
    event_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    lease_until TEXT,
    next_attempt_at TEXT NOT NULL,
    last_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_test INTEGER NOT NULL CHECK(is_test IN (0,1))
);
CREATE TABLE IF NOT EXISTS receipt_wakes (
    event_id TEXT PRIMARY KEY REFERENCES receipts(event_id),
    status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown','failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    claim_token TEXT,
    lease_until TEXT,
    next_attempt_at TEXT NOT NULL,
    last_code TEXT,
    native_turn_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_test INTEGER NOT NULL CHECK(is_test IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_receipt_outbox_recovery ON receipt_outbox(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_receipt_wakes_recovery ON receipt_wakes(status, updated_at);
CREATE TABLE IF NOT EXISTS receipt_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue TEXT NOT NULL,
    event_id TEXT NOT NULL,
    claim_token TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('sending','sent','unknown','failed')),
    code TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS decisions (
    decision_id TEXT PRIMARY KEY,
    receipt_id TEXT NOT NULL REFERENCES receipts(event_id),
    task_id TEXT NOT NULL,
    stage_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','decided','action-pending','verified')),
    disposition TEXT NOT NULL CHECK(disposition IN ('active','rework','revoked')),
    authority TEXT NOT NULL CHECK(authority IN ('controller','user','external')),
    decision_required INTEGER NOT NULL CHECK(decision_required=1),
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    first_decided_at TEXT,
    updated_at TEXT NOT NULL,
    is_test INTEGER NOT NULL CHECK(is_test IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_decisions_state ON decisions(state, authority, updated_at);
CREATE TABLE IF NOT EXISTS decision_revisions (
    decision_id TEXT NOT NULL REFERENCES decisions(decision_id),
    revision INTEGER NOT NULL,
    payload TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY(decision_id, revision)
);
"""
