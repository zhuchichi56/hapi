"""Private verification candidate queue, additive to the existing SQLite factory."""

JOBS_SQL = """
CREATE TABLE IF NOT EXISTS verification_jobs (
    event_id TEXT PRIMARY KEY REFERENCES receipts(event_id),
    state TEXT NOT NULL CHECK(state IN ('queued','claimed','dispatching','running','reconciliation-needed','submitted','failed','controller-reviewed')),
    priority INTEGER NOT NULL DEFAULT 0 CHECK(priority BETWEEN 0 AND 10),
    revision INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
    token TEXT,
    owner TEXT,
    lease_until TEXT,
    eligible_at TEXT NOT NULL,
    first_claim_at TEXT,
    first_dispatch_at TEXT,
    first_start_at TEXT,
    candidate_finished_at TEXT,
    candidate TEXT,
    last_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    is_test INTEGER NOT NULL CHECK(is_test IN (0,1))
);
"""

SCHEMA = JOBS_SQL + """
CREATE INDEX IF NOT EXISTS idx_verification_ready ON verification_jobs(state,eligible_at,created_at);
CREATE TABLE IF NOT EXISTS verification_runs (
    token TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES verification_jobs(event_id),
    dispatch_id TEXT NOT NULL UNIQUE,
    execution_id TEXT,
    state TEXT NOT NULL CHECK(state IN ('dispatching','active','unknown','completed','stopped')),
    dispatch_at TEXT NOT NULL,
    started_at TEXT,
    result_at TEXT,
    evidence TEXT NOT NULL DEFAULT '[]',
    provenance TEXT NOT NULL DEFAULT 'untrusted-local-operator-claim'
);
CREATE INDEX IF NOT EXISTS idx_verification_runs_event ON verification_runs(event_id,dispatch_at);
CREATE TABLE IF NOT EXISTS verification_history (
    event_id TEXT NOT NULL REFERENCES verification_jobs(event_id),
    revision INTEGER NOT NULL,
    action TEXT NOT NULL,
    request TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    PRIMARY KEY(event_id,revision)
);
"""


def migrate(connection):
    """Expand the candidate-v1 CHECK without losing jobs, run FKs or history."""
    def needs_upgrade():
        row = connection.execute("SELECT sql FROM sqlite_master WHERE name='verification_jobs'").fetchone()
        return row and "'controller-reviewed'" not in row['sql']
    if not needs_upgrade():
        return
    foreign_keys = connection.execute('PRAGMA foreign_keys').fetchone()[0]
    synchronous = connection.execute('PRAGMA synchronous').fetchone()[0]
    connection.execute('PRAGMA foreign_keys=OFF')
    connection.execute('PRAGMA synchronous=FULL')
    try:
        connection.execute('BEGIN IMMEDIATE')
        if needs_upgrade():
            connection.execute(JOBS_SQL.replace('verification_jobs (', 'verification_jobs_upgrade (', 1))
            connection.execute('INSERT INTO verification_jobs_upgrade SELECT * FROM verification_jobs')
            connection.execute('DROP TABLE verification_jobs')
            connection.execute('ALTER TABLE verification_jobs_upgrade RENAME TO verification_jobs')
            connection.execute('CREATE INDEX idx_verification_ready ON verification_jobs(state,eligible_at,created_at)')
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.execute('PRAGMA foreign_keys=%d' % foreign_keys)
        connection.execute('PRAGMA synchronous=%d' % synchronous)
