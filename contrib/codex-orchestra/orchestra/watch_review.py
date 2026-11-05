"""Local controller reviews of delivered file-mtime stages; never writes markers.

Only file metadata is inspected. Decisions live in the ledger transaction;
projection is read-only and tolerates a ledger with no watch_reviews table.
"""

import json
import os
import stat

from .errors import NotFoundError, TransitionError, ValidationError
from .util import now_iso


def _text(value, label):
    if not isinstance(value, str) or not value.strip():
        raise ValidationError('%s must be non-empty text' % label)
    return value.strip()


def _file(value, label):
    path = os.path.abspath(os.path.expanduser(_text(value, label)))
    try:
        info = os.stat(path)
    except OSError as exc:
        raise ValidationError('%s must reference an existing file' % label) from exc
    if not stat.S_ISREG(info.st_mode):
        raise ValidationError('%s must reference a regular file' % label)
    return path, info


def _source(ledger, task_id):
    path = os.path.join(ledger.state_dir, 'watchdog-sources.json')
    try:
        with open(path, encoding='utf-8') as handle:
            sources = json.load(handle)
    except (OSError, ValueError) as exc:
        raise ValidationError('watchdog-sources.json must be an existing JSON object') from exc
    spec = sources.get(task_id) if isinstance(sources, dict) else None
    if not isinstance(spec, dict):
        raise NotFoundError('unknown watch source: %s' % task_id)
    if spec.get('kind') != 'file-mtime':
        raise ValidationError('watch-review requires a file-mtime source')
    return spec


def stage(spec):
    """Identity of the exact delivered marker, or None before delivery/removal."""
    watched, _ = _file(spec.get('path'), 'source path')
    if not spec.get('doneFile'):
        return None
    try:
        done, info = _file(spec['doneFile'], 'doneFile')
    except ValidationError:
        return None
    return dict(path=watched, doneFile=done, mtime_ns=info.st_mtime_ns, size=info.st_size)


def _decisions(connection, task_id):
    if not connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='watch_reviews'").fetchone():
        return []
    return [json.loads(row['payload']) for row in connection.execute(
        'SELECT payload FROM watch_reviews WHERE task_id=? ORDER BY rowid DESC', (task_id,))]


def _view(connection, task_id, spec, identity):
    decisions = _decisions(connection, task_id)
    current = next((item for item in decisions if item['stage'] == identity), None) if identity else None
    # Legacy acceptedFile remains compatible only until an explicit stage review
    # exists. An old marker must never mask a new stage after explicit review.
    legacy = not decisions and bool(spec.get('acceptedFile')) and os.path.exists(spec['acceptedFile'])
    return dict(taskId=task_id, source=spec, stage=identity,
                execution='reported' if identity else 'running',
                review=current['result'] if current else ('accepted' if legacy else ('awaiting' if identity else 'pending')),
                decision=current, latestDecision=decisions[0] if decisions else None)


def status(ledger, task_id):
    spec = _source(ledger, task_id)
    identity = stage(spec)
    with ledger._receipt_tx(write=False) as connection:
        return _view(connection, task_id, spec, identity)


def projection(ledger, task_id, spec):
    """Read-only hook for Watchdog._watch_tasks; no schema or marker creation."""
    identity = stage(spec)
    with ledger._receipt_tx(write=False) as connection:
        view = _view(connection, task_id, spec, identity)
    return dict(review=view['review'], watchReview=view['decision'],
                latestWatchReview=view['latestDecision'], watchStage=identity,
                deliveryTurnId=json.dumps(identity, sort_keys=True) if identity else None,
                goal=spec.get('goal', ''), gaps=spec.get('gaps', []))


def validate_evidence_refs(evidence_refs):
    if not isinstance(evidence_refs, list) or not evidence_refs:
        raise ValidationError('--evidence-ref requires existing evidence files')
    refs = [_file(ref, '--evidence-ref')[0] for ref in evidence_refs]
    if any(not os.access(ref, os.R_OK) for ref in refs):
        raise ValidationError('--evidence-ref must be readable')
    return refs


def record(ledger, task_id, result, reason, evidence_refs, op_id, *, actor):
    ledger._authorize_review(actor)
    if result not in ('accepted', 'rejected'):
        raise ValidationError('watch review result must be accepted or rejected')
    reason = _text(reason, '--evidence')
    op_id = _text(op_id, '--op-id')
    refs = validate_evidence_refs(evidence_refs)
    spec = _source(ledger, task_id)
    identity = stage(spec)
    if identity is None:
        raise TransitionError('watch-review requires an existing doneFile/current delivered stage')
    request = dict(taskId=task_id, result=result, actor=actor, reason=reason,
                   evidence_ref=refs, stage=identity, source=spec, opId=op_id)
    with ledger._receipt_tx() as connection:
        if connection.execute('SELECT 1 FROM tasks WHERE id=?', (task_id,)).fetchone():
            raise TransitionError('watch-review is for watch-only sources; use review for ledger tasks')
        previous = ledger._existing_op(connection, op_id, task_id, 'watch_review')
        if previous is not None:
            payload = json.loads(previous['payload'])
            if {k: v for k, v in payload.items() if k != 'createdAt'} != request:
                raise TransitionError('op-id payload conflict for watch-review: %s' % op_id)
            return dict(reused=True, decision=payload)
        # Recheck source and marker after acquiring the ledger writer lock.
        if _source(ledger, task_id) != spec or stage(spec) != identity:
            raise TransitionError('watch source or delivered stage changed during review; retry after inspection')
        connection.execute('CREATE TABLE IF NOT EXISTS watch_reviews ('
                           'op_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL)')
        payload = dict(request, createdAt=now_iso())
        ledger._insert_op(connection, op_id, task_id, 'watch_review', 'recorded', payload)
        connection.execute('INSERT INTO watch_reviews(op_id,task_id,payload) VALUES(?,?,?)',
                           (op_id, task_id, json.dumps(payload, ensure_ascii=False)))
        return dict(reused=False, decision=payload)
