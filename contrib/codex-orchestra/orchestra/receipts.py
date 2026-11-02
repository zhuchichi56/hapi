"""Durable receipt inbox and controller-only decision interface v1.

All access uses Ledger's connection factory and task guards. The private local
operator is the trust boundary: actor IDs are assertions by that trusted caller,
not authentication tokens. No mutation is exposed by the HTTP snapshot server.
"""

import json
import math
import re
import uuid
from contextlib import contextmanager

from .constants import CONTROLLER_THREAD_ID
from .decision_projection import CLOCK, elapsed, project, safe_display
from .errors import NotFoundError, TransitionError, ValidationError
from .util import normalize_iso, now_iso, parse_iso

KINDS = ('delivery', 'blocked', 'failed', 'need-input')
STATES = ('pending', 'decided', 'action-pending', 'verified')
MAX_ATTEMPTS = 3
LEASE_SECONDS = 30
RETRY_SECONDS = 2
ID_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,159}$')


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def text(value, field, limit=1200):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValidationError('%s must be nonempty text (max %d)' % (field, limit))
    if any(ord(c) < 32 and c not in '\n\t' for c in value):
        raise ValidationError('%s contains control characters' % field)
    return value


def ident(value, field):
    if not isinstance(value, str) or not ID_RE.fullmatch(value):
        raise ValidationError('%s must be a stable identifier (max 160)' % field)
    return value


def evidence(value, field='evidence'):
    if not isinstance(value, list) or not value or len(value) > 50:
        raise ValidationError('%s requires 1..50 evidence references' % field)
    return [text(item, field, 1000) for item in value]


def fields(data, allowed, required=()):
    if not isinstance(data, dict):
        raise ValidationError('payload must be an object')
    if set(data) - set(allowed) or set(required) - set(data):
        raise ValidationError('unexpected or missing payload fields')


def normalize_receipt(data):
    required = ('eventId', 'taskId', 'sessionId', 'turnId', 'kind', 'occurredAt',
                'checklist', 'limitations', 'summary', 'source')
    fields(data, required, required)
    result = {key: ident(data[key], key) for key in ('eventId', 'taskId', 'sessionId', 'turnId')}
    if data['kind'] not in KINDS:
        raise ValidationError('invalid receipt kind')
    result.update(kind=data['kind'], occurredAt=normalize_iso(data['occurredAt'], 'occurredAt'),
                  summary=text(data['summary'], 'summary', 500), source=ident(data['source'], 'source'))
    checklist = data['checklist']
    if not isinstance(checklist, list) or len(checklist) > 100:
        raise ValidationError('checklist must contain at most 100 requirements')
    result['checklist'] = []
    for item in checklist:
        fields(item, ('requirement', 'status', 'evidence'), ('requirement', 'status', 'evidence'))
        if item['status'] not in ('pass', 'fail', 'unverified'):
            raise ValidationError('invalid checklist status')
        refs = item['evidence']
        if not isinstance(refs, list) or len(refs) > 50:
            raise ValidationError('invalid checklist evidence')
        refs = [text(ref, 'evidence', 1000) for ref in refs]
        if item['status'] == 'pass' and not refs:
            raise ValidationError('pass requires evidence')
        result['checklist'].append(dict(requirement=text(item['requirement'], 'requirement', 500),
                                        status=item['status'], evidence=refs))
    if not isinstance(data['limitations'], list) or len(data['limitations']) > 50:
        raise ValidationError('limitations must be a list of at most 50 strings')
    result['limitations'] = [text(item, 'limitation', 1000) for item in data['limitations']]
    return result


def authorize(actor):
    if actor != CONTROLLER_THREAD_ID:
        raise TransitionError('only the authorized controller may record review/decisions')


class ReceiptDecisionMixin:
    def _receipt_now(self):
        return now_iso()

    @contextmanager
    def _receipt_tx(self, write=True):
        connection = self._connect()
        try:
            # FULL sync before BEGIN makes receipt/outbox ACK durable in the WAL,
            # retaining the installed connection factory and private permissions.
            if write:
                connection.execute('PRAGMA synchronous=FULL')
            connection.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield connection
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()

    def _receipt_initialize(self, test_mode):
        if not isinstance(test_mode, bool):
            raise ValidationError('test_mode must be boolean')
        with self._receipt_tx() as connection:
            mode = self._meta(connection, 'receipt_decision_mode')
            if mode and mode != 'test' and test_mode:
                raise TransitionError('test_mode requires a separate empty test ledger')
            if not mode:
                if test_mode and connection.execute('SELECT 1 FROM tasks LIMIT 1').fetchone():
                    raise TransitionError('test_mode requires a separate empty test ledger')
                mode = 'test' if test_mode else 'production'
                self._set_meta(connection, 'receipt_decision_mode', mode)
                self._set_meta(connection, 'receipt_decision_coverage_start', self._receipt_now())
            if not self._meta(connection, 'receipt_decision_coverage_start'):
                self._set_meta(connection, 'receipt_decision_coverage_start', self._receipt_now())
            self._set_meta(connection, 'receipt_decision_schema', '1')
            self.receipt_test_mode = mode == 'test'

    def _receipt_task(self, connection, payload):
        task = self._require_task(connection, payload['taskId'], 'receipt')
        session = payload['sessionId']
        if task.get('thread_id') != session:
            row = connection.execute(
                'SELECT responsibility_status FROM task_sessions WHERE task_id=? AND session_id=?',
                (payload['taskId'], session)).fetchone()
            if row is None or row['responsibility_status'] == 'ended':
                raise TransitionError('receipt session is not an active task session')
        if session == CONTROLLER_THREAD_ID or payload['source'] == CONTROLLER_THREAD_ID:
            raise TransitionError('controller cannot submit a worker receipt')
        return task

    def receive_receipt(self, data, *, wake_adapter=None, wake_mode=None):
        # Passing an explicit adapter retains the old synchronous API. Passive
        # production receive (including LedgerReceiver) defaults to durable ACK.
        if wake_mode is None:
            wake_mode = 'sync' if wake_adapter is not None else 'durable'
        if wake_mode not in ('durable', 'sync'):
            raise ValidationError('wake_mode must be durable or sync')
        payload = normalize_receipt(data)
        event = payload['eventId']
        raw = encoded(payload)
        with self._receipt_tx() as connection:
            current = connection.execute('SELECT * FROM receipts WHERE event_id=?', (event,)).fetchone()
            reused = current is not None
            if reused:
                if current['payload'] != raw:
                    raise TransitionError('receipt eventId payload collision')
                received_at = current['received_at']
            else:
                self._receipt_task(connection, payload)
                received_at = self._receipt_now()
                if not self._meta(connection, 'receipt_decision_statistics_start'):
                    self._set_meta(connection, 'receipt_decision_statistics_start', received_at)
                connection.execute(
                    'INSERT INTO receipts VALUES (?,?,?,?,?,?,?,?,?)',
                    (event, payload['taskId'], payload['sessionId'], payload['turnId'], payload['kind'],
                     raw, payload['occurredAt'], received_at, int(self.receipt_test_mode)))
                notice_kind = 'delivery' if payload['kind'] == 'delivery' else 'blocked'
                task = connection.execute('SELECT thread_id FROM tasks WHERE id=?', (payload['taskId'],)).fetchone()
                # Match the installed collector's main-turn delivery dedup key.
                dedup = ('delivery:%s:%s' % (payload['taskId'], payload['turnId'])
                         if notice_kind == 'delivery' and task['thread_id'] == payload['sessionId']
                         else 'receipt:%s' % event)
                # Inbox contains a bounded locator, never raw native content.
                self._notice(connection, payload['taskId'], notice_kind,
                             '%s receipt %s (%s); controller review required' %
                             (payload['taskId'], event, payload['kind']), dedup)
                connection.execute(
                    'INSERT INTO receipt_wakes(event_id,status,next_attempt_at,created_at,updated_at,is_test) '
                    "VALUES (?,'pending',?,?,?,?)",
                    (event, received_at, received_at, received_at, int(self.receipt_test_mode)))
                from .review_queue import enqueue
                enqueue(connection, event, received_at, self.receipt_test_mode)
        # The durable receive transaction has committed before any native I/O.
        adapter = wake_adapter if wake_adapter is not None else self.wake_adapter
        if wake_mode == 'sync' and adapter is None and not self.receipt_test_mode:
            from .receipt_delivery import NativeWakeAdapter
            adapter = NativeWakeAdapter()
        ack = dict(ok=True, ack='durable-received', eventId=event, receiptId=event,
                   receivedAt=received_at, reused=reused, acceptedReview=False)
        ack['wakeMode'] = wake_mode
        if wake_mode == 'sync' and adapter is not None:
            try:
                ack['wake'] = self.dispatch_wake(event, adapter)
            except TransitionError:
                ack['wakeError'] = 'wake-policy-rejected'
            except Exception:
                # ACK still means durable receive. Persisted claims recover as
                # unknown; never turn a transport problem into worker replay.
                ack['wakeError'] = 'wake-dispatch-error'
        return ack

    def get_receipt(self, event_id):
        event_id = ident(event_id, 'eventId')
        with self._receipt_tx(False) as connection:
            row = connection.execute('SELECT * FROM receipts WHERE event_id=?', (event_id,)).fetchone()
            if row is None:
                return None
            result = json.loads(row['payload'])
            result.update(receiptId=event_id, receivedAt=row['received_at'], isTest=bool(row['is_test']))
            reviews = connection.execute(
                'SELECT payload FROM receipt_reviews WHERE event_id=? ORDER BY reviewed_at, rowid',
                (event_id,)).fetchall()
            result['reviews'] = [json.loads(review['payload']) for review in reviews]
            return result

    def review_receipt(self, event_id, data, *, actor_id):
        authorize(actor_id)
        fields(data, ('reviewId', 'result', 'evidence'), ('reviewId', 'result', 'evidence'))
        review_id = ident(data['reviewId'], 'reviewId')
        if data['result'] not in ('accepted', 'rejected', 'needs-rework'):
            raise ValidationError('invalid receipt review result')
        record = dict(reviewId=review_id, receiptId=ident(event_id, 'eventId'),
                      result=data['result'], evidence=evidence(data['evidence']), reviewerId=actor_id)
        with self._receipt_tx() as connection:
            row = connection.execute('SELECT * FROM receipts WHERE event_id=?', (event_id,)).fetchone()
            if row is None:
                raise NotFoundError('unknown receipt')
            self._require_task(connection, row['task_id'], 'receipt-review')
            worker = json.loads(row['payload'])
            if actor_id in (worker['sessionId'], worker['source']):
                raise TransitionError('worker cannot review its own receipt')
            previous = connection.execute('SELECT payload FROM receipt_reviews WHERE review_id=?',
                                          (review_id,)).fetchone()
            if previous:
                saved = json.loads(previous['payload'])
                if {k: v for k, v in saved.items() if k != 'reviewedAt'} != record:
                    raise TransitionError('reviewId payload collision')
                from .review_queue import retire_reviewed
                retire_reviewed(connection, self._receipt_now(), event_id)
                return saved
            record['reviewedAt'] = self._receipt_now()
            connection.execute('INSERT INTO receipt_reviews VALUES (?,?,?,?)',
                               (review_id, event_id, encoded(record), record['reviewedAt']))
            from .review_queue import retire_reviewed
            retire_reviewed(connection, record['reviewedAt'], event_id)
        return record

    # Queue operations are implemented in a separate module to share one crash-
    # safe claim protocol between worker delivery and controller wake.
    def enqueue_receipt(self, data):
        from .receipt_delivery import enqueue
        return enqueue(self, data)

    def dispatch_receipt(self, event_id, receiver):
        from .receipt_delivery import dispatch_receipt
        return dispatch_receipt(self, event_id, receiver)

    def dispatch_wake(self, event_id, adapter):
        from .receipt_delivery import dispatch_wake
        return dispatch_wake(self, event_id, adapter)

    def delivery_status(self, event_id, *, queue='receipt'):
        from .receipt_delivery import status
        return status(self, event_id, queue)

    def drain_receipts(self, *, receiver=None, wake_adapter=None, limit=20):
        from .receipt_delivery import drain
        return drain(self, receiver=receiver, wake_adapter=wake_adapter, limit=limit)

    def create_decision(self, data, *, actor_id):
        authorize(actor_id)
        required = ('decisionId', 'receiptId', 'taskId', 'stageId', 'sessionId', 'turnId',
                    'decisionRequired', 'authority', 'trigger', 'options', 'owner', 'dueAt')
        fields(data, required + ('publicDisplay',), required)
        record = {key: ident(data[key], key) for key in
                  ('decisionId', 'receiptId', 'taskId', 'stageId', 'sessionId', 'turnId', 'owner')}
        if data['decisionRequired'] is not True:
            raise ValidationError('ordinary notifications are not decisions')
        if data['authority'] not in ('controller', 'user', 'external'):
            raise ValidationError('invalid decision authority')
        options = data['options']
        if not isinstance(options, list) or not 2 <= len(options) <= 20:
            raise ValidationError('decision requires 2..20 options')
        options = [text(option, 'option', 500) for option in options]
        if len(set(options)) != len(options):
            raise ValidationError('decision options must be distinct')
        record.update(publicDisplay=safe_display(data.get('publicDisplay')), decisionRequired=True, authority=data['authority'],
                      trigger=text(data['trigger'], 'trigger'), options=options,
                      dueAt=normalize_iso(data['dueAt'], 'dueAt') if data['dueAt'] is not None else None)
        with self._receipt_tx() as connection:
            current = connection.execute('SELECT payload FROM decisions WHERE decision_id=?',
                                         (record['decisionId'],)).fetchone()
            if current:
                saved = json.loads(current['payload'])
                initial = connection.execute('SELECT payload FROM decision_revisions WHERE decision_id=? AND revision=1',
                                             (record['decisionId'],)).fetchone()
                if any(json.loads(initial['payload'])[key] != value for key, value in record.items()):
                    raise TransitionError('decisionId payload collision; use revision API')
                return saved
            self._require_task(connection, record['taskId'], 'decision')
            receipt = connection.execute('SELECT * FROM receipts WHERE event_id=?', (record['receiptId'],)).fetchone()
            if receipt is None:
                raise NotFoundError('decision requires a durable receipt')
            if (receipt['task_id'], receipt['session_id'], receipt['turn_id']) != (
                    record['taskId'], record['sessionId'], record['turnId']):
                raise TransitionError('decision receipt/task/session/turn linkage mismatch')
            if not connection.execute('SELECT 1 FROM receipt_reviews WHERE event_id=?',
                                      (record['receiptId'],)).fetchone():
                raise TransitionError('independent controller receipt review required first')
            now = self._receipt_now()
            record.update(state='pending', disposition='active', revision=1, createdAt=now,
                          updatedAt=now, recordedAt=now, triggeredAt=receipt['received_at'], triggerBasis='receipt-received',
                          clock=CLOCK, pendingSince=receipt['received_at'], firstDecidedAt=None, latestDecidedAt=None, decidedAt=None, controllerChoice=None,
                          reason=None, nextAction=None, decidedBy=None, authorityEvidence=[],
                          actionPendingAt=None, actionConfirmedAt=None, executionConfirmedBy=None, executionEvidence=[],
                          executionReceiptId=None, verifiedAt=None,
                          verifierId=None, verificationEvidence=[], reworkCount=0, revokedCount=0,
                          isTest=bool(receipt['is_test']))
            connection.execute('INSERT INTO decisions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                               (record['decisionId'], record['receiptId'], record['taskId'], record['stageId'],
                                record['sessionId'], record['turnId'], 'pending', 'active', record['authority'], 1,
                                encoded(record), 1, now, None, now, receipt['is_test']))
            self._save_decision_revision(connection, record)
        return record

    def _save_decision_revision(self, connection, record):
        connection.execute('INSERT INTO decision_revisions VALUES (?,?,?,?)',
                           (record['decisionId'], record['revision'], encoded(record), record['updatedAt']))

    def get_decision(self, decision_id, *, history=False):
        with self._receipt_tx(False) as connection:
            row = connection.execute('SELECT payload FROM decisions WHERE decision_id=?',
                                     (ident(decision_id, 'decisionId'),)).fetchone()
            if row is None:
                raise NotFoundError('unknown decision')
            result = json.loads(row['payload'])
            if history:
                result['history'] = [json.loads(r['payload']) for r in connection.execute(
                    'SELECT payload FROM decision_revisions WHERE decision_id=? ORDER BY revision', (decision_id,))]
            return result

    def update_decision(self, decision_id, data, *, actor_id):
        authorize(actor_id)
        if not isinstance(data, dict) or type(data.get('expectedRevision')) is not int:
            raise ValidationError('expectedRevision integer required')
        action = data.get('action')
        allowed = {
            'revise': ('trigger', 'options', 'owner', 'dueAt', 'nextAction', 'publicDisplay'),
            'choose': ('choice', 'reason', 'nextAction', 'decidedBy', 'authorityEvidence', 'publicDisplay'),
            'action': (), 'execution-confirm': ('executionReceiptId', 'evidence'), 'verify': ('evidence',),
            'rework': ('reason', 'evidence'), 'revoke': ('reason', 'evidence'),
        }
        if not isinstance(action, str) or action not in allowed:
            raise ValidationError('invalid decision action')
        fields(data, ('action', 'expectedRevision') + allowed[action], ('action', 'expectedRevision'))
        with self._receipt_tx() as connection:
            row = connection.execute('SELECT * FROM decisions WHERE decision_id=?',
                                     (ident(decision_id, 'decisionId'),)).fetchone()
            if row is None:
                raise NotFoundError('unknown decision')
            record = json.loads(row['payload'])
            self._require_task(connection, record['taskId'], 'decision')
            if record['revision'] != data['expectedRevision']:
                raise TransitionError('decision revision conflict')
            if record['disposition'] == 'revoked':
                raise TransitionError('revoked decision is immutable')
            now = self._receipt_now()
            if parse_iso(now) < parse_iso(record['updatedAt']):
                raise TransitionError('server clock moved backwards; reconcile before mutation')
            if action == 'revise':
                if record['state'] == 'verified':
                    raise TransitionError('verified decision requires explicit rework')
                for key in allowed[action]:
                    if key not in data:
                        continue
                    if key == 'publicDisplay':
                        record[key] = safe_display(data[key])
                    elif key == 'dueAt':
                        record[key] = normalize_iso(data[key], key) if data[key] is not None else None
                    elif key == 'options':
                        if record['state'] != 'pending':
                            raise TransitionError('options may only change before choice')
                        options = data[key]
                        if not isinstance(options, list) or not 2 <= len(options) <= 20:
                            raise ValidationError('decision requires 2..20 options')
                        record[key] = [text(option, 'option', 500) for option in options]
                        if len(set(record[key])) != len(record[key]):
                            raise ValidationError('decision options must be distinct')
                    elif key == 'owner':
                        if record['state'] == 'action-pending':
                            raise TransitionError('execution owner changes require rework')
                        record[key] = ident(data[key], key)
                    else:
                        if key == 'nextAction' and record['state'] == 'action-pending':
                            raise TransitionError('execution action changes require rework')
                        record[key] = text(data[key], key)
                if 'publicDisplay' not in data:
                    for raw_key, safe_key in (('trigger', 'question'), ('nextAction', 'nextAction'), ('owner', 'owner')):
                        if raw_key in data:
                            record['publicDisplay'][safe_key] = None
            elif action == 'choose':
                if record['state'] != 'pending':
                    raise TransitionError('only pending decision may be decided')
                if data.get('choice') not in record['options']:
                    raise ValidationError('choice must be a recorded option')
                if elapsed(record.get('triggeredAt'), now) is None:
                    raise TransitionError('receipt-to-choice clock is unknown or negative')
                chooser = ident(data.get('decidedBy'), 'decidedBy')
                if record['authority'] == 'controller':
                    authorize(chooser)
                    refs = []
                else:
                    worker_receipt = connection.execute('SELECT payload FROM receipts WHERE event_id=?',
                                                        (record['receiptId'],)).fetchone()
                    worker_source = json.loads(worker_receipt['payload'])['source']
                    if chooser in (CONTROLLER_THREAD_ID, record['sessionId'], worker_source):
                        raise TransitionError('user/external authority cannot be substituted by controller/worker')
                    refs = evidence(data.get('authorityEvidence'), 'authorityEvidence')
                record.update(state='decided', disposition='active', controllerChoice=data['choice'],
                              reason=text(data.get('reason'), 'reason'), nextAction=text(data.get('nextAction'), 'nextAction'),
                              decidedBy=chooser, authorityEvidence=refs, decidedAt=now, latestDecidedAt=now,
                              publicDisplay=safe_display(data.get('publicDisplay')),
                              firstDecidedAt=record['firstDecidedAt'] or now)
            elif action == 'action':
                if record['state'] != 'decided':
                    raise TransitionError('action-pending requires decided state')
                record.update(state='action-pending', actionPendingAt=now)
            elif action in ('execution-confirm', 'verify'):
                if record['state'] != 'action-pending':
                    raise TransitionError('execution/verification requires action-pending state')
                if action == 'verify' and not record.get('actionConfirmedAt'):
                    raise TransitionError('independent verification requires prior execution-confirm')
                if action == 'execution-confirm' and record.get('actionConfirmedAt'):
                    raise TransitionError('execution already confirmed; use rework to change it')
                execution_id = ident(data.get('executionReceiptId') if action == 'execution-confirm'
                                     else record.get('executionReceiptId'), 'executionReceiptId')
                execution = connection.execute('SELECT * FROM receipts WHERE event_id=?', (execution_id,)).fetchone()
                allowed_execution_kinds = ('delivery', 'failed') if action == 'execution-confirm' else ('delivery',)
                if execution is None or execution['task_id'] != record['taskId'] or execution['kind'] not in allowed_execution_kinds:
                    raise TransitionError('verification requires durable execution delivery receipt for this task')
                execution_payload = json.loads(execution['payload'])
                if parse_iso(execution['received_at']) > parse_iso(now):
                    raise TransitionError('execution receipt clock is ahead of confirmation/verification')
                if (execution_id == record['receiptId'] or execution['is_test'] != row['is_test']
                        or parse_iso(execution['received_at']) < parse_iso(record['actionPendingAt'])):
                    raise TransitionError('execution evidence must follow the action and use matching test scope')
                if action == 'verify' and actor_id in (record['owner'], execution['session_id'], execution_payload['source']):
                    raise TransitionError('independent verifier required; no self verification')
                checks = execution_payload['checklist']
                if action == 'verify' and (not checks or any(c['status'] != 'pass' or not c['evidence'] for c in checks)):
                    raise TransitionError('verified requires passing execution evidence')
                if action == 'execution-confirm':
                    record.update(actionConfirmedAt=execution['received_at'], executionReceiptId=execution_id,
                                  executionConfirmedBy=actor_id, executionEvidence=evidence(data.get('evidence')))
                else:
                    record.update(state='verified', verifiedAt=now, verifierId=actor_id,
                                  verificationEvidence=evidence(data.get('evidence')))
                    review_id = 'verification-' + uuid.uuid5(uuid.NAMESPACE_URL,
                        decision_id + ':' + str(record['revision'] + 1)).hex
                    review = dict(reviewId=review_id, receiptId=execution_id, result='accepted',
                                  evidence=record['verificationEvidence'], reviewerId=actor_id, reviewedAt=now)
                    connection.execute('INSERT INTO receipt_reviews VALUES (?,?,?,?)',
                                       (review_id, execution_id, encoded(review), now))
                    from .review_queue import retire_reviewed
                    retire_reviewed(connection, now, execution_id)
            elif action in ('rework', 'revoke'):
                if action == 'rework' and record['state'] == 'pending':
                    raise TransitionError('rework requires an existing choice')
                record['changeReason'] = text(data.get('reason'), 'reason')
                record['changeEvidence'] = evidence(data.get('evidence'))
                if action == 'rework':
                    record.update(state='pending', disposition='rework', pendingSince=now, reworkCount=record['reworkCount'] + 1,
                                  controllerChoice=None, decidedAt=None, reason=None, nextAction=None,
                                  decidedBy=None, authorityEvidence=[], actionPendingAt=None, actionConfirmedAt=None,
                                  executionConfirmedBy=None, executionEvidence=[], publicDisplay=dict(record['publicDisplay'], nextAction=None),
                                  executionReceiptId=None, verifiedAt=None, verifierId=None, verificationEvidence=[])
                else:
                    record.update(disposition='revoked', revokedCount=record['revokedCount'] + 1)
            record.update(revision=record['revision'] + 1, updatedAt=now)
            connection.execute('UPDATE decisions SET state=?,disposition=?,payload=?,revision=?,first_decided_at=?,updated_at=? '
                               'WHERE decision_id=?', (record['state'], record['disposition'], encoded(record),
                                record['revision'], record['firstDecidedAt'], now, decision_id))
            self._save_decision_revision(connection, record)
        return record

    def decisions_snapshot(self, *, include_test=False, task_id=None, state=None, waiting=None, at=None):
        if not isinstance(include_test, bool):
            raise ValidationError('include_test must be boolean')
        if state is not None and state not in STATES:
            raise ValidationError('invalid decision state filter')
        if waiting is not None and waiting not in ('waiting-user', 'waiting-external', 'controller'):
            raise ValidationError('invalid waiting filter')
        if task_id is not None:
            ident(task_id, 'taskId')
        now = parse_iso(at) if at is not None else parse_iso(self._receipt_now())
        with self._receipt_tx(False) as connection:
            rows = connection.execute('SELECT payload FROM decisions WHERE (? OR is_test=0) ORDER BY created_at,decision_id',
                                      (int(include_test),)).fetchall()
            records = [json.loads(row['payload']) for row in rows]
            coverage_start = self._meta(connection, 'receipt_decision_statistics_start')
        for record in records:
            record['waiting'] = ('waiting-' + record['authority'] if record['state'] == 'pending'
                                 and record['authority'] != 'controller' and record['disposition'] != 'revoked'
                                 else 'controller' if record['state'] == 'pending' and record['disposition'] != 'revoked'
                                 else None)
        # Counts and samples share exactly the returned filter scope.
        records = [r for r in records if (task_id is None or r['taskId'] == task_id)
                   and (state is None or r['state'] == state) and (waiting is None or r['waiting'] == waiting)]
        active = [r for r in records if r['disposition'] != 'revoked']
        pending = [r for r in active if r['state'] == 'pending']
        unresolved = [r for r in active if r['state'] != 'verified']
        pending_waits = [elapsed(r.get('pendingSince'), now.isoformat()) for r in pending]
        unresolved_waits = [elapsed(r.get('triggeredAt'), now.isoformat()) for r in unresolved]
        decided = [r for r in records if r['firstDecidedAt'] is not None]
        sample_values = [elapsed(r.get('triggeredAt'), r['firstDecidedAt']) for r in decided]
        samples = sorted(value for value in sample_values if value is not None)
        def percentile(p):
            return samples[max(0, math.ceil(len(samples) * p) - 1)] if samples else None
        def longest(values):
            known = [value for value in values if value is not None]
            return max(known) if known else None
        known_overdue = sum(r['dueAt'] is not None and parse_iso(r['dueAt']) < now for r in unresolved)
        missing_due = sum(r['dueAt'] is None for r in unresolved)
        counts = dict(decided=len(decided), currentlyEffective=sum(r['state'] != 'pending' for r in active),
                      pending=len(pending), overdue=known_overdue if missing_due == 0 else None, knownOverdue=known_overdue,
                      missingDueAt=missing_due, overdueUnknown=missing_due,
                      actionPending=sum(r['state'] in ('decided', 'action-pending') for r in active),
                      awaitingExecution=sum(r['state'] in ('decided', 'action-pending') and r.get('actionConfirmedAt') is None for r in active),
                      awaitingVerification=sum(r['state'] == 'action-pending' and r.get('actionConfirmedAt') is not None for r in active),
                      longestWait=longest(pending_waits), pendingDecisionWait=longest(pending_waits),
                      allUnresolvedWait=longest(unresolved_waits),
                      waitingUser=sum(r['waiting'] == 'waiting-user' for r in active),
                      waitingExternal=sum(r['waiting'] == 'waiting-external' for r in active),
                      rework=sum(r['reworkCount'] > 0 for r in records),
                      revoked=sum(r['revokedCount'] > 0 for r in records))
        backlog = self.receipt_review_backlog(include_test=include_test, task_id=task_id, at=now.isoformat())
        counts['unreviewedReceipts'] = backlog['count']
        return dict(interfaceVersion=1, generatedAt=now.isoformat(timespec='microseconds'),
                    statisticsStartAt=coverage_start,
                    coverage=dict(start=coverage_start, history='recorded-since-start-only', includesTest=include_test,
                                  testLedger=self.receipt_test_mode, overdueComplete=missing_due == 0,
                                  latencyMissing=sum(value is None for value in sample_values)), counts=counts,
                    waitUnit='seconds', receiptReviewBacklog=backlog,
                    latency=dict(unit='seconds', basis='receipt-to-first-decision', method='nearest-rank', sampleCount=len(samples),
                                 missing=sum(value is None for value in sample_values),
                                 p50=percentile(.50), p95=percentile(.95)), decisions=records)

    def receipt_review_backlog(self, *, include_test=False, task_id=None, at=None):
        now = at or self._receipt_now()
        with self._receipt_tx(False) as connection:
            rows = connection.execute(
                'SELECT event_id,task_id,kind,received_at FROM receipts r WHERE (? OR is_test=0) '
                'AND (? IS NULL OR task_id=?) AND NOT EXISTS '
                '(SELECT 1 FROM receipt_reviews v WHERE v.event_id=r.event_id) ORDER BY received_at,event_id',
                (int(include_test), task_id, task_id)).fetchall()
        receipts = [dict(receiptId=r['event_id'], taskId=r['task_id'], kind=r['kind'], receivedAt=r['received_at'],
                         waitSeconds=elapsed(r['received_at'], now)) for r in rows]
        known = [r['waitSeconds'] for r in receipts if r['waitSeconds'] is not None]
        return dict(version=1, generatedAt=now, count=len(receipts), oldestWaitSeconds=max(known) if known else None,
                    receipts=receipts)

    def public_decisions_snapshot(self, *, include_test=False):
        return project(self.decisions_snapshot(include_test=include_test))
